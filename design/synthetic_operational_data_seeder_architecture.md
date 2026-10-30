# MULTI-YEAR SYNTHETIC OPERATIONAL DATA SEEDER (BUILT ON FAKE RAILS) — MASTER ARCHITECTURE & TECHNICAL SPECIFICATION

**Target Repository:** `selmotamed-ctrl/payment-gateway-monolith`  
**Target Workspace Directories:** `core-back/prisma/syntheticSeeder/` · `fake-rails-back/api/portal/seederSync.ts` · `deploy/`  
**Database Engine:** MySQL 8.0+ / MariaDB 10.6+ (`@prisma/adapter-mariadb` + `Prisma.Decimal(18,4)`) synchronized with `fake-rails-back` (`bun:sqlite` WAL store)

## Executive Summary & Architectural Vision

A newly deployed payment gateway with only empty tables and static blueprint configs does not reveal how dashboards, server-side filters, pagination, SLA timers, Maker-Checker queues, reconciliation sweeps, AML case escalations, and financial statements behave under real multi-year operational load. Conversely, naive seeders that insert only `ACTIVE` merchants and `SUCCEEDED` payments fail to test the 90% of back-office and merchant workflows that deal with exceptions, in-flight states, disputes, holds, and historical drift.

This specification designs the **Multi-Year Synthetic Operational Data Seeder** (`core-back/prisma/syntheticSeeder/`), which synthesizes **3.5 years of continuous, chronological platform operation (`2023-05-01` through `2026-10-30`)** across all **66 Prisma models** in `core-back` and synchronizes every generated payment attempt, step log, webhook, and settlement statement directly into the **Standalone Fake Payment Rails Service** (`fake-rails-back`).

### Headline Architectural Guarantees

1. **Five-Layer Pre-Flight Safety Gate (Never Runs on a Real Production Server):**
   - Because test servers may run with `NODE_ENV="production"` to match production build optimizations, the seeder **never relies on `NODE_ENV` alone**.
   - It enforces a strict 5-layer pre-flight gate (`SeederSafetyGate.ts`) requiring: (1) `IS_TEST_SERVER === "true"` in environment variables, (2) `FAKE_RAILS_ENABLED === "true"`, (3) the database `platform_settings` key `server.environment_mode === "TEST_SANDBOX"`, (4) every configured Gateway in `core-back` having its `base_urls` pointed exclusively to `FAKE_RAILS_ALLOWED_HOSTS` (zero real external partner URLs), and (5) a live HTTPS handshake to `fake-rails-back/health` confirming the Fake Rails Service is deployed, reachable, and ready to receive synchronized transactions.
2. **100% Fake-Rails-Backed Transactions (Live Interactivity on Historical Data):**
   - Every seeded `PaymentAttempt` references the deployed Fake Rails (`Gateway`, `GatewayVersion`, `Rail`, `RailRoute`, `CredentialSet`) and is bulk-synced into `fake-rails-back`'s SQLite database (`fake_transactions` and `fake_step_events`).
   - As a result, when a tester opens `admin-front` after seeding and clicks **"Inquire Now"** on a seeded `UNKNOWN` payment attempt, or approves a **Refund Adjustment** on a seeded `SUCCEEDED` attempt from 4 months ago, or runs a **Statement Reconciliation**, `core-back` makes a real network call to `fake-rails-back` and receives a coherent, matching response for that seeded transaction.
3. **"Middle-of-Operation" Multi-State Realism (Year 3.5 Snapshot at `T_NOW`):**
   - Rather than generating uniform records, the seeder uses a chronological event-simulation engine driven by a deterministic PRNG (`xoshiro128**` seeded by `SYNTHETIC_SEED_KEY`).
   - At `T_NOW`, the database looks exactly like a live national payment switch at 15:00 Tripoli time after 3.5 years of operation: merchants in `ACTIVE`, `PENDING`, `SUSPENDED`, `REJECTED`, and `CLOSED`; join requests waiting in `IN_REVIEW`, `INFO_REQUESTED`, and `PENDING_CHECKER`; gateways with superseded, rolled-back, live, and draft versions; links with active in-flight slot locks (`active_locked_count > 0`); attempts currently sitting in `AWAITING_CUSTOMER`, `AUTHORIZING`, `VERIFYING`, and `UNKNOWN`; open `P1`/`P2` operator cases; pending four-eyes approvals; active disputes awaiting evidence; and `AML_HOLD` escrows awaiting MLRO review.
4. **Zero-Drift Double-Entry Ledger Integrity (`0.0000 LYD` Invariant Verified):**
   - Every financial event is posted through the exact 15 double-entry journal templates (`DECIMAL(18,4)`) rather than faking wallet balances. Historical months are snapshotted into `gl_accounts.checkpoint_balance` + `last_checkpoint_id`, and the seeder's final step runs `InvariantVerifier.verifySystemInvariant()` — aborting if drift is not strictly `0.0000 LYD`.

