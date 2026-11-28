//! The declarative flow engine: transforms, step execution, the rail loop and the spec runtime.
//!
//! Port of `core-back/engine/flow/**`, `core-back/engine/transforms/TransformPipeline.ts`,
//! `core-back/engine/runtime/{flowProvider,slotStore,contextCipher}.ts` and the flow rules of
//! `core-back/engine/specImporter/specValidator.ts`, per chapter 2 §12, §15, §16, §17 and §28 of the
//! Rust/ntex port plan.
//!
//! | Module | TypeScript source |
//! | :--- | :--- |
//! | [`transform`] | `engine/transforms/TransformPipeline.ts` (39 operations, BigInt money) |
//! | [`selector`] | `engine/apiConsumer/{recursiveSelect,recursiveSet,compileUrl}.ts` |
//! | [`jsregex`] | `new RegExp(pattern, "u").test` for status rules (no regex crate is pinned) |
//! | [`schema`] | `engine/flow/StepExecutor.ts` step vocabulary, `specImporter/specSchema.ts` |
//! | [`step`] | `engine/flow/StepExecutor.ts` (HTTP / COMPUTE / RENDER / WAIT / ASSERT / BRANCH) |
//! | [`compute`] | `engine/runtime/computeRegistry.ts` (the three seeded operations) |
//! | [`engine`] | `engine/flow/DynamicRailEngine.ts` (the rail loop) |
//! | [`materialize`] | `engine/runtime/flowProvider.ts` + the flow rules of `specValidator.ts` |
//! | [`ports`] | `AttemptRepository`, `SlotReservationStore`, `ApiConsumer`, `VaultContextCipher` |
//! | [`clock`] | `Date`, `crypto.randomUUID`, `crypto.randomInt` |
//!
//! ## Ported
//!
//! - the complete transform library, including `scale`/`MUL_INT`/`DIV_DECIMAL`/`round` on an
//!   arbitrary-precision BigInt decimal and the refusal of `to_number` on monetary outputs;
//! - prototype-safe dotted selectors, `{{path}}` templates, assertions, URL compilation and
//!   query/path encoding;
//! - the six step kinds with the seeded rails' OTP, redirect, widget, card, hosted, push and wallet
//!   shapes, retries/timeouts, canonical status rules and the Fake Rails scoped headers;
//! - `CRYPTO_SIGNATURE` parameters through a declarative profile and the three compute operations;
//! - the rail loop: visible-rail selection, slot reservation, initiate, per-step advance, confirm
//!   (with the atomic claim), inquire, verified callbacks with the inbox dedupe, cancel, refund and
//!   the full finalize semantics (idempotent guard, AML escrow, late success, SUSPENSE routing);
//! - runtime schema types, offline flow validation and materialisation from stored gateway flow
//!   JSON, with a fixture-based test.
//!
//! ## Remaining (later waves)
//!
//! - `pg-db` adapters for [`ports::FlowStore`], [`ports::SlotStore`] and [`ports::FlowProvider`]
//!   (the SQL in chapter 2 §15/§17 is documented on the traits);
//! - the `pg-egress` HTTP executor behind [`ports::EgressPort`] (mTLS client certificates, token
//!   cache, 2 MiB cap, pinned DNS);
//! - the `pg-ledger` database poster behind [`ports::LedgerPort`];
//! - the core route wiring (`checkout` confirm/cancel/return, `merchant` refund), the background
//!   workers (expiry, poll, reconciliation) and the outbox/case/reporting sinks;
//! - the customer-form normalizer/validator of the guard pipeline, and `CAPTURE`/
//!   `SETTLEMENT_FETCH`/`CANCEL` phase executors (the TS engine has none; parity).
//!
//! See `README.md` for the deviations and the mapping to the tracker.

#![forbid(unsafe_code)]
// The error is the `{status,code,message,details}` envelope every caller serialises; boxing it would
// change every port signature for a few dozen bytes.
#![allow(clippy::result_large_err)]

