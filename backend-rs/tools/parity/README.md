# Parity harness (P0-T10 / P0-T11)

Bun/TypeScript tooling that proves HTTP and database parity between the TypeScript
services and the Rust/ntex port. No new dependencies: Bun, `openssl`, and the PostgreSQL
client binaries are all it needs.

| File | Purpose |
| :--- | :--- |
| `normalize.ts` | configurable response normaliser + structural differ |
| `edge-launcher.ts` | start/poll/stop a TS or Rust edge on a free port |
| `replay.ts` | read-replay runner with an in-process fake core (`--ts-vs-ts` self-check) |
| `fixtures.ts` | fixture loader/placeholder expansion + inventory seeding |
| `db-diff.ts` | semantic PostgreSQL differ for dual-DB write runs (`Bun.SQL`) |
| `db-fixture.ts` | COMPACT dump/checksum/restore helper (P0-T11) |
| `parity-md.ts` | generates the per-route `PARITY.md` table from inventory + `status.json` |
| `status.json` | per-route ledger: `live-rs`, `scaffold`, or `todo` |
| `PARITY.md` | generated table (currently 1,152 unique routes) |

Fixtures live in `backend-rs/tests/parity-fixtures/`; see its README for the format and the
10-case smoke set.

---

## Quick start

```bash
# Harness self-check: TS against TS, must be zero diffs.
bun backend-rs/tools/parity/replay.ts --ts-vs-ts

# TS against Rust. The Rust edge is the release binary when present, else `cargo run`.
EDGE_UNDER_TEST=rs bun backend-rs/tools/parity/replay.ts

# Normalisation rules and unit tests.
bun backend-rs/tools/parity/replay.ts --print-rules
bun test backend-rs/tools/parity/normalize.test.ts backend-rs/tools/parity/fixtures.test.ts

# Generate PARITY.md + the status ledger after an inventory change.
bun backend-rs/tools/parity/parity-md.ts --seed-status --write
bun backend-rs/tools/parity/parity-md.ts --check

# Dual-database semantic diff.
DATABASE_URL=postgres://.../parity_ts DATABASE_URL_B=postgres://.../parity_rs \
  bun backend-rs/tools/parity/db-diff.ts

# P0-T11 database fixture (destructive restore requires --yes).
DATABASE_URL=postgres://.../seeded bun backend-rs/tools/parity/db-fixture.ts dump
bun backend-rs/tools/parity/db-fixture.ts verify
DATABASE_URL_B=postgres://.../parity_rs bun backend-rs/tools/parity/db-fixture.ts restore --yes
```

`replay.ts` options: `--ts-vs-ts`, `--rs-vs-rs`, `--edge-pair=ts-rs`, `--fixtures`,
`--channel`, `--json[=<path>]`, `--verbose`, `--seed-from-inventory[=<dir>]`,
`--per-channel`, `--print-rules`.

Environment: `EDGE_UNDER_TEST` (`ts|rs`, right-hand side when no pair is given),
`PARITY_PKI_DIR` (reuse mTLS material), `PARITY_TMP_DIR` (default `/tmp/opencode`),
`PARITY_MERCHANT_TOKEN`, `PARITY_ADMIN_TOKEN`, `PARITY_KEEP_PKI`.

---

## Edge launcher

`startEdge({ channel, env, implementation })`:

- `ts`: `bun <channel>-back/index.ts` (the real service, not a test double).
- `rs`: `backend-rs/target/release/<channel>-edge serve` when present; otherwise
  `cargo run -q -p <channel>-edge -- serve` from `backend-rs/`. **The harness never invokes
  `cargo build`.** The fallback exists for a warm developer cache; CI should build the release
  binaries first so the run is fast and deterministic.
- Binds `127.0.0.1:<free port>` (`PORT`; `ADMIN_BIND_HOST` too), waits up to 30 s for
  `GET /health` to return 200, records stdout/stderr (last 300 lines) and stops the process
  group with SIGTERM, then SIGKILL after 5 s.