## 1. Pre-Flight Safety Gate & Fake Rails Dependency Verification

### 1.1 The Five-Layer Safety Gate (`core-back/prisma/syntheticSeeder/SeederSafetyGate.ts`)

Before a single row is written, `runSyntheticSeeder()` executes `assertSafeToSeedSyntheticData()`:

```ts
export async function assertSafeToSeedSyntheticData(prisma: PrismaClient): Promise<FakeRailsHealthReport> {
  // Gate 1: Explicit Test/Sandbox Server Declaration (independent of NODE_ENV)
  if (process.env.IS_TEST_SERVER !== "true") {
    throw new Error(
      "SEEDER_BLOCKED_NOT_TEST_SERVER: Refusing to run synthetic seeder because IS_TEST_SERVER is not 'true'. " +
      "This seeder is strictly restricted to designated test/sandbox servers."
    );
  }

  // Gate 2: Fake Rails Must Be Explicitly Enabled
  if (process.env.FAKE_RAILS_ENABLED !== "true" || !process.env.FAKE_RAILS_PUBLIC_BASE_URL) {
    throw new Error(
      "SEEDER_BLOCKED_FAKE_RAILS_DISABLED: FAKE_RAILS_ENABLED='true' and FAKE_RAILS_PUBLIC_BASE_URL are required."
    );
  }

  // Gate 3: If NODE_ENV === 'production', FAKE_RAILS_ALLOW_IN_PRODUCTION must also be 'true'
  if (process.env.NODE_ENV === "production" && process.env.FAKE_RAILS_ALLOW_IN_PRODUCTION !== "true") {
    throw new Error(
      "SEEDER_BLOCKED_PROD_GUARD: NODE_ENV is 'production' but FAKE_RAILS_ALLOW_IN_PRODUCTION is not 'true'."
    );
  }

  // Gate 4: Verify no GatewayEnvironment in MySQL points to a real external non-Fake-Rails host
  const allowedFakeHosts = new Set(
    (process.env.FAKE_RAILS_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean)
  );
  const envs = await prisma.gatewayEnvironment.findMany({ include: { gatewayVersion: { include: { gateway: true } } } });
  if (envs.length === 0) {
    throw new Error("SEEDER_BLOCKED_NO_FAKE_RAILS_SEEDED: Run seedFakeRails.ts first so fake gateways exist.");
  }
  for (const ge of envs) {
    const urls = Object.values((ge.baseUrls as Record<string, string>) ?? {});
    for (const rawUrl of urls) {
      const parsed = new URL(rawUrl);
      if (!allowedFakeHosts.has(parsed.hostname)) {
        throw new Error(
          `SEEDER_BLOCKED_EXTERNAL_HOST_DETECTED: Gateway '${ge.gatewayVersion.gateway.code}' points to '${parsed.hostname}', ` +
          `which is not in FAKE_RAILS_ALLOWED_HOSTS. Synthetic data can only be seeded against Fake Rails.`
        );
      }
    }
  }

  // Gate 5: Live Network Probe to Fake Rails Service + Shared Seeder Token Verification
  const healthUrl = new URL("/portal-api/internal/seeder-handshake", process.env.FAKE_RAILS_PUBLIC_BASE_URL);
  const res = await fetch(healthUrl.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fake-rails-seeder-token": process.env.FAKE_RAILS_SEEDER_TOKEN ?? "",
    },
    body: JSON.stringify({ check: "PRE_FLIGHT_SEEDER_SYNC" }),
  });
  if (!res.ok) {
    throw new Error(`SEEDER_BLOCKED_FAKE_RAILS_UNREACHABLE: Fake Rails handshake failed with HTTP ${res.status}`);
  }
  return (await res.json()) as FakeRailsHealthReport;
}
```

### 1.2 CLI & `deploy.env` Integration

In `deploy/deploy.env`, the operator can control synthetic seeding on test servers:

```ini
# --- 8. SYNTHETIC OPERATIONAL DATA SEEDER (TEST SERVERS WITH FAKE RAILS ONLY) -
RUN_SYNTHETIC_HISTORY_SEED="false"      # Set "true" to populate 3.5 years of multi-state operational history
SYNTHETIC_SEED_PROFILE="STANDARD"       # "COMPACT" (~15k attempts, 20s) | "STANDARD" (~120k attempts, 90s) | "STRESS" (~500k attempts)
SYNTHETIC_SEED_KEY="libya-pg-2023-2026" # Deterministic PRNG seed for 100% reproducible history
SYNTHETIC_YEARS_SPAN="3.5"              # Simulates operations from 2023-05-01 up to T_NOW
```

