//! In-memory ports for the flow-engine tests.
//!
//! Every fake is deterministic: the clock is frozen, the RNG counts, the egress is scripted and the
//! ledger records. No test touches a database, a network or the OS.

#![allow(dead_code)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use pg_domain_flow::{LinkSlotState, PaymentStatus, SlotDecision};
use rust_decimal::Decimal;
use serde_json::{Map, Value};

use pg_flow_engine::{
    Attempt, AttemptPatch, AttemptTransitionEvent, BuiltinComputeRegistry, CallbackInbox,
    CallbackVerification, CallbackVerifier, CancelOutcome, CasePriority, CaseSink, Clock,
    ConfirmationPosting, CredentialResolver, EgressBody, EgressError, EgressPort, EgressRequest,
    EgressResponse, EngineError, FixedClock, FlowPhase, FlowProvider, FlowStep, FlowStore,
    LedgerPort, OperatorCaseInput, PostedEntry, RailEngine, RailEngineOptions,
    ReconciliationScheduler, ReportingEvaluator, ScenarioPosting, SlotCommit, SlotReservation,
    SlotStore, StepCursor, StepExecutor, StepExecutorOptions, StepLogRecord, StoreError,
    TransitionSink, VaultPort,
};

pub const LINK_ID: &str = "link-1";
pub const MERCHANT_ID: &str = "0190a5c4-0000-7000-8000-000000000001";
pub const CREDENTIAL_SET_ID: &str = "0190a5c4-0000-7000-8000-000000000002";
pub const API_HOST: &str = "sandbox.provider.ly";

#[must_use]
pub fn dec(value: &str) -> Decimal {
    value.parse().expect("test decimal")
}

#[must_use]
pub fn default_attempt() -> Attempt {
    let mut attempt = Attempt::new("attempt-1", "ORD-1", dec("100.0000"), "LYD");
    attempt.env = pg_flow_engine::Environment::Live;
    attempt.link_id = Some(LINK_ID.to_owned());
    attempt.rail_id = Some("otp".to_owned());
    attempt.route_id = Some("route-1".to_owned());
    attempt.merchant_id = Some(MERCHANT_ID.to_owned());
    attempt.credential_set_id = Some(CREDENTIAL_SET_ID.to_owned());
    attempt.gateway_id = Some("gateway-1".to_owned());
    attempt.gateway_version_id = Some("version-1".to_owned());
    attempt.application_id = Some("application-1".to_owned());
    attempt.platform_commission_amount = Some(dec("2.5000"));
    attempt.net_merchant_amount = Some(dec("97.5000"));
    attempt.gateway_fee_amount = Some(dec("0.8000"));
    attempt.created_at = Some(Utc::now());
    attempt
}

// ---------------------------------------------------------------------------------------------
// Flow store
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct StoreState {
    attempts: HashMap<String, Attempt>,
    cursors: HashMap<(String, FlowPhase), StepCursor>,
    logs: Vec<StepLogRecord>,
    finalize_claims: HashSet<String>,
    confirm_hashes: HashMap<String, String>,
}

pub struct MemoryStore {
    inner: Mutex<StoreState>,
    clock: Arc<FixedClock>,
}

impl MemoryStore {
    pub fn new(clock: Arc<FixedClock>, attempt: Attempt) -> Self {
        let mut state = StoreState::default();
        state.attempts.insert(attempt.id.clone(), attempt);
        Self {
            inner: Mutex::new(state),
            clock,
        }
    }

    pub fn insert_attempt(&self, attempt: Attempt) {
        if let Ok(mut state) = self.inner.lock() {
            state.attempts.insert(attempt.id.clone(), attempt);
        }
    }

    pub fn logs(&self) -> Vec<StepLogRecord> {
        self.inner
            .lock()
            .map(|state| state.logs.clone())
            .unwrap_or_default()
    }

    pub fn cursor(&self, attempt_id: &str, phase: FlowPhase) -> Option<StepCursor> {
        self.inner
            .lock()
            .ok()
            .and_then(|state| state.cursors.get(&(attempt_id.to_owned(), phase)).cloned())
    }

    fn attempt(&self, attempt_id: &str) -> Result<Attempt, StoreError> {
        self.inner
            .lock()
            .map_err(|_| StoreError::Backend("store lock poisoned".to_owned()))?
            .attempts
            .get(attempt_id)
            .cloned()
            .ok_or_else(|| StoreError::NotFound(attempt_id.to_owned()))
    }
}

