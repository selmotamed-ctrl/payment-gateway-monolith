//! Ports and records of the rail engine.
//!
//! The engine owns no database. Every side effect goes through one of these traits, which the core
//! service adapts onto `pg-db`/`pg-ledger`/`pg-egress`/`pg-crypto`:
//!
//! | Port | TypeScript source | Database adapter (later) |
//! | :--- | :--- | :--- |
//! | [`FlowStore`] | `AttemptRepository` + step logs + the encrypted context | `payment_attempts`, `attempt_step_logs` |
//! | [`SlotStore`] | `SlotReservationStore` (`runtime/slotStore.ts`) | `payment_links`, SUSPENSE posting |
//! | [`FlowProvider`] | `FlowProvider` / `PrismaFlowProvider` | `flows`, `flow_steps`, `status_rules` |
//! | [`EgressPort`] | `ApiConsumer.request` | `pg-egress` HTTP executor |
//! | [`VaultPort`] | `VaultContextCipher` | `pg-crypto::Vault` with `attempt-context` |
//! | [`LedgerPort`] | `PaymentLedgerPoster` | `pg-ledger` DB poster |
//! | [`Clock`], [`Rng`] | `Date` / `crypto.randomUUID` / `secureRandomInt` | system clock, OS RNG |
//!
//! Deliberate scoping (recorded in `README.md` and `DEVIATIONS.md`):
//!
//! - There is no transaction object. `finalize` is a claim + slot commit + posting + status write
//!   sequence; the DB adapter must run those four writes in one transaction (chapter 2 §17). The
//!   [`FlowStore::claim_finalize`] guard keeps two finalizers from both committing, exactly like the
//!   TS single-writer claim.
//! - The egress response is returned for every HTTP status, including 4xx/5xx. The TS
//!   `StepExecutor` sees the same when no `ApiConsumer` is configured; an `ApiConsumer` throws before
//!   the executor can map a status rule, so the adapter may keep that stricter posture. The engine
//!   maps the status rule first, which is the documented executor contract.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use pg_domain_flow::{LinkSlotState, PaymentStatus};
use pg_domain_ledger::LedgerScenario;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::error::EngineError;
use crate::schema::{FlowPhase, FlowStep, HttpMethod, RetryPolicy, SideEffect};

/// The deployment environment of an attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Environment {
    Live,
    #[default]
    Sandbox,
}

impl Environment {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "LIVE",
            Self::Sandbox => "SANDBOX",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "LIVE" => Some(Self::Live),
            "SANDBOX" => Some(Self::Sandbox),
            _ => None,
        }
    }
}

/// `LedgerOwnershipMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OwnershipMode {
    Internal,
    #[default]
    PlatformClearing,
    MerchantDirect,
}

impl OwnershipMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Internal => "INTERNAL",
            Self::PlatformClearing => "PLATFORM_CLEARING",
            Self::MerchantDirect => "MERCHANT_DIRECT",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "INTERNAL" => Some(Self::Internal),
            "PLATFORM_CLEARING" => Some(Self::PlatformClearing),
            "MERCHANT_DIRECT" => Some(Self::MerchantDirect),
            _ => None,
        }
    }
}

/// `feeBearer` of the pinned commission profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FeeBearer {
    #[default]
    MerchantAbsorbs,
    PayerSurcharge,
    Split,
}

impl FeeBearer {
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "MERCHANT_ABSORBS" => Some(Self::MerchantAbsorbs),
            "PAYER_SURCHARGE" => Some(Self::PayerSurcharge),
            "SPLIT" => Some(Self::Split),
            _ => None,
        }
    }
}

/// One `payment_attempts` row, as much as the flow engine reads and writes.
///
/// Field names follow the TypeScript `DynamicAttempt` where the engine uses them
/// (`requestedAmount`, `totalChargedAmount`, `publicOutputs`, ...).
#[derive(Debug, Clone, PartialEq)]
pub struct Attempt {
    pub id: String,
    pub reference: String,
    pub gateway_reference: Option<String>,
    pub merchant_id: Option<String>,
    pub application_id: Option<String>,
    pub gateway_id: Option<String>,
    pub gateway_version_id: Option<String>,
    pub route_id: Option<String>,
    pub rail_id: Option<String>,
    pub link_id: Option<String>,
    pub credential_set_id: Option<String>,
    pub wallet_id: Option<String>,
    pub wallet_gl_account_id: Option<String>,
    pub commission_profile_id: Option<String>,
    pub sub_mode: Option<String>,
    pub customer_fingerprint: Option<String>,
    pub ownership_mode: OwnershipMode,
    pub fee_bearer: FeeBearer,
    pub fee_accrual: bool,
    pub status: PaymentStatus,
    pub substatus: Option<String>,
    pub canonical_error: Option<String>,
    pub currency: String,
    pub env: Environment,
    pub requested_amount: Decimal,
    pub total_charged_amount: Decimal,
    pub settled_amount: Option<Decimal>,
    pub gateway_fee_amount: Option<Decimal>,
    pub surcharge_amount: Decimal,
    pub platform_commission_amount: Option<Decimal>,
    pub net_merchant_amount: Option<Decimal>,
    pub mismatch_tolerance: Option<Decimal>,
    pub provider_reference: Option<String>,
    pub network_reference: Option<String>,
    pub point_of_no_return: bool,
    pub otp_attempts: u32,
    pub max_otp_attempts: Option<u32>,
    pub public_outputs: Map<String, Value>,
    /// The plaintext context, used when no ciphertext exists (fresh attempt / tests).
    pub context: Map<String, Value>,
    pub context_ciphertext: Option<String>,
    pub ledger_entry_id: Option<String>,
    pub terminal_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
}