## 2. Chronological Simulation Engine & Volume Scaling Profiles

To make time-series charts, monthly wallet statements, cohort retention, clearing account ageing, and checkpoint balances mathematically consistent, the seeder simulates history **chronologically** from `T_START = T_NOW - 42 months` (`2023-05-01T08:00:00Z`) to `T_NOW` (`2026-10-30T15:00:00Z`).

### 2.1 Three Configurable Scale Profiles

| Entity Group | `COMPACT` (CI / Fast Dev) | `STANDARD` (Full Staging / Demo) | `STRESS` (Load & Index Benchmark) |
| :--- | :--- | :--- | :--- |
| **Time Span Simulated** | 3.5 Years (42 Months) | 3.5 Years (42 Months) | 4.0 Years (48 Months) |
| **Merchants (`merchants`)** | 65 | 250 | 1,200 |
| **Join Requests (`join_requests`)** | 80 | 310 | 1,500 |
| **KYB Documents & Beneficial Owners** | 420 docs / 150 owners | 1,650 docs / 580 owners | 7,800 docs / 2,800 owners |
| **Platform & Merchant Users (`users`)** | 160 | 640 | 3,000 |
| **Wallets & Applications** | 95 wallets / 130 apps | 380 wallets / 520 apps | 1,800 wallets / 2,500 apps |
| **Payment Links (`payment_links`)** | 8,500 | 65,000 | 280,000 |
| **Payment Attempts (`payment_attempts`)** | 15,000 | 120,000 | 500,000 |
| **Journal Entries & Lines** | ~22,000 entries / ~62,000 lines | ~175,000 entries / ~490,000 lines | ~720,000 entries / ~2.0M lines |
| **Reconciliation Runs & Items** | 180 runs / 12,000 items | 720 runs / 95,000 items | 1,460 runs / 400,000 items |
| **Disputes, Adjustments & Cashouts** | 350 | 2,400 | 10,000 |
| **AML Screenings, Matches & Cases** | 600 screenings / 95 cases | 2,800 screenings / 420 cases | 12,000 screenings / 1,800 cases |
| **Operator Cases & Approval Requests** | 450 | 2,900 | 11,500 |

### 2.2 Temporal Curve & Libyan Market Seasonality Model

The chronological generator modulates daily merchant onboarding and transaction volume using four realistic multipliers:
1. **3.5-Year S-Curve Adoption (`m = 1..42`):** Starts with 4 merchants and ~40 attempts/day in Month 1 (May 2023) as NeomPay, Sadad, and Edfali launch; accelerates in Year 2 as Moamalat Lightbox, T-LYNC, MyPay, and DPay routes go live; and reaches full maturity in Year 3–3.5 as CBL LYPay and OnePay instant-payment QR rails scale up.
2. **Intra-Week Rhythm:** Peak volume Saturday–Thursday (`09:00–22:00 Africa/Tripoli`), with a sharp Friday prayer dip (`11:30–14:30`) followed by Friday evening retail/restaurant POS activity.
3. **Seasonal Spikes:** `1.8x` volume surge during Ramadan and the last 10 days before Eid al-Fitr / Eid al-Adha, plus end-of-month salary disbursement spikes (`25th–3rd` of each month).
4. **Historical Outage & Incident Epochs:** Simulates 4 historical upstream gateway incidents over the 3.5 years (plus 1 active partial degradation right now at `T_NOW`) that naturally generated clusters of `UNKNOWN` attempts, circuit-breaker trips (`gateway_health_samples`), late webhook recoveries, and statement reconciliation mismatches.

## 3. Comprehensive Multi-State Distribution Across All 66 Database Models

Nothing in the seeded database is uniform. Every table contains records across its full state machine:

### 3.1 Group A & F: Merchants, Onboarding, KYB, Users & Applications

