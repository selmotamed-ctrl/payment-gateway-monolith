# Rust consumers of the golden vectors

The coordinator wires these assertions into crate integration tests. Vectors live in
`backend-rs/tests/golden-vectors/`; embed them with `include_str!` so the test binary has no
runtime path dependency:

```rust
const FNV: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden-vectors/fnv-shares.json"
));
```

Suggested test files:

| Vector | Crate | Test file |
| :--- | :--- | :--- |
| `fnv-shares.json` | `pg-crypto` | `crates/pg-crypto/tests/golden_fnv.rs` |
| `vault.json` | `pg-crypto` | `crates/pg-crypto/tests/golden_vault.rs` |
| `webhooks.json` | `pg-crypto` | `crates/pg-crypto/tests/golden_webhooks.rs` |
| `canonical.json` | `pg-crypto` | `crates/pg-crypto/tests/golden_canonical.rs` |
| `money-decimal.json` | `pg-types` | `crates/pg-types/tests/golden_money.rs` |
| `js-key-order.json` | `pg-types` | `crates/pg-types/tests/golden_json_order.rs` |
| `js-dates.json` | `pg-types` | `crates/pg-types/tests/golden_dates.rs` |
| `pgos1.json` | `pg-objstore` | `crates/pg-objstore/tests/golden_pgos1.rs` |

All JSON uses two-space indentation and **camelCase** fields, except the nested `pgos1` `metadata`
object, which uses the snake_case `ObjectCryptoMetadata` names. Deserialize into small per-file
structs with `#[serde(rename_all = "camelCase")]` that name only the fields you need (serde ignores
unknown fields by default; do **not** add `deny_unknown_fields`).

---

## 0. Defects these vectors already expose (read before writing the tests)

1. **`pgos1` frame length is incompatible with TypeScript.** `seal_pgos1` writes
   `u32be(len(ct)+16)` followed by `ct||tag`; the TS contract (and `frameLengths`) is
   `u32be(plaintext_len) || ct || tag(16)`. The total byte count is identical, so only the length
   fields and frame split differ. `decrypt_pgos1` correspondingly expects `len` bytes that already
   contain the tag. A TS stream cannot be opened by Rust and a Rust stream cannot be opened by TS.
   §8 gives the exact fix.
2. **`JSON_CANONICAL` re-orders integer-like keys.** `canonical.rs::sorted_object` inserts keys in
   JS `.sort()` order, but JavaScript re-enumerates canonical array indices numerically when the
   object is stringified. `json-integer-like-keys` expects `{"0":…,"2":…,"10":…}`; Rust currently
   emits `{"0":…,"10":…,"2":…}`. Apply the array-index rule (or `pg_types::js_object_order`) after
   the recursive sort.
3. **`Money4::to_fixed_4` uses banker's rounding and keeps negative zero.** It calls `round_dp(4)`
   (rust_decimal default `MidpointNearestEven`); `toFixed4` is decimal.js `ROUND_HALF_UP`.
   `0.00005` → expected `0.0001`, Rust `0.0000` (vector case `decimal-08`), and `-0`/`-0.0000` →
   expected `0.0000`, Rust `-0.0000` (`decimal-02`/`decimal-04`). Use
   `round_dp_with_strategy(4, RoundingStrategy::MidpointAwayFromZero)` and normalize negative zero
   before formatting (decimal.js `toFixed` does not print the sign of zero).
4. **Scientific-notation inputs.** rust_decimal 1.43 `FromStr` falls back to
   `from_scientific_lossy` when the string contains `e`/`E`, so `1e21` parses; use
   `Decimal::from_scientific` when an exact parse is preferred. Seven vector inputs use exponent
   notation and all fit comfortably.
5. **`RoundingMode::parse` is stricter than the TS helper.** TS accepts `BANKERS`, `CEIL`, a
   `ROUND_` prefix and falls back to `HALF_UP` for unknown values; `RoundingMode::parse` returns
   `None` for all of those. `rounding-alias-*` records the TS outcome (`resolvedMode`); add a
   `parse_ts` (or extend `parse`) that reproduces it.