#[async_trait]
impl FlowStore for MemoryStore {
    async fn load_attempt(&self, attempt_id: &str) -> Result<Option<Attempt>, StoreError> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| StoreError::Backend("store lock poisoned".to_owned()))?
            .attempts
            .get(attempt_id)
            .cloned())
    }

    async fn update_attempt(
        &self,
        attempt_id: &str,
        patch: AttemptPatch,
    ) -> Result<Attempt, StoreError> {
        let now = self.clock.now();
        let mut state = self
            .inner
            .lock()
            .map_err(|_| StoreError::Backend("store lock poisoned".to_owned()))?;
        let attempt = state
            .attempts
            .get_mut(attempt_id)
            .ok_or_else(|| StoreError::NotFound(attempt_id.to_owned()))?;
        if let Some(expected) = patch.expected_status {
            if attempt.status != expected {
                return Err(StoreError::StateConflict {
                    expected: expected.as_str().to_owned(),
                    observed: attempt.status.as_str().to_owned(),
                });
            }
        }
        patch.apply(attempt, now);
        Ok(attempt.clone())
    }

    async fn claim_finalize(
        &self,
        attempt_id: &str,
        expected_status: PaymentStatus,
    ) -> Result<bool, StoreError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| StoreError::Backend("store lock poisoned".to_owned()))?;
        let attempt = state
            .attempts
            .get(attempt_id)
            .ok_or_else(|| StoreError::NotFound(attempt_id.to_owned()))?;
        if attempt.status != expected_status {
            return Ok(false);
        }
        Ok(state.finalize_claims.insert(attempt_id.to_owned()))
    }

    async fn claim_authorizing(
        &self,
        attempt_id: &str,
        idempotency_key_hash: Option<&str>,
    ) -> Result<bool, StoreError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| StoreError::Backend("store lock poisoned".to_owned()))?;
        if let Some(hash) = idempotency_key_hash {
            if state
                .confirm_hashes
                .get(attempt_id)
                .is_some_and(|stored| stored == hash)
            {
                return Ok(false);
            }
        }
        let attempt = state
            .attempts
            .get_mut(attempt_id)
            .ok_or_else(|| StoreError::NotFound(attempt_id.to_owned()))?;
        let claimable = matches!(
            attempt.status,
            PaymentStatus::Created
                | PaymentStatus::Initiating
                | PaymentStatus::AwaitingCustomer
                | PaymentStatus::Verifying
                | PaymentStatus::Unknown
        ) && !(matches!(
            attempt.status,
            PaymentStatus::Unknown | PaymentStatus::Verifying
        ) && attempt.point_of_no_return);
        if !claimable || attempt.terminal_at.is_some() {
            return Ok(false);
        }
        attempt.status = PaymentStatus::Authorizing;
        attempt.point_of_no_return = true;
        if let Some(hash) = idempotency_key_hash {
            state
                .confirm_hashes
                .insert(attempt_id.to_owned(), hash.to_owned());
        }
        Ok(true)
    }

    async fn load_cursor(
        &self,
        attempt_id: &str,
        phase: FlowPhase,
    ) -> Result<Option<StepCursor>, StoreError> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| StoreError::Backend("store lock poisoned".to_owned()))?
            .cursors
            .get(&(attempt_id.to_owned(), phase))
            .cloned())
    }

    async fn save_cursor(&self, cursor: &StepCursor) -> Result<(), StoreError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| StoreError::Backend("store lock poisoned".to_owned()))?;
        state
            .cursors
            .insert((cursor.attempt_id.clone(), cursor.phase), cursor.clone());
        Ok(())
    }

    async fn record_step(&self, record: StepLogRecord) -> Result<(), StoreError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| StoreError::Backend("store lock poisoned".to_owned()))?;
        state.logs.push(record);
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------------------------

pub struct MemorySlots {
    links: Mutex<HashMap<String, LinkSlotState>>,
    groups: Mutex<HashMap<(String, String), u32>>,
    releases: Mutex<Vec<String>>,
    commits: Mutex<u32>,
    reservations: Mutex<u32>,
}

impl Default for MemorySlots {
    fn default() -> Self {
        Self::new()
    }
}

impl MemorySlots {
    #[must_use]
    pub fn new() -> Self {
        Self {
            links: Mutex::new(HashMap::new()),
            groups: Mutex::new(HashMap::new()),
            releases: Mutex::new(Vec::new()),
            commits: Mutex::new(0),
            reservations: Mutex::new(0),
        }
    }

    pub fn with_link(&self, link_id: &str, state: LinkSlotState) {
        if let Ok(mut links) = self.links.lock() {
            links.insert(link_id.to_owned(), state);
        }
    }

    pub fn with_unlimited_link(&self) {
        self.with_link(LINK_ID, LinkSlotState::unlimited());
    }

    pub fn link(&self, link_id: &str) -> Option<LinkSlotState> {
        self.links
            .lock()
            .ok()
            .and_then(|links| links.get(link_id).copied())
    }