| Model (`Table`) | Seeded State Breakdown & Mid-Operation Scenarios |
| :--- | :--- |
| **`Merchant` (`merchants`)** | - **`ACTIVE` (62%):** Operating across `LOW` (25%), `STANDARD` (60%), and `HIGH` (15%) risk tiers; spanning Tripoli, Benghazi, Misrata, Zawiya, Sabha, and Tobruk.<br>- **`PENDING` (12%):** Currently mid-onboarding; half have `sandbox_before_approval` test attempts in `SANDBOX`! <br>- **`SUSPENDED` (11%):** Suspended across all 6 reason codes: `AML` (confirmed/potential watch-list hit), `FRAUD` (chargeback spike), `KYB_EXPIRED` (commercial registry expired > 30 days ago), `COMMISSION_CEILING` (`MERCHANT_DIRECT` merchant whose `COMMISSION_RECEIVABLE` exceeded `commission_receivable_ceiling` — Edge Case 48), `MERCHANT_REQUEST`, and `OTHER`. Includes **2 emergency suspensions** triggered in the last 12 hours awaiting `MLRO` ratification (`mode = EMERGENCY_RATIFICATION`)!<br>- **`REJECTED` (9%):** Rejected during onboarding (`UNVERIFIABLE_BUSINESS`, `INCOMPLETE_DOCUMENTS`, `PROHIBITED_ACTIVITY`, `POLICY`).<br>- **`CLOSED` (6%):** Operated for 8–20 months, processed hundreds of payments, cashed out to exactly `0.0000 LYD` wallet balance, and closed cleanly. |
| **`JoinRequest` (`join_requests`)** | - Covers **all 9 statuses**:<br>  • `APPROVED` (58% — both single-reviewer `LOW/STANDARD` and four-eyes `RISK_BASED` approvals with `four_eyes_reasons`),<br>  • `REJECTED` (11% — includes 4 applicants who re-applied under a new trade name/phone `resubmission_of_id`, triggering `DUPLICATE_OR_RELATED` flags — Edge Case 118),<br>  • `IN_REVIEW` (8% — currently assigned to operators, some approaching `sla_due_at`, and 2 overdue),<br>  • `INFO_REQUESTED` (6% — SLA clock paused waiting for merchant to re-upload a blurry tax certificate or bank letter),<br>  • `PENDING_CHECKER` (5% — Maker approved, sitting in Checker queue right now),<br>  • `SUBMITTED` (4% — freshly submitted today, unassigned),<br>  • `DRAFT` (3% — applicant partially filled form),<br>  • `WITHDRAWN` (2%), and `EXPIRED` (3% — abandoned drafts > 30 days old, Edge Case 116). |
| **`KybDocument` (`kyb_documents`) & `BeneficialOwner` (`beneficial_owners`)** | - Every merchant has 4–7 `kyb_documents` (`COMMERCIAL_REGISTRY`, `TAX_CERTIFICATE`, `ARTICLES_OF_ASSOCIATION`, `OWNER_ID`, `SIGNATORY_ID`, `PROOF_OF_ADDRESS`, `BANK_LETTER`, `SECTOR_LICENSE`).<br>- Statuses: `ACCEPTED` (78%), `UPLOADED` (10% — awaiting review in active join requests), `REJECTED` (6% — blurry/expired), `EXPIRED` (6% — `expires_on < T_NOW`, plus 8 documents expiring within the next 7–30 days that triggered `KYB_DOC_EXPIRING` notifications).<br>- Includes **3 deliberate SHA-256 duplicate document pairs** shared across two unrelated merchants to showcase the `DUPLICATE_DOCUMENT` compliance alert (Edge Case 120), and **2 rejected uploads with `av_status = INFECTED`**.<br>- `beneficial_owners`: 1–4 per merchant (`OWNER`, `DIRECTOR`, `SIGNATORY`, `CONTROLLER`), Arabic + English names, AES-256-GCM `national_id_ciphertext`, `pep_declared = true` on 4% of owners, and historical owner changes (`valid_to` set on former owners). |
| **`User` (`users`) & `UserIdentity` (`user_identities`)** | - **18 Platform Admin Users** across `GATEWAY_ADMIN`, `SECURITY_ADMIN`, `FINANCE`, `OPERATOR`, `COMPLIANCE`, `MLRO`, and `SUPPORT` (distinct Maker and Checker accounts per domain, plus `INVITED` and `SUSPENDED` staff accounts, and varied `academy_progress_json` completion badges).<br>- **Merchant Users:** `MERCHANT_ADMIN`, `MERCHANT_STAFF` (scoped to specific `app_scope_ids`), and `MERCHANT_CASHIER`, linked via `PHONE`, `EMAIL`, and `GOOGLE` OIDC `user_identities` (including unverified identities). |
| **`Wallet` (`wallets`), `Application` (`applications`), `AccessToken` & `PosTerminal`** | - Wallets in `ACTIVE` (82%), `PENDING` (8%), `FROZEN` (5% — linked to suspended/AML-held merchants), and `CLOSED` (5%). Includes **3 active wallets with negative balances** (e.g., `-45.0000 LYD` within `negative_balance_ceiling = 200.0000 LYD`) resulting from post-cashout chargebacks (Journal Entry 15)!<br>- Applications in `ACTIVE` (78%), `PENDING` (8%), `DRAFT` (5%), `SUSPENDED` (5%), `CLOSED` (4%), plus **6 applications with pending sensitive-field `approval_requests`** (changing `assigned_wallet_id`, `rail_whitelist`, or `redirect_domain_allowlist`).<br>- `access_tokens`: active and revoked `pg_live_` tokens with `access_token_ips` CIDR rules.<br>- `pos_terminals` (`ACTIVE`, `INACTIVE`, `BLOCKED`) and paired `pos_screens` (some active in the last 5 minutes, some idle). |