impl Attempt {
    /// A minimal attempt with the given identity and amount. Tests usually tweak the public fields.
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        reference: impl Into<String>,
        amount: Decimal,
        currency: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            reference: reference.into(),
            requested_amount: amount,
            total_charged_amount: amount,
            currency: currency.into(),
            ..Self::default()
        }
    }

    /// `totalChargedAmount ?? requestedAmount` as a decimal.
    #[must_use]
    pub fn charged_amount(&self) -> Decimal {
        if self.total_charged_amount.is_zero() && !self.requested_amount.is_zero() {
            self.requested_amount
        } else {
            self.total_charged_amount
        }
    }

    /// The expected reference of the trusted-success check: the gateway reference, else our
    /// reference.
    #[must_use]
    pub fn expected_reference(&self) -> Option<&str> {
        self.gateway_reference
            .as_deref()
            .or(Some(self.reference.as_str()))
    }

    /// `attempt.env` as the string the callback evidence is compared with.
    #[must_use]
    pub fn env_str(&self) -> &'static str {
        self.env.as_str()
    }

    /// The substatus the engine compares (`AML_HOLD`).
    #[must_use]
    pub fn is_aml_held(&self) -> bool {
        self.substatus.as_deref() == Some(crate::engine::AML_HOLD_SUBSTATUS)
    }

    /// True when the attempt is one of the terminal success statuses (`finalizeGuardFor`).
    #[must_use]
    pub fn holds_money(&self) -> bool {
        self.status.holds_money()
    }

    /// The `attempt` selector root (`StepExecutionContext.attempt`). Decimal values are rendered as
    /// their exact decimal string so a transform can format them without a float.
    #[must_use]
    pub fn context_map(&self) -> Map<String, Value> {
        let mut map = Map::new();
        let mut insert = |key: &str, value: Value| {
            map.insert(key.to_owned(), value);
        };
        insert("id", Value::String(self.id.clone()));
        insert("reference", Value::String(self.reference.clone()));
        if let Some(reference) = &self.gateway_reference {
            insert("gatewayReference", Value::String(reference.clone()));
        }
        for (key, value) in [
            ("merchantId", &self.merchant_id),
            ("applicationId", &self.application_id),
            ("gatewayId", &self.gateway_id),
            ("gatewayVersionId", &self.gateway_version_id),
            ("routeId", &self.route_id),
            ("railId", &self.rail_id),
            ("linkId", &self.link_id),
            ("credentialSetId", &self.credential_set_id),
            ("walletId", &self.wallet_id),
            ("subMode", &self.sub_mode),
            ("providerReference", &self.provider_reference),
            ("networkReference", &self.network_reference),
        ] {
            if let Some(value) = value {
                insert(key, Value::String(value.clone()));
            }
        }
        insert(
            "requestedAmount",
            Value::String(self.requested_amount.to_string()),
        );
        insert(
            "totalChargedAmount",
            Value::String(self.total_charged_amount.to_string()),
        );
        if let Some(amount) = self.settled_amount {
            insert("settledAmount", Value::String(amount.to_string()));
        }
        if let Some(amount) = self.gateway_fee_amount {
            insert("gatewayFeeAmount", Value::String(amount.to_string()));
        }
        insert(
            "surchargeAmount",
            Value::String(self.surcharge_amount.to_string()),
        );
        if let Some(amount) = self.platform_commission_amount {
            insert(
                "platformCommissionAmount",
                Value::String(amount.to_string()),
            );
        }
        if let Some(amount) = self.net_merchant_amount {
            insert("netMerchantAmount", Value::String(amount.to_string()));
        }
        if let Some(tolerance) = self.mismatch_tolerance {
            insert("mismatchTolerance", Value::String(tolerance.to_string()));
        }
        insert("currency", Value::String(self.currency.clone()));
        insert("env", Value::String(self.env.as_str().to_owned()));
        insert("status", Value::String(self.status.as_str().to_owned()));
        insert(
            "ownershipMode",
            Value::String(self.ownership_mode.as_str().to_owned()),
        );
        insert("pointOfNoReturn", Value::Bool(self.point_of_no_return));
        insert("otpAttempts", Value::from(self.otp_attempts));
        if let Some(expires_at) = self.expires_at {
            insert(
                "expiresAt",
                Value::String(expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
            );
        }
        map
    }
}