The TS edges validate their environment at boot and **require TLS for the core URL**:
`CORE_BACK_URL` must be `https://`, and `MTLS_CLIENT_CERT_PATH` / `MTLS_CLIENT_KEY_PATH` /
`MTLS_CA_CERT_PATH` must exist. `edgeEnvironment()` supplies exactly those plus loopback
bind/proxy settings. The fake core terminates TLS 1.3 and requires a client certificate, so the
mTLS path is exercised rather than bypassed. PKI is generated with `openssl` per run into
`PARITY_TMP_DIR`; `PARITY_PKI_DIR` reuses a fixed set (`ca.crt`, `ca.key`, `server.crt`,
`server.key`, `client.crt`, `client.key`).

If `openssl` is unavailable the harness fails with `PARITY_PKI_UNAVAILABLE`. If no Rust release
binary exists and `cargo` is unavailable, the Rust side fails with the captured process log.
There is no plain-HTTP mode: the TS schema rejects it.

## Fake core contract

`replay.ts` starts one in-process `Bun.serve` HTTPS server per run and records every upstream
request (`method`, `path` including query, lower-cased headers, body). It answers:

| Upstream path | Response |
| :--- | :--- |
| `GET /health` | `{ status, service, uptime, serverTime }` |
| `.../internal/checkout/pay/:linkKey` | synthetic link: amount `100.0000`, `LYD`, `visible_rails`, `scopes`, generated id/requestId/timestamps |
| `.../pay/:linkKey/logs/:attemptId[/status]` | attempt timeline/status |
| `.../pay/:linkKey/initiate` | 201 attempt with `clientAction: SHOW_OTP_FORM` |
| `.../pay/:linkKey/confirm|resend|cancel` | 200 settled attempt |
| `.../internal/checkout/return/:token` | reference + SUCCEEDED |
| `.../internal/checkout/academy/certificates/:id` | certificate verification payload |
| `.../internal/merchant/<resource>` | list envelope for payments/links/wallets and a generic fallback |
| `.../internal/admin/stats/overview` | dashboard metrics with `byCurrency` |
| `.../internal/admin/rails`, `.../merchants` | list envelopes |
| anything else under `/internal/` | deterministic `{ ok, path, requestId, ... }` |
| anything else | 404 `CORE_NOT_FOUND` |

Two properties matter:

1. **Deterministic content**: the same request always gets the same business values.
2. **Volatile fields are deliberate**: every relevant response carries a fresh UUID, an ISO
   timestamp and request ids, so the self-check fails immediately if the normaliser stops
   removing them.

Every parity case must make exactly one upstream call. The report compares the upstream request
by `x-request-id` (when the fixture pins one) or by position: method, path+query, body, and the
edge-owned headers (`accept`, `authorization`, `content-type`, `x-client-user-agent`,
`x-edge-service`, `x-pg-min-lsn`, `x-real-client-ip`, `x-request-id`).

## Normalisation rules

`normalize.ts` exports `normalizeResponse`, `diffResponses`, `pathMatches`, `formatDifferences`
and `ruleTableLines`. The default table:

| id | scope | match | action |
| :--- | :--- | :--- | :--- |
| `status` | status | HTTP status line | exact |
| `headers.allowlist` | headers | `content-type`, `content-disposition`, `cache-control`, `x-content-sha256`, `x-pg-*`, `ratelimit`, `ratelimit-*`, `retry-after`, `location`, `set-cookie` | keep |
| `headers.volatile` | headers | `date`, `etag`, `age`, `server`, `connection`, `keep-alive`, `transfer-encoding`, `content-length`, `x-request-id`, `x-trace-id`, `x-pg-request-id`, `x-pg-trace-id` | drop |
| `headers.ratelimit-number` | headers | `remaining=N`, `reset=N` | `<n>` |
| `body.volatile-key` | body | `requestId`, `request_id`, `traceId`, `trace_id`, `spanId`, `span_id`, `release`, `commit`, `build`, `uptime`, `generatedAt`, `createdAt`, `updatedAt`, `deletedAt`, `issuedAt`, `expiresAt`, `serverTime`, `webhook-id`, `nonce` | drop |
| `body.detail-message` | body | `details/*/message` (design ch.8 §3.1) | drop |
| `body.uuid` | body | canonical UUID string | `<uuid>` |
| `body.iso-timestamp` | body | RFC 3339 string | `<timestamp>` |
| `body.jwt` | body | three-segment JWT | `<jwt>` |
| `body.lsn` | body | `^[0-9A-Fa-f]{1,16}/[0-9A-Fa-f]{1,16}$` | `<lsn>` |
| `body.set-key` | body | arrays under `authorities`, `scopes`, `permissions`, `roles`, `tags` | sort |
| `body.key-order` | body | every object | sort keys |

