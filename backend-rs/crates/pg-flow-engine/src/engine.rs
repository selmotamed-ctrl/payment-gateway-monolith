//! The rail engine loop: initiate, advance, confirm, inquire, callback, cancel, refund, finalize.
//!
//! Port of `core-back/engine/flow/DynamicRailEngine.ts` (1,534 lines) over the ports of
//! [`crate::ports`]. The state machine, the transition table and `finalizeGuardFor` come from
//! [`pg_domain_flow`]; the ledger scenarios come from [`pg_domain_ledger`] (the DB poster is a
//! separate crate and implements [`LedgerPort`]).
//!
//! Preserved behaviours:
//!
//! - every status write is a compare-and-set against the status the flow observed; a lost race is
//!   `409 ATTEMPT_STATE_CONFLICT` and the public entry points return the persisted state;
//! - `finalizeGuardFor`: settled attempts are idempotent, `CANCELLED`/`BLOCKED` are refused, and
//!   `FAILED`/`EXPIRED` stay recoverable (a late success opens a P2 case);
//! - a confirmed success is verified from the gateway answer only (status, reference, amount within
//!   tolerance, currency, environment); payer input is limited to `otp`;
//! - slots: reserve before `INITIATING`, release on a terminal non-success, commit on success, and
//!   route an excess settlement to `SUSPENSE` (never a clean merchant credit);
//! - an AML-held capture is escrowed, not settled: the case release is the only settlement;
//! - `confirm` with the atomic claim lets exactly one caller run `SUBMIT`, even on a double click;
//! - `UNKNOWN`/`VERIFYING` past the point of no return can never be resubmitted.
//!
//! Recorded deviations (see `README.md`):
//!
//! - there is no transaction object. The adapter must run the slot commit, the ledger posting and
//!   the status write in one transaction (chapter 2 §17); the claim keeps double-finalize out;
//! - per-step persistence: the cursor, the sealed context and the public outputs are written after
//!   every step (the TS writes them after the phase) so a crash resumes at the next step. The
//!   returned result is identical;
//! - form normalisation/validation (`FormNormalizer`/`FormValidator`) stays with the guard pipeline;
//!   this engine merges the supplied form fields into the customer fields;
//! - the step cursor's `previous_response` must be encrypted at rest by the adapter.

#![forbid(unsafe_code)]

use std::sync::Arc;

use chrono::Duration;
use pg_domain_flow::{
    canary_selected, finalize_guard, is_allowed, resolve_visible_routes, FinalizeGuard,
    PaymentStatus, RailCandidate, VisibleRailsPolicy, VisibleRoute, VisibleRoutes,
};
use rust_decimal::Decimal;
use serde_json::{Map, Value};

use crate::error::{codes, EngineError};
use crate::ports::{
    Attempt, AttemptPatch, AttemptTransitionEvent, CallbackInbox, CallbackVerifier, CasePriority,
    CaseSink, Clock, ConfirmationPosting, CredentialResolver, FlowProvider, FlowStore, LedgerPort,
    OperatorCaseInput, OwnershipMode, PostedEntry, ReconciliationScheduler, ReportingEvaluator,
    ScenarioPosting, SlotCommit, SlotOutcome, SlotStore, TransitionSink, VaultPort,
};
use crate::schema::{CanonicalStepStatus, ClientAction, FlowPhase, FlowStep};
use crate::selector::stringify_value;
use crate::step::{
    BranchOutcome, StepContext, StepExecutionResult, StepExecutor, StepLog, StepOutputs,
};

/// The substatus of an AML-held capture (`AML_HOLD_SUBSTATUS`).
pub const AML_HOLD_SUBSTATUS: &str = "AML_HOLD";
/// The substatus of an attempt voided by its AML case (`AML_VOID_SUBSTATUS`).
pub const AML_VOID_SUBSTATUS: &str = "AML_VOID";
/// The substatus of an excess settlement routed to SUSPENSE (`SUSPENSE_SETTLEMENT`).
pub const SUSPENSE_SETTLEMENT_SUBSTATUS: &str = "SUSPENSE_SETTLEMENT";
/// The context flag written after a trusted success (`trustedSuccessObserved`).
pub const TRUSTED_SUCCESS_OBSERVED: &str = "trustedSuccessObserved";
/// The context key of a named base URL map.
pub const CONTEXT_URLS: &str = "urls";
/// The context key of the stored customer fields (`AttemptGuardPipeline`).
pub const CONTEXT_FIELDS: &str = "fields";

/// The confirm idempotency allowlist (`CONFIRM_CUSTOMER_INPUT_ALLOWLIST`).
pub const CONFIRM_CUSTOMER_INPUT_ALLOWLIST: [&str; 1] = ["otp"];

/// How the money of a successful settlement was routed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settlement {
    Normal,
    Suspense,
}

/// `DynamicRailResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct RailResult {
    pub attempt: Attempt,
    pub status: PaymentStatus,
    pub substatus: Option<String>,
    pub canonical_error: Option<String>,
    pub client_action: Option<Value>,
    pub settlement: Option<Settlement>,
    pub outputs: Map<String, Value>,
}

impl RailResult {
    /// The persisted state a lost race or a duplicate signal returns.
    #[must_use]
    pub fn persisted(attempt: Attempt) -> Self {
        let status = attempt.status;
        let substatus = attempt.substatus.clone();
        let outputs = attempt.public_outputs.clone();
        Self {
            attempt,
            status,
            substatus,
            canonical_error: None,
            client_action: None,
            settlement: None,
            outputs,
        }
    }
}

/// The outcome of one `advance_step` call.
#[derive(Debug, Clone, PartialEq)]
pub struct StepAdvance {
    pub attempt_id: String,
    pub phase: FlowPhase,
    /// The step that ran, or `None` when the phase was already complete.
    pub step_id: Option<String>,
    pub step_index: Option<usize>,
    pub canonical_status: Option<CanonicalStepStatus>,
    pub substatus: Option<String>,
    pub canonical_error: Option<String>,
    pub output: StepOutputs,
    pub response: Option<Value>,
    pub client_action: Option<Value>,
    pub branch: Option<BranchOutcome>,
    pub logs: Vec<StepLog>,
    /// The provisional/final phase status when the phase is finished.
    pub phase_status: PaymentStatus,
    /// True when no further step will run in this phase.
    pub finished: bool,
}

/// `ConfirmOptions`.
#[derive(Debug, Clone, Default)]
pub struct ConfirmOptions {
    /// Performs the atomic AUTHORIZING claim before `SUBMIT`. The checkout API always sets it.
    pub claim: bool,
    /// The sha256 of the caller's idempotency key; the store compares it with the stored hash.
    pub idempotency_key_hash: Option<String>,
}

impl ConfirmOptions {
    #[must_use]
    pub fn claimed(idempotency_key_hash: Option<String>) -> Self {
        Self {
            claim: true,
            idempotency_key_hash,
        }
    }
}

/// `initiate` options.
#[derive(Debug, Clone, Default)]
pub struct InitiateOptions {
    /// The attempt-creation guard already reserved the slot (design §9.1 rule 2).
    pub slot_reserved: bool,
    /// The resolved visible routes of this rail; when present the attempt's route must be in it.
    pub visible_routes: Option<VisibleRoutes>,
}

/// The result of an atomic cancel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelResult {
    pub attempt_id: String,
    pub status: PaymentStatus,
    pub released: bool,
}

/// `TrustedSuccessFacts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustedSuccessFacts {
    pub status: bool,
    pub reference: bool,
    pub amount: bool,
    pub currency: bool,
    pub environment: bool,
}

/// `TrustedSuccessResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustedSuccessResult {
    pub trusted: bool,
    pub facts: TrustedSuccessFacts,
}

/// The engine ports.
pub struct RailEngineOptions {
    pub store: Arc<dyn FlowStore>,
    pub slots: Arc<dyn SlotStore>,
    pub flow: Arc<dyn FlowProvider>,
    pub executor: Arc<StepExecutor>,
    pub clock: Arc<dyn Clock>,
    pub vault: Option<Arc<dyn VaultPort>>,
    pub ledger: Option<Arc<dyn LedgerPort>>,
    pub credentials: Option<Arc<dyn CredentialResolver>>,
    pub transition_sink: Option<Arc<dyn TransitionSink>>,
    pub callback_verifier: Option<Arc<dyn CallbackVerifier>>,
    pub callback_inbox: Option<Arc<dyn CallbackInbox>>,
    pub reconciliation: Option<Arc<dyn ReconciliationScheduler>>,
    pub cases: Option<Arc<dyn CaseSink>>,
    pub reporting: Option<Arc<dyn ReportingEvaluator>>,
    pub pan_field_names: Vec<String>,
}