### 3.2 Group B, C & D: Fake Gateways, Version History, Credential Sets & Route Health

| Model (`Table`) | Seeded State Breakdown & Mid-Operation Scenarios |
| :--- | :--- |
| **`Gateway` & `GatewayVersion`** | - All 20 gateways seeded and bound to `FAKE_RAILS_PUBLIC_BASE_URL`:<br>  • **16 `LIVE` (`VERIFIED`) gateways**, each with a realistic version history: `v1` (`SUPERSEDED` from 2024), `v2` (`ROLLED_BACK` after a simulated timeout spike in 2025), and `v3` (`LIVE` with complete 12-Gate `GatewayVersionEvidence`).<br>  • **2 gateways with a `v4` in `PENDING_APPROVAL` / `SANDBOX_VERIFIED`** sitting in the Maker-Checker queue right now so admins can test the JSON-Patch version diff viewer and 1-click promotion!<br>  • **2 gateways in `DRAFT` (`UNVERIFIED`)** and **1 legacy gateway in `SUSPENDED` / `RETIRED`**.<br>  • **2 gateways marked `HIGH_RISK`** with recorded executive `risk_acceptance_note` approvals. |
| **`CredentialSet` (`credential_sets`)** | - **Platform Credential Sets (`owner_type = PLATFORM`):** `VERIFIED` sets for `SANDBOX` and `LIVE` across all active gateways (both `PLATFORM_CLEARING` and `PROVIDER_HELD` for aggregators), including 3 sets with overlapping `secret_version` (`v1` and `v2` active simultaneously to demonstrate zero-downtime key rotation, Edge Case 61).<br>- **Merchant-Owned Credential Sets (`owner_type = MERCHANT`, `settlement_target = MERCHANT_DIRECT`):** 18 merchant credential sets across `VERIFIED` (active direct settlement), `UNTESTED` (freshly entered by merchant, awaiting check), `FAILING` (token expired overnight — Edge Case 60), and `REVOKED`. |
| **`Rail` & `RailRoute` & `GatewayHealthSample`** | - All 20 customer-facing rails with full Arabic/English `help_guide_json` and `rail_fields`.<br>- Multi-route configurations on major rails (e.g., `edfali` has Route 1 direct via `edfali` gateway, Route 2 via `plutu`, Route 3 via `dpay`; `sadad` has direct + aggregator routes):<br>  • `ACTIVE` + `HEALTHY` (75% of routes),<br>  • `ACTIVE` + `DEGRADED` (2 routes experiencing elevated p95 latency today),<br>  • `ACTIVE` + `OPEN_BREAKER` (1 aggregator route whose circuit breaker tripped 20 minutes ago, automatically failing traffic over to the direct route!),<br>  • `DRAINING` (1 route being phased out with 2 in-flight attempts still pinned to it — Edge Case 109),<br>  • `PAUSED` (2 routes paused by admin or maintenance window).<br>- 30 days of hourly `gateway_health_samples` (`p50_ms`, `p95_ms`, `p99_ms`, `successes`, `definitive_failures`, `ambiguous_unknowns`, `rate_limits_429`) populating all health charts. |

### 3.3 Group E: Payment Links, Attempts (All 14 States) & Synchronization with Fake Rails

