# Parity fixtures

Inputs for `backend-rs/tools/parity/replay.ts` and the P0-T11 database fixture helper.

```
reads/
  checkout.json      4 GET cases (payer link, attempt log, return redirect, certificate)
  merchant.json      3 GET cases (payments, links, wallets)
  admin.json         3 GET cases (dashboard overview, merchants, rails)
generated/           optional output of `replay.ts --seed-from-inventory` (not committed)
db/                  optional COMPACT pg_dump + manifest (CI artefact, not committed)
```

The 10 read cases are the deterministic smoke set. They run against the fake core in
`replay.ts` and are compared between the TS edge and the edge under test
(`--ts-vs-ts` for the harness self-check).

## Fixture format

A file is either a bare JSON array of cases or:

```json
{
  "channel": "checkout",
  "cases": [
    {
      "name": "payer link view",
      "method": "GET",
      "path": "/api/v1/pay/LNKPARITY01",
      "headers": {
        "accept": "application/json",
        "x-request-id": "parity-checkout-0001",
        "x-forwarded-for": "203.0.113.10"
      },
      "body": null,
      "normalize": {
        "unorderedPaths": ["visible_rails"],
        "placeholders": [
          { "name": "generated-ref", "pattern": "^PARITY-REF-\\d+$", "placeholder": "<ref>" }
        ]
      },
      "notes": "why this case exists"
    }
  ]
}
```

- `channel` is `checkout`, `merchant` or `admin`; it may also come from the filename
  (`merchant.json`, `merchant-lists.json`).
- `method`/`path` are the public edge route. `headers` are sent unchanged to both edges.
- `body` is serialised as JSON and gets `content-type: application/json` when present.
- `normalize` is per-case; it overrides the defaults documented in
  `backend-rs/tools/parity/README.md` (drop/keep keys and paths, unordered/ordered paths and
  keys, extra placeholders, header allowlist/prefixes, key order, rate-limit pinning, detail
  messages, status).
- Every case must reach the fake core exactly once. Pin `x-request-id` so the upstream request
  can be paired and compared. Use a distinct id per case.

Placeholders expanded in headers, path and string bodies:

| Placeholder | Value |
| :--- | :--- |
| `{{PARITY_MERCHANT_TOKEN}}` | synthetic HS256-shaped session, `aud=payment-gateway-merchant` |
| `{{PARITY_ADMIN_TOKEN}}` | synthetic session, `aud=payment-gateway-admin`, `authorities:["*"]`, `typ/iss/exp` valid for the admin edge guard |

Override them with `PARITY_MERCHANT_TOKEN` / `PARITY_ADMIN_TOKEN`. They are **not** production
credentials: the edge only reads the claims; the fake core does not verify signatures.

Admin cases stay on loopback. `admin-back`'s `enforceLanAccess` prefers `x-real-ip` when the
immediate peer is loopback, so do not add a public `x-real-ip` to an admin fixture unless
`ADMIN_LAN_CIDRS` is widened for the run.

## Fake-core routes used by the smoke set

| Fixture | Public route | Fake-core route |
| :--- | :--- | :--- |
| checkout 1 | `GET /api/v1/pay/LNKPARITY01` | `GET /internal/checkout/pay/LNKPARITY01` |
| checkout 2 | `GET /api/v1/pay/LNKPARITY01/logs/ATT-PARITY-0001` | `GET /internal/checkout/pay/.../logs/...` |
| checkout 3 | `GET /api/v1/return/RETPARITYTOKEN01` | `GET /internal/checkout/return/RETPARITYTOKEN01` |
| checkout 4 | `GET /api/v1/verify/certificate/ABCDEF0123456789` | `GET /internal/checkout/academy/certificates/...` |
| merchant 1–3 | `/api/v1/merchant/{payments,links,wallets}` | `/internal/merchant/...` |
| admin 1–3 | `/api/v1/admin/{stats/overview,merchants,rails}` | `/internal/admin/...` |

The fake core's shapes are synthetic but carry the volatility a real service has (UUIDs, ISO
timestamps, request ids, release/commit), so the normaliser is exercised on every run.

## Seeding from the real inventory

```bash
bun backend-rs/tools/parity/replay.ts --seed-from-inventory [<dir>] --per-channel 4
```

Writes `generated/<channel>.json` from the GET routes in
`backend-rs/tests/golden-vectors/route-inventory/edge-routes.json` (parameterless routes first,
then parameterised routes with `INVENTORY_PARAM_VALUES` samples). Generated cases are a starting
point: check the query contract, add a fake-core branch when the response shape matters, and move
the curated case into `reads/` once it is meaningful. The default replay input is `reads/`, so
generated files never replace the smoke set silently.

## Database fixture (P0-T11)

`backend-rs/tools/parity/db-fixture.ts` writes `db/compact.dump` + `db/compact.json` from a
COMPACT-seeded database. The dump is not committed; store it as a CI artefact.

```bash
DATABASE_URL=postgres://.../seeded bun backend-rs/tools/parity/db-fixture.ts dump
bun backend-rs/tools/parity/db-fixture.ts verify
DATABASE_URL_B=postgres://.../parity_rs bun backend-rs/tools/parity/db-fixture.ts restore --yes
```

`restore` is destructive (`--clean --if-exists`) and refuses without `--yes`. After a write
scenario, compare the two databases with `tools/parity/db-diff.ts`.

## Adding a case

1. Confirm the route is in the inventory and the fake core can produce a deterministic response.
2. Add the case with a unique `x-request-id` and the right auth placeholder.
3. Run `bun backend-rs/tools/parity/replay.ts --ts-vs-ts --verbose`; zero diffs is the self-check.
4. If a field is genuinely volatile, express it as a `normalize` rule; do not remove assertions.
5. When the Rust route is live, run with `EDGE_UNDER_TEST=rs` and record the result in
   `backend-rs/tools/parity/status.json` / the tracker.