pub mod adapters;
pub mod clock;
pub mod compute;
pub mod crypto_profile;
pub mod engine;
pub mod error;
pub mod jsregex;
pub mod materialize;
pub mod ports;
pub mod schema;
pub mod selector;
pub mod step;
pub mod transform;

pub use clock::{CounterRng, FixedClock, OsRng, SystemClock};
pub use compute::{BuiltinComputeRegistry, ComputeContext, ComputeRegistry};
pub use crypto_profile::{
    profile_from_parts, sign_payload, signing_payload, CryptoProfile, CryptoProfileResolver,
    SigningPayload,
};
pub use engine::{
    allow_listed_customer_input, client_action_from, context_fields, is_retryable_otp,
    is_success_status, phase_status, route_in_canary, verify_trusted_success_facts, CancelResult,
    ConfirmOptions, InitiateOptions, RailEngine, RailEngineOptions, RailResult, Settlement,
    StepAdvance, TrustedSuccessFacts, TrustedSuccessResult, AML_HOLD_SUBSTATUS, AML_VOID_SUBSTATUS,
    CONFIRM_CUSTOMER_INPUT_ALLOWLIST, CONTEXT_FIELDS, CONTEXT_URLS, SUSPENSE_SETTLEMENT_SUBSTATUS,
    TRUSTED_SUCCESS_OBSERVED,
};
pub use error::{codes, EngineError};
pub use jsregex::{JsRegex, RegexError};
pub use materialize::{
    import_gateway_flow, materialize_flow, resolve_url_template, to_mime_content_type,
    validate_flow_spec, FlowValidationInput, MaterializedFlow, MaterializedGatewayFlow,
    SpecDiagnostic, SpecValidation, StoredAssertion, StoredBranch, StoredCompute, StoredFlow,
    StoredFlowStep, StoredIdempotency, StoredRender, StoredStatusRule, StoredStepOutput,
    StoredStepParameter, StoredWait,
};
pub use ports::{
    confirmation_scenario, Attempt, AttemptPatch, AttemptTransitionEvent, CallbackInbox,
    CallbackVerification, CallbackVerifier, CancelOutcome, CasePriority, CaseSink, Clock,
    ConfirmationPosting, CredentialResolver, EgressBody, EgressError, EgressPort, EgressRequest,
    EgressResponse, Environment, FeeBearer, FlowProvider, FlowStore, LedgerPort, OperatorCaseInput,
    OwnershipMode, PostedEntry, ReconciliationScheduler, ReportingEvaluator, Rng, ScenarioPosting,
    SlotCommit, SlotOutcome, SlotReservation, SlotStore, StepCursor, StepLogRecord, StoreError,
    TransitionSink, VaultPort,
};
pub use schema::{
    Assertion, AssertionOp, BranchStep, CanonicalStepStatus, ClientAction, ComputeStep, FlowPhase,
    FlowStep, HttpMethod, IdempotencyConfig, IdempotencyMode, OutputStore, ParameterPlace,
    ParameterSource, RenderStep, RetryPolicy, SideEffect, StatusRule, StepOutput, StepParameter,
    StepType, WaitStep,
};
pub use selector::{
    compile_url, evaluate_assertion, select, set_path, stringify_value, UrlOptions,
};
pub use step::{
    BranchOutcome, StepContext, StepExecutionResult, StepExecutor, StepExecutorOptions, StepLog,
    StepOutputs, WaitPort, DEFAULT_TIMEOUT_MS, MAX_WAIT_MS,
};
pub use transform::{
    decimal_string, validate_transform_usage, SecretResolver, TransformContext, TransformPipe,
    TransformPipeline, TransformUsage, TransformValidationError, MONETARY_OUTPUT_STORES,
    TRANSFORM_OPERATIONS,
};

/// A short description of this crate for `--help`/diagnostics.
pub const CRATE_PURPOSE: &str =
    "declarative flow engine (transforms, steps, rail loop, spec runtime)";
