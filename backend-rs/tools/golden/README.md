# Golden vectors (`P0-T06`)

Cross-implementation vectors for the Rust/ntex port. Every file is produced by running the **real
TypeScript modules** of `core-back` under Bun — never by re-implementing the behaviour — and is
committed under `backend-rs/tests/golden-vectors/` so the Rust suites can consume it without Node,
Bun or a database.

Plan: `design/14-rust-port/08_verification_benchmarks_and_cutover.md` §2 and
`design/14-rust-port/02_contracts_reference.md` §6, §11–§13. Rust assertions: `RUST_CONSUMERS.md`.

## Run

From the repository root:

```bash
bun backend-rs/tools/golden/generate.ts   # write backend-rs/tests/golden-vectors/
bun backend-rs/tools/golden/check.ts      # regenerate to a temp dir, byte-compare, exit 1 on drift
```

Requirements:

- Bun ≥ 1.4 (the repo's pinned Bun).
- `core-back/node_modules` installed (`bun install` in `core-back`) — the generator imports
  `decimal.js` from there.
- `core-back/generated/prisma/client.ts` present (`bun run migrate-generate` in `core-back`).
- No `DATABASE_URL`, certificates or running services: the generator imports only pure modules.
  It sets `KMS_MASTER_KEY` / clears `KMS_KEYS_JSON` **inside its own process** for the env-mode
  vault case.

Options:

| Flag | Meaning |
| :--- | :--- |
| `--out DIR` | Destination directory (default `backend-rs/tests/golden-vectors/`). |
| `--reuse-from DIR` | Reuse random `vault`/`pgos1` payloads from `DIR` (default: the `--out` directory). |
| `--refresh-random` | Mint new `vault`/`pgos1` payloads. This is the only way the committed bytes change. |

`check.ts` regenerates into `mkdtemp()` with `reuse-from` pointed at the committed directory,
compares bytes, validates the header (`generatedBy`, `contract`, non-empty `cases`), and the id
sorting and uniqueness of the eight files this generator owns. Other vector families in the same
directory (for example `route-inventory/`, owned by `tools/route-inventory`) are left untouched.

Field names are **camelCase** in every file except the nested `pgos1` `metadata` object, which uses
the snake_case `ObjectCryptoMetadata` names. Add `#[serde(rename_all = "camelCase")]` to the vector
structs (not to `ObjectCryptoMetadata`).

## Determinism

- Cases are sorted by `id` with a locale-independent comparison; object keys are written in a
  fixed order; there are no timestamps, commits, host names or floats.
- The only random values are the AES-GCM IVs inside `vault.json` payloads and the DEK / nonce
  prefix / wrapped-DEK nonce inside `pgos1.json` streams. Those payloads **are** the vector, so the
  generator reuses the committed payload after proving with the TypeScript code that it still
  decrypts to the recorded plaintext. `generate.ts` run twice therefore produces identical bytes
  (verified by SHA-256), and only `--refresh-random` changes them.
- Changing the generator's fixed master key or KEK is detected: the old payload no longer decrypts,
  so a fresh one is minted and `check.ts` reports the drift.

## Files

| File | Cases | Committed size | TypeScript source |
| :--- | ---: | ---: | :--- |
| `fnv-shares.json` | 20 | 7,630 B | `core-back/lib/storageEngine/shardBalances.ts` (`fnv1aHash`, `shardIdForAttempt`) |
| `money-decimal.json` | 62 | 15,482 B | `decimal.js` + Prisma `Decimal` (the classes the API emits) |
| `js-key-order.json` | 10 | 5,645 B | the JavaScript engine (`Object.keys`, `JSON.stringify`) |
| `js-dates.json` | 13 | 2,484 B | the JavaScript engine (`Date#toISOString`) |
| `vault.json` | 15 | 11,517 B | `core-back/engine/crypto/Vault.ts` (`encryptSecret`, `sign`) |
| `webhooks.json` | 6 | 4,456 B | `core-back/lib/webhooks/standardWebhooks.ts` |
| `canonical.json` | 17 | 5,227 B | `core-back/engine/crypto/CryptoEngine.ts` (`canonicalize`) |
| `pgos1.json` | 5 | 575,484 B | `core-back/lib/objectStorageSdk/crypto.ts` (`encryptBufferToPgos1`) |

Total: 148 cases, 627,925 bytes.

### `fnv-shares.json`

20 ledger reference ids (ASCII, Arabic, emoji/astral `U+1F600` and `U+10348`, a NUL byte, 300-char
ASCII, 360-char Arabic, around a tab/newline, empty). Per case: `fnv1a32` (unsigned), `fnv1a32Hex`,
`utf16CodeUnits`, `shards` for widths 1/2/16/32/128/256 and `walletShard16` (MERCHANT_WALLET
is pinned to shard 0).

### `money-decimal.json`

`kind: "decimal"` — 30 inputs from zero/negative zero through `numeric(18,4)` bounds and exponent
forms. Fields: `decimalToString` (`Decimal#toString`), `toFixed4` (`Decimal#toFixed(4)`,
HALF_UP), `prismaJson.v` (`JSON.stringify(Prisma.Decimal)`, which keeps the minus sign on `-0`).

`kind: "rounding"` — 3 values × 7 modes = 21 `toDecimalPlaces(4, mode)` results, with the decimal.js
constant name/number.

`kind: "commission"` — 7 results for `2469.13 × 0.005 = 12.34565` (a true 5th-decimal midpoint) so
each mode is distinguishable.

`kind: "roundingAlias"` — `BANKERS`, `CEIL`, `ROUND_UP`, `NONSENSE` (unknown → `HALF_UP`), copied
from `roundingModeOf` because importing `api/internal/checkout.ts` validates the full core
environment and exits without `DATABASE_URL`/mTLS/KMS.

### `js-key-order.json`

10 nested objects built from explicit insertion pairs: canonical array indices (`0`, `2`, `10`),
the boundary `4294967294` (index) vs `4294967295`/`4294967296` (strings), `01`, `" 1"`, `"1 "`,
`"1.0"`, Arabic/emoji keys and three-level nesting. Per case: `insertion`, `objectKeys`,
`stringified`.

### `js-dates.json`

12 valid values (epoch 0, ±1 ms, 1900, 2023, `.1`, `.12`, `.123456`, date-only, year 9999, the
maximum JS date) plus one invalid case that must throw `RangeError`.

### `vault.json`

Fixed `KMS_MASTER_KEY = "0123456789abcdef0123456789abcdef"` (32 ASCII bytes, used as-is). 9
`encrypt` cases across `test-key`, `mfa-sms`, `credential-set`, `reporting-xml` (including an empty
plaintext, Arabic/emoji and a 2,200-char value) with the produced `payload`; 6 `sign` cases with
the hex HMAC. `resolution` records whether the TypeScript `Vault` was built with an explicit
`masterKey` or read `KMS_MASTER_KEY` from the environment.

### `webhooks.json`

5 Standard Webhooks signatures over `evt_…`, Unix seconds and JSON bodies (empty object, a
realistic `payment.succeeded`, Arabic, emoji, 1,000-char) plus one two-secret rotation header case.
Top-level `signingSecret` and `rotationSecret`.

### `canonical.json`

17 cases: `SORTED_KEY_VALUE_AMP` (basic, nested/null, UTF-16 key order), `SORTED_VALUES_HASH`
(joined, custom separator, include list, default `hashed` exclusion), `JSON_CANONICAL` (nested,
integer-like keys, unicode/null/number), `TEMPLATE_STRING` (double/single braces, nested paths,
include list, literal braces) and `SORTED_KEY_VALUE_AMP` with include, exclude and both. Every
case carries the exact `expected` string.

### `pgos1.json`

Fixed KEK `v1:<64 hex>`, fixed object UUID, chunk size 4096, 5 plaintexts (1 byte, exactly one
chunk, chunk+1, 5,000, 200,000 bytes). Per case: `objectId`, `keyring` (identical to the top-level
value, so a case is self-contained), `chunkSizeBoundary`, `plaintextBase64`, `streamBase64`, the
snake_case `metadata` (`kek_version`, `wrapped_dek`, `dek_nonce`, `stream_prefix`, `chunk_size`,
`chunk_count`, `plaintext_sha256`, `plaintext_size`) and `frameLengths` (the `u32be` value of every
frame, in order). Top-level `keyring`, `activeKekVersion`, `objectId`.

## Layout

```
backend-rs/tools/golden/
  generate.ts          generator (imports the real TS modules)
  check.ts             drift check (temp dir + byte compare)
  lib/inputs.ts        deterministic inputs (strings, decimals, dates, fields, payload sizes)
  lib/io.ts            vector file render/write/reuse helpers
  README.md            this file
  RUST_CONSUMERS.md    exact assertions each Rust test must make
backend-rs/tests/golden-vectors/
  canonical.json ... pgos1.json   the eight files above
  route-inventory/                owned by backend-rs/tools/route-inventory (not this generator)
```

## Adding a case

1. Add the input to `lib/inputs.ts` (or the case list in `generate.ts` for computed vectors).
2. Run `bun backend-rs/tools/golden/generate.ts`.
3. Review the diff, especially `expected`/`frameLengths`/`metadata`.
4. Add the Rust assertion described in `RUST_CONSUMERS.md` (and update it if the shape changed).
5. Run `bun backend-rs/tools/golden/check.ts` and the Rust suite.

Do not hand-edit a committed vector: the next `check.ts` run overwrites the expectation.