6. **`Vault::verify_signature` accepts uppercase hex.** TS `verifySignature` rejects anything that
   is not `^[0-9a-f]{64}$`; Rust lowercases before comparing. The vault test must assert `false` for
   an uppercased signature.
7. **The maximum JS date is outside chrono's range.** JS `8.64e15 ms` is year 275760; chrono's
   `NaiveDate::MAX` is year 262143, so `DateTime::from_timestamp_millis(8_640_000_000_000_000)`
   returns `None`. Decide explicitly (reject with an error, or a custom wide date); do not panic.
   Every other `js-dates` case is representable.
8. **`DecimalJs` mirrors `toJSON`, not `toString`, for negative zero.** decimal.js `toString()`
   prints `0`, `JSON.stringify`/`valueOf` prints `-0`. `DecimalJs::to_decimal_js_string` prints
   `-0`, which is right for `Prisma.Decimal` in JSON; the money test must compare it with
   `prismaJson.v`, and compare `decimalToString` separately (see §2).

---

## 1. `fnv-shares.json` — `pg_crypto::fnv`

Struct: `{ cases: Vec<Case> }`, `Case { id: String, value: String, utf16_code_units: usize,
fnv1a32: u32, fnv1a32_hex: String, wallet_shard16: u32, shards: BTreeMap<String, u32> }`.

For every case:

```rust
assert_eq!(case.value.encode_utf16().count(), case.utf16_code_units, "{}", case.id);
let hash = pg_crypto::fnv::fnv1a32_utf16(&case.value);
assert_eq!(hash, case.fnv1a32, "{}", case.id);
assert_eq!(format!("{hash:08x}"), case.fnv1a32_hex, "{}", case.id);
for (count, expected) in &case.shards {
    let count: u32 = count.parse().unwrap();
    assert_eq!(pg_crypto::fnv::shard_index(&case.value, count), *expected, "{} width {}", case.id, count);
}
assert_eq!(pg_crypto::fnv::shard_index(&case.value, 16), 0, "MERCHANT_WALLET is pinned for {}", case.id);
assert_eq!(case.wallet_shard16, 0);
```

Additional invariants: `fnv1a32_utf16("") == 0x811c_9dc5`, `fnv1a32_utf16("a") == 0xe40c_292c`,
`fnv1a32_utf16("foobar") == 0xbf9c_f968` (the existing unit tests), and
`shard_index(value, 0) == 0` for every value (defensive branch).

The empty string, `😀` (two UTF-16 units) and `𐍈` (two units) are the cases that fail if a port
iterates `char`s instead of UTF-16 code units.

---

## 2. `money-decimal.json` — `pg_types::money`

Struct: `{ cases: Vec<Case> }` with optional fields. Dispatch on `kind`.

Parse helper used by all kinds:

```rust
fn parse_decimal(input: &str) -> Decimal {
    if input.contains('e') || input.contains('E') {
        Decimal::from_scientific(input).expect(input) // exact; FromStr is lossy for long inputs
    } else {
        Decimal::from_str(input).expect(input)
    }
}
```

### `kind == "decimal"` (30)

```rust
let decimal = parse_decimal(&case.input);
// DecimalJs reproduces JSON.stringify(Prisma.Decimal) — including -0.
assert_eq!(DecimalJs(decimal).to_string(), case.prisma_json.v, "{}", case.id);
// Money4 reproduces toFixed(4) with ROUND_HALF_UP.
assert_eq!(Money4(decimal).to_string(), case.to_fixed4, "{}", case.id);
if case.input.starts_with('-') && decimal.is_zero() {
    assert_eq!(case.decimal_to_string, "0", "decimal.js toString drops the sign of -0");
    assert_eq!(case.prisma_json.v, "-0", "decimal.js toJSON keeps the sign of -0");
} else {
    assert_eq!(case.decimal_to_string, case.prisma_json.v, "{}", case.id);
}
```

If `Money4` is fixed per §0.3, all 30 pass. Until then `decimal-02`, `decimal-04` (negative zero)
and `decimal-08` (`0.00005` → expected `0.0001`) are expected failures and should be marked
`#[ignore]` with a comment pointing here.

