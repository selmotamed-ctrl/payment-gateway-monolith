# `pg-flow-engine`

The declarative flow engine: transforms, step executor, the rail loop, the spec runtime and the
PostgreSQL/egress/ledger adapters for its ports.

The pure engine is documented in `src/lib.rs` (module → TypeScript source map). This README covers
the **adapters** (`src/adapters/**`) and how to wire them.

## Adapters

| Module | Trait | TypeScript source | Tables / client |
| :--- | :--- | :--- | :--- |
| `adapters::store::PgFlowStore` | `FlowStore` | `engine/runtime/attemptRepository.ts`, `api/internal/checkout.ts:claimAttemptForConfirm/cancelAttemptAtomically` | `payment_attempts`, `attempt_step_logs`, `outbox_events`, `worker_cursors` |
| `adapters::provider::PgFlowProvider` | `FlowProvider` | `engine/runtime/flowProvider.ts` | `flows`, `flow_steps`, `step_parameters`, `step_outputs`, `status_rules`, `gateway_environments` |
| `adapters::slots::PgSlotStore` | `SlotStore` | `engine/runtime/slotStore.ts` | `payment_links`, `payment_attempts`, `journal_*`, `adjustments`, `operator_cases` |
| `adapters::egress::PgEgressAdapter` / `BoundEgress` | `EgressPort`, `CredentialResolver` | `engine/apiConsumer/ApiConsumer.ts`, `engine/runtime/platform.ts:loadConsumerConfig` | `credential_sets`, `gateway_auth`, `gateway_environments`, `gateway_settings` |
| `adapters::ledger::PgLedgerAdapter` | `LedgerPort` | `engine/ledger/LedgerPoster.ts` | `pg-ledger` poster (`journal_entries`, `journal_lines`, `gl_account_shards`) |
| `adapters::vault::PgVaultAdapter` | `VaultPort` | `engine/runtime/contextCipher.ts` | `pg-crypto::Vault` (`attempt-context`, `credential-set`) |
| `adapters::sinks::PgCaseSink` | `CaseSink` | `engine/compliance/OperatorCaseSink.ts` | `operator_cases`, `operator_case_events` |
| `adapters::sinks::PgTransitionSink` | `TransitionSink` | `lib/invalidationBus.ts` | process-wide broadcast (bridge to Redis in the storage layer) |

### Transactions

The ports are `&self` with no transaction object. Every write adapter also exposes an
`*_on(&mut PgConnection, ...)` form. **Use it** from a caller that already owns a transaction (the
checkout confirm path, a worker, the slot commit) so the state change, the slot counters and the
journal commit or roll back together; the trait implementation opens one short transaction around
the same statements for standalone calls.

### Wiring one attempt

```rust,ignore
let store = Arc::new(PgFlowStore::new(pool.clone()));
let slots = Arc::new(PgSlotStore::new(pool.clone()));
let flow = Arc::new(PgFlowProvider::new(pool.clone()));
let ledger = Arc::new(PgLedgerAdapter::new(pool.clone()));
let vault = Arc::new(PgVaultAdapter::from_process_env());
let egress = PgEgressAdapter::new(pool.clone(), vault.clone(), EgressConfig { /* deploy policy */ ..Default::default() });

// The egress request does not carry the attempt id, so bind the pinned gateway/credential
// configuration of the attempt; the returned BoundEgress is both the EgressPort and the
// CredentialResolver for that attempt.
let bound = Arc::new(egress.bind(&attempt).await?);
let engine = RailEngine::new(RailEngineOptions {
    store, slots, flow, ledger,
    executor: Arc::new(StepExecutor::new(bound.clone(), clock.clone(), rng.clone())),
    ledger: Some(ledger.clone()),
    credentials: Some(bound.clone()),
    vault: Some(vault.clone()),
    cases: Some(Arc::new(PgCaseSink::new(pool.clone()))),
    transition_sink: Some(Arc::new(PgTransitionSink::default())),
    ..
});
```