| Status / Category | Share | Exact Operational & Invariant Rules Enforced by Seeder |
| :--- | :--- | :--- |
| **`SUCCEEDED`** | **68.0%** | Validated across all 20 Fake Rails and all 3 Fee Bearers (`MERCHANT_ABSORBS`, `PAYER_SURCHARGE`, `SPLIT`) and all 3 Settlement Targets (`PLATFORM_CLEARING`, `PROVIDER_HELD`, `MERCHANT_DIRECT`, plus `INTERNAL` NeomPay). Every single row has a balanced `JournalEntry` (`ledger_entry_id`) and increments `payment_links.confirmed_count`. |
| **`FAILED`** | **11.5%** | Includes terminal declines (`INSUFFICIENT_FUNDS`), `LIMIT_EXCEEDED` (customer CBL ceiling hit — excluded from breaker count), 3x wrong OTP lockout (`otp_attempts = 3`), and pre-point-of-no-return gateway faults that triggered route failover within the same `AttemptGroup`. Slot lock released (`active_locked_count` decremented). |
| **`EXPIRED`** | **7.0%** | Customer abandoned OTP, Redirect, QR, or Push screen past `expires_at = min(gateway_ttl, platform_ttl)`. Pre-expiry `VERIFY` inquiry logged in `attempt_step_logs`. Includes **8 Late-Success Recovery cases** where a webhook arrived during `grace_expires_at` and recovered `EXPIRED -> SUCCEEDED` (or routed to `SUSPENSE` if the single-use link was already paid by another attempt — Edge Case 10 & 41)! |
| **`CANCELLED`** | **3.5%** | Cancelled by customer or POS cashier before `point_of_no_return`. |
| **`BLOCKED`** | **2.5%** | Blocked at initiation by Guard Pipeline: Velocity `REJECT` rules (SMS pumping / IP flood), hot-path AML watch-list hits, and NeomPay anti-self-dealing (`SELF_PAYMENT_NOT_ALLOWED` — Edge Case 134). |
| **`REFUNDED` & `PARTIALLY_REFUNDED`** | **2.5%** | Linked to executed `REFUND` `Adjustment` rows (`provider_refund_ref` populated from `fake-rails-back`) and balanced reversal `JournalEntry` rows (Entries 9 & 14). |
| **`DISPUTED`** | **1.5%** | Linked to `disputes` rows (`OPENED`, `EVIDENCE_REQUESTED`, `EVIDENCE_SUBMITTED`, `WON`, `LOST`, `EXPIRED`) and corresponding `CHARGEBACK` `Adjustment` rows. |
| **In-Flight & Stuck States at `T_NOW` (`CREATED`, `INITIATING`, `AWAITING_CUSTOMER`, `AUTHORIZING`, `VERIFYING`, `UNKNOWN`)** | **3.5%** (~450 rows in `STANDARD`) | **Active right now when the tester opens the portal:**<br>- **`AWAITING_CUSTOMER`:** Customers currently on `OTP_REQUIRED` (`otp_attempts = 0, 1, 2`), `REDIRECT_PENDING`, `WIDGET_OPEN`, `QR_PENDING`, `PUSH_PENDING`, `CODE_PENDING`, and `TRANSFER_PENDING` (`expires_at` is 3 to 18 minutes in the future; `active_locked_count = 1` reserved on the link!).<br>- **`AUTHORIZING` & `VERIFYING`:** Currently polling `next_check_at` or awaiting AML Hold resolution (`substatus = 'AML_HOLD'`).<br>- **`UNKNOWN` (35 active cases):** `MOVES_MONEY` confirm calls that timed out or returned HTTP 502/500 or conflicting webhook/inquiry signals (`P1 CONFLICT`), holding their link's `active_locked_count` slot and linked to open `operator_cases` in the Admin Back Office! |

### 3.4 Double-Entry Ledger, Checkpoints, Reconciliation, AML & Maker-Checker Queues

1. **All 15 Journal Entry Templates Exercised (`journal_entries` & `journal_lines`):**
   - The seeder never writes raw numbers to `gl_accounts`. Every confirmed payment, T+N settlement sweep, fee variance true-up, `MERCHANT_DIRECT` commission receivable & wallet netting, `AML_HOLD` escrow, `AML_RELEASE`, `AML_VOID`, `CASHOUT_SUBTRACTION`, `REFUND`, `CHARGEBACK` reserve, `DISPUTE_OUTCOME` (`WON`/`LOST`), `INTERNAL` NeomPay settlement, and `SUSPENSE` duplicate-payment capture is posted via `LedgerPoster` templates.
   - **Monthly Checkpoint Snapshots:** At the end of each simulated historical month (`2023-05` through `2026-09`), the seeder runs `CheckpointService` to set `checkpoint_balance`, `last_checkpoint_id`, and `checkpoint_at` on every `GlAccount`. October 2026 journal lines remain post-checkpoint so live balance queries (`checkpoint_balance + SUM(lines > last_checkpoint_id)`) exercise both parts of the formula.
2. **T+N Statement Reconciliation History (`reconciliation_runs` & `reconciliation_items`):**
   - Seeds 42 months of daily/weekly `ReconciliationRun` rows across all statement-enabled gateways, leaving 97% of items `MATCHED` (with `SETTLEMENT_SWEEP` and `FEE_VARIANCE` journal entries posted) and leaving **28 open unmatched/mismatched items** (`AMOUNT_MISMATCH`, `MISSING_AT_GATEWAY`, `MISSING_LOCALLY`, `DUPLICATE`) linked to open `operator_cases` for Finance to inspect.