/// The rail engine.
pub struct RailEngine {
    store: Arc<dyn FlowStore>,
    slots: Arc<dyn SlotStore>,
    flow: Arc<dyn FlowProvider>,
    executor: Arc<StepExecutor>,
    clock: Arc<dyn Clock>,
    vault: Option<Arc<dyn VaultPort>>,
    ledger: Option<Arc<dyn LedgerPort>>,
    credentials: Option<Arc<dyn CredentialResolver>>,
    transition_sink: Option<Arc<dyn TransitionSink>>,
    callback_verifier: Option<Arc<dyn CallbackVerifier>>,
    callback_inbox: Option<Arc<dyn CallbackInbox>>,
    reconciliation: Option<Arc<dyn ReconciliationScheduler>>,
    cases: Option<Arc<dyn CaseSink>>,
    reporting: Option<Arc<dyn ReportingEvaluator>>,
    pan_field_names: Vec<String>,
}

impl RailEngine {
    #[must_use]
    pub fn new(options: RailEngineOptions) -> Self {
        Self {
            store: options.store,
            slots: options.slots,
            flow: options.flow,
            executor: options.executor,
            clock: options.clock,
            vault: options.vault,
            ledger: options.ledger,
            credentials: options.credentials,
            transition_sink: options.transition_sink,
            callback_verifier: options.callback_verifier,
            callback_inbox: options.callback_inbox,
            reconciliation: options.reconciliation,
            cases: options.cases,
            reporting: options.reporting,
            pan_field_names: options.pan_field_names,
        }
    }

    // -----------------------------------------------------------------------------------------
    // Rail selection
    // -----------------------------------------------------------------------------------------

    /// Selects the first visible route of a rail (`resolve_visible_routes`).
    pub fn select_visible_route(
        candidates: &[RailCandidate],
        policy: VisibleRailsPolicy,
    ) -> Result<VisibleRoute, EngineError> {
        let visible = resolve_visible_routes(candidates, policy);
        visible.routes.first().cloned().ok_or_else(|| {
            EngineError::new(
                409,
                codes::NO_VISIBLE_ROUTE,
                "No payment route is visible for this payment",
            )
        })
    }

    /// Resolves the visible set, keeping the exclusions for the caller's diagnostics.
    #[must_use]
    pub fn visible_routes(
        candidates: &[RailCandidate],
        policy: VisibleRailsPolicy,
    ) -> VisibleRoutes {
        resolve_visible_routes(candidates, policy)
    }

    /// Resolves the visible routes and initiates on the first one.
    pub async fn initiate_with_candidates(
        &self,
        attempt_id: &str,
        candidates: &[RailCandidate],
        policy: VisibleRailsPolicy,
        form_data: &Map<String, Value>,
        options: InitiateOptions,
    ) -> Result<RailResult, EngineError> {
        let route = Self::select_visible_route(candidates, policy)?;
        let attempt = self.get_attempt(attempt_id).await?;
        if attempt.route_id.as_deref() != Some(route.route_id.as_str()) {
            self.store
                .update_attempt(
                    attempt_id,
                    AttemptPatch {
                        route_id: Some(route.route_id),
                        ..AttemptPatch::default()
                    },
                )
                .await?;
        }
        self.initiate(attempt_id, form_data, options).await
    }

    // -----------------------------------------------------------------------------------------
    // initiate
    // -----------------------------------------------------------------------------------------

    pub async fn initiate(
        &self,
        attempt_id: &str,
        form_data: &Map<String, Value>,
        options: InitiateOptions,
    ) -> Result<RailResult, EngineError> {
        let result = self.run_initiate(attempt_id, form_data, options).await;
        self.on_state_conflict(attempt_id, result).await
    }

    async fn run_initiate(
        &self,
        attempt_id: &str,
        form_data: &Map<String, Value>,
        options: InitiateOptions,
    ) -> Result<RailResult, EngineError> {
        let mut attempt = self.get_attempt(attempt_id).await?;
        if let Some(visible) = &options.visible_routes {
            if !visible.is_visible() {
                return Err(EngineError::new(
                    409,
                    codes::NO_VISIBLE_ROUTE,
                    "No payment route is visible for this payment",
                ));
            }
            if let Some(route_id) = attempt.route_id.as_deref() {
                if !visible.route_ids().contains(&route_id) {
                    return Err(EngineError::new(
                        409,
                        codes::ROUTE_NOT_VISIBLE,
                        format!("Route '{route_id}' is not visible for this payment"),
                    ));
                }
            }
        }

        let pre_execution = self
            .run_phase(FlowPhase::PreInitiate, &attempt, form_data)
            .await?;
        if pre_execution.step_count > 0
            && matches!(
                pre_execution.status,
                PaymentStatus::Failed | PaymentStatus::Blocked
            )
        {
            self.transition(
                &mut attempt,
                pre_execution.status,
                execution_error_patch(&pre_execution),
            )
            .await?;
            if options.slot_reserved {
                self.release_slot(&attempt, pre_execution.status.as_str())
                    .await?;
            }
            return Ok(self.to_result(&attempt, &pre_execution));
        }

        let mut reserved = options.slot_reserved;
        if !reserved {
            let reservation = self
                .slots
                .reserve(&attempt)
                .await
                .map_err(|error| EngineError::reservation_failed(error.to_string()))?;
            if attempt.link_id.is_none() {
                if let Some(link_id) = reservation.link_id {
                    attempt = self
                        .store
                        .update_attempt(
                            attempt_id,
                            AttemptPatch {
                                link_id: Some(link_id),
                                ..AttemptPatch::default()
                            },
                        )
                        .await?;
                }
            }
            reserved = true;
        }

        let result = self
            .initiate_after_reservation(&mut attempt, form_data)
            .await;
        if result.is_err() && reserved {
            let _ = self.release_slot(&attempt, "INITIATE_FAILED").await;
        }
        result
    }

    async fn initiate_after_reservation(
        &self,
        attempt: &mut Attempt,
        form_data: &Map<String, Value>,
    ) -> Result<RailResult, EngineError> {
        self.transition(attempt, PaymentStatus::Initiating, AttemptPatch::default())
            .await?;
        let execution = self
            .run_phase(FlowPhase::Initiate, attempt, form_data)
            .await?;
        match execution.status {
            PaymentStatus::Unknown => {
                self.transition(
                    attempt,
                    PaymentStatus::Unknown,
                    execution_error_patch(&execution),
                )
                .await?;
            }
            PaymentStatus::Failed | PaymentStatus::Blocked => {
                self.transition(attempt, execution.status, execution_error_patch(&execution))
                    .await?;
                self.release_slot(attempt, execution.status.as_str())
                    .await?;
            }
            _ => {
                let mut patch = AttemptPatch {
                    public_outputs: Some(execution.outputs.public.clone()),
                    ..AttemptPatch::default()
                };
                if let Some(error) = &execution.canonical_error {
                    patch.canonical_error = Some(error.clone());
                }
                self.transition(attempt, PaymentStatus::AwaitingCustomer, patch)
                    .await?;
            }
        }
        Ok(self.to_result(attempt, &execution))
    }

    // -----------------------------------------------------------------------------------------
    // advance step / phase
    // -----------------------------------------------------------------------------------------

    /// Executes the next step of a phase `(attempt, phase)`, persisting the cursor and outputs.
    pub async fn advance_step(
        &self,
        attempt_id: &str,
        phase: FlowPhase,
    ) -> Result<StepAdvance, EngineError> {
        self.advance_step_inner(attempt_id, phase, &Map::new(), None)
            .await
    }

    /// [`Self::advance_step`] with the customer input of the phase (the OTP of a SUBMIT).
    pub async fn advance_step_with_input(
        &self,
        attempt_id: &str,
        phase: FlowPhase,
        form_data: &Map<String, Value>,
    ) -> Result<StepAdvance, EngineError> {
        self.advance_step_inner(attempt_id, phase, form_data, None)
            .await
    }