### `kind == "rounding"` (21) and `kind == "commission"` (7)

```rust
let mode = RoundingMode::parse(&case.mode).expect(&case.mode);
let value = match case.kind.as_str() {
    "rounding" => parse_decimal(&case.value),
    "commission" => parse_decimal(&case.amount).checked_mul(parse_decimal(&case.percentage_rate)).unwrap(),
    _ => unreachable!(),
};
let rounded = mode.apply(value);
let expected = case.rounded.as_deref().or(case.commission.as_deref()).unwrap();
assert_eq!(rounded.rescale(4).to_string(), expected, "{}", case.id);
assert_eq!(mode.to_strategy(), expected_strategy(&case.decimal_mode)); // match the name
```

`mode.apply` is `round_dp_with_strategy(4, …)`; `rescale(4)` only pads to four places, so the
comparison is exact. Assert the decimal.js constant too: `decimalModeConstant` is 0..6 in
`ROUND_UP, ROUND_DOWN, ROUND_CEIL, ROUND_FLOOR, ROUND_HALF_UP, ROUND_HALF_DOWN, ROUND_HALF_EVEN`
order (use it as documentation; the Rust enum is the source of truth).

Values: `0.12345`, `1.23445`, `-2.34555`; commission is `2469.13 × 0.005 = 12.34565`, a true
midpoint, so HALF_UP/UP/CEILING → `12.3457` and HALF_EVEN/HALF_DOWN/DOWN/FLOOR → `12.3456`
(HALF_EVEN sees an odd preceding digit 5, so rounds away).

### `kind == "roundingAlias"` (4)

`resolvedMode` is what `roundingModeOf` returns for `inputMode`. Assert the TS-parity helper:

```rust
assert_eq!(parse_ts(&case.input_mode), Some(expected_mode(&case.resolved_mode)));
```

Again, `RoundingMode::parse` alone returns `None` for all four today (§0.5).

---

## 3. `js-key-order.json` — `pg_types::json_order`

Struct: `{ cases: Vec<Case> }`, `Case { id, insertion: Vec<(String, Value)>, object_keys: Vec<String>,
stringified: String }`.

```rust
let mut map = serde_json::Map::new();
for (key, value) in &case.insertion {
    map.insert(key.clone(), value.clone());
}
let value = Value::Object(map);
assert_eq!(js_object_order_string(&value), case.stringified, "{}", case.id);
let ordered = js_object_order(&value);
let keys: Vec<&String> = ordered.as_object().unwrap().keys().collect();
assert_eq!(keys, &case.object_keys, "{}", case.id);
```

Boundary assertions (from `index-boundary` / `non-canonical-indices`):

```rust
assert!(is_array_index("0"));
assert!(is_array_index("4294967294"));
assert!(!is_array_index("4294967295"));
assert!(!is_array_index("4294967296"));
assert!(!is_array_index("01"));
assert!(!is_array_index(" 1"));
assert!(!is_array_index("1 "));
assert!(!is_array_index("1.0"));
assert!(!is_array_index("-1"));
```

Note: the vector file itself stores integer-like keys in JS enumeration order (0, 2, 10 …) because
`JSON.stringify` wrote it; that is exactly the order `serde_json` with `preserve_order` will read,
so the reconstruction above is faithful. String keys keep the file order, which equals the
recorded insertion order.

---

## 4. `js-dates.json` — `pg_types::time::JsDate`

Struct: `{ cases: Vec<Case> }`, `Case { id, kind: "epochMs" | "iso" | "invalid", input: Option<Value>,
epoch_ms: Option<i64>, iso: Option<String>, error: Option<String> }`.