3. **7-Layer AML & Compliance History (`aml_screenings`, `aml_screening_matches`, `aml_cases`, `regulatory_reports`):**
   - Onboarding, periodic, list-update, and transaction-time screenings across `CLEAR` (88%), `POTENTIAL_MATCH` (9% — some dispositioned as `FALSE_POSITIVE` with `suppress_future = true`, some `UNREVIEWED` in the Compliance queue), `CONFIRMED_MATCH` (2% — sanctions/PEP hits), and `ERROR` (1% — provider outage holding a join request in `IN_REVIEW`, Edge Case 124).
   - `aml_cases` across `OPEN`, `IN_REVIEW`, `PENDING_CHECKER` (analyst proposed release/void, waiting for `MLRO` checker), `RELEASED`, `REJECTED_VOID`, `FROZEN`, and `ESCALATED_STR`.
   - `regulatory_reports` (`LARGE_TRANSACTION`, `SUSPICIOUS_ACTIVITY`, `PERIODIC_RETURN`) across `DRAFT`, `PENDING_CHECKER`, `APPROVED`, `SUBMITTED`, `ACKNOWLEDGED`, and `REJECTED_BY_AUTHORITY`.
4. **Active Maker-Checker Approval Queue (`approval_requests`):**
   - Seeds both historical decided approvals (`EXECUTED`, `REJECTED`) and **24 live `PENDING_REVIEW` / `EMERGENCY_RATIFICATION` requests** across every domain (gateway version go-live, commission profile change, velocity rule edit, AML case release, refund adjustment, chargeback reserve, merchant bank account edit, and emergency merchant suspension ratification) so any Checker logging into `admin-front` immediately has a rich queue to review.

## 4. Two-Phase Seeder Execution & Fake Rails Bulk Synchronization Pipeline

Inserting ~120,000 attempts and ~490,000 journal lines one-by-one via individual Prisma `.create()` calls would take 20+ minutes. The seeder uses a **Batch-Compiled Two-Phase Pipeline** that completes the entire `STANDARD` 3.5-year dataset in **under 90 seconds**:

```text
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: IN-MEMORY CHRONOLOGICAL GRAPH & LEDGER COMPILER (Deterministic PRNG)       │
│  1. Reads seeded Fake Gateways, Routes, CredentialSets & System GL Accounts         │
│  2. Simulates Day 1 (2023-05-01) -> Day 1,278 (2026-10-30):                         │
│     • Merchant cohorts, JoinRequests, KYB docs, Wallets, Apps, Links                │
│     • PaymentAttempts across all 14 states + StepLogs + InboundEvents               │
│     • Double-Entry JournalEntries & JournalLines + Monthly GL Checkpoints           │
│     • Cashouts, Disputes, Adjustments, AML Cases, Recon Runs, Approvals             │
│  3. Verifies in-memory Trial Balance == 0.0000 LYD & Slot Reservation Invariants    │
└───────────────────┬───────────────────────────────────────────────┬─────────────────┘
                    │                                               │
                    ▼ (Chunked createMany: 2,500 rows/tx)           ▼ (POST /portal-api/internal/bulk-seed)
┌───────────────────────────────────────────┐   ┌─────────────────────────────────────┐
│ PHASE 2A: MYSQL / MARIADB BULK INSERT     │   │ PHASE 2B: FAKE RAILS SQLITE SYNC    │
│  • Inserts all 66 tables in topological   │   │  • Streams chunked NDJSON of all    │
│    FK order using Prisma createMany       │   │    seeded attempts & step events    │
│  • Runs InvariantVerifier.verify()        │   │  • Populates fake_transactions &    │
│    asserting 0.0000 LYD drift             │   │    fake_step_events in SQLite WAL   │
└───────────────────────────────────────────┘   └─────────────────────────────────────┘
```

### 4.1 Fake Rails Bulk Synchronization Endpoint (`POST /portal-api/internal/bulk-seed`)

When Phase 2B runs, `core-back` streams batches of 5,000 `fake_transactions` and `fake_step_events` records to `fake-rails-back` authenticated by `X-Fake-Rails-Seeder-Token`:
- `fake-rails-back` wraps each batch in a single SQLite `BEGIN IMMEDIATE ... COMMIT` transaction (`INSERT OR REPLACE INTO fake_transactions ...`).
- Every `AWAITING_CUSTOMER`, `VERIFYING`, `UNKNOWN`, and `SUCCEEDED` attempt in `core-back` now has a matching record in `fake-rails-back` with the exact same `our_reference`, `provider_reference`, `network_reference`, `requested_amount_wire`, `settled_amount_lyd`, `expected_otp`, and `status`.
- Consequently:
  1. Opening the **Fake Rails Tester Portal (`/transactions` or `/dashboard`)** immediately shows the full 3.5-year transaction history and all currently pending OTP/QR/Push transactions!
  2. Clicking **"Inquire"** in `admin-front` on any seeded `UNKNOWN` attempt queries `fake-rails-back`, which returns the authoritative status and resolves the `UNKNOWN` attempt live!
  3. Approving a **Refund Adjustment** in `admin-front` on any seeded `SUCCEEDED` attempt executes the `REFUND` flow against `fake-rails-back` and transitions the transaction to `REFUNDED` on both sides!