    async fn advance_step_inner(
        &self,
        attempt_id: &str,
        phase: FlowPhase,
        form_data: &Map<String, Value>,
        steps: Option<&[FlowStep]>,
    ) -> Result<StepAdvance, EngineError> {
        let mut attempt = self.get_attempt(attempt_id).await?;
        let owned_steps;
        let steps = match steps {
            Some(steps) => steps,
            None => {
                owned_steps = self.flow.get_steps(phase, &attempt).await?;
                owned_steps.as_slice()
            }
        };
        let mut cursor = self
            .store
            .load_cursor(attempt_id, phase)
            .await?
            .unwrap_or_else(|| crate::ports::StepCursor::start(attempt_id, phase));
        if cursor.completed || cursor.next_index >= steps.len() {
            if !cursor.completed {
                cursor.completed = true;
                cursor.updated_at = Some(self.clock.now());
                self.store.save_cursor(&cursor).await?;
            }
            return Ok(StepAdvance {
                attempt_id: attempt_id.to_owned(),
                phase,
                step_id: None,
                step_index: None,
                canonical_status: None,
                substatus: None,
                canonical_error: None,
                output: StepOutputs::default(),
                response: None,
                client_action: None,
                branch: None,
                logs: Vec::new(),
                phase_status: phase_status(phase, !steps.is_empty()),
                finished: true,
            });
        }

        let index = cursor.next_index;
        let step = &steps[index];
        let state = self.read_context(&attempt).await?;
        let mut customer_fields = context_fields(&state);
        for (key, value) in form_data {
            customer_fields.insert(key.clone(), value.clone());
        }
        let credentials = self
            .credentials
            .as_ref()
            .map(|resolver| resolver.credentials(&attempt))
            .unwrap_or_default();
        let urls = object_field(&state, CONTEXT_URLS);
        let mut attempt_map = attempt.context_map();
        attempt_map.insert("context".to_owned(), Value::Object(state.clone()));
        let mut context = StepContext {
            phase: Some(phase),
            credentials,
            attempt: attempt_map,
            customer_fields: customer_fields.clone(),
            state: state.clone(),
            previous_response: cursor.previous_response.clone(),
            urls,
            template_values: customer_fields,
            pan_field_names: self.pan_field_names.clone(),
            ..StepContext::default()
        };
        let result = self.executor.execute(step, &mut context).await?;

        // Merge and persist the step outputs.
        let mut next_state = state;
        for (key, value) in &result.output.state {
            next_state.insert(key.clone(), value.clone());
        }
        let mut public_outputs = attempt.public_outputs.clone();
        for (key, value) in &result.output.public {
            public_outputs.insert(key.clone(), value.clone());
        }
        self.persist_outputs(
            &mut attempt,
            &next_state,
            &public_outputs,
            result.output.settled_amount,
            result.output.provider_reference.as_deref(),
            result.output.network_reference.as_deref(),
        )
        .await?;
        self.record_logs(&attempt, phase, index, &result).await?;

        let stopped = result.status != CanonicalStepStatus::Succeeded;
        let mut finished = stopped;
        let mut next_index = index + 1;
        if let Some(branch) = result.branch {
            let target = match branch {
                BranchOutcome::Then => step
                    .branch
                    .as_ref()
                    .and_then(|branch| branch.then_step_id.as_deref()),
                BranchOutcome::Else => step
                    .branch
                    .as_ref()
                    .and_then(|branch| branch.else_step_id.as_deref()),
            };
            match target.and_then(|target| {
                steps
                    .iter()
                    .enumerate()
                    .skip(index + 1)
                    .find(|(_, candidate)| candidate.id == target)
                    .map(|(position, _)| position)
            }) {
                Some(target_index) => {
                    next_index = target_index + 1;
                    finished = false;
                }
                None => finished = true,
            }
        }
        if next_index >= steps.len() {
            finished = true;
        }
        cursor.next_index = next_index;
        cursor.previous_response = result.response.clone();
        cursor.completed = finished;
        cursor.updated_at = Some(self.clock.now());
        self.store.save_cursor(&cursor).await?;

        let phase_status = if stopped {
            result.status.payment_status()
        } else {
            phase_status(phase, true)
        };
        Ok(StepAdvance {
            attempt_id: attempt_id.to_owned(),
            phase,
            step_id: Some(result.step_id.clone()),
            step_index: Some(index),
            canonical_status: Some(result.status),
            substatus: result.substatus.clone(),
            canonical_error: result.canonical_error.clone(),
            output: result.output.clone(),
            response: result.response.clone(),
            client_action: client_action_from(&result),
            branch: result.branch,
            logs: result.logs.clone(),
            phase_status,
            finished,
        })
    }

    async fn run_phase(
        &self,
        phase: FlowPhase,
        attempt: &Attempt,
        form_data: &Map<String, Value>,
    ) -> Result<PhaseExecution, EngineError> {
        let steps = self.flow.get_steps(phase, attempt).await?;
        if steps.is_empty() {
            return Ok(PhaseExecution {
                status: phase_status(phase, false),
                substatus: None,
                canonical_error: None,
                response: None,
                step_count: 0,
                outputs: StepOutputs::default(),
                client_action: None,
            });
        }
        let mut cursor = crate::ports::StepCursor::start(&attempt.id, phase);
        cursor.updated_at = Some(self.clock.now());
        self.store.save_cursor(&cursor).await?;

        let mut outputs = StepOutputs::default();
        let mut response = None;
        let mut client_action = None;
        let (status, substatus, canonical_error) = loop {
            let advance = self
                .advance_step_inner(&attempt.id, phase, form_data, Some(&steps))
                .await?;
            merge_outputs(&mut outputs, &advance.output);
            if advance.response.is_some() {
                response = advance.response.clone();
            }
            if advance.client_action.is_some() {
                client_action = advance.client_action.clone();
            }
            if advance.finished {
                break (
                    advance.phase_status,
                    advance.substatus.clone(),
                    advance.canonical_error.clone(),
                );
            }
        };
        Ok(PhaseExecution {
            status,
            substatus,
            canonical_error,
            response,
            step_count: steps.len(),
            outputs,
            client_action,
        })
    }

    // -----------------------------------------------------------------------------------------
    // confirm
    // -----------------------------------------------------------------------------------------

    pub async fn confirm(
        &self,
        attempt_id: &str,
        evidence: &Map<String, Value>,
        options: ConfirmOptions,
    ) -> Result<RailResult, EngineError> {
        let result = self.run_confirm(attempt_id, evidence, options).await;
        self.on_state_conflict(attempt_id, result).await
    }

    async fn run_confirm(
        &self,
        attempt_id: &str,
        evidence: &Map<String, Value>,
        options: ConfirmOptions,
    ) -> Result<RailResult, EngineError> {
        let mut current = self.get_attempt(attempt_id).await?;
        if current.status == PaymentStatus::Succeeded {
            return Ok(RailResult {
                substatus: None,
                canonical_error: None,
                client_action: None,
                settlement: None,
                status: PaymentStatus::Succeeded,
                outputs: current.public_outputs.clone(),
                attempt: current,
            });
        }
        if options.claim {
            let claimed = self
                .store
                .claim_authorizing(attempt_id, options.idempotency_key_hash.as_deref())
                .await?;
            if !claimed {
                let latest = self.get_attempt(attempt_id).await?;
                return Ok(RailResult::persisted(latest));
            }
            current.status = PaymentStatus::Authorizing;
            current.point_of_no_return = true;
            self.publish(&current, None);
        } else {
            if current.status == PaymentStatus::Unknown && current.point_of_no_return {
                return Err(EngineError::new(
                    409,
                    codes::POINT_OF_NO_RETURN,
                    "A money-moving attempt in UNKNOWN cannot be resubmitted",
                ));
            }
            self.transition(
                &mut current,
                PaymentStatus::Authorizing,
                AttemptPatch {
                    point_of_no_return: Some(true),
                    ..AttemptPatch::default()
                },
            )
            .await?;
        }

        let input = allow_listed_customer_input(evidence);
        let execution = self.run_phase(FlowPhase::Submit, &current, &input).await?;
        match execution.status {
            PaymentStatus::Unknown => {
                self.transition(
                    &mut current,
                    PaymentStatus::Unknown,
                    execution_error_patch(&execution),
                )
                .await?;
                return Ok(self.to_result(&current, &execution));
            }
            PaymentStatus::AwaitingCustomer
                if is_retryable_otp(execution.canonical_error.as_deref()) =>
            {
                return self.handle_retryable_otp(&mut current, &execution).await;
            }
            PaymentStatus::Failed => {
                self.transition(
                    &mut current,
                    PaymentStatus::Failed,
                    execution_error_patch(&execution),
                )
                .await?;
                self.release_slot(&current, "FAILED").await?;
                return Ok(self.to_result(&current, &execution));
            }
            PaymentStatus::Verifying => {
                self.transition(
                    &mut current,
                    PaymentStatus::Verifying,
                    AttemptPatch::default(),
                )
                .await?;
                return Ok(self.to_result(&current, &execution));
            }
            _ => {}
        }
        if execution.step_count == 0 {
            return self.run_inquire(&current.id).await;
        }
        let combined = execution
            .response
            .as_ref()
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let trusted = verify_trusted_success_facts(&combined, &current);
        if !trusted.trusted {
            self.transition(
                &mut current,
                PaymentStatus::Unknown,
                AttemptPatch {
                    canonical_error: Some(codes::TRUSTED_SUCCESS_FACTS_FAILED.to_owned()),
                    ..AttemptPatch::default()
                },
            )
            .await?;
            return Ok(RailResult {
                status: PaymentStatus::Unknown,
                substatus: None,
                canonical_error: Some(codes::TRUSTED_SUCCESS_FACTS_FAILED.to_owned()),
                client_action: None,
                settlement: None,
                outputs: execution.outputs.public.clone(),
                attempt: current,
            });
        }
        let finalized = self.finalize_success(&current).await?;
        Ok(self.success_result(current, execution.outputs.public.clone(), finalized))
    }