- Paths use `/` segments; `*` matches one segment, `**` matches zero or more; a leading `body/`
  is accepted.
- Arrays keep order unless a path/key marks them as sets.
- JSON object key order is normalised by default (a byte-order difference with equal values is
  noise). Set `keyOrder: "preserve"` when a route genuinely depends on insertion order; true
  canonical-JSON formats belong in golden vectors instead.
- Rate-limit counters are normalised because two sequential runs can cross a one-second tick.
  `pinRateLimit: true` compares them exactly.
- Header values are placeholder-normalised too (e.g. an LSN echoed in `x-pg-min-lsn`).

Per-case overrides in a fixture: `normalize.dropKeys`, `keepKeys`, `dropPaths`,
`unorderedPaths`, `unorderedKeys`, `orderedKeys`, `placeholders`
(`{ name, pattern, flags?, placeholder?, substring? }`), `headerAllowlist`,
`headerAllowPrefixes`, `dropHeaders`, `keepHeaders`, `keyOrder`, `pinRateLimit`,
`ignoreDetailMessages`, `ignoreStatus`. `--print-rules` prints the table.

## Dual-database differ

`db-diff.ts` connects to A (`DATABASE_URL`) and B (`DATABASE_URL_B`) with Bun's built-in
`Bun.SQL` (no `pg` dependency). If the runtime lacks `Bun.SQL` it prints
`PG_DRIVER_MISSING` and exits 2; run it with Bun >= 1.2. `pg` is deliberately not
required and is not silently substituted.

- Discovers every base table in `public` (`pg_class.relkind = 'r'`, so partitioned parents are
  not double-counted through their children).
- Compares `count(*)` and a row-set checksum: each row is `md5(jsonb_build_array(<columns>))`,
  rows are sorted by hash before `string_agg`, so physical order is irrelevant.
- Ignores `id` and `*_at`/`*At`/`timestamp` columns by default, plus configurable volatile
  columns. `--strict-ids` keeps `id`. A FK to a generated id must be ignored through `--rules`
  when the scenario creates new parents; compare the relationship by business key instead.
- Exact checks: `ledger.balances` (`gl_account_shards.current_balance`, `line_seq` per business
  account), `ledger.journal_totals` (debit/credit sums and line counts per currency),
  `outbox.by_topic` (processed/parked buckets) and `outbox.total`.
- `--rules` JSON: `{ "ignoreColumns": [...], "tables": { "<table>": { "ignoreColumns": [...],
  "skip": true, "note": "..." } } }`. `--json` writes the full report.
- Exit codes: 0 equal, 1 differences, 2 harness/driver/connection error.

The check was exercised against two throwaway PostgreSQL 18 databases: identical data → PASS,
then a changed business value and a changed `gl_account_shards.current_balance` → two table diffs
plus a failed ledger exact check.

## Route parity ledger

`parity-md.ts` reads the committed inventory
(`backend-rs/tests/golden-vectors/route-inventory/{routes,edge-routes}.json`) and
`status.json`, and writes `PARITY.md` (default next to the tool; `--out backend-rs/PARITY.md`
publishes it to the coordinator-owned root file).

- Three duplicate inventory rows (two `admin-back` auth aliases, one duplicated core sandbox
  route) collapse into one row with an `N inventory aliases` note → **1,152 unique routes**
  (610 core, 417 admin, 106 merchant, 19 checkout). Each row carries the method, route, Rust
  target, TS origin (`file:line`) and notes.
- Status values are exactly `live-rs`, `scaffold`, `todo`. Today: `/health` on core and the three
  edges is `scaffold`; everything else is `todo`.