```rust
match case.kind.as_str() {
    "epochMs" => {
        let value = case.input.as_ref().unwrap().as_i64().unwrap();
        let date = DateTime::from_timestamp_millis(value).expect(&case.id);
        assert_eq!(JsDate(date).to_iso_string(), case.iso.as_ref().unwrap(), "{}", case.id);
        assert_eq!(date.timestamp_millis(), case.epoch_ms.unwrap());
    }
    "iso" => {
        let raw = case.input.as_ref().unwrap().as_str().unwrap();
        let date = if raw.len() == 10 {                 // "2026-11-28": ECMA-262 date-only = UTC
            JsDate::from_str(&format!("{raw}T00:00:00Z")).unwrap()
        } else {
            JsDate::from_str(raw).unwrap()
        };
        assert_eq!(date.to_iso_string(), case.iso.as_ref().unwrap(), "{}", case.id);
    }
    "invalid" => {
        assert_eq!(case.error.as_deref(), Some("RangeError"));
        assert!(JsDate::from_str("NaN").is_err());
        // Rust has no NaN DateTime; the HTTP layer must reject non-finite input, not coerce it to
        // the Unix epoch.
    }
    _ => unreachable!(),
}
```

Specific expectations: `.1` → `.100`, `.12` → `.120`, `.123456` → `.123` (truncation),
`-1` → `1969-12-31T23:59:59.999Z`, `year-1900` → `1900-01-01T00:00:00.000Z`, `year-9999` →
`9999-12-31T23:59:59.999Z`. `max-date` is §0.7.

---

## 5. `vault.json` — `pg_crypto::vault`

Top level: `kmsMasterKey`, `keyEncoding: "utf8-32-bytes"`. Build one resolver for both resolution
modes (Rust has no separate explicit-master-key constructor):

```rust
let mut env = BTreeMap::new();
env.insert("KMS_MASTER_KEY".to_string(), case_file.kms_master_key.clone());
let vault = Vault::new(EnvironmentKeyResolver::from_map(env));
```

### `kind == "encrypt"` (9)

```rust
assert!(assert_valid_key_id(&case.key_id).is_ok(), "{}", case.id);
assert_eq!(vault.decrypt_secret(&case.payload).unwrap(), case.plaintext, "{}", case.id);

let parts: Vec<&str> = case.payload.split(':').collect();
assert_eq!(parts.len(), 4, "{}", case.id);
assert_eq!(parts[0], case.key_id);
assert_eq!(base64::engine::general_purpose::STANDARD.decode(parts[1]).unwrap().len(), 12);
assert_eq!(base64::engine::general_purpose::STANDARD.decode(parts[2]).unwrap().len(), 16);
// Empty plaintext is valid: parts[3] is the empty string.
if case.plaintext.is_empty() { assert_eq!(parts[3], ""); }

// Fresh encryption still round-trips and uses the same key id prefix.
let sealed = vault.encrypt_secret(&case.plaintext, &case.key_id).unwrap();
assert!(sealed.starts_with(&format!("{}:", case.key_id)));
assert_eq!(vault.decrypt_secret(&sealed).unwrap(), case.plaintext);
```

Negative: for a non-empty ciphertext, replacing the last ciphertext character with a different
base64 character must yield `Err(VaultError::AuthenticationFailed)` (not a panic); an unknown key id
yields `Err(VaultError::KeyNotFound(_))`.

`resolution` (`explicit`/`env`) is TypeScript-side only; both use the same master key, so Rust
asserts the same result for both.

### `kind == "sign"` (6)

```rust
assert_eq!(vault.sign(&case.data, &case.key_id).unwrap(), case.signature, "{}", case.id);
assert!(vault.verify_signature(&case.data, &case.signature, &case.key_id).unwrap());
// TS verifySignature only accepts lowercase hex (§0.6).
assert!(!vault.verify_signature(&case.data, &case.signature.to_uppercase(), &case.key_id).unwrap());
assert!(!vault.verify_signature(&format!("{}x", case.data), &case.signature, &case.key_id).unwrap());
```

`vault-sign-audit-anchor` is the exact AUTO-27 message format
`audit-anchor/v1|<lastSeqNo>|<lastRowHash>|<rowsVerifiedTotal>`.

---

## 6. `webhooks.json` — `pg_crypto::webhooks`

Top level: `signingSecret`, `rotationSecret`.