    async fn handle_retryable_otp(
        &self,
        attempt: &mut Attempt,
        execution: &PhaseExecution,
    ) -> Result<RailResult, EngineError> {
        let next_attempts = attempt.otp_attempts.saturating_add(1);
        let maximum = attempt.max_otp_attempts.unwrap_or(3);
        if next_attempts >= maximum {
            let mut patch = execution_error_patch(execution);
            patch.otp_attempts = Some(next_attempts);
            self.transition(attempt, PaymentStatus::Failed, patch)
                .await?;
            self.release_slot(attempt, "FAILED").await?;
            return Ok(RailResult {
                status: PaymentStatus::Failed,
                substatus: execution.substatus.clone(),
                canonical_error: Some("RETRYABLE_OTP".to_owned()),
                client_action: None,
                settlement: None,
                outputs: execution.outputs.public.clone(),
                attempt: attempt.clone(),
            });
        }
        self.transition(
            attempt,
            PaymentStatus::AwaitingCustomer,
            AttemptPatch {
                otp_attempts: Some(next_attempts),
                canonical_error: Some("RETRYABLE_OTP".to_owned()),
                ..AttemptPatch::default()
            },
        )
        .await?;
        Ok(RailResult {
            status: PaymentStatus::AwaitingCustomer,
            substatus: execution.substatus.clone(),
            canonical_error: Some("RETRYABLE_OTP".to_owned()),
            client_action: None,
            settlement: None,
            outputs: execution.outputs.public.clone(),
            attempt: attempt.clone(),
        })
    }

    // -----------------------------------------------------------------------------------------
    // inquiry
    // -----------------------------------------------------------------------------------------

    pub async fn inquire(&self, attempt_id: &str) -> Result<RailResult, EngineError> {
        let result = self.run_inquire(attempt_id).await;
        self.on_state_conflict(attempt_id, result).await
    }