- `--check` fails on a route with no status entry, an unknown status, a note for an unknown
  route, or a `PARITY.md` that no longer matches `status.json`. `--strict` also fails on stale
  entries. `--seed-status` adds new routes as `todo` and preserves existing entries. `--write`
  refuses to update the table when an existing ledger is missing routes; run `--seed-status
  --write` so the new routes are visible in the diff.

## P0-T11 database fixture

`db-fixture.ts` produces `tests/parity-fixtures/db/compact.dump` with
`compact.json` (bytes, SHA-256, creation time, schema version, seed profile). The dump is a CI
artefact and is not committed. `verify` recomputes the checksum; `restore --yes` runs
`pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error` into
`DATABASE_URL_B` and refuses without `--yes`. `PG_BIN_DIR` locates PostgreSQL 18 binaries when
they are not on `PATH`.

## Limitations

- The Rust edges are P2 scaffolds: only `/health` is live; every other route answers
  501 (or 404 for an unmatched path). `EDGE_UNDER_TEST=rs` therefore reports deterministic
  non-parity diffs until those routes land; that is expected and is why `--ts-vs-ts` is the
  acceptance gate.
- The fake core covers the smoke read paths, not every route. A new parity case for an uncovered
  path needs a branch in `fakeCoreResponse` (or a recorded proxy) before it can pass.
- SSE/streaming, multipart and redirect chains with external hosts are outside the read replayer.
  `fetch` follows no redirects (`redirect: "manual"`), shown by the checkout return case.
- Admin fixtures run from loopback: `enforceLanAccess` trusts `x-real-ip` on loopback, so a
  public client address in an admin fixture would produce `403 ADMIN_LAN_ONLY`.
- The normaliser intentionally hides clocks, generated ids and set order. It does **not** hide
  money, statuses, error codes or business references; those must match exactly.
- The DB differ compares rows by checksum, not by business-key join. It cannot tell you *which*
  row differs inside a table (only count/checksum), and it does not reconcile generated FKs
  automatically. Use the JSON report and a targeted SQL query for the pair that differs.
- `db-fixture` needs `pg_dump`/`pg_restore` 18 and a database seeded with the COMPACT profile; no
  dump is stored in the repository.
- `parity-md.ts` writes next to the tool by default because `backend-rs/PARITY.md` is owned by
  the coordinator; pass `--out backend-rs/PARITY.md` when publishing. The table covers the two
  requested inventories only: the object-storage daemon, fake-rails, backup daemon and worker
  runtimes are tracked in the root `PARITY.md` instead.

## Adding a parity case

1. Pick a GET route that already exists in the inventory and whose response the fake core can
   produce. Add a branch to `fakeCoreResponse` if needed.
2. Add a case to `backend-rs/tests/parity-fixtures/reads/<channel>.json` with a unique
   `x-request-id`, deterministic path/query and any auth placeholder.
3. Run `replay.ts --ts-vs-ts --verbose`. Zero diffs is the harness self-check. If the case legitimately
   contains an unordered set or a generated reference, add a `normalize` override rather than
   dropping the field.
4. Once the Rust route is live, run `EDGE_UNDER_TEST=rs bun backend-rs/tools/parity/replay.ts
   --channel <channel>` and record the evidence in `PARITY.md`/the tracker.
5. Keep the status ledger honest: a route is `live-rs` only when the Rust implementation serves
   it in a deployed release, not when a stub answers 404/501.

## Verified in this environment

- `bun backend-rs/tools/parity/replay.ts --ts-vs-ts` → **PASS, 10/10 cases, 0 response diffs,
  0 upstream diffs**, with the real `checkout-back`, `merchant-back` and `admin-back` services
  started against the mTLS fake core.
- `bun test backend-rs/tools/parity/normalize.test.ts` → 13/13.
- `bun test backend-rs/tools/parity/fixtures.test.ts` → 3/3 (ten-case shape, placeholder
  expansion, inventory seeding).
- `bun backend-rs/tools/parity/parity-md.ts --check` → 1,152 routes up to date; missing/invalid
  status and stale markdown were negative-tested.
- `db-diff.ts` equal/diff scenarios and `db-fixture.ts` dump/verify/restore were exercised
  against throwaway PostgreSQL 18 databases.