    pub fn releases(&self) -> Vec<String> {
        self.releases
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    pub fn commits(&self) -> u32 {
        self.commits.lock().map(|value| *value).unwrap_or(0)
    }

    pub fn reservations(&self) -> u32 {
        self.reservations.lock().map(|value| *value).unwrap_or(0)
    }
}

#[async_trait]
impl SlotStore for MemorySlots {
    async fn reserve(&self, attempt: &Attempt) -> Result<SlotReservation, StoreError> {
        let link_id = attempt.link_id.clone().ok_or_else(|| {
            StoreError::Backend("The attempt is not bound to a payment link".to_owned())
        })?;
        let mut links = self
            .links
            .lock()
            .map_err(|_| StoreError::Backend("slot lock poisoned".to_owned()))?;
        let link = links
            .get(&link_id)
            .copied()
            .ok_or_else(|| StoreError::NotFound(format!("link {link_id}")))?;
        match SlotDecision::reserve(&link, &link_id, &attempt.id) {
            SlotDecision::Reserved { reservation_id } => {
                let entry = links.entry(link_id.clone()).or_insert(link);
                entry.active_locked_count = entry.active_locked_count.saturating_add(1);
                if let Ok(mut reservations) = self.reservations.lock() {
                    *reservations += 1;
                }
                Ok(SlotReservation {
                    reservation_id,
                    link_id: Some(link_id),
                })
            }
            SlotDecision::Unavailable { .. } => Err(StoreError::Backend(
                "The payment link has no available slot".to_owned(),
            )),
            _ => Err(StoreError::Backend("unexpected slot decision".to_owned())),
        }
    }

    async fn release(&self, attempt: &Attempt, reason: &str) -> Result<(), StoreError> {
        if let Some(link_id) = attempt.link_id.as_deref() {
            if let Ok(mut links) = self.links.lock() {
                if let Some(link) = links.get_mut(link_id) {
                    link.active_locked_count = link.released_locked_count();
                }
            }
        }
        if let Ok(mut releases) = self.releases.lock() {
            releases.push(reason.to_owned());
        }
        Ok(())
    }