    async fn run_inquire(&self, attempt_id: &str) -> Result<RailResult, EngineError> {
        let mut current = self.get_attempt(attempt_id).await?;
        if current.status == PaymentStatus::Succeeded {
            return Ok(RailResult {
                status: PaymentStatus::Succeeded,
                substatus: None,
                canonical_error: None,
                client_action: None,
                settlement: None,
                outputs: current.public_outputs.clone(),
                attempt: current,
            });
        }
        let late_success_candidate = matches!(
            current.status,
            PaymentStatus::Failed | PaymentStatus::Expired
        );
        if !late_success_candidate
            && current.status != PaymentStatus::Unknown
            && current.status != PaymentStatus::Verifying
        {
            self.transition(
                &mut current,
                PaymentStatus::Verifying,
                AttemptPatch::default(),
            )
            .await?;
        }
        let empty = Map::new();
        let execution = self.run_phase(FlowPhase::Verify, &current, &empty).await?;
        current = self.get_attempt(attempt_id).await?;
        match execution.status {
            PaymentStatus::Unknown => {
                self.transition(
                    &mut current,
                    PaymentStatus::Unknown,
                    execution_error_patch(&execution),
                )
                .await?;
                return Ok(self.to_result(&current, &execution));
            }
            PaymentStatus::Failed => {
                let context = self.read_context(&current).await?;
                if context
                    .get(TRUSTED_SUCCESS_OBSERVED)
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    self.transition(
                        &mut current,
                        PaymentStatus::Unknown,
                        AttemptPatch {
                            canonical_error: Some(codes::CONFLICTING_TRUSTED_SIGNALS.to_owned()),
                            ..AttemptPatch::default()
                        },
                    )
                    .await?;
                    self.open_case(
                        "CONFLICT",
                        CasePriority::P1,
                        &current.id,
                        "Conflicting trusted signals",
                        format!(
                            "Attempt {} received a failure signal from the gateway while a trusted success had already been observed. The attempt is frozen in UNKNOWN for operator review.",
                            current.id
                        ),
                        4,
                    );
                    return Ok(RailResult {
                        status: PaymentStatus::Unknown,
                        substatus: None,
                        canonical_error: Some(codes::CONFLICTING_TRUSTED_SIGNALS.to_owned()),
                        client_action: None,
                        settlement: None,
                        outputs: execution.outputs.public.clone(),
                        attempt: current,
                    });
                }
                self.transition(
                    &mut current,
                    PaymentStatus::Failed,
                    execution_error_patch(&execution),
                )
                .await?;
                self.release_slot(&current, "INQUIRY_FAILED").await?;
                return Ok(self.to_result(&current, &execution));
            }
            PaymentStatus::Verifying | PaymentStatus::AwaitingCustomer => {
                self.transition(&mut current, execution.status, AttemptPatch::default())
                    .await?;
                return Ok(self.to_result(&current, &execution));
            }
            _ => {}
        }
        let response = execution
            .response
            .as_ref()
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let trusted = verify_trusted_success_facts(&response, &current);
        if !trusted.trusted {
            self.transition(
                &mut current,
                PaymentStatus::Unknown,
                AttemptPatch {
                    canonical_error: Some(codes::TRUSTED_SUCCESS_FACTS_FAILED.to_owned()),
                    ..AttemptPatch::default()
                },
            )
            .await?;
            return Ok(RailResult {
                status: PaymentStatus::Unknown,
                substatus: None,
                canonical_error: Some(codes::TRUSTED_SUCCESS_FACTS_FAILED.to_owned()),
                client_action: None,
                settlement: None,
                outputs: execution.outputs.public.clone(),
                attempt: current,
            });
        }
        let finalized = self.finalize_success(&current).await?;
        Ok(self.success_result(current, execution.outputs.public.clone(), finalized))
    }

    // -----------------------------------------------------------------------------------------
    // callbacks
    // -----------------------------------------------------------------------------------------

    pub async fn verify_callback(
        &self,
        channel: &str,
        raw_request: &Value,
    ) -> Result<RailResult, EngineError> {
        let verifier = self.callback_verifier.as_ref().ok_or_else(|| {
            EngineError::with_code(
                501,
                codes::CALLBACK_VERIFIER_MISSING,
                "Callback verifier is not configured",
            )
        })?;
        let verification = verifier.verify(channel, raw_request).await?;
        let Some(attempt_id) = verification
            .attempt_id
            .clone()
            .filter(|_| verification.verified)
        else {
            return Err(EngineError::with_code(
                401,
                codes::CALLBACK_VERIFICATION_FAILED,
                verification
                    .reason
                    .clone()
                    .unwrap_or_else(|| "Callback verification failed".to_owned()),
            ));
        };
        let mut current = self.get_attempt(&attempt_id).await?;
        let dedupe_key = callback_dedupe_key(channel, raw_request, &attempt_id);
        if let Some(inbox) = &self.callback_inbox {
            if !inbox.accept(channel, &dedupe_key, &attempt_id) {
                return Ok(RailResult::persisted(current));
            }
        }
        match finalize_guard(current.status) {
            FinalizeGuard::Idempotent if !verification.must_inquire => {
                if verify_trusted_success_facts(&verification.evidence, &current).trusted {
                    return Ok(RailResult::persisted(current));
                }
                return Err(EngineError::terminal_contradicting_callback(
                    current.status.as_str(),
                ));
            }
            FinalizeGuard::Refuse => {
                return Err(EngineError::terminal_cannot_finalize(
                    current.status.as_str(),
                ));
            }
            _ => {}
        }
        let environment = verification
            .evidence
            .get("environment")
            .or_else(|| verification.evidence.get("env"));
        if let Some(environment) = environment {
            if stringify_value(environment) != current.env.as_str() {
                return Err(EngineError::new(
                    409,
                    codes::CALLBACK_ENVIRONMENT_MISMATCH,
                    "Callback environment does not match the attempt",
                ));
            }
        }
        if verification.must_inquire {
            return self.run_inquire(&attempt_id).await;
        }
        if !verify_trusted_success_facts(&verification.evidence, &current).trusted {
            return self
                .on_state_conflict(
                    &attempt_id,
                    async {
                        self.transition(
                            &mut current,
                            PaymentStatus::Unknown,
                            AttemptPatch {
                                canonical_error: Some(
                                    codes::TRUSTED_SUCCESS_FACTS_FAILED.to_owned(),
                                ),
                                ..AttemptPatch::default()
                            },
                        )
                        .await?;
                        Ok(RailResult {
                            status: PaymentStatus::Unknown,
                            substatus: None,
                            canonical_error: Some(codes::TRUSTED_SUCCESS_FACTS_FAILED.to_owned()),
                            client_action: None,
                            settlement: None,
                            outputs: current.public_outputs.clone(),
                            attempt: current.clone(),
                        })
                    }
                    .await,
                )
                .await;
        }
        let finalized = self.finalize_success(&current).await?;
        Ok(self.success_result(current.clone(), current.public_outputs.clone(), finalized))
    }

    // -----------------------------------------------------------------------------------------
    // refund / cancel
    // -----------------------------------------------------------------------------------------

    /// The gateway-side refund (`VOID` before a settlement, `REFUND` after it).
    ///
    /// The journal is not posted here: the governance finalizer posts the approved adjustment in the
    /// same transaction that marks it EXECUTED (`finalizeRefundAdjustment`).
    pub async fn refund(
        &self,
        attempt_id: &str,
        amount: Decimal,
        adjustment_id: &str,
    ) -> Result<RailResult, EngineError> {
        let mut current = self.get_attempt(attempt_id).await?;
        if amount <= Decimal::ZERO {
            return Err(EngineError::new(
                400,
                codes::INVALID_REFUND_AMOUNT,
                "Refund amount must be greater than zero",
            ));
        }
        if amount > current.total_charged_amount {
            return Err(EngineError::new(
                400,
                codes::REFUND_AMOUNT_EXCEEDED,
                "Refund amount exceeds the settled amount",
            ));
        }
        let phase = if current.settled_amount.is_none() {
            FlowPhase::Void
        } else {
            FlowPhase::Refund
        };
        let mut input = Map::new();
        input.insert("amount".to_owned(), Value::String(format!("{amount:.4}")));
        input.insert(
            "adjustmentId".to_owned(),
            Value::String(adjustment_id.to_owned()),
        );
        let execution = self.run_phase(phase, &current, &input).await?;
        if execution.status == PaymentStatus::Unknown {
            if let Some(scheduler) = &self.reconciliation {
                scheduler.schedule(&current.id, Some(adjustment_id));
            }
            return Ok(RailResult {
                status: PaymentStatus::Unknown,
                substatus: execution.substatus.clone(),
                canonical_error: execution.canonical_error.clone(),
                client_action: None,
                settlement: None,
                outputs: execution.outputs.public.clone(),
                attempt: current,
            });
        }
        if execution.status == PaymentStatus::Failed {
            if let Some(scheduler) = &self.reconciliation {
                scheduler.schedule(&current.id, Some(adjustment_id));
            }
            return Ok(self.to_result(&current, &execution));
        }
        let fully_refunded = amount == current.total_charged_amount;
        let next = if fully_refunded {
            PaymentStatus::Refunded
        } else {
            PaymentStatus::PartiallyRefunded
        };
        self.transition(&mut current, next, AttemptPatch::default())
            .await?;
        Ok(RailResult {
            status: next,
            substatus: None,
            canonical_error: None,
            client_action: None,
            settlement: None,
            outputs: execution.outputs.public.clone(),
            attempt: current,
        })
    }

    /// `cancelAttemptAtomically` plus the slot release.
    pub async fn cancel(&self, attempt_id: &str) -> Result<CancelResult, EngineError> {
        let outcome = self.store.cancel_attempt(attempt_id).await?;
        if outcome.released {
            let attempt = self.get_attempt(attempt_id).await?;
            self.slots.release(&attempt, "CANCELLED").await?;
            self.publish(&attempt, None);
        }
        if !outcome.released && outcome.status != PaymentStatus::Cancelled {
            return Err(EngineError::new(
                409,
                codes::ATTEMPT_NOT_CANCELLABLE,
                "The attempt can no longer be cancelled",
            ));
        }
        Ok(CancelResult {
            attempt_id: attempt_id.to_owned(),
            status: outcome.status,
            released: outcome.released,
        })
    }

    // -----------------------------------------------------------------------------------------
    // finalize
    // -----------------------------------------------------------------------------------------

    async fn finalize_success(&self, attempt: &Attempt) -> Result<SlotCommit, EngineError> {
        let fresh = self.get_attempt(&attempt.id).await?;
        match finalize_guard(fresh.status) {
            FinalizeGuard::Idempotent => {
                return Ok(idempotent_commit(&fresh));
            }
            FinalizeGuard::Refuse => {
                return Err(EngineError::terminal_cannot_finalize(fresh.status.as_str()));
            }
            FinalizeGuard::Allow => {}
        }
        if fresh.status == PaymentStatus::Failed
            && fresh.substatus.as_deref() == Some(AML_VOID_SUBSTATUS)
        {
            return Err(EngineError::terminal_aml_void());
        }
        if fresh.is_aml_held() {
            return self.escrow_held_capture(&fresh).await;
        }
        let previous_status = fresh.status;
        let claimed = self.store.claim_finalize(&fresh.id, fresh.status).await?;
        if !claimed {
            let latest = self.get_attempt(&fresh.id).await?;
            if latest.status != PaymentStatus::Succeeded {
                return Err(EngineError::new(
                    409,
                    codes::ATTEMPT_FINALIZE_CONFLICT,
                    format!(
                        "The attempt is already being finalized (status {})",
                        latest.status
                    ),
                ));
            }
            return Ok(idempotent_commit(&latest));
        }
        let commit = self.slots.commit(&fresh).await?;
        if commit.outcome == SlotOutcome::Suspense {
            let _ = self
                .store
                .update_attempt(
                    &fresh.id,
                    AttemptPatch {
                        status: Some(PaymentStatus::Succeeded),
                        substatus: Some(SUSPENSE_SETTLEMENT_SUBSTATUS.to_owned()),
                        ledger_entry_id: commit.journal_entry_id.clone(),
                        expected_status: Some(fresh.status),
                        ..AttemptPatch::default()
                    },
                )
                .await?;
            let mut settled = fresh.clone();
            settled.status = PaymentStatus::Succeeded;
            settled.substatus = Some(SUSPENSE_SETTLEMENT_SUBSTATUS.to_owned());
            if let Some(entry) = &commit.journal_entry_id {
                settled.ledger_entry_id = Some(entry.clone());
            }
            self.publish(&settled, Some(SUSPENSE_SETTLEMENT_SUBSTATUS));
            return Ok(commit);
        }
        let posted = self.post_confirmation(&fresh).await?;
        let mut patch = AttemptPatch {
            status: Some(PaymentStatus::Succeeded),
            clear_substatus: true,
            expected_status: Some(fresh.status),
            ..AttemptPatch::default()
        };
        if let Some(entry) = &posted {
            patch.ledger_entry_id = Some(entry.entry_id.clone());
        }
        let mut updated = self.store.update_attempt(&fresh.id, patch).await?;
        updated.status = PaymentStatus::Succeeded;
        self.publish(&updated, None);

        // Remember that a trusted success was observed, so a later contradicting failure freezes
        // the attempt instead of failing it.
        let mut context = self.read_context(&updated).await?;
        context.insert(TRUSTED_SUCCESS_OBSERVED.to_owned(), Value::Bool(true));
        if let Some(vault) = &self.vault {
            let sealed = vault
                .seal(
                    &serde_json::to_string(&context).unwrap_or_else(|_| "{}".to_owned()),
                    "attempt-context",
                )
                .map_err(|error| EngineError::with_code(500, "CONTEXT_SEAL_FAILED", error))?;
            let _ = self
                .store
                .update_attempt(
                    &fresh.id,
                    AttemptPatch {
                        context_ciphertext: Some(sealed),
                        ..AttemptPatch::default()
                    },
                )
                .await?;
        }
        if matches!(
            previous_status,
            PaymentStatus::Failed | PaymentStatus::Expired
        ) {
            self.open_case(
                "LATE_SUCCESS",
                CasePriority::P2,
                &fresh.id,
                "Late success recovered",
                format!(
                    "Attempt {} succeeded after it had reached {}{}. Verify the customer notification and the merchant credit.",
                    fresh.id,
                    previous_status,
                    if commit.outcome == SlotOutcome::Suspense {
                        " and was routed to SUSPENSE"
                    } else {
                        ""
                    }
                ),
                24,
            );
        }
        if let Some(reporting) = &self.reporting {
            let amount = updated
                .settled_amount
                .unwrap_or_else(|| updated.charged_amount());
            reporting.evaluate(
                &updated.id,
                updated.merchant_id.as_deref(),
                amount,
                &updated.currency,
            );
        }
        Ok(SlotCommit {
            outcome: SlotOutcome::Committed,
            journal_entry_id: posted.map(|entry| entry.entry_id),
            adjustment_id: None,
            operator_case_id: None,
            reason: None,
        })
    }

    /// `GAP-015`: the gateway capture of an AML-held attempt is verified, so the money is escrowed.
    async fn escrow_held_capture(&self, attempt: &Attempt) -> Result<SlotCommit, EngineError> {
        let mut journal_entry_id = attempt.ledger_entry_id.clone();
        if let Some(ledger) = &self.ledger {
            if attempt.ownership_mode != OwnershipMode::MerchantDirect && journal_entry_id.is_none()
            {
                let amount = attempt.charged_amount();
                let posted = ledger
                    .post_scenario(ScenarioPosting {
                        scenario: pg_domain_ledger::LedgerScenario::AmlHoldAndRelease,
                        stage: None,
                        ref_id: attempt.id.clone(),
                        amount,
                        commission_amount: Decimal::ZERO,
                        merchant_amount: Decimal::ZERO,
                        merchant_id: attempt.merchant_id.clone(),
                        gateway_id: attempt.gateway_id.clone(),
                        credential_set_id: attempt.credential_set_id.clone(),
                        wallet_gl_account_id: attempt.wallet_gl_account_id.clone(),
                        currency: attempt.currency.clone(),
                        env: attempt.env,
                    })
                    .await?;
                journal_entry_id = Some(posted.entry_id.clone());
                let _ = self
                    .store
                    .update_attempt(
                        &attempt.id,
                        AttemptPatch {
                            substatus: Some(AML_HOLD_SUBSTATUS.to_owned()),
                            ledger_entry_id: Some(posted.entry_id),
                            ..AttemptPatch::default()
                        },
                    )
                    .await?;
            }
        }
        let mut updated = self.get_attempt(&attempt.id).await?;
        updated.substatus = Some(AML_HOLD_SUBSTATUS.to_owned());
        if let Some(entry) = &journal_entry_id {
            updated.ledger_entry_id = Some(entry.clone());
        }
        let mut context = self.read_context(&updated).await?;
        context.insert(TRUSTED_SUCCESS_OBSERVED.to_owned(), Value::Bool(true));
        if let Some(vault) = &self.vault {
            if let Ok(sealed) = vault.seal(
                &serde_json::to_string(&context).unwrap_or_else(|_| "{}".to_owned()),
                "attempt-context",
            ) {
                let _ = self
                    .store
                    .update_attempt(
                        &attempt.id,
                        AttemptPatch {
                            context_ciphertext: Some(sealed),
                            ..AttemptPatch::default()
                        },
                    )
                    .await;
            }
        }
        self.publish(&updated, Some(AML_HOLD_SUBSTATUS));
        let reason = if journal_entry_id.is_some() {
            "AML_HOLD_ESCROWED"
        } else {
            "AML_HOLD_NO_ESCROW"
        };
        Ok(SlotCommit {
            outcome: SlotOutcome::Held,
            journal_entry_id,
            adjustment_id: None,
            operator_case_id: None,
            reason: Some(reason.to_owned()),
        })
    }

    async fn post_confirmation(
        &self,
        attempt: &Attempt,
    ) -> Result<Option<PostedEntry>, EngineError> {
        let Some(ledger) = &self.ledger else {
            return Ok(None);
        };
        let amount = attempt.requested_amount;
        let commission = commission_for_attempt(attempt)?;
        let surcharge = attempt.surcharge_amount;
        let merchant_amount = attempt.net_merchant_amount.unwrap_or(amount - commission);
        let mut posting = ConfirmationPosting {
            attempt_id: attempt.id.clone(),
            ownership_mode: attempt.ownership_mode,
            fee_bearer: attempt.fee_bearer,
            fee_accrual: attempt.fee_accrual,
            amount,
            surcharge_amount: surcharge,
            commission_amount: commission,
            merchant_amount,
            gateway_fee_amount: attempt.gateway_fee_amount,
            provider_fee_amount: attempt.gateway_fee_amount,
            scenario: pg_domain_ledger::LedgerScenario::PlatformHeldConfirmation,
            merchant_id: attempt.merchant_id.clone(),
            gateway_id: attempt.gateway_id.clone(),
            credential_set_id: attempt.credential_set_id.clone(),
            wallet_gl_account_id: attempt.wallet_gl_account_id.clone(),
            currency: attempt.currency.clone(),
            env: attempt.env,
        };
        posting.scenario = crate::ports::confirmation_scenario(&posting)?;
        Ok(Some(ledger.post_confirmation(posting).await?))
    }

    // -----------------------------------------------------------------------------------------
    // trusted success
    // -----------------------------------------------------------------------------------------

    #[must_use]
    pub fn verify_trusted_success_facts(
        evidence: &Map<String, Value>,
        attempt: &Attempt,
    ) -> TrustedSuccessResult {
        verify_trusted_success_facts(evidence, attempt)
    }

    // -----------------------------------------------------------------------------------------
    // internal helpers
    // -----------------------------------------------------------------------------------------

    async fn get_attempt(&self, attempt_id: &str) -> Result<Attempt, EngineError> {
        self.store
            .load_attempt(attempt_id)
            .await?
            .ok_or_else(|| EngineError::attempt_not_found(attempt_id))
    }

    async fn on_state_conflict(
        &self,
        attempt_id: &str,
        result: Result<RailResult, EngineError>,
    ) -> Result<RailResult, EngineError> {
        match result {
            Err(error) if error.code == codes::ATTEMPT_STATE_CONFLICT => {
                let latest = self.get_attempt(attempt_id).await?;
                Ok(RailResult::persisted(latest))
            }
            other => other,
        }
    }

    async fn transition(
        &self,
        attempt: &mut Attempt,
        next: PaymentStatus,
        mut patch: AttemptPatch,
    ) -> Result<(), EngineError> {
        if attempt.status != next && !is_allowed(attempt.status, next) {
            return Err(EngineError::invalid_transition(
                attempt.status.as_str(),
                next.as_str(),
            ));
        }
        patch.status = Some(next);
        patch.expected_status = Some(attempt.status);
        let substatus = patch.substatus.clone();
        let updated = self.store.update_attempt(&attempt.id, patch).await?;
        *attempt = updated;
        self.publish(attempt, substatus.as_deref());
        Ok(())
    }

    fn publish(&self, attempt: &Attempt, substatus: Option<&str>) {
        if let Some(sink) = &self.transition_sink {
            sink.publish(AttemptTransitionEvent {
                attempt_id: attempt.id.clone(),
                status: attempt.status,
                substatus: substatus.map(str::to_owned),
                merchant_id: attempt.merchant_id.clone(),
            });
        }
    }

    async fn release_slot(&self, attempt: &Attempt, reason: &str) -> Result<(), EngineError> {
        if attempt.status.releases_slot() {
            self.slots.release(attempt, reason).await?;
        }
        Ok(())
    }

    async fn read_context(&self, attempt: &Attempt) -> Result<Map<String, Value>, EngineError> {
        if let Some(vault) = &self.vault {
            if let Some(ciphertext) = attempt
                .context_ciphertext
                .as_deref()
                .filter(|value| !value.is_empty())
            {
                let plaintext = vault
                    .open(ciphertext, "attempt-context")
                    .map_err(|error| EngineError::with_code(500, "CONTEXT_OPEN_FAILED", error))?;
                return Ok(serde_json::from_str::<Value>(&plaintext)
                    .ok()
                    .and_then(|value| value.as_object().cloned())
                    .unwrap_or_default());
            }
        }
        Ok(attempt.context.clone())
    }

    async fn persist_outputs(
        &self,
        attempt: &mut Attempt,
        state: &Map<String, Value>,
        public: &Map<String, Value>,
        settled_amount: Option<Decimal>,
        provider_reference: Option<&str>,
        network_reference: Option<&str>,
    ) -> Result<(), EngineError> {
        let ciphertext = if let Some(vault) = &self.vault {
            let plaintext = serde_json::to_string(state).unwrap_or_else(|_| "{}".to_owned());
            Some(
                vault
                    .seal(&plaintext, "attempt-context")
                    .map_err(|error| EngineError::with_code(500, "CONTEXT_SEAL_FAILED", error))?,
            )
        } else {
            None
        };
        let patch = AttemptPatch {
            context_ciphertext: ciphertext.clone(),
            public_outputs: Some(public.clone()),
            provider_reference: provider_reference.map(str::to_owned),
            network_reference: network_reference.map(str::to_owned),
            settled_amount,
            ..AttemptPatch::default()
        };
        let updated = self.store.update_attempt(&attempt.id, patch).await?;
        *attempt = updated;
        if ciphertext.is_none() {
            attempt.context = state.clone();
        }
        attempt.public_outputs = public.clone();
        Ok(())
    }

    async fn record_logs(
        &self,
        attempt: &Attempt,
        phase: FlowPhase,
        index: usize,
        result: &StepExecutionResult,
    ) -> Result<(), EngineError> {
        for (log_index, log) in result.logs.iter().enumerate() {
            let response_text = match &log.response {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Null) | None => String::new(),
                Some(value) => serde_json::to_string(value).unwrap_or_default(),
            };
            self.store
                .record_step(crate::ports::StepLogRecord {
                    attempt_id: attempt.id.clone(),
                    gateway_version_id: attempt.gateway_version_id.clone(),
                    phase,
                    step_id: log.step_id.clone(),
                    step_order: u32::try_from(index * 100 + log_index).unwrap_or(u32::MAX),
                    redacted_request: log.request.clone().unwrap_or(Value::Null),
                    redacted_response_text: response_text,
                    http_status: log.http_status,
                    duration_ms: log.duration_ms,
                    outcome: log.outcome.clone(),
                    created_at: self.clock.now(),
                })
                .await?;
        }
        Ok(())
    }

    fn to_result(&self, attempt: &Attempt, execution: &PhaseExecution) -> RailResult {
        RailResult {
            attempt: attempt.clone(),
            status: execution.status,
            substatus: execution.substatus.clone(),
            canonical_error: execution.canonical_error.clone(),
            client_action: execution.client_action.clone(),
            settlement: None,
            outputs: execution.outputs.public.clone(),
        }
    }

    fn success_result(
        &self,
        attempt: Attempt,
        outputs: Map<String, Value>,
        finalized: SlotCommit,
    ) -> RailResult {
        match finalized.outcome {
            SlotOutcome::Held => RailResult {
                status: attempt.status,
                substatus: Some(AML_HOLD_SUBSTATUS.to_owned()),
                canonical_error: None,
                client_action: None,
                settlement: None,
                outputs,
                attempt,
            },
            SlotOutcome::Suspense => RailResult {
                status: PaymentStatus::Succeeded,
                substatus: Some(SUSPENSE_SETTLEMENT_SUBSTATUS.to_owned()),
                canonical_error: Some(codes::SLOT_ALREADY_SETTLED_SUSPENSE.to_owned()),
                client_action: None,
                settlement: Some(Settlement::Suspense),
                outputs,
                attempt,
            },
            SlotOutcome::Committed => RailResult {
                status: PaymentStatus::Succeeded,
                substatus: None,
                canonical_error: None,
                client_action: None,
                settlement: Some(Settlement::Normal),
                outputs,
                attempt,
            },
        }
    }

    fn open_case(
        &self,
        kind: &str,
        priority: CasePriority,
        attempt_id: &str,
        title: &str,
        detail: String,
        sla_hours: i64,
    ) {
        if let Some(sink) = &self.cases {
            sink.open(OperatorCaseInput {
                kind: kind.to_owned(),
                priority,
                attempt_id: attempt_id.to_owned(),
                title: title.to_owned(),
                detail,
                sla_due_at: self.clock.now() + Duration::hours(sla_hours),
            });
        }
    }
}