### `kind == "sign"` (5)

```rust
let signature = sign_standard_webhook(&case.webhook_id, case.timestamp_seconds, &case.body, &case.secret).unwrap();
assert_eq!(signature, case.signature, "{}", case.id);
assert!(signature.starts_with("v1,"));
assert!(verify_standard_webhook_at(
    Some(&case.webhook_id),
    Some(&case.timestamp_seconds.to_string()),
    Some(&case.signature),
    &case.body,
    &[case.secret.clone()],
    300,
    case.timestamp_seconds,
));
// Wrong body, stale timestamp, missing header.
assert!(!verify_standard_webhook_at(Some(&case.webhook_id), Some(&case.timestamp_seconds.to_string()), Some(&case.signature), &format!("{} ", case.body), &[case.secret.clone()], 300, case.timestamp_seconds));
assert!(!verify_standard_webhook_at(Some(&case.webhook_id), Some(&case.timestamp_seconds.to_string()), Some(&case.signature), &case.body, &[case.secret.clone()], 300, case.timestamp_seconds + 301));
```

### `kind == "headers"` (1)

```rust
let headers = build_standard_webhook_headers(&case.webhook_id, case.timestamp_seconds, &case.body, &case.secrets).unwrap();
let map: BTreeMap<_, _> = headers.into_iter().collect();
assert_eq!(map["webhook-id"], case.webhook_id);
assert_eq!(map["webhook-timestamp"], case.timestamp_seconds.to_string());
assert_eq!(map["webhook-signature"], case.headers["webhook-signature"]);
assert_eq!(map["webhook-signature"].split(' ').count(), case.secrets.len());
assert!(map["webhook-signature"].split(' ').all(|entry| entry.starts_with("v1,")));
```

Also assert the two individual signatures appear in rotation order (first `signingSecret`, then
`rotationSecret`), because the verifier accepts any of them.

---

## 7. `canonical.json` — `pg_crypto::canonical`

Struct: `{ cases: Vec<Case> }`, `Case { id, mode, fields: Value, includedFields: Option<Vec<String>>,
excludedFields: Option<Vec<String>>, templateString: Option<String>, valueSeparator: Option<String>,
expected: String }`.

```rust
let mode = CanonicalizationMode::parse(&case.mode).expect(&case.mode);
let input = CanonicalizationInput {
    fields: case.fields.as_object().cloned().unwrap_or_default(),
    raw_body: None,
    timestamp: None,
    included_fields: case.included_fields.clone(),
    excluded_fields: case.excluded_fields.clone(),
    template_string: case.template_string.clone(),
    value_separator: case.value_separator.clone(),
};
assert_eq!(canonicalize(mode, &input).unwrap(), case.expected, "{}", case.id);
```

Key expectations:

- `skv-basic` — `C=` (null → empty), case-sensitive key sort (`C` before `a`).
- `skv-unicode-keys` — `مبلغ` (U+0645) < `😀` (D83D) < `�` (FFFD) in UTF-16 code-unit order.
- `svh-default-hashed-exclusion` — `hashed` is hidden even without `excludedFields`.
- `skv-included-and-excluded` — exclusion wins over inclusion, both case-insensitive.
- `tpl-literal-braces` — invalid placeholders stay literal.
- `json-integer-like-keys` — the §0.2 failure: `{"0":"zero","2":"two","10":"ten","b":1}`.

Fix for §0.2: after `sorted_object`, apply the array-index-first rule recursively (the same rule as
`pg_types::json_order::js_object_order`). `pg-crypto` does not depend on `pg-types`; either add the
workspace dependency or implement the reordering in `canonical.rs` and share a test with
`js-key-order.json`. Do not change `.sort()` itself: keys are sorted lexicographically first, then
re-enumerated numerically by the stringifier.

---

## 8. `pgos1.json` — `pg_objstore::pgos1`