impl Default for Attempt {
    fn default() -> Self {
        Self {
            id: String::new(),
            reference: String::new(),
            gateway_reference: None,
            merchant_id: None,
            application_id: None,
            gateway_id: None,
            gateway_version_id: None,
            route_id: None,
            rail_id: None,
            link_id: None,
            credential_set_id: None,
            wallet_id: None,
            wallet_gl_account_id: None,
            commission_profile_id: None,
            sub_mode: None,
            customer_fingerprint: None,
            ownership_mode: OwnershipMode::PlatformClearing,
            fee_bearer: FeeBearer::MerchantAbsorbs,
            fee_accrual: false,
            status: PaymentStatus::Created,
            substatus: None,
            canonical_error: None,
            currency: "LYD".to_owned(),
            env: Environment::Sandbox,
            requested_amount: Decimal::ZERO,
            total_charged_amount: Decimal::ZERO,
            settled_amount: None,
            gateway_fee_amount: None,
            surcharge_amount: Decimal::ZERO,
            platform_commission_amount: None,
            net_merchant_amount: None,
            mismatch_tolerance: None,
            provider_reference: None,
            network_reference: None,
            point_of_no_return: false,
            otp_attempts: 0,
            max_otp_attempts: None,
            public_outputs: Map::new(),
            context: Map::new(),
            context_ciphertext: None,
            ledger_entry_id: None,
            terminal_at: None,
            expires_at: None,
            created_at: None,
        }
    }
}

/// The patch of one attempt write.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AttemptPatch {
    pub status: Option<PaymentStatus>,
    pub substatus: Option<String>,
    /// Explicitly clears the persisted substatus (a finalize completed).
    pub clear_substatus: bool,
    pub canonical_error: Option<String>,
    pub otp_attempts: Option<u32>,
    pub point_of_no_return: Option<bool>,
    pub ledger_entry_id: Option<String>,
    pub context_ciphertext: Option<String>,
    pub public_outputs: Option<Map<String, Value>>,
    pub provider_reference: Option<String>,
    pub network_reference: Option<String>,
    pub settled_amount: Option<Decimal>,
    pub gateway_fee_amount: Option<Decimal>,
    pub route_id: Option<String>,
    pub link_id: Option<String>,
    /// The status this write observed; the store applies the patch only while the row still has it.
    pub expected_status: Option<PaymentStatus>,
}