    async fn commit(&self, attempt: &Attempt) -> Result<SlotCommit, StoreError> {
        let Some(link_id) = attempt.link_id.clone() else {
            return Ok(SlotCommit::committed());
        };
        let mut links = self
            .links
            .lock()
            .map_err(|_| StoreError::Backend("slot lock poisoned".to_owned()))?;
        let Some(link) = links.get(&link_id).copied() else {
            return Ok(SlotCommit::suspense("SLOT_ALREADY_SETTLED"));
        };
        let fingerprint = attempt
            .customer_fingerprint
            .clone()
            .unwrap_or_else(|| "fingerprint".to_owned());
        let key = (link_id.clone(), fingerprint.clone());
        let success_count = self
            .groups
            .lock()
            .map_err(|_| StoreError::Backend("group lock poisoned".to_owned()))?
            .get(&key)
            .copied()
            .unwrap_or(0);
        let group = pg_domain_flow::AttemptGroupState {
            link_id: link_id.clone(),
            customer_fingerprint: fingerprint,
            success_count,
        };
        match SlotDecision::commit_group(&link, &group) {
            SlotDecision::Committed { state } => {
                let entry = links.entry(link_id.clone()).or_insert(link);
                entry.confirmed_count = entry.confirmed_count.saturating_add(1);
                entry.active_locked_count = entry.released_locked_count();
                entry.state = state;
                if let Ok(mut groups) = self.groups.lock() {
                    *groups.entry(key).or_insert(0) += 1;
                }
                if let Ok(mut commits) = self.commits.lock() {
                    *commits += 1;
                }
                Ok(SlotCommit::committed())
            }
            SlotDecision::Suspense => {
                let entry = links.entry(link_id.clone()).or_insert(link);
                entry.active_locked_count = entry.released_locked_count();
                Ok(SlotCommit {
                    outcome: pg_flow_engine::SlotOutcome::Suspense,
                    journal_entry_id: Some("entry-suspense".to_owned()),
                    adjustment_id: Some("adjustment-1".to_owned()),
                    operator_case_id: Some("case-1".to_owned()),
                    reason: Some("SLOT_ALREADY_SETTLED".to_owned()),
                })
            }
            SlotDecision::Unavailable { .. } => Err(StoreError::Backend(
                "this payer already settled this payment link; an attempt group allows one success"
                    .to_owned(),
            )),
            SlotDecision::Reserved { .. } => {
                Err(StoreError::Backend("unexpected commit decision".to_owned()))
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct EgressState {
    scripts: Vec<(String, VecDeque<Result<EgressResponse, EgressError>>)>,
    requests: Vec<EgressRequest>,
}

pub struct FakeEgress {
    inner: Mutex<EgressState>,
}

impl Default for FakeEgress {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeEgress {
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(EgressState::default()),
        }
    }

    fn queue(&self, pattern: &str) -> VecDeque<Result<EgressResponse, EgressError>> {
        let mut state = self.inner.lock().expect("egress lock");
        if let Some(position) = state
            .scripts
            .iter()
            .position(|(existing, _)| existing == pattern)
        {
            return std::mem::take(&mut state.scripts[position].1);
        }
        VecDeque::new()
    }

    fn put(&self, pattern: &str, queue: VecDeque<Result<EgressResponse, EgressError>>) {
        let mut state = self.inner.lock().expect("egress lock");
        if let Some(position) = state
            .scripts
            .iter()
            .position(|(existing, _)| existing == pattern)
        {
            state.scripts[position].1 = queue;
        } else {
            state.scripts.push((pattern.to_owned(), queue));
        }
    }

    pub fn enqueue_json(&self, pattern: &str, status: u16, body: Value) {
        let response = json_response(pattern, status, body);
        let mut queue = self.queue(pattern);
        queue.push_back(Ok(response));
        self.put(pattern, queue);
    }

    pub fn enqueue_status(&self, pattern: &str, status: u16) {
        let response = EgressResponse {
            status,
            headers: Default::default(),
            raw_text: String::new(),
            data: Value::Null,
            url: format!("https://{API_HOST}{pattern}"),
        };
        let mut queue = self.queue(pattern);
        queue.push_back(Ok(response));
        self.put(pattern, queue);
    }

    pub fn enqueue_error(&self, pattern: &str, error: EgressError) {
        let mut queue = self.queue(pattern);
        queue.push_back(Err(error));
        self.put(pattern, queue);
    }

    pub fn enqueue_raw(&self, pattern: &str, status: u16, content_type: &str, text: String) {
        let response = EgressResponse {
            status,
            headers: [("content-type".to_owned(), content_type.to_owned())]
                .into_iter()
                .collect(),
            raw_text: text,
            data: Value::Null,
            url: format!("https://{API_HOST}{pattern}"),
        };
        let mut queue = self.queue(pattern);
        queue.push_back(Ok(response));
        self.put(pattern, queue);
    }

    pub fn requests(&self) -> Vec<EgressRequest> {
        self.inner
            .lock()
            .map(|state| state.requests.clone())
            .unwrap_or_default()
    }

    pub fn count(&self) -> usize {
        self.inner
            .lock()
            .map(|state| state.requests.len())
            .unwrap_or(0)
    }
}

fn json_response(pattern: &str, status: u16, body: Value) -> EgressResponse {
    EgressResponse {
        status,
        headers: [("content-type".to_owned(), "application/json".to_owned())]
            .into_iter()
            .collect(),
        raw_text: serde_json::to_string(&body).unwrap_or_default(),
        data: body,
        url: if pattern.starts_with("http") {
            pattern.to_owned()
        } else {
            format!("https://{API_HOST}{pattern}")
        },
    }
}

#[async_trait]
impl EgressPort for FakeEgress {
    async fn send(&self, request: EgressRequest) -> Result<EgressResponse, EgressError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| EgressError::blocked("egress lock poisoned"))?;
        state.requests.push(request.clone());
        let position = state
            .scripts
            .iter()
            .position(|(pattern, queue)| !queue.is_empty() && request.url.contains(pattern));
        match position {
            Some(index) => state.scripts[index].1.pop_front().expect("non-empty queue"),
            None => Err(EgressError::blocked(format!(
                "unscripted request {} {}",
                request.method.as_str(),
                request.url
            ))),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
pub struct FakeVault {
    seals: Mutex<u32>,
    opens: Mutex<u32>,
    failure: Mutex<Option<String>>,
}

impl FakeVault {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn seal_calls(&self) -> u32 {
        self.seals.lock().map(|value| *value).unwrap_or(0)
    }

    pub fn open_calls(&self) -> u32 {
        self.opens.lock().map(|value| *value).unwrap_or(0)
    }

    pub fn fail_with(&self, message: &str) {
        if let Ok(mut failure) = self.failure.lock() {
            *failure = Some(message.to_owned());
        }
    }
}

impl VaultPort for FakeVault {
    fn seal(&self, plaintext: &str, key_id: &str) -> Result<String, String> {
        if let Ok(mut seals) = self.seals.lock() {
            *seals += 1;
        }
        if let Some(message) = self.failure.lock().ok().and_then(|value| value.clone()) {
            return Err(message);
        }
        Ok(format!("{key_id}:{}", hex::encode(plaintext.as_bytes())))
    }

    fn open(&self, sealed: &str, key_id: &str) -> Result<String, String> {
        if let Ok(mut opens) = self.opens.lock() {
            *opens += 1;
        }
        let payload = sealed
            .strip_prefix(&format!("{key_id}:"))
            .ok_or_else(|| "vault payload has the wrong key id".to_owned())?;
        let bytes = hex::decode(payload).map_err(|error| error.to_string())?;
        String::from_utf8(bytes).map_err(|error| error.to_string())
    }
}

// ---------------------------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
pub struct RecordingLedger {
    confirmations: Mutex<Vec<ConfirmationPosting>>,
    scenarios: Mutex<Vec<ScenarioPosting>>,
    failure: Mutex<Option<EngineError>>,
    count: Mutex<u32>,
}

impl RecordingLedger {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn confirmations(&self) -> Vec<ConfirmationPosting> {
        self.confirmations
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    pub fn scenarios(&self) -> Vec<ScenarioPosting> {
        self.scenarios
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    pub fn fail_next(&self, error: EngineError) {
        if let Ok(mut failure) = self.failure.lock() {
            *failure = Some(error);
        }
    }

    fn next_entry(&self) -> String {
        let mut count = self.count.lock().expect("ledger lock");
        *count += 1;
        format!("entry-{count}")
    }
}

#[async_trait]
impl LedgerPort for RecordingLedger {
    async fn post_confirmation(
        &self,
        posting: ConfirmationPosting,
    ) -> Result<PostedEntry, EngineError> {
        if let Some(error) = self.failure.lock().ok().and_then(|mut value| value.take()) {
            return Err(error);
        }
        if let Ok(mut confirmations) = self.confirmations.lock() {
            confirmations.push(posting);
        }
        Ok(PostedEntry {
            entry_id: self.next_entry(),
            idempotent: false,
        })
    }

    async fn post_scenario(&self, posting: ScenarioPosting) -> Result<PostedEntry, EngineError> {
        if let Some(error) = self.failure.lock().ok().and_then(|mut value| value.take()) {
            return Err(error);
        }
        if let Ok(mut scenarios) = self.scenarios.lock() {
            scenarios.push(posting);
        }
        Ok(PostedEntry {
            entry_id: self.next_entry(),
            idempotent: false,
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
pub struct RecordingCases {
    cases: Mutex<Vec<OperatorCaseInput>>,
}

impl RecordingCases {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cases(&self) -> Vec<OperatorCaseInput> {
        self.cases
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }
}

impl CaseSink for RecordingCases {
    fn open(&self, input: OperatorCaseInput) {
        if let Ok(mut cases) = self.cases.lock() {
            cases.push(input);
        }
    }
}

#[derive(Default)]
pub struct RecordingReconciliation {
    calls: Mutex<Vec<(String, Option<String>)>>,
}

impl RecordingReconciliation {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn calls(&self) -> Vec<(String, Option<String>)> {
        self.calls
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }
}

impl ReconciliationScheduler for RecordingReconciliation {
    fn schedule(&self, attempt_id: &str, adjustment_id: Option<&str>) {
        if let Ok(mut calls) = self.calls.lock() {
            calls.push((attempt_id.to_owned(), adjustment_id.map(str::to_owned)));
        }
    }
}

#[derive(Default)]
pub struct RecordingTransitions {
    events: Mutex<Vec<AttemptTransitionEvent>>,
}

impl RecordingTransitions {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn events(&self) -> Vec<AttemptTransitionEvent> {
        self.events
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }
}

impl TransitionSink for RecordingTransitions {
    fn publish(&self, event: AttemptTransitionEvent) {
        if let Ok(mut events) = self.events.lock() {
            events.push(event);
        }
    }
}

#[derive(Default)]
pub struct RecordingReporting;

impl ReportingEvaluator for RecordingReporting {
    fn evaluate(&self, _: &str, _: Option<&str>, _: Decimal, _: &str) {}
}

// ---------------------------------------------------------------------------------------------
// Credentials / callback fakes
// ---------------------------------------------------------------------------------------------

pub struct FixedCredentials {
    values: Map<String, Value>,
}

impl FixedCredentials {
    #[must_use]
    pub fn new(values: Map<String, Value>) -> Self {
        Self { values }
    }

    #[must_use]
    pub fn moamalat() -> Self {
        let mut values = Map::new();
        values.insert("MID".to_owned(), Value::String("MID-1".to_owned()));
        values.insert("TID".to_owned(), Value::String("TID-1".to_owned()));
        values.insert(
            "MerchantSecretKey".to_owned(),
            Value::String("00ff10".to_owned()),
        );
        Self::new(values)
    }
}

impl CredentialResolver for FixedCredentials {
    fn credentials(&self, _: &Attempt) -> Map<String, Value> {
        self.values.clone()
    }
}

pub struct ScriptedCallbackVerifier {
    result: Mutex<CallbackVerification>,
}

impl ScriptedCallbackVerifier {
    #[must_use]
    pub fn new(result: CallbackVerification) -> Self {
        Self {
            result: Mutex::new(result),
        }
    }
}

#[async_trait]
impl CallbackVerifier for ScriptedCallbackVerifier {
    async fn verify(
        &self,
        _channel: &str,
        _raw_request: &Value,
    ) -> Result<CallbackVerification, EngineError> {
        Ok(self
            .result
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| CallbackVerification::rejected("lock poisoned")))
    }
}

#[derive(Default)]
pub struct AcceptOnceInbox {
    seen: Mutex<HashSet<String>>,
}

impl AcceptOnceInbox {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl CallbackInbox for AcceptOnceInbox {
    fn accept(&self, _channel: &str, dedupe_key: &str, _attempt_id: &str) -> bool {
        self.seen
            .lock()
            .map(|mut seen| seen.insert(dedupe_key.to_owned()))
            .unwrap_or(false)
    }
}

// ---------------------------------------------------------------------------------------------
// Static flow provider and harness
// ---------------------------------------------------------------------------------------------

#[derive(Default, Clone)]
pub struct StaticFlow {
    steps: HashMap<FlowPhase, Vec<FlowStep>>,
}

impl StaticFlow {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn phase(mut self, phase: FlowPhase, steps: Vec<FlowStep>) -> Self {
        self.steps.insert(phase, steps);
        self
    }

    #[must_use]
    pub fn get(&self, phase: FlowPhase) -> Vec<FlowStep> {
        self.steps.get(&phase).cloned().unwrap_or_default()
    }

    #[must_use]
    pub fn merge(mut self, other: StaticFlow) -> Self {
        for (phase, steps) in other.steps {
            self.steps.insert(phase, steps);
        }
        self
    }
}

#[async_trait]
impl FlowProvider for StaticFlow {
    async fn get_steps(
        &self,
        phase: FlowPhase,
        _attempt: &Attempt,
    ) -> Result<Vec<FlowStep>, EngineError> {
        Ok(self.get(phase))
    }
}

pub struct Harness {
    pub store: Arc<MemoryStore>,
    pub slots: Arc<MemorySlots>,
    pub egress: Arc<FakeEgress>,
    pub ledger: Arc<RecordingLedger>,
    pub vault: Arc<FakeVault>,
    pub clock: Arc<FixedClock>,
    pub cases: Arc<RecordingCases>,
    pub reconciliation: Arc<RecordingReconciliation>,
    pub transitions: Arc<RecordingTransitions>,
    pub engine: RailEngine,
    pub flow: StaticFlow,
}

pub struct HarnessBuilder {
    attempt: Attempt,
    flow: StaticFlow,
    provider: Option<Arc<dyn FlowProvider>>,
    link: LinkSlotState,
    credentials: Option<Map<String, Value>>,
    with_compute: bool,
    callback_verifier: Option<Arc<dyn CallbackVerifier>>,
    callback_inbox: Option<Arc<dyn CallbackInbox>>,
    fake_rails_hosts: Vec<String>,
}

impl HarnessBuilder {
    #[must_use]
    pub fn new(attempt: Attempt) -> Self {
        Self {
            attempt,
            flow: StaticFlow::new(),
            provider: None,
            link: LinkSlotState::unlimited(),
            credentials: None,
            with_compute: false,
            callback_verifier: None,
            callback_inbox: None,
            fake_rails_hosts: Vec::new(),
        }
    }

    #[must_use]
    pub fn default_attempt() -> Self {
        Self::new(default_attempt())
    }

    #[must_use]
    pub fn flow(mut self, phase: FlowPhase, steps: Vec<FlowStep>) -> Self {
        self.flow = self.flow.phase(phase, steps);
        self
    }

    #[must_use]
    pub fn static_flow(mut self, flow: StaticFlow) -> Self {
        self.flow = self.flow.merge(flow);
        self
    }

    #[must_use]
    pub fn provider(mut self, provider: Arc<dyn FlowProvider>) -> Self {
        self.provider = Some(provider);
        self
    }

    #[must_use]
    pub fn link(mut self, link: LinkSlotState) -> Self {
        self.link = link;
        self
    }

    #[must_use]
    pub fn credentials(mut self, credentials: Map<String, Value>) -> Self {
        self.credentials = Some(credentials);
        self
    }

    #[must_use]
    pub fn compute(mut self) -> Self {
        self.with_compute = true;
        self
    }

    #[must_use]
    pub fn callback_verifier(mut self, verifier: Arc<dyn CallbackVerifier>) -> Self {
        self.callback_verifier = Some(verifier);
        self
    }

    #[must_use]
    pub fn callback_inbox(mut self, inbox: Arc<dyn CallbackInbox>) -> Self {
        self.callback_inbox = Some(inbox);
        self
    }

    #[must_use]
    pub fn fake_rails_hosts(mut self, hosts: Vec<String>) -> Self {
        self.fake_rails_hosts = hosts;
        self
    }

    #[must_use]
    pub fn build(self) -> Harness {
        let clock = Arc::new(FixedClock::at(1_700_000_000_000));
        let store = Arc::new(MemoryStore::new(clock.clone(), self.attempt));
        let slots = Arc::new(MemorySlots::new());
        slots.with_link(LINK_ID, self.link);
        let egress = Arc::new(FakeEgress::new());
        let ledger = Arc::new(RecordingLedger::new());
        let vault = Arc::new(FakeVault::new());
        let cases = Arc::new(RecordingCases::new());
        let reconciliation = Arc::new(RecordingReconciliation::new());
        let transitions = Arc::new(RecordingTransitions::new());

        let executor = {
            let base = StepExecutor::new(
                egress.clone(),
                clock.clone(),
                Arc::new(pg_flow_engine::CounterRng::new(1)),
            );
            let base = if self.with_compute {
                base.with_compute(Arc::new(BuiltinComputeRegistry::new(
                    clock.clone(),
                    Arc::new(pg_flow_engine::CounterRng::new(1)),
                )))
            } else {
                base
            };
            let options = StepExecutorOptions {
                allowed_hosts: Some(vec![API_HOST.to_owned()]),
                allow_any_host: false,
                allow_insecure_http: false,
                fake_rails_hosts: self.fake_rails_hosts,
                ..StepExecutorOptions::default()
            };
            Arc::new(base.with_options(options))
        };

        let mut options = RailEngineOptions {
            store: store.clone(),
            slots: slots.clone(),
            flow: self
                .provider
                .clone()
                .unwrap_or_else(|| Arc::new(self.flow.clone()) as Arc<dyn FlowProvider>),
            executor,
            clock: clock.clone(),
            vault: Some(vault.clone()),
            ledger: Some(ledger.clone()),
            credentials: self.credentials.map(|values| {
                Arc::new(FixedCredentials::new(values)) as Arc<dyn CredentialResolver>
            }),
            transition_sink: Some(transitions.clone()),
            callback_verifier: self.callback_verifier,
            callback_inbox: self.callback_inbox,
            reconciliation: Some(reconciliation.clone()),
            cases: Some(cases.clone()),
            reporting: Some(Arc::new(RecordingReporting)),
            pan_field_names: Vec::new(),
        };
        if options.credentials.is_none() {
            options.credentials = Some(Arc::new(FixedCredentials::moamalat()));
        }
        let engine = RailEngine::new(options);
        Harness {
            store,
            slots,
            egress,
            ledger,
            vault,
            clock,
            cases,
            reconciliation,
            transitions,
            engine,
            flow: self.flow,
        }
    }
}

pub fn form(fields: &[(&str, Value)]) -> Map<String, Value> {
    fields
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

pub fn otp(value: &str) -> Map<String, Value> {
    form(&[("otp", Value::String(value.to_owned()))])
}

pub fn timestamp(millis: i64) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp_millis(millis).expect("timestamp")
}

/// A helper that builds the seeded OTP rail (Edfali/Sadad shape).
#[must_use]
pub fn otp_flow() -> StaticFlow {
    use pg_flow_engine::{
        ClientAction, HttpMethod, OutputStore, ParameterPlace, ParameterSource, RetryPolicy,
        SideEffect, StatusRule, StepOutput, StepParameter, TransformPipe,
    };
    let send_otp = FlowStep::json(
        "send-otp",
        HttpMethod::Post,
        format!("https://{API_HOST}/verify"),
    )
    .side_effect(SideEffect::SendsNotification)
    .retry_policy(RetryPolicy::SafeWithCooldown)
    .parameters(vec![
        StepParameter::new(
            ParameterPlace::Body,
            "mobile_number",
            ParameterSource::CustomerField,
            Some("customer_mobile"),
        )
        .with_transforms(vec![TransformPipe::phone_normalize("LOCAL_09")]),
        StepParameter::new(
            ParameterPlace::Body,
            "amount",
            ParameterSource::Attempt,
            Some("totalChargedAmount"),
        )
        .with_transforms(vec![TransformPipe::format_decimal(2)]),
        StepParameter::new(
            ParameterPlace::Body,
            "invoice_no",
            ParameterSource::Attempt,
            Some("reference"),
        ),
    ])
    .outputs(vec![
        StepOutput::state("process_id", "result.process_id", true),
        StepOutput::state("otp_reference", "result.otp_reference", false),
    ]);
    let show_otp = FlowStep::render("show-otp", ClientAction::ShowOtpForm)
        .outputs(vec![StepOutput::public("actionType", "actionType", true)]);
    let confirm = FlowStep::json(
        "confirm-otp",
        HttpMethod::Post,
        format!("https://{API_HOST}/confirm"),
    )
    .side_effect(SideEffect::MovesMoney)
    .retry_policy(RetryPolicy::Never)
    .point_of_no_return(true)
    .parameters(vec![
        StepParameter::new(
            ParameterPlace::Body,
            "process_id",
            ParameterSource::State,
            Some("process_id"),
        ),
        StepParameter::new(
            ParameterPlace::Body,
            "code",
            ParameterSource::CustomerField,
            Some("otp"),
        ),
        StepParameter::new(
            ParameterPlace::Body,
            "amount",
            ParameterSource::Attempt,
            Some("totalChargedAmount"),
        )
        .with_transforms(vec![TransformPipe::format_decimal(2)]),
    ])
    .outputs(vec![
        StepOutput::new(
            "transaction_id",
            Some("transaction_id"),
            OutputStore::ProviderRef,
            true,
        ),
        StepOutput::new(
            "settled_amount",
            Some("amount"),
            OutputStore::SettledAmount,
            false,
        ),
    ])
    .status_rules(vec![
        StatusRule::equals(
            "status",
            "SUCCESS",
            pg_flow_engine::CanonicalStepStatus::Succeeded,
        ),
        StatusRule::equals(
            "status",
            "INVALID_OTP",
            pg_flow_engine::CanonicalStepStatus::AwaitingCustomer,
        )
        .with_error("RETRYABLE_OTP"),
        StatusRule::equals(
            "status",
            "DECLINED",
            pg_flow_engine::CanonicalStepStatus::Failed,
        )
        .with_error("TERMINAL_DECLINE"),
    ]);
    let inquiry = FlowStep::json(
        "inquiry",
        HttpMethod::Post,
        format!("https://{API_HOST}/inquiry"),
    )
    .parameters(vec![StepParameter::new(
        ParameterPlace::Body,
        "invoice_no",
        ParameterSource::Attempt,
        Some("reference"),
    )])
    .outputs(vec![
        StepOutput::state("status", "status", true),
        StepOutput::new(
            "transaction_id",
            Some("transaction_id"),
            OutputStore::ProviderRef,
            false,
        ),
        StepOutput::new(
            "settled_amount",
            Some("amount"),
            OutputStore::SettledAmount,
            false,
        ),
    ])
    .status_rules(vec![StatusRule::equals(
        "status",
        "SUCCESS",
        pg_flow_engine::CanonicalStepStatus::Succeeded,
    )]);
    StaticFlow::new()
        .phase(FlowPhase::Initiate, vec![send_otp, show_otp])
        .phase(FlowPhase::Submit, vec![confirm])
        .phase(FlowPhase::Verify, vec![inquiry])
}

/// Scripts the happy OTP responses.
pub fn script_otp_success(egress: &FakeEgress) {
    egress.enqueue_json(
        "/verify",
        200,
        serde_json::json!({"result": {"status": "OTP_SENT", "process_id": "P-1"}}),
    );
    egress.enqueue_json(
        "/confirm",
        200,
        serde_json::json!({
            "status": "SUCCESS",
            "transaction_id": "TX-1",
            "amount": "100.0000",
            "currency": "LYD",
            "environment": "LIVE",
            "reference": "ORD-1"
        }),
    );
    egress.enqueue_json(
        "/inquiry",
        200,
        serde_json::json!({
            "status": "SUCCESS",
            "transaction_id": "TX-1",
            "amount": "100.0000",
            "currency": "LYD",
            "environment": "LIVE",
            "reference": "ORD-1"
        }),
    );
}

#[must_use]
pub fn ledger_postings(ledger: &RecordingLedger) -> usize {
    ledger.confirmations().len() + ledger.scenarios().len()
}

#[must_use]
pub fn last_attempt(harness: &Harness) -> Attempt {
    harness.store.inner_attempt().expect("attempt")
}

impl MemoryStore {
    pub fn inner_attempt(&self) -> Option<Attempt> {
        self.inner
            .lock()
            .ok()
            .and_then(|state| state.attempts.values().next().cloned())
    }
}

/// Keeps `EgressBody` in scope for tests that assert on the recorded body.
#[must_use]
pub fn body_text(request: &EgressRequest) -> Option<String> {
    match &request.body {
        Some(EgressBody::Text(text)) => Some(text.clone()),
        Some(EgressBody::Json(value)) => serde_json::to_string(value).ok(),
        Some(EgressBody::Form(fields)) => Some(
            fields
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join("&"),
        ),
        Some(EgressBody::Multipart(fields)) => Some(
            fields
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join("&"),
        ),
        Some(EgressBody::Bytes(bytes)) => String::from_utf8(bytes.clone()).ok(),
        None => None,
    }
}

/// A case-priority helper for the assertions.
#[must_use]
pub fn is_p1(priority: CasePriority) -> bool {
    priority == CasePriority::P1
}

/// `CancelOutcome` is re-exported for tests that inspect the default trait method.
pub type DefaultCancelOutcome = CancelOutcome;