/// The phase execution accumulated over its steps.
struct PhaseExecution {
    status: PaymentStatus,
    substatus: Option<String>,
    canonical_error: Option<String>,
    response: Option<Value>,
    step_count: usize,
    outputs: StepOutputs,
    client_action: Option<Value>,
}

fn merge_outputs(target: &mut StepOutputs, source: &StepOutputs) {
    for (key, value) in &source.state {
        target.state.insert(key.clone(), value.clone());
    }
    for (key, value) in &source.public {
        target.public.insert(key.clone(), value.clone());
    }
    if source.settled_amount.is_some() {
        target.settled_amount = source.settled_amount;
    }
    if source.provider_fee.is_some() {
        target.provider_fee = source.provider_fee;
    }
    if source.provider_reference.is_some() {
        target.provider_reference = source.provider_reference.clone();
    }
    if source.network_reference.is_some() {
        target.network_reference = source.network_reference.clone();
    }
}

fn execution_error_patch(execution: &PhaseExecution) -> AttemptPatch {
    AttemptPatch {
        substatus: execution.substatus.clone(),
        canonical_error: execution.canonical_error.clone(),
        ..AttemptPatch::default()
    }
}

/// The customer inputs a confirm may pass into `SUBMIT`: `otp` only.
#[must_use]
pub fn allow_listed_customer_input(evidence: &Map<String, Value>) -> Map<String, Value> {
    let mut result = Map::new();
    for key in CONFIRM_CUSTOMER_INPUT_ALLOWLIST {
        if let Some(value) = evidence.get(key) {
            result.insert(key.to_owned(), value.clone());
        }
    }
    result
}