impl AttemptPatch {
    #[must_use]
    pub fn status(status: PaymentStatus) -> Self {
        Self {
            status: Some(status),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn expected(mut self, status: PaymentStatus) -> Self {
        self.expected_status = Some(status);
        self
    }

    /// Applies the patch to a loaded row. The caller has already checked `expected_status` (or is
    /// the in-memory store doing so in one critical section).
    pub fn apply(self, attempt: &mut Attempt, now: DateTime<Utc>) {
        if let Some(status) = self.status {
            attempt.status = status;
            if status.is_terminal() && attempt.terminal_at.is_none() {
                attempt.terminal_at = Some(now);
            }
        }
        if self.clear_substatus {
            attempt.substatus = None;
        }
        if let Some(substatus) = self.substatus {
            attempt.substatus = Some(substatus);
        }
        if let Some(error) = self.canonical_error {
            attempt.canonical_error = Some(error);
        }
        if let Some(attempts) = self.otp_attempts {
            attempt.otp_attempts = attempts;
        }
        if let Some(point_of_no_return) = self.point_of_no_return {
            attempt.point_of_no_return = point_of_no_return;
        }
        if let Some(ledger_entry_id) = self.ledger_entry_id {
            attempt.ledger_entry_id = Some(ledger_entry_id);
        }
        if let Some(ciphertext) = self.context_ciphertext {
            attempt.context_ciphertext = Some(ciphertext);
            attempt.context = Map::new();
        }
        if let Some(public) = self.public_outputs {
            attempt.public_outputs = public;
        }
        if let Some(reference) = self.provider_reference {
            attempt.provider_reference = Some(reference);
        }
        if let Some(reference) = self.network_reference {
            attempt.network_reference = Some(reference);
        }
        if let Some(amount) = self.settled_amount {
            attempt.settled_amount = Some(amount);
        }
        if let Some(amount) = self.gateway_fee_amount {
            attempt.gateway_fee_amount = Some(amount);
        }
        if let Some(route_id) = self.route_id {
            attempt.route_id = Some(route_id);
        }
        if let Some(link_id) = self.link_id {
            attempt.link_id = Some(link_id);
        }
    }
}

/// The store could not complete the operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    NotFound(String),
    StateConflict { expected: String, observed: String },
    Unsupported(&'static str),
    Backend(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(what) => formatter.write_str(what),
            Self::StateConflict { expected, observed } => {
                write!(formatter, "expected {expected}, observed {observed}")
            }
            Self::Unsupported(feature) => write!(formatter, "unsupported: {feature}"),
            Self::Backend(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for StoreError {}

/// The persisted position of one phase of one attempt.
#[derive(Debug, Clone, PartialEq)]
pub struct StepCursor {
    pub attempt_id: String,
    pub phase: FlowPhase,
    /// The index of the next step to execute.
    pub next_index: usize,
    /// The `previous_response` a continuation sees.
    pub previous_response: Option<Value>,
    pub completed: bool,
    /// The time the last step wrote, for observability.
    pub updated_at: Option<DateTime<Utc>>,
}

impl StepCursor {
    #[must_use]
    pub fn start(attempt_id: impl Into<String>, phase: FlowPhase) -> Self {
        Self {
            attempt_id: attempt_id.into(),
            phase,
            next_index: 0,
            previous_response: None,
            completed: false,
            updated_at: None,
        }
    }
}

/// One `attempt_step_logs` row (`recordStepLogs`).
#[derive(Debug, Clone, PartialEq)]
pub struct StepLogRecord {
    pub attempt_id: String,
    pub gateway_version_id: Option<String>,
    pub phase: FlowPhase,
    pub step_id: String,
    pub step_order: u32,
    pub redacted_request: Value,
    pub redacted_response_text: String,
    pub http_status: Option<u16>,
    pub duration_ms: u64,
    pub outcome: String,
    pub created_at: DateTime<Utc>,
}

/// The outcome of an atomic cancel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelOutcome {
    pub status: PaymentStatus,
    /// True when this call changed the row (and therefore owns the slot release).
    pub released: bool,
}

/// `SlotReservation { reservationId, linkId }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotReservation {
    pub reservation_id: String,
    pub link_id: Option<String>,
}

/// `SlotCommitResult["outcome"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotOutcome {
    Committed,
    Suspense,
    Held,
}

impl SlotOutcome {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Committed => "COMMITTED",
            Self::Suspense => "SUSPENSE",
            Self::Held => "HELD",
        }
    }
}

/// `SlotCommitResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotCommit {
    pub outcome: SlotOutcome,
    pub journal_entry_id: Option<String>,
    pub adjustment_id: Option<String>,
    pub operator_case_id: Option<String>,
    pub reason: Option<String>,
}

impl SlotCommit {
    #[must_use]
    pub fn committed() -> Self {
        Self {
            outcome: SlotOutcome::Committed,
            journal_entry_id: None,
            adjustment_id: None,
            operator_case_id: None,
            reason: None,
        }
    }

    #[must_use]
    pub fn suspense(reason: impl Into<String>) -> Self {
        Self {
            outcome: SlotOutcome::Suspense,
            journal_entry_id: None,
            adjustment_id: None,
            operator_case_id: None,
            reason: Some(reason.into()),
        }
    }
}

/// Attempt + step cursor + step logs + context.
#[async_trait]
pub trait FlowStore: Send + Sync {
    async fn load_attempt(&self, attempt_id: &str) -> Result<Option<Attempt>, StoreError>;

    /// Compare-and-set write. Returns `StateConflict` when `expected_status` no longer matches.
    async fn update_attempt(
        &self,
        attempt_id: &str,
        patch: AttemptPatch,
    ) -> Result<Attempt, StoreError>;

    /// `PrismaSlotReservationStore`'s single-writer finalize claim. The default keeps the TS
    /// optional-callback behaviour (every caller wins), which is only safe for a single writer.
    async fn claim_finalize(
        &self,
        _attempt_id: &str,
        _expected_status: PaymentStatus,
    ) -> Result<bool, StoreError> {
        Ok(true)
    }

    /// `claimAttemptForConfirm`: only one caller may move a claimable attempt to AUTHORIZING.
    ///
    /// `idempotency_key_hash` is the sha256 the checkout API computed; a database adapter stores it
    /// in `customer_fields_masked.confirm_idempotency_key_hash` and refuses a repeat.
    async fn claim_authorizing(
        &self,
        attempt_id: &str,
        idempotency_key_hash: Option<&str>,
    ) -> Result<bool, StoreError>;