## 5. Directory Structure of the Synthetic Seeder Module

```text
core-back/prisma/syntheticSeeder/
├── index.ts                            # CLI entrypoint (`bun run seed-synthetic-history`)
├── SeederSafetyGate.ts                 # 5-layer pre-flight safety & Fake Rails reachability verifier
├── prng.ts                             # Deterministic xoshiro128** PRNG + weighted distribution samplers
├── timelineClock.ts                    # 3.5-year chronological iterator with Tripoli hours & Ramadan spikes
├── libyanDataCatalog.ts                # Authentic Libyan Arabic/English names, cities, banks, phones, tax IDs
├── generators/
│   ├── 01_adminAndStaffGenerator.ts    # Admin roles, maker/checker pairs, academy progress
│   ├── 02_merchantCohortGenerator.ts   # Merchants (5 states), JoinRequests (9 states), KYB, Owners, Dupes
│   ├── 03_gatewayLifecycleGenerator.ts # Version history (SUPERSEDED/ROLLED_BACK/LIVE/DRAFT), Route health
│   ├── 04_linksAndAttemptsGenerator.ts # Links, AttemptGroups, Attempts (all 14 states), StepLogs, Webhooks
│   ├── 05_ledgerAndCheckpoints.ts      # All 15 Journal Entry templates + monthly GL checkpoints
│   ├── 06_reconAndStatements.ts        # 42 months of ReconciliationRuns & matched/mismatched items
│   ├── 07_disputesCashoutsAdjustments.ts# Disputes, SYSTEM_AUTOMATION chargebacks, refunds, cashouts
│   └── 08_amlAndGovernanceQueues.ts    # AML screenings/matches/cases/reports, OperatorCases, Approvals
├── sync/
│   ├── bulkMysqlWriter.ts              # Topological FK-ordered chunked createMany writer
│   └── fakeRailsBulkSyncClient.ts      # Streams seeded transactions to fake-rails-back SQLite store
└── verify/
    └── postSeedAudit.ts                # Asserts 0.0000 LYD ledger drift, slot invariants & FK integrity
```

## 6. OpenCode Implementation Checklist for the Synthetic Data Seeder

- [ ] **`SD-1` Implement `SeederSafetyGate.ts` & Deterministic PRNG (`prng.ts`, `libyanDataCatalog.ts`):** Enforce all 5 pre-flight safety gates (`IS_TEST_SERVER="true"`, `FAKE_RAILS_ENABLED="true"`, `FAKE_RAILS_ALLOW_IN_PRODUCTION`, zero external gateway hosts, and live handshake to `fake-rails-back`) so the seeder can never run against real gateways or a non-test server.
- [ ] **`SD-2` Implement Merchant, KYB, Beneficial Owner & Gateway Version Generators (`01`–`03`):** Generate multi-state merchants (`ACTIVE`, `PENDING`, `SUSPENDED`, `REJECTED`, `CLOSED`), join requests across all 9 states, duplicate SHA-256 KYB documents, expired KYB docs, merchant-direct credential sets, and gateway version histories.
- [ ] **`SD-3` Implement Chronological Payment Attempt & 15-Template Ledger Compiler (`04`–`05`):** Simulate 3.5 years of transactions across all 20 Fake Rails and all 14 `AttemptStatus` values (including active in-flight and `UNKNOWN` attempts at `T_NOW`), generating mathematically balanced `JournalEntry` and `JournalLine` rows and monthly `GlAccount` checkpoints.
- [ ] **`SD-4` Implement Reconciliation, Disputes, Cashouts, AML & Maker-Checker Generators (`06`–`08`):** Populate 42 months of statement reconciliation runs (with open mismatches), automated chargeback drafts, refunds, cash-outs, negative-balance wallets, AML cases/reports, operator cases, and pending Maker-Checker approvals.
- [ ] **`SD-5` Implement Chunked MySQL Writer, Fake Rails Bulk Sync & Post-Seed Invariant Audit:** Write `bulkMysqlWriter.ts`, `fakeRailsBulkSyncClient.ts` (`POST /portal-api/internal/bulk-seed`), and `postSeedAudit.ts` verifying `InvariantVerifier` = `0.0000 LYD` drift; wire `RUN_SYNTHETIC_HISTORY_SEED` into `deploy/deploy.ts`.