/// `isRetryableOtp`.
#[must_use]
pub fn is_retryable_otp(error: Option<&str>) -> bool {
    error.is_some_and(|error| error.to_ascii_uppercase().contains("RETRYABLE_OTP"))
}

/// `phaseStatus`.
#[must_use]
pub fn phase_status(phase: FlowPhase, has_steps: bool) -> PaymentStatus {
    if !has_steps {
        return if phase == FlowPhase::Submit {
            PaymentStatus::Succeeded
        } else {
            PaymentStatus::AwaitingCustomer
        };
    }
    PaymentStatus::Succeeded
}

/// The context fields stored on the attempt (`AttemptGuardPipeline`).
#[must_use]
pub fn context_fields(state: &Map<String, Value>) -> Map<String, Value> {
    state
        .get(CONTEXT_FIELDS)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn object_field(state: &Map<String, Value>, key: &str) -> Map<String, Value> {
    state
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// `successStatus`.
#[must_use]
pub fn is_success_status(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(pg_domain_flow::is_success_status)
}

/// `verifyTrustedSuccessFacts`.
#[must_use]
pub fn verify_trusted_success_facts(
    evidence: &Map<String, Value>,
    attempt: &Attempt,
) -> TrustedSuccessResult {
    let status = evidence
        .get("status")
        .or_else(|| evidence.get("payment_status"))
        .or_else(|| evidence.get("result"))
        .is_some_and(is_success_status);
    let expected_reference = attempt.expected_reference();
    let evidence_reference = evidence
        .get("reference")
        .or_else(|| evidence.get("provider_reference"))
        .or_else(|| evidence.get("transaction_id"))
        .or_else(|| evidence.get("gateway_reference"));
    let reference = evidence_reference.is_some_and(|value| !stringify_value(value).is_empty())
        && expected_reference.is_none_or(|expected| {
            evidence_reference.is_some_and(|value| stringify_value(value) == expected)
        });
    let evidence_amount = evidence
        .get("amount")
        .or_else(|| evidence.get("settled_amount"))
        .or_else(|| evidence.get("total_charged_amount"));
    let amount = evidence_amount.is_some_and(|value| amount_within_tolerance(value, attempt));
    let currency = evidence.get("currency").is_some_and(|value| {
        let text = stringify_value(value);
        !text.is_empty() && text.eq_ignore_ascii_case(&attempt.currency)
    });
    let environment = evidence
        .get("environment")
        .or_else(|| evidence.get("env"))
        .is_some_and(|value| {
            let text = stringify_value(value);
            !text.is_empty() && text == attempt.env.as_str()
        });
    let facts = TrustedSuccessFacts {
        status,
        reference,
        amount,
        currency,
        environment,
    };
    TrustedSuccessResult {
        trusted: status && reference && amount && currency && environment,
        facts,
    }
}

fn amount_within_tolerance(value: &Value, attempt: &Attempt) -> bool {
    let charged = attempt.total_charged_amount;
    let Some(settled) = decimal_from_value(value) else {
        return false;
    };
    if settled == charged {
        return true;
    }
    let Some(tolerance) = attempt.mismatch_tolerance else {
        return false;
    };
    if tolerance <= Decimal::ZERO {
        return false;
    }
    (settled - charged).abs() <= tolerance
}

fn decimal_from_value(value: &Value) -> Option<Decimal> {
    match value {
        Value::String(text) => text.trim().parse::<Decimal>().ok(),
        Value::Number(number) => number.to_string().parse::<Decimal>().ok(),
        _ => None,
    }
}

fn commission_for_attempt(attempt: &Attempt) -> Result<Decimal, EngineError> {
    if let Some(commission) = attempt.platform_commission_amount {
        return Ok(commission);
    }
    if let Some(value) = attempt.context.get("platformCommissionAmount") {
        if let Some(commission) = decimal_from_value(value) {
            return Ok(commission);
        }
    }
    Err(EngineError::new(
        400,
        codes::COMMISSION_NOT_RESOLVED,
        "The platform commission must be resolved from the pinned commission profile",
    ))
}

fn idempotent_commit(attempt: &Attempt) -> SlotCommit {
    let outcome = if attempt.substatus.as_deref() == Some(SUSPENSE_SETTLEMENT_SUBSTATUS) {
        SlotOutcome::Suspense
    } else if attempt.substatus.as_deref() == Some(AML_HOLD_SUBSTATUS) {
        SlotOutcome::Held
    } else {
        SlotOutcome::Committed
    };
    SlotCommit {
        outcome,
        journal_entry_id: attempt.ledger_entry_id.clone(),
        adjustment_id: None,
        operator_case_id: None,
        reason: None,
    }
}

fn callback_dedupe_key(channel: &str, raw_request: &Value, attempt_id: &str) -> String {
    if let Some(map) = raw_request.as_object() {
        if let Some(explicit) = map.get("dedupeKey").or_else(|| map.get("dedupe_key")) {
            return format!("{channel}:{}", stringify_value(explicit));
        }
    }
    format!("{channel}:{attempt_id}")
}

/// `clientActionFrom`.
#[must_use]
pub fn client_action_from(result: &StepExecutionResult) -> Option<Value> {
    let public = Value::Object(result.output.public.clone());
    if let Some(Value::Object(action)) = public.get("clientAction") {
        if action.contains_key("type") && action.contains_key("payload") {
            return Some(Value::Object(action.clone()));
        }
    }
    let action_type = public
        .get("actionType")
        .or_else(|| public.get("type"))
        .and_then(Value::as_str)?;
    ClientAction::parse(action_type)?;
    let mut payload = result.output.public.clone();
    payload.remove("actionType");
    payload.remove("type");
    Some(serde_json::json!({
        "type": action_type,
        "payload": Value::Object(payload),
    }))
}

/// `canarySelected` is re-exported for callers that build [`RailCandidate`]s.
#[must_use]
pub fn route_in_canary(route_id: &str, canary_key: Option<&str>, percent: u8) -> bool {
    canary_selected(route_id, canary_key, percent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::str::FromStr;

    fn attempt() -> Attempt {
        let mut attempt = Attempt::new(
            "a1",
            "ORD-1",
            Decimal::from_str("100.0000").expect("decimal"),
            "LYD",
        );
        attempt.total_charged_amount = Decimal::from_str("100.0000").expect("decimal");
        attempt.env = crate::ports::Environment::Live;
        attempt
    }

    #[test]
    fn trusted_facts_require_all_five_facts() {
        let attempt = attempt();
        let mut evidence = Map::new();
        evidence.insert("status".to_owned(), json!("SUCCESS"));
        evidence.insert("reference".to_owned(), json!("ORD-1"));
        evidence.insert("amount".to_owned(), json!("100"));
        evidence.insert("currency".to_owned(), json!("LYD"));
        evidence.insert("environment".to_owned(), json!("LIVE"));
        let result = verify_trusted_success_facts(&evidence, &attempt);
        assert!(result.trusted);
        assert!(result.facts.amount);

        for key in ["status", "reference", "amount", "currency", "environment"] {
            let mut missing = evidence.clone();
            missing.remove(key);
            let result = verify_trusted_success_facts(&missing, &attempt);
            assert!(!result.trusted, "{key} must be required");
        }
        evidence.insert("status".to_owned(), json!("DECLINED"));
        assert!(!verify_trusted_success_facts(&evidence, &attempt).trusted);
    }

    #[test]
    fn amount_tolerance_is_exact_or_within_the_route_limit() {
        let mut attempt = attempt();
        let evidence = |amount: &str| {
            let mut map = Map::new();
            map.insert("amount".to_owned(), json!(amount));
            map
        };
        attempt.mismatch_tolerance = Some(Decimal::from_str("0.0500").expect("decimal"));
        assert!(amount_within_tolerance(&json!("100.0000"), &attempt));
        assert!(amount_within_tolerance(&json!("100.04"), &attempt));
        assert!(!amount_within_tolerance(&json!("100.06"), &attempt));
        attempt.mismatch_tolerance = None;
        assert!(!amount_within_tolerance(&json!("100.01"), &attempt));
        assert!(!amount_within_tolerance(&json!("abc"), &attempt));
        let _ = evidence;
    }

    #[test]
    fn confirm_input_allowlist_drops_everything_but_otp() {
        let mut evidence = Map::new();
        evidence.insert("otp".to_owned(), json!("123456"));
        evidence.insert("status".to_owned(), json!("SUCCESS"));
        evidence.insert("amount".to_owned(), json!("100"));
        let input = allow_listed_customer_input(&evidence);
        assert_eq!(input.len(), 1);
        assert_eq!(input.get("otp"), Some(&json!("123456")));
    }

    #[test]
    fn retryable_otp_detection_is_case_insensitive() {
        assert!(is_retryable_otp(Some("RETRYABLE_OTP")));
        assert!(is_retryable_otp(Some("gateway_retryable_otp")));
        assert!(!is_retryable_otp(Some("TERMINAL_DECLINE")));
        assert!(!is_retryable_otp(None));
    }

    #[test]
    fn phase_status_matches_the_engine_defaults() {
        assert_eq!(
            phase_status(FlowPhase::Submit, false),
            PaymentStatus::Succeeded
        );
        assert_eq!(
            phase_status(FlowPhase::Initiate, false),
            PaymentStatus::AwaitingCustomer
        );
        assert_eq!(
            phase_status(FlowPhase::Initiate, true),
            PaymentStatus::Succeeded
        );
    }

    #[test]
    fn dedupe_key_prefers_the_explicit_value() {
        assert_eq!(
            callback_dedupe_key("webhook", &json!({"dedupeKey": "x"}), "a1"),
            "webhook:x"
        );
        assert_eq!(
            callback_dedupe_key("webhook", &json!({}), "a1"),
            "webhook:a1"
        );
    }

    #[test]
    fn client_action_is_built_from_action_type() {
        let mut output = StepOutputs::default();
        output
            .public
            .insert("actionType".to_owned(), json!("SHOW_OTP_FORM"));
        output.public.insert("phone".to_owned(), json!("09"));
        let result = StepExecutionResult {
            step_id: "s".to_owned(),
            status: CanonicalStepStatus::Succeeded,
            substatus: None,
            canonical_error: None,
            output,
            response: None,
            raw_text: None,
            branch: None,
            logs: Vec::new(),
        };
        let action = client_action_from(&result).expect("action");
        assert_eq!(action["type"], "SHOW_OTP_FORM");
        assert_eq!(action["payload"]["phone"], "09");
        assert!(action["payload"].get("actionType").is_none());
    }
}