    /// `cancelAttemptAtomically`. The default implementation walks the same preconditions with a
    /// compare-and-set; an adapter overrides it with the one conditional `UPDATE`.
    async fn cancel_attempt(&self, attempt_id: &str) -> Result<CancelOutcome, StoreError> {
        let Some(attempt) = self.load_attempt(attempt_id).await? else {
            return Err(StoreError::NotFound(attempt_id.to_owned()));
        };
        let cancellable = attempt.terminal_at.is_none()
            && !attempt.point_of_no_return
            && !attempt.is_aml_held()
            && !matches!(
                attempt.status,
                PaymentStatus::Succeeded
                    | PaymentStatus::Authorizing
                    | PaymentStatus::Refunded
                    | PaymentStatus::PartiallyRefunded
                    | PaymentStatus::Failed
                    | PaymentStatus::Expired
                    | PaymentStatus::Cancelled
                    | PaymentStatus::Blocked
            );
        if !cancellable {
            return Ok(CancelOutcome {
                status: attempt.status,
                released: false,
            });
        }
        match self
            .update_attempt(
                attempt_id,
                AttemptPatch::status(PaymentStatus::Cancelled).expected(attempt.status),
            )
            .await
        {
            Ok(updated) => Ok(CancelOutcome {
                status: updated.status,
                released: true,
            }),
            Err(StoreError::StateConflict { .. }) => {
                let latest = self.load_attempt(attempt_id).await?;
                Ok(CancelOutcome {
                    status: latest.map_or(PaymentStatus::Cancelled, |row| row.status),
                    released: false,
                })
            }
            Err(error) => Err(error),
        }
    }

    async fn load_cursor(
        &self,
        attempt_id: &str,
        phase: FlowPhase,
    ) -> Result<Option<StepCursor>, StoreError>;

    async fn save_cursor(&self, cursor: &StepCursor) -> Result<(), StoreError>;

    async fn record_step(&self, record: StepLogRecord) -> Result<(), StoreError>;
}

/// Link slots and the attempt-group single-success rule.
#[async_trait]
pub trait SlotStore: Send + Sync {
    /// `reserveSlot`: the guard's slot check plus the reservation id.
    async fn reserve(&self, attempt: &Attempt) -> Result<SlotReservation, StoreError>;

    /// `releaseSlot`: `active_locked_count = GREATEST(0, active_locked_count - 1)`.
    async fn release(&self, attempt: &Attempt, reason: &str) -> Result<(), StoreError>;

    /// `commitSlot`: advances the counters, or routes an excess settlement to SUSPENSE.
    async fn commit(&self, attempt: &Attempt) -> Result<SlotCommit, StoreError>;
}

/// The steps of one phase.
#[async_trait]
pub trait FlowProvider: Send + Sync {
    async fn get_steps(
        &self,
        phase: FlowPhase,
        attempt: &Attempt,
    ) -> Result<Vec<FlowStep>, EngineError>;
}

/// The gateway answer of one outbound request.
#[derive(Debug, Clone, PartialEq)]
pub struct EgressResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub raw_text: String,
    pub data: Value,
    pub url: String,
}

/// A request body the egress adapter serialises.
#[derive(Debug, Clone, PartialEq)]
pub enum EgressBody {
    /// A JSON document (`JSON.stringify`).
    Json(Value),
    /// An already encoded text body (XML, plain text).
    Text(String),
    /// `application/x-www-form-urlencoded`, in insertion order.
    Form(Vec<(String, String)>),
    /// Multipart fields. The adapter owns the boundary and must delete an explicit `content-type`.
    Multipart(Vec<(String, String)>),
    Bytes(Vec<u8>),
}

/// One outbound request handed to `pg-egress`.
#[derive(Debug, Clone, PartialEq)]
pub struct EgressRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Option<EgressBody>,
    pub timeout_ms: u64,
    pub side_effect: SideEffect,
    pub retry_policy: RetryPolicy,
    pub point_of_no_return: bool,
}

/// A transport/validation failure. A gateway HTTP answer is [`EgressResponse`], not an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EgressError {
    pub message: String,
    pub status: Option<u16>,
    pub retryable: bool,
    pub money_uncertain: bool,
}

impl EgressError {
    #[must_use]
    pub fn transport(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
            retryable: true,
            money_uncertain: false,
        }
    }

    #[must_use]
    pub fn blocked(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
            retryable: false,
            money_uncertain: false,
        }
    }

    #[must_use]
    pub fn timeout() -> Self {
        Self {
            message: "Gateway request timed out".to_owned(),
            status: None,
            retryable: true,
            money_uncertain: false,
        }
    }
}

impl std::fmt::Display for EgressError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for EgressError {}

/// Outbound HTTP. The production adapter is the `pg-egress` executor (mTLS, allowlist, pinned DNS,
/// 2 MiB cap, JSON depth); tests use an in-memory script.
#[async_trait]
pub trait EgressPort: Send + Sync {
    async fn send(&self, request: EgressRequest) -> Result<EgressResponse, EgressError>;
}