`PgEgressAdapter::prefetch(&attempt)` fills the shared `PgCredentialResolver` cache for a caller that
builds one executor for several attempts; a cache miss returns an empty credential map rather than
blocking the async runtime, so the route layer must prefetch before the engine runs a `CREDENTIAL`
step.

### Not implemented here

| Trait | Why / next step |
| :--- | :--- |
| `CallbackVerifier` | Channel-specific signature verification (crypto profiles, timestamp window, IP allowlist, correlation and the `inbound_events` dedupe) belongs to the core callback route; the rail loop only needs it for `verify_callback`. |
| `CallbackInbox` | Same: `inbound_events` insert/claim is owned by the callback worker; the port is synchronous and cannot await the insert. |
| `ReconciliationScheduler` | The production scheduler is a durable `REFUND_INQUIRY` background-job chain (`engine/workers/RefundInquiry.ts`), owned by the workers track. |
| `ReportingEvaluator` | Needs the regulatory reporting rule source/compiler and the encrypted `regulatory_reports` writes; optional in the rail loop. |
| `Clock` / `Rng` | Already provided by the crate (`SystemClock`, `FixedClock`, `OsRng`, `CounterRng`). |

## Adapter deviations (report to `DEVIATIONS.md`)

1. **Step cursor storage.** `FlowStore::load_cursor/save_cursor` have no TypeScript table (the TS
   engine re-runs a phase from its context). The adapter persists the cursor in the existing
   `worker_cursors` key/value table under `flow-cursor:{attemptId}:{phase}` (SHA-256 key when the
   name would exceed 96 characters). No migration was added.
2. **Merchant-direct zero commission.** `ConfirmationPosting` always returns a `PostedEntry`, while
   the TS `postPaymentConfirmation` returns `null` when the template has no line. The adapter
   returns `409 MERCHANT_DIRECT_ZERO_COMMISSION` instead of claiming a journal that does not exist;
   the confirm path must skip the ledger port for that case.
3. **SUSPENSE ownership.** `ScenarioPosting` carries no ownership mode, so `SUSPENSE_SETTLEMENT`
   always debits `GATEWAY_CLEARING` (the platform-clearing leg). The slot sink knows the attempt and
   posts the same scenario; an `INTERNAL` attempt that needs the treasury leg must post explicitly.
4. **Reserve error code.** The engine wraps every `SlotStore::reserve` failure as
   `409 SLOT_RESERVATION_FAILED`; the adapter message is the TS `PAYMENT_LINK_SLOT_UNAVAILABLE`
   ("The payment link has no available slot") because the port has no code field. No `LINK_BUSY` /
   `LINK_LOCKED` codes exist in the TypeScript slot store.
5. **Egress error mapping.** A gateway 4xx/5xx is returned as an `EgressResponse` (the documented
   engine contract: status rules run first). Only transport/response-validation failures become an
   `EgressError`; `money_uncertain` is preserved from the executor.
6. **`Cargo.toml`.** The task said `pg-db`, `pg-ledger` and `sqlx` were already added, but the file
   did not contain them when this work started; they were added exactly as specified.

## Tests

```bash
cd backend-rs
cargo test -p pg-flow-engine
cargo clippy -p pg-flow-engine --all-targets --no-deps -- -D warnings
cargo fmt -p pg-flow-engine
```

- `tests/adapters_db.rs` is database-gated: `PG_TEST_DATABASE_URL` (default
  `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test`) with schema 46. It prints
  `SKIP:` when unreachable. Every test opens one transaction, seeds a complete attempt fixture and
  rolls back, so the append-only journal and case event tables are never polluted. It covers the
  attempt projection, CAS status writes with `ATTEMPT_STATE_CONFLICT`, the single-writer confirm
  claim + idempotency hash, late-success finalize, cancel, step logs, flow materialisation, slot
  reserve/busy/commit, the SUSPENSE overflow journal + refund draft + P1 case, the case sink and
  ledger posting idempotency/rollback.
- `tests/adapters_egress.rs` uses a loopback HTTP server: JSON answer, API-key header, non-2xx
  answer mapping, multipart boundary ownership and money-uncertain transport failure.