Top level: `{ keyring: "v1:<64 hex>", activeKekVersion: 1, objectId: "<uuid>", cases: [...] }`.
`Case { id, objectId, keyring, chunkSizeBoundary, plaintextBase64, streamBase64, frameLengths: Vec<u32>, metadata: ObjectCryptoMetadata }`.
The per-case `keyring` is identical to the top-level value (self-contained cases); `metadata`
already uses the Rust field names, so
`serde_json::from_value::<ObjectCryptoMetadata>(case.metadata.clone())` works unchanged.

```rust
let keyring = KekKeyring::parse(&file.keyring, Some(file.active_kek_version)).unwrap();
for case in &file.cases {
    let object_id = Uuid::parse_str(&case.object_id).unwrap();
    let plaintext = STANDARD.decode(&case.plaintext_base64).unwrap();
    let stream = STANDARD.decode(&case.stream_base64).unwrap();

    assert_eq!(plaintext.len() as u64, case.metadata.plaintext_size, "{}", case.id);
    assert_eq!(hex::encode(sha256(&plaintext)), case.metadata.plaintext_sha256, "{}", case.id);
    assert_eq!(case.metadata.chunk_size, 4096);
    assert_eq!(case.frame_lengths.len() as u64, case.metadata.chunk_count);

    // Framing contract (fails today, see §0.1): u32be(plaintext_len) | ct | tag(16).
    assert_eq!(&stream[..5], b"pgos1");
    let mut offset = 5usize;
    for (index, declared) in case.frame_lengths.iter().enumerate() {
        let len = u32::from_be_bytes(stream[offset..offset + 4].try_into().unwrap()) as usize;
        assert_eq!(len as u32, *declared, "{} frame {}", case.id, index);
        let expected = if index + 1 == case.frame_lengths.len() {
            plaintext.len() - 4096 * index
        } else {
            4096
        };
        assert_eq!(len, expected, "{} frame {}", case.id, index);
        offset += 4 + len + 16;
        assert!(offset <= stream.len(), "{} frame {}", case.id, index);
    }
    assert_eq!(offset, stream.len(), "{}", case.id);
    assert_eq!(
        stream.len(),
        5 + 4 * case.frame_lengths.len() + plaintext.len() + 16 * case.frame_lengths.len(),
        "{}",
        case.id
    );

    assert_eq!(decrypt_pgos1(object_id, &stream, &keyring, &case.metadata).unwrap(), plaintext, "{}", case.id);

    // Negative: the AAD binds the object id; a tampered byte fails authentication.
    assert_eq!(
        decrypt_pgos1(Uuid::new_v4(), &stream, &keyring, &case.metadata).unwrap_err(),
        Pgos1Error::Crypto
    );
}
```

### Required fix for the framing mismatch (§0.1)

In `seal_pgos1`:

```rust
let sealed = cipher.encrypt(...)?;                 // ct || tag
let split = sealed.len() - 16;
output.extend_from_slice(&(chunk.len() as u32).to_be_bytes()); // plaintext length, NOT sealed.len()
output.extend_from_slice(&sealed[..split]);        // ciphertext
output.extend_from_slice(&sealed[split..]);        // tag
```

In `decrypt_pgos1`: after reading `len`, take `ct = &stream[offset..offset + len]`,
`tag = &stream[offset + len..offset + len + 16]`, advance by `len + 16`, concatenate `ct || tag` and
decrypt; the existing `offset == stream.len()` and `chunk_count` checks then hold. `MAX_FRAME_BYTES`
must bound the plaintext length (`len <= 16 MiB`), and the tag length is always 16.

Until this is fixed, keep the framing assertions in a separate `#[test]` marked `#[ignore]` with a
pointer to this document, and run the `decrypt_pgos1` assertions in a `ts_interop` test that is
expected to fail (so the failure is visible rather than silent).

---

## 9. Regenerating

Never edit a vector by hand. After changing a TS module or adding a case:

```bash
bun backend-rs/tools/golden/generate.ts
bun backend-rs/tools/golden/check.ts
cargo test -p pg-crypto -p pg-types -p pg-objstore --test golden_*
```

`check.ts` exits 1 when any committed byte differs, a file is missing, or an id is duplicated or
unsorted. CI should run it before the Rust suites (`P0-T02` wiring).