/// `VaultContextCipher`: seals and opens the attempt context.
pub trait VaultPort: Send + Sync {
    fn seal(&self, plaintext: &str, key_id: &str) -> Result<String, String>;
    fn open(&self, sealed: &str, key_id: &str) -> Result<String, String>;
}

/// Wall clock and retry delay.
#[async_trait]
pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
    /// Sleeps for the retry cooldown. The production clock uses `tokio::time::sleep`; a test clock
    /// returns immediately and records the delay.
    async fn sleep_ms(&self, milliseconds: u64) {
        if milliseconds > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(milliseconds)).await;
        }
    }
}

/// `crypto.randomUUID` / `crypto.randomInt` / `secureRandomInt`.
pub trait Rng: Send + Sync {
    fn uuid(&self) -> Uuid;
    fn int(&self, max_exclusive: u32) -> u32;
}

/// A signed journal posting request for a payment confirmation.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfirmationPosting {
    pub attempt_id: String,
    pub ownership_mode: OwnershipMode,
    pub fee_bearer: FeeBearer,
    pub fee_accrual: bool,
    pub amount: Decimal,
    pub surcharge_amount: Decimal,
    pub commission_amount: Decimal,
    pub merchant_amount: Decimal,
    /// `gatewayFeeAmount` of the attempt; the route fee.
    pub gateway_fee_amount: Option<Decimal>,
    /// `providerFeeAmount` alias the ledger templates read (`PLATFORM_HELD_CONFIRMATION`).
    pub provider_fee_amount: Option<Decimal>,
    /// The scenario `buildPaymentConfirmationTemplate` selected; the DB poster resolves the lines.
    pub scenario: LedgerScenario,
    pub merchant_id: Option<String>,
    pub gateway_id: Option<String>,
    pub credential_set_id: Option<String>,
    pub wallet_gl_account_id: Option<String>,
    pub currency: String,
    pub env: Environment,
}

/// `buildPaymentConfirmationTemplate`'s scenario selection, with the TS validation.
pub fn confirmation_scenario(posting: &ConfirmationPosting) -> Result<LedgerScenario, EngineError> {
    match posting.ownership_mode {
        OwnershipMode::Internal => return Ok(LedgerScenario::InternalConfirmation),
        OwnershipMode::MerchantDirect => return Ok(LedgerScenario::MerchantDirectConfirmation),
        OwnershipMode::PlatformClearing => {}
    }
    if posting.commission_amount < Decimal::ZERO {
        return Err(EngineError::new(
            400,
            "INVALID_LEDGER_AMOUNT",
            "Commission amount must not be negative",
        ));
    }
    match posting.fee_bearer {
        FeeBearer::PayerSurcharge => {
            require_fee(posting.gateway_fee_amount, "Gateway fee amount")?;
            require_fee(Some(posting.surcharge_amount), "Payer surcharge amount")?;
            Ok(LedgerScenario::PayerSurchargeConfirmation)
        }
        FeeBearer::Split => {
            require_fee(posting.gateway_fee_amount, "Gateway fee amount")?;
            require_fee(Some(posting.surcharge_amount), "Payer surcharge amount")?;
            Ok(LedgerScenario::SplitSurchargeConfirmation)
        }
        FeeBearer::MerchantAbsorbs => {
            if posting.fee_accrual {
                require_fee(posting.gateway_fee_amount, "Gateway fee amount")?;
                Ok(LedgerScenario::PlatformHeldFeeAccrual)
            } else {
                require_fee(posting.provider_fee_amount, "Provider fee amount")?;
                Ok(LedgerScenario::PlatformHeldConfirmation)
            }
        }
    }
}

fn require_fee(value: Option<Decimal>, label: &str) -> Result<Decimal, EngineError> {
    let Some(value) = value else {
        return Err(EngineError::new(
            400,
            "MISSING_FEE_AMOUNT",
            format!("{label} must be resolved before posting"),
        ));
    };
    if value < Decimal::ZERO {
        return Err(EngineError::new(
            400,
            "INVALID_LEDGER_AMOUNT",
            format!("{label} must not be negative"),
        ));
    }
    Ok(value)
}

/// A scenario posting (AML escrow, refund scenario, ...).
#[derive(Debug, Clone, PartialEq)]
pub struct ScenarioPosting {
    pub scenario: LedgerScenario,
    pub stage: Option<pg_domain_ledger::LedgerScenarioStage>,
    pub ref_id: String,
    pub amount: Decimal,
    pub commission_amount: Decimal,
    pub merchant_amount: Decimal,
    pub merchant_id: Option<String>,
    pub gateway_id: Option<String>,
    pub credential_set_id: Option<String>,
    pub wallet_gl_account_id: Option<String>,
    pub currency: String,
    pub env: Environment,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostedEntry {
    pub entry_id: String,
    /// True when the journal already existed for `(ref_type, ref_id)`.
    pub idempotent: bool,
}

/// The ledger adapter. `pg-ledger` implements this; the pure [`pg_domain_ledger`] templates pick
/// the lines.
#[async_trait]
pub trait LedgerPort: Send + Sync {
    async fn post_confirmation(
        &self,
        posting: ConfirmationPosting,
    ) -> Result<PostedEntry, EngineError>;

    async fn post_scenario(&self, posting: ScenarioPosting) -> Result<PostedEntry, EngineError>;
}

/// The `attempt:transition` invalidation bus.
pub trait TransitionSink: Send + Sync {
    fn publish(&self, event: AttemptTransitionEvent);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptTransitionEvent {
    pub attempt_id: String,
    pub status: PaymentStatus,
    pub substatus: Option<String>,
    pub merchant_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CasePriority {
    P1,
    P2,
    P3,
}

impl CasePriority {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::P1 => "P1",
            Self::P2 => "P2",
            Self::P3 => "P3",
        }
    }
}

/// `OperatorCaseSink.open`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorCaseInput {
    pub kind: String,
    pub priority: CasePriority,
    pub attempt_id: String,
    pub title: String,
    pub detail: String,
    pub sla_due_at: DateTime<Utc>,
}

pub trait CaseSink: Send + Sync {
    fn open(&self, input: OperatorCaseInput);
}

/// `ReconciliationScheduler.schedule`.
pub trait ReconciliationScheduler: Send + Sync {
    fn schedule(&self, attempt_id: &str, adjustment_id: Option<&str>);
}

/// The outcome of `CallbackVerifier.verify`.
#[derive(Debug, Clone, PartialEq)]
pub struct CallbackVerification {
    pub verified: bool,
    pub attempt_id: Option<String>,
    pub evidence: Map<String, Value>,
    pub must_inquire: bool,
    pub duplicate: bool,
    pub reason: Option<String>,
}

impl CallbackVerification {
    #[must_use]
    pub fn verified(attempt_id: impl Into<String>) -> Self {
        Self {
            verified: true,
            attempt_id: Some(attempt_id.into()),
            evidence: Map::new(),
            must_inquire: false,
            duplicate: false,
            reason: None,
        }
    }

    #[must_use]
    pub fn rejected(reason: impl Into<String>) -> Self {
        Self {
            verified: false,
            attempt_id: None,
            evidence: Map::new(),
            must_inquire: false,
            duplicate: false,
            reason: Some(reason.into()),
        }
    }
}

/// Callback signature/protocol verification (the channel-specific verifier of the core).
#[async_trait]
pub trait CallbackVerifier: Send + Sync {
    async fn verify(
        &self,
        channel: &str,
        raw_request: &Value,
    ) -> Result<CallbackVerification, EngineError>;
}

/// `callbackInbox.accept(channel, dedupeKey, attemptId)`.
pub trait CallbackInbox: Send + Sync {
    fn accept(&self, channel: &str, dedupe_key: &str, attempt_id: &str) -> bool;
}

/// Resolves the credential entries of an attempt (`CREDENTIAL` parameter source). The core adapter
/// decrypts the credential set with the Vault and returns the entries under their key names.
pub trait CredentialResolver: Send + Sync {
    fn credentials(&self, attempt: &Attempt) -> Map<String, Value>;
}

/// `ReportingEvaluator.evaluate`; a failure is swallowed by the engine.
pub trait ReportingEvaluator: Send + Sync {
    fn evaluate(
        &self,
        attempt_id: &str,
        merchant_id: Option<&str>,
        amount: Decimal,
        currency: &str,
    );
}

/// A shared handle to a port.
pub type Shared<T> = Arc<T>;

/// Helper used by [`StepCursor`] consumers.
#[must_use]
pub fn slot_reservation_id(link_id: &str, attempt_id: &str) -> String {
    format!("{link_id}:{attempt_id}")
}

/// The link row a slot adapter reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkStateRow {
    pub slots: LinkSlotState,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn patch_applies_terminal_timestamp_and_clear() {
        let now = Utc::now();
        let mut attempt = Attempt::default();
        let mut patch = AttemptPatch::status(PaymentStatus::Succeeded);
        patch.substatus = Some("X".to_owned());
        patch.apply(&mut attempt, now);
        assert_eq!(attempt.status, PaymentStatus::Succeeded);
        assert_eq!(attempt.terminal_at, Some(now));
        assert_eq!(attempt.substatus.as_deref(), Some("X"));
        let patch = AttemptPatch {
            clear_substatus: true,
            ..AttemptPatch::default()
        };
        patch.apply(&mut attempt, now);
        assert!(attempt.substatus.is_none());
    }

    #[test]
    fn attempt_amount_fallbacks_and_reference() {
        let mut attempt = Attempt::new(
            "a",
            "ref-1",
            Decimal::from_str("10.0000").expect("decimal"),
            "LYD",
        );
        assert_eq!(attempt.expected_reference(), Some("ref-1"));
        attempt.gateway_reference = Some("gw-9".to_owned());
        assert_eq!(attempt.expected_reference(), Some("gw-9"));
        attempt.total_charged_amount = Decimal::ZERO;
        assert_eq!(
            attempt.charged_amount(),
            Decimal::from_str("10").expect("decimal")
        );
        assert!(!attempt.is_aml_held());
        attempt.substatus = Some("AML_HOLD".to_owned());
        assert!(attempt.is_aml_held());
    }

    #[test]
    fn slot_outcome_names_match_the_ts_union() {
        assert_eq!(SlotOutcome::Committed.as_str(), "COMMITTED");
        assert_eq!(SlotOutcome::Suspense.as_str(), "SUSPENSE");
        assert_eq!(SlotOutcome::Held.as_str(), "HELD");
        assert_eq!(slot_reservation_id("link", "attempt"), "link:attempt");
    }

    #[test]
    fn environment_and_ownership_parse_the_prisma_names() {
        for (raw, env) in [
            ("LIVE", Environment::Live),
            ("SANDBOX", Environment::Sandbox),
        ] {
            assert_eq!(Environment::parse(raw), Some(env));
            assert_eq!(env.as_str(), raw);
        }
        assert_eq!(Environment::parse("live"), Some(Environment::Live));
        assert_eq!(
            OwnershipMode::parse("MERCHANT_DIRECT"),
            Some(OwnershipMode::MerchantDirect)
        );
        assert_eq!(OwnershipMode::Internal.as_str(), "INTERNAL");
        assert_eq!(
            FeeBearer::parse("PAYER_SURCHARGE"),
            Some(FeeBearer::PayerSurcharge)
        );
    }

    #[test]
    fn confirmation_scenario_matches_the_ledger_poster() {
        let posting =
            |ownership, fee_bearer, fee_accrual, fee: Option<Decimal>| ConfirmationPosting {
                attempt_id: "attempt-1".to_owned(),
                ownership_mode: ownership,
                fee_bearer,
                fee_accrual,
                amount: Decimal::from(100),
                surcharge_amount: Decimal::from(2),
                commission_amount: Decimal::from(2),
                merchant_amount: Decimal::from(98),
                gateway_fee_amount: fee,
                provider_fee_amount: fee,
                scenario: pg_domain_ledger::LedgerScenario::PlatformHeldConfirmation,
                merchant_id: None,
                gateway_id: None,
                credential_set_id: None,
                wallet_gl_account_id: None,
                currency: "LYD".to_owned(),
                env: Environment::Live,
            };
        let fee = Some(Decimal::new(8, 1));
        assert_eq!(
            confirmation_scenario(&posting(
                OwnershipMode::Internal,
                FeeBearer::MerchantAbsorbs,
                false,
                fee
            ))
            .expect("internal"),
            pg_domain_ledger::LedgerScenario::InternalConfirmation
        );
        assert_eq!(
            confirmation_scenario(&posting(
                OwnershipMode::MerchantDirect,
                FeeBearer::MerchantAbsorbs,
                false,
                fee
            ))
            .expect("direct"),
            pg_domain_ledger::LedgerScenario::MerchantDirectConfirmation
        );
        assert_eq!(
            confirmation_scenario(&posting(
                OwnershipMode::PlatformClearing,
                FeeBearer::PayerSurcharge,
                false,
                fee
            ))
            .expect("surcharge"),
            pg_domain_ledger::LedgerScenario::PayerSurchargeConfirmation
        );
        assert_eq!(
            confirmation_scenario(&posting(
                OwnershipMode::PlatformClearing,
                FeeBearer::Split,
                false,
                fee
            ))
            .expect("split"),
            pg_domain_ledger::LedgerScenario::SplitSurchargeConfirmation
        );
        assert_eq!(
            confirmation_scenario(&posting(
                OwnershipMode::PlatformClearing,
                FeeBearer::MerchantAbsorbs,
                true,
                fee
            ))
            .expect("accrual"),
            pg_domain_ledger::LedgerScenario::PlatformHeldFeeAccrual
        );
        assert_eq!(
            confirmation_scenario(&posting(
                OwnershipMode::PlatformClearing,
                FeeBearer::MerchantAbsorbs,
                false,
                fee
            ))
            .expect("held"),
            pg_domain_ledger::LedgerScenario::PlatformHeldConfirmation
        );
        assert_eq!(
            confirmation_scenario(&posting(
                OwnershipMode::PlatformClearing,
                FeeBearer::MerchantAbsorbs,
                false,
                None
            ))
            .expect_err("fee")
            .code,
            "MISSING_FEE_AMOUNT"
        );
    }
}
