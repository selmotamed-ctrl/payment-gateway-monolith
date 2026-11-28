# Chapter 2 — Contracts Reference (Track P)

> Part of the Rust/ntex port plan (`porting_to_ntex_rust.md`). Everything here must be reproduced **exactly**
> during Track P. Each section names its TypeScript source of truth. Each item needs golden vectors (chapter 8 §2)
> or parity cases (chapter 8 §3) before it counts as done. Where a Track S/E item later changes a contract, the
> item references the section here; this chapter always describes **today's** behaviour.

---

## 1. Internal mTLS (core and daemons)

Source: `core-back/index.ts:199-251`, `core-back/api/index.ts:15-20`, `core-back/api/middleware/mtlsGuard.ts`.

- Core server: TLS 1.3 minimum, client certificate **required** and verified against `MTLS_CA_CERT_PATH`; server
  cert/key `MTLS_SERVER_CERT_PATH` / `MTLS_SERVER_KEY_PATH`; no custom cipher list. Missing files → startup error
  containing `Run 'bun run generate-mtls-certs'` (keep the text until S-OPS-03 changes it in both implementations).
- Channel binding by subject **CN** (first CN when several):

  | Prefix | Allowed CN(s) |
  | :--- | :--- |
  | `/internal/admin` | `admin-back` |
  | `/internal/merchant` | `merchant-back` |
  | `/internal/checkout` | `checkout-back` |
  | `/internal/sandbox` | `merchant-back`, `admin-back` |

- Errors (envelope §3): not authorised by CA → `401 MTLS_UNAUTHORIZED` "Client certificate not authorized by
  internal CA"; no readable CN → `401 MTLS_UNAUTHORIZED` "Client certificate could not be inspected"; wrong CN →
  `403 FORBIDDEN_SERVICE_IDENTITY` "Certificate CN '<cn>' is not permitted on <allowed CNs joined ", "> channel".
- `GET /health` needs a valid client certificate but no CN check.
- Daemons authorise by CN **or DNS SAN**: backup control plane `BACKUP_ALLOWED_CLIENT_CNS` (default
  `backup-client`), WAL plane `BACKUP_WAL_CLIENT_CNS` (default `wal-archive-client`, only `PUT /v1/wal/...`), object
  storage `OBJECT_STORAGE_ALLOWED_CLIENT_CNS` (default `object-storage-client,backup-daemon,backup-client`; mTLS
  required when `NODE_ENV=production` unless `OBJECT_STORAGE_REQUIRE_MTLS=false`). Unauthorised peer → raw
  `HTTP/1.1 403` body `{"error":{"code":"forbidden","message":"client certificate is not authorized"}}`.
- Implementation: rustls `WebPkiClientVerifier` with the internal CA as only root; extract CN/SANs with
  `x509-parser` once per connection, store as connection state. Gating spike P0-T07.

## 2. Request id, headers, body limits

- `x-request-id`: accept incoming if it matches `^[A-Za-z0-9._:-]{1,128}$`, else UUIDv4; echo on the response (core
  and edges). Note: the console log uses a different short id (`#<6char>`); keep both.
- Core middleware order (`createApp`): `x-powered-by` off; `trust proxy = TRUST_PROXY`; request id; telemetry
  context (AsyncLocalStorage); request logger; raw-body routes; JSON; urlencoded; `/health`; `/internal` routers
  with CN guards; `/api` public router (rate limited); error handler.
- Raw-body routes (`core-back/lib/rawBody/index.ts`, any content type, before the JSON parser):

  | Path | Limit |
  | :--- | :--- |
  | `/internal/admin/reconciliation/upload` | 100 MB |
  | `/internal/admin/assets/upload` | 5 MB |
  | `/internal/merchant/onboarding/kyb-documents` | 25 MB |
  | `/internal/checkout/inbound` and below | 25 MB |
  | `/internal/admin/join-requests/:id/kyb-documents` (regex) | 25 MB |
  | `/internal/admin/aml/cases/:id/evidence` (regex) | 50 MB |
  | `/internal/{admin,merchant}/disputes/:id/attachments` (regex) | 25 MB |
  | default for raw routes | 25 MB |

- JSON: `^/internal/(admin|merchant)/report-engine(/|$)` → 24 MB (`REPORT_ENGINE_JSON_LIMIT`,
  `adminReportEngine.ts:59-60`; oversize → `413 PAYLOAD_TOO_LARGE`); everything else 1 MB. urlencoded
  (`extended:true`) 1 MB. Malformed JSON → **HTTP 400** with body `{"code":"SERVER_ERROR","message":"Internal server
  error","reference":…}`.
- Edge security headers (`admin-back/lib/security/index.ts`, same in the other edges): `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors
  'none'`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store` unless set; no `x-powered-by`;
  CORS headers only when `CORS_ALLOWED_ORIGINS` is set, never with credentials.
- Edge JSON limits `MAX_JSON_BODY_BYTES`: admin 4 MiB, merchant 2 MiB, checkout 1 MiB.

## 3. Error envelope

Source: `core-back/lib/error/index.ts`.

- `{"code": string, "message": string, "reference"?: string, "details"?: any}`; core `reference` = request id.
- `ApiError(status, code, message, details?)` → its status. `ObjectStorageError` / `BlobStoreUnavailableError` →
  their `httpStatus` (403/404/409/413/415/423/503). `SyntaxError` → 400 (body still `SERVER_ERROR`). Other → 500
  `SERVER_ERROR` / "Internal server error". Headers already sent → do nothing.
- Core validation: `400 INVALID_BODY`, `details: [{path, code, message}]` for body, params and query
  (`parseOrThrow`). Edge validation: `400 VALIDATION_FAILED`, `details` = raw zod issues.
- Edge unknown route: `404 {"code":"NOT_FOUND","message":"No route matches <METHOD> <path>"}`. Core has no explicit
  404 handler: capture the actual TS response (Express default) in P0-T04 and reproduce it.
- Daemons use `{error:{code,message}}`.
- No central code catalogue: P0-T04 extracts every `new ApiError(` into `error-codes.json`.

## 4. Validation (zod 4 → Rust)

- `.strict()` → reject unknown keys with zod issue `unrecognized_keys` (path `[]`).
- Reproduce issue `code` and `path` for each check used: `invalid_type`, `too_small`, `too_big`,
  `invalid_format` (zod 4 string formats), `invalid_value`, `unrecognized_keys`, `custom`. `message` text is
  best-effort; the parity normaliser ignores it unless pinned.
- **Transforms are contracts too**: zod `.transform()` / `.preprocess()` (e.g. `lib/zReady` Libyan phone
  normalisation capturing `(00|+)?218`, trimming, lowercasing) change the value core stores. Port each one with a
  golden vector.
- Common regexes (copy verbatim): money `^\d{1,14}(\.\d{1,4})?$`; idempotency key `[A-Za-z0-9_.:-]{8,128}`; request
  id §2.

## 5. Authentication and sessions

Sources: `core-back/lib/auth/index.ts`, `api/middleware/authDoubleCheck.ts`, `lib/auth/{revocation,mfaChallenges,
throttle,googleOAuth,merchantAuthorities}.ts`, edges' `lib/security/sessionCookie.ts`, `lib/authLimiters.ts`.

- **Session JWT** HS256: `iss="payment-gateway-core"`, `aud ∈ {payment-gateway-admin, payment-gateway-merchant,
  payment-gateway-checkout}`, `exp = iat + 43200`, `jti = randomUUID()`, payload `{sub, typ:"session", role,
  merchantId, authorities[], appScopeIds[], mfa:boolean}`.
- **Signing key** `HKDF-SHA256(ikm = utf8(KMS_MASTER_KEY raw string, NOT normalised), salt = "payment-gateway-core",
  info = "session-signing", L = 32)`; MFA HMAC key same with `info = "mfa-challenge"`. Live and Sandbox share the key.
- **Bearer** `^Bearer\s+(.+)$` (case-insensitive).
- **Core double check**: `pg_live_`/`pg_test_` prefix → API token; else session JWT. Session: signature, audience
  vs channel, revocation by `jti` (Redis then table), user ACTIVE, `iat*1000 < sessionsInvalidBefore` → revoked,
  authorities re-read from DB (`authoritiesMap`), non-empty authorities, sandbox user mirroring. Errors:
  `401 SESSION_INVALID|SESSION_REVOKED|SESSION_USER_MISSING|SESSION_AUDIENCE_INVALID|AUTH_REQUIRED`,
  `403 SESSION_USER_INACTIVE|SESSION_AUTHORITIES_EMPTY|STAFF_PRINCIPAL_REQUIRED|MERCHANT_PRINCIPAL_REQUIRED`.
  **The `mfa` claim is not re-checked after login** (parity; fixed by S-SEC-04).
- **API tokens**: `pg_live_` (Live) / `pg_test_` (Sandbox) + base64url(32 random bytes); stored hex SHA-256 in
  `AccessToken.tokenHash`; checks plane, hash, revoked, expiry, CIDR allowlist on `x-real-client-ip`, merchant
  ACTIVE; updates `lastUsedAt`. Errors: `401 ACCESS_TOKEN_INVALID|ACCESS_TOKEN_REVOKED|ACCESS_TOKEN_EXPIRED|
  LIVE_TOKEN_ON_SANDBOX_PLANE|SANDBOX_TOKEN_ON_LIVE_PLANE`, `403 ACCESS_TOKEN_IP_NOT_ALLOWED|MERCHANT_NOT_ACTIVE`;
  API tokens only on `/external/*` else `403 API_TOKEN_SCOPE_VIOLATION`. Scopes: `link:write`, `link:read`,
  `payment:read` (+ legacy aliases, `merchantAuthorities.ts:39`), enforced only on `/external/*`.
- **Authorities**: `requireAuthorities` OR semantics; `*` only for staff; merchant authority catalogue of 17
  (`merchantAuthorities.ts:12-31`). `requireMerchantScope` (`authDoubleCheck.ts:448-460`) returns the principal
  unchecked when `merchantId` is null (parity; fixed by S-SEC-02).
- **Admin `auth/me`** is registered before `requireAuthentication` (static data) — parity.
- **Passwords**: bcrypt cost 12, `$2a$`/`$2b$`; unknown user compared against a dummy hash.
- **Revocation**: Redis `SET pgauth:revoked:<jti> 1 PX <ms to exp>` + `session_revocations` row; Redis miss → table
  → re-warm; prune ~1 in 50.
- **MFA / email verification / password reset** (`mfa_challenges`): purpose `LOGIN_MFA|EMAIL_VERIFICATION|
  PASSWORD_RESET`, channel `ADMIN|MERCHANT`; code `readUInt32BE(randomBytes(4)) % 1_000_000` zero-padded 6;
  `codeHash = hex(HMAC-SHA256(mfaKey, "<userId>:<code>"))`; TTL 5 min, 5 attempts, 15 min lock, max 5 issues / 15 min;
  new challenge consumes open ones and sets their queued notifications to `SUPPRESSED`; code vault-sealed under
  `mfa-sms`, address under `mfa-address`; password reset sets `sessionsInvalidBefore`. No TOTP.
- **Throttles**: keys `pgauth:<scope>:<sha256hex(lower(value))>:count|:lock`, scopes `login-id`, `login-pair`
  (`id|ip`), `login-ip`, `mfa-ip`; 15 min window/lock; limits pair 5, id 50, ip 30, mfa-ip 20; `429 AUTH_THROTTLED`
  with `details.retryAfterSeconds`; Lua `INCR_WINDOW_LUA` (`sharedState.ts`, copy verbatim); in-memory fallback
  capped at 20,000 entries.
- **Google OAuth (merchant)**: PKCE S256; routes `/auth/google/start|callback|exchange` (`merchant.ts:1129-1193`);
  tables `oauth_states`, `oauth_login_tickets`; verifier vault key `google-oauth-verifier`; ID token verified against
  Google's JWKS (jose `createRemoteJWKSet`: fetch, cache, rotate on unknown `kid`) with the configured issuer list;
  settings key `auth.google`. Admin Google login is not implemented. Rust: reqwest + `jsonwebtoken` JWK set with a
  `moka` cache keyed by `kid`, refresh on miss at most once per 60 s.
- **Cookie mode** (`SESSION_COOKIE_MODE`, default off): `pg_admin_session` (Path `/api/v1/admin`),
  `pg_merchant_session` (Path `/api/v1/merchant`); `HttpOnly; SameSite=Strict; Secure` (Secure dropped when
  `SESSION_COOKIE_SECURE=false`), `Max-Age=43200`; value regex `^[A-Za-z0-9._-]{20,4096}$`; login returns
  `sessionCookie:true` instead of `token`; cookie-authenticated unsafe methods need `x-pg-csrf: 1` else
  `403 CSRF_HEADER_REQUIRED`.

## 6. Vault (column encryption)

Source: `core-back/engine/crypto/Vault.ts`.

- Stored form `keyId:b64(iv12):b64(tag16):b64(ct)`; standard padded base64, decoding must be canonical (re-encode
  and compare); keyId `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
- AES-256-GCM, AAD = utf8(keyId) only (cross-row swapping is possible — fixed in E-SEC-03 vault v2).
- Key resolution: (1) `KMS_KEYS_JSON` `{keyId: b64(32B)}`; (2) `KMS_MASTER_KEY` starting `{` → JSON map; (3)
  containing `:` → `keyId:b64(32B)`; (4) master key: exactly 32 UTF-8 bytes as-is, else canonical base64 → 32 bytes,
  else SHA-256 of the bytes.
- Derivation `HKDF-SHA256(master, salt = utf8(keyId), info = "payment-gateway:vault:aes-256-gcm:v1", 32)`.
- `Vault.sign(keyId, data)` = hex HMAC-SHA256 under the derived key.
- **Key ids in use**: `credential-set`, `notification-address`, `kyb-national-id`, `platform-setting-secret`,
  `staff-invitation`, `mfa-sms`, `mfa-address`, `google-oauth-verifier`, `webhook-secret`, `attempt-context`
  (`engine/runtime/contextCipher.ts:14`, flow state between phases), `reporting-payload`, `reporting-xml`,
  `reporting-xlsx`, `reporting-docx`, `filing-adapter-secret` (`admin.ts:301-305`), and the audit anchor key
  (default `audit-anchor-v1`, overridable by `AUDIT_ANCHOR_KEY_ID`). P0-T04 greps `Vault`/`seal`/`encrypt(` call sites
  to confirm the list is complete.

## 7. Object storage "pgos1"

Source: `core-back/lib/objectStorageSdk/crypto.ts:142-154` (backup daemon keeps a divergent copy in
`deploy/backup-daemon/src/shared/crypto.ts` that lacks the production refusal of the dev KEK — unify in Rust).

- File: `pgos1` (5 ASCII bytes), frames to EOF `u32be(len) | ct(len) | tag(16)`; no trailer; chunk 64 KiB default
  (4 KiB–16 MiB); reject frames > 16 MiB; refuse empty payloads.
- Chunk nonce `prefix[0..7] | u32be(index) | u8(final)`; AAD `uuidBytes(objectId)[16] | u32be(index) | u8(final)`.
- DEK 32 random bytes; wrapped with AES-256-GCM under KEK vN: random 12-byte nonce, AAD `dek:<objectId>:v<N>`,
  `wrapped = ct(32) | tag(16)`.
- KEKs raw 32 bytes from `OBJECT_STORAGE_KEK_KEYRING="v1:<64hex>,v2:<64hex>"`, active
  `OBJECT_STORAGE_ACTIVE_KEK_VERSION`; dev fallback `SHA-256(DATABASE_URL)`, refused in production.
- Metadata in `storage_objects` (wrapped DEK, nonce, KEK version, stream prefix, chunk size/count, plaintext SHA-256,
  size). Path `{namespace}/{tenant|shared}/{yyyy}/{mm}/{objectId}.v1.enc`.
- SDK also: MIME sniffing and executable rejection (`sniff.ts`), SVG sanitising, AV quarantine, locks, legal hold,
  GC, scrub, KEK rewrap.
- Daemon HTTP: `GET /v1/health`; `PUT|HEAD|GET /v1/blobs/{bucket}/{rel}` (`x-content-sha256` on PUT,
  `x-blob-byte-size` on HEAD); `POST /v1/trash/{bucket}/{rel}`; `POST /v1/purge-trash`; `GET /v1/list/{bucket}?…`.
  `blobStore.ts` is byte-identical in core and the daemon.

## 8. Backup daemon contracts

Sources: `deploy/backup-daemon/src/{server,config,cryptoEnvelope,scheduler,cron,catalogMirror,objectStorageBackup,
instanceLock,logicalDump,commandRunner,artifactStore,restoreDrillRunner,walFetchCli}.ts`,
`core-back/lib/storageEngine/backupControlClient.ts`.

- HTTP (port 4090): `GET /health`, `GET /v1/overview`, `POST /v1/backups/trigger` (202), `PUT /v1/policy`,
  `GET /v1/runs?limit` (≤500), `POST /v1/drills/run` (202, `{latest|targetTime}`), `GET /v1/drills?limit`,
  `PUT /v1/wal/:target/:file` (WAL CN only; 409 for different bytes under an existing name). Idempotency-Key
  handling; FIFO queue with 25 waiting.
- Core client env: `BACKUP_DAEMON_URL`, `_CA_CERT_PATH`, `_CLIENT_CERT_PATH`, `_CLIENT_KEY_PATH`, `_TIMEOUT_MS`
  (15000); errors `BACKUP_DAEMON_TIMEOUT` (504) / `UNREACHABLE` / `NOT_CONFIGURED` (502). Daemon side uses
  `BACKUP_DAEMON_CERT_PATH` / `_KEY_PATH` / `_CA_CERT_PATH` (names differ — keep).
- **PGBKv2**: `"PGBKv2"` (6) | `0x02` | salt16 | iv12 | ct | tag16; payload key `HKDF(master, salt,
  "pg-backup-v2:payload:<target>:<id>")`; AAD `header || "|<target>:<id>"`; manifest HMAC key `HKDF(master,
  "pg-backup-v2-catalog", "manifest-hmac-sha256")`; master `BACKUP_ENCRYPTION_KEY_HEX` (64 hex); zstd before
  encryption. Drill reports HMAC-SHA256 over stable JSON.
- Engines `pg-native` (default; `auto` maps to it, `configSchema.ts:744`), `wal-g`, `barman`; tools listed in
  chapter 1 §10; S3 via `Bun.S3Client`; catalog mirror (encrypted, HMAC-signed copy per tier); object-storage backup
  (incremental blob copy, parity check, KEK keyring escrow under the backup key); per-host instance lock; scheduler
  with its own 5-field cron.

## 9. Rate limiting

- Edges: `express-rate-limit` v8 fixed windows, in memory per process. Reproduce fixed window per key, same env
  vars, same key derivation (IP, token hash, account), same `429` body and headers (captured in P0-T04).
- Limits: admin auth 10/15 min, API 600/60 s, search 120/min (token-hash key), academy 60/min, uploads 20, backup
  jobs 6/10 min; merchant auth 20/15 min, API 300/60 s, external 120/60 s, upload 10; checkout pay 120/60 s (before
  body parsing), inbound 600/60 s; core `/api/public` 15/hour.
- Per-account failure limiters: `admin-back/lib/authLimiters.ts` **and** `merchant-back/lib/authLimiters.ts`.
- Rust: one shared sharded map per process (not per ntex worker) so limits do not multiply by worker count.

## 10. Edge → core upstream pool

Source: `{admin,merchant,checkout}-back/lib/coreInternalClient.ts`, `lib/corePools.ts`, `lib/mtlsClient/index.ts`.

- Nodes `CORE_BACK_URLS` (comma, de-duplicated, absolute `https:`), fallback `CORE_BACK_URL`. Sandbox pool
  `SANDBOX_CORE_BACK_URLS` with `x-execution-plane: SANDBOX`, `x-sandbox-proxy: <edge>`; never falls back to Live;
  unset → `503 SANDBOX_NODE_UNAVAILABLE`.
- Per node: keep-alive 30 s, ≤ 64 sockets, TLS 1.3 only, `MTLS_CLIENT_*`, SNI only for hostnames; SSE pool 128
  sockets, `MAX_STREAMS_PER_IP` (5).
- Selection: least in-flight, monotonic round-robin tie-break; never the same URL twice per logical call.
- Health: passive; transport/TLS/timeout errors count, any HTTP response marks healthy; eject after 3 consecutive
  failures (`CORE_FAILURE_THRESHOLD`) for 5 s (`CORE_FAILURE_COOLDOWN_MS`); half-open single probe when in-flight 0,
  half-open preferred; none eligible → `503 CORE_UNAVAILABLE`.
- Retries: `maxAttempts` 2; connect-phase failures retried for GET/HEAD/PUT/DELETE/OPTIONS; after send, replay on
  502/503/504 only for GET/HEAD/OPTIONS, `Idempotency-Key` requests or opt-in (`retryIdempotent`,
  `retryIfUnavailable`); all-5xx → last core body unchanged.
- Timeouts: `CORE_REQUEST_TIMEOUT_MS` (admin 60000, others 30000), `CORE_TOTAL_DEADLINE_MS` 300000,
  `CORE_MAX_RESPONSE_BYTES` 64 MiB, `RECONCILIATION_TIMEOUT_MS`, checkout inbound 10 s, checkout SSE 10 min, POS SSE
  `POS_STREAM_TIMEOUT_MS` 900000.
- Errors: timeout `504 CORE_TIMEOUT`; refused/reset/pipe/unreachable `502 CORE_UNREACHABLE`; DNS
  `502 CORE_DNS_FAILURE`; TLS `502 CORE_TLS_ERROR`; other `502 CORE_CONNECTION_ERROR`; `CORE_RESPONSE_TOO_LARGE`,
  `CORE_BAD_GATEWAY` (502); `CORE_GATEWAY_TIMEOUT` (504).
- Path confinement `assertCorePath`: reject `//`, `://`, backslashes, bad percent escapes, dot segments; force channel
  prefix (admin `/internal/admin`, `/internal/sandbox`; merchant `/internal/merchant`, `/internal/sandbox`; checkout
  `/internal/checkout`).
- Headers to core (set last): `x-request-id`, `x-real-client-ip`, `x-client-user-agent` (sanitised),
  `x-edge-service`, `accept: application/json`, content-type, `authorization` verbatim (no separate identity
  header), `idempotency-key`, `x-pg-min-lsn` when declared (admin validates `^hex/hex$`). Relay back:
  `x-pg-served-by`, `x-pg-min-lsn`.
- Header safety: strip hop-by-hop/framing headers, compute `content-length`; non-printable-ASCII names/values →
  `400 CORE_HEADER_INVALID`.
- Client IP: trust `x-real-ip` (fallback `x-real-client-ip`) only from `TRUSTED_PROXY_CIDRS` peers.

## 11. Signatures and crypto engine

- **Outbound merchant webhooks** (`lib/webhooks/standardWebhooks.ts`, `lib/webhooks/egress.ts`,
  `engine/webhooks/events.ts`): headers `webhook-id` (`evt_<outboxId>`), `webhook-timestamp` (Unix s per attempt),
  `webhook-signature` (space-joined `v1,<b64 HMAC-SHA256(key, "<id>.<ts>.<body>")>` per active secret; both during the
  24 h rotation overlap). Secret `whsec_` + b64(32B); key = decoded part ≥ 16 bytes. Body
  `JSON.stringify({id, type, created, data})`; `content-type: application/json`, `user-agent:
  PaymentGateway-Webhooks/1`; delivered to the pinned IP. Retry [5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h] ±20%, 8
  attempts → PARKED; retry on network/408/429/5xx; endpoint DISABLED after 5 days (`MERCHANT_WEBHOOK_DISABLE_AFTER_DAYS`).
  Events: `payment.succeeded|failed|expired|refunded`, `dispute.opened|closed`, `cashout.paid|failed`, `link.expired`,
  `webhook.test`. Up to 5 endpoints per application, `eventTypes` filter.
- **CryptoEngine** (`engine/crypto/CryptoEngine.ts`): algorithms HMAC_SHA256, HMAC_SHA512, RSA_SHA256 (**sign and
  verify**; signing with PEM private key `:308-318`), SHA256, SHA512; key decoding UTF8/HEX (strict)/BASE64 (strict
  canonical); output HEX_LOWER/HEX_UPPER/BASE64. Canonicalisation modes: `SORTED_KEY_VALUE_AMP`,
  `MOAMALAT_SECURE_HASH`, `TIMESTAMP_DOT_RAW_BODY`, `DPAY_WEBHOOK_VERIFY`, `SORTED_VALUES_HASH`, `PLUTU_CALLBACK_HASH`,
  `MYPAY_RAW_BODY`, `TEMPLATE_STRING` (`{{a.b}}`/`{a}`), `JSON_CANONICAL`, `RAW_BODY`. **Sort = JS `.sort()` = UTF-16
  code-unit order** (Rust: compare `encode_utf16()` iterators). Values: null/undefined → `""`, Date → ISO,
  objects → `JSON.stringify`; include/exclude matching case-insensitive; compare `timingSafeEqual(sha256(a), sha256(b))`.
- **SMS webhook transport** (`engine/notifications/CommunicationTransport.ts:200-226`): exact JSON body (golden
  vector), `x-notification-signature: sha256=<hex>`, `x-notification-delivery-id`.
- **Legacy notification webhook** (`NotificationTransport.ts:106-110`): key `HMAC(masterKey,
  "core-back/notification-webhook/v1")`, header `x-notification-signature`, 5 s timeout.
- **Audit anchor**: message `audit-anchor/v1|<lastSeqNo>|<lastRowHash>|<rowsVerifiedTotal>`, `Vault.sign` with the
  anchor key (`AuditChainAnchorWorker.ts:38-39`).
- **Inbound callbacks**: checkout edge forwards raw bytes and only headers `content-type, user-agent, x-signature,
  x-gateway-signature, x-hub-signature-256, x-moomalat-signature, x-timestamp, x-nonce`; GET/HEAD/POST only;
  sandbox/test/uat → SANDBOX, live/production → LIVE; `express.raw` decompresses gzip/br/zstd before forwarding
  (replicate, recompute `content-length`). Core processes synchronously before acknowledging (parity; E-F09 changes it).

## 12. Money, decimals, rounding

- `numeric(18,4)` money (40 columns), `numeric(5,2)` ×3, `numeric(8,6)` ×1 → `rust_decimal::Decimal`.
- Serialisation per handler (parity decides per field): `Money4` = `toFixed(4)`, null → `"0.0000"`
  (`adminCommerce.ts:78`); `DecimalJs` = Prisma Decimal in `JSON.stringify` → decimal.js `toString()`: no trailing
  zeros, exponential notation when exponent ≥ 21 or ≤ −7.
- Input money regex `^\d{1,14}(\.\d{1,4})?$`.
- Commission: profile `roundingMode` (default HALF_UP) to 4 dp once; net/payer share/surcharge by exact subtraction
  (`checkout.ts:364-492`). Mapping: HALF_UP→`MidpointAwayFromZero`, HALF_EVEN→`MidpointNearestEven`,
  HALF_DOWN→`MidpointTowardZero`, UP→`AwayFromZero`, DOWN→`ToZero`, CEILING→`ToPositiveInfinity`,
  FLOOR→`ToNegativeInfinity`.
- Transform `round` (NONE/NEAREST/UP/DOWN) is BigInt-based (`TransformPipeline.ts:658`): port with `num-bigint`.
- Report engine transforms: decimal.js precision 40 HALF_UP (`TransformPipelineExecutor.ts:12`) → `bigdecimal`.
- Known accounting defects are **replicated** in Track P and fixed in E-F13 (GAP-008: partial refunds post the full
  refund scenario, surcharge balance on INTERNAL rails, first-wallet credit, refund splits > 4 dp, AML release fee
  accrual).

## 13. JSON, dates, ids, key order

- **Key order**: JS objects order integer-like keys (canonical array indices `0`, `1`, … up to 2³²−2) first in
  ascending numeric order, then string keys in insertion order. Use `serde_json` with `preserve_order` **and** a
  `js_object_order()` helper applied whenever a map with dynamic keys is serialised (e.g. `byCurrency`, jsonb
  passthrough). Values read from `jsonb` arrive in PostgreSQL's jsonb key order (shorter keys first, then bytewise);
  TS then applies JS ordering when re-serialising — apply `js_object_order()` to jsonb values before output.
- **Numbers**: JS formatting (`1e21` → `1e+21`, `0.1+0.2` → `0.30000000000000004`) via `ryu-js` where a handler
  emits a JS number that may be non-integer.
- **Dates**: `toISOString()` → `YYYY-MM-DDTHH:MM:SS.sssZ` always 3 fraction digits. Columns are mostly
  `timestamp(3)` without time zone holding UTC: truncate to milliseconds before writing.
- **UUIDs**: 105 models client-generated v7 (`Uuid::now_v7()`), 6 v4 (StorageObject, StorageObjectLock,
  StorageObjectAccessLog, ReportAssetBundleEntry, DisputeAttachment, AmlCaseEvidence), one `cuid()` text PK
  (`SandboxSyncAudit`; port Prisma's cuid v1 algorithm or the `cuid` crate output format — golden vector checks
  shape only).
- **BigInt**: never implicit; ledger sequence numbers as strings.

## 14. Ledger posting

Sources: `engine/ledger/LedgerPoster.ts`, `lib/storageEngine/{ledgerShardWriter,shardRouting,shardBalances}.ts`,
`lib/cashoutBalance.ts`, `project-design/parts/01-core-back/03-ledger.md` §3.3 (17 scenarios, 21 variants).

1. `validateTemplate` (`:740`): ≥ 1 line, amounts > 0, Σdebit = Σcredit; omit zero optional legs.
2. `INSERT journal_entries … ON CONFLICT (ref_type, ref_id) DO NOTHING RETURNING`; replay returns the existing entry
   with empty lines, no payload comparison.
3. One account-resolution SELECT: explicit id → context override → scoped (type, owner, gateway, credential set, env,
   currency) → platform-wide (type + currency) → `GL_ACCOUNT_NOT_FOUND`; cache scoped hits 60 s (≤ 20k), never
   fallbacks.
4. Shard = `fnv1a32_utf16(refId) % shard_count` (offset `0x811c9dc5`, prime `0x01000193`, over UTF-16 code units,
   `shardBalances.ts:11-16`); width 1..256 (system 16, wallets 1); MERCHANT_WALLET debits → shard 0.
5. Fold per (account, shard), sort, one `INSERT … SELECT FROM unnest(...) ON CONFLICT DO UPDATE SET current_balance +=
   delta, line_seq += n RETURNING line_seq`; j-th line `shard_seq = high_water − n + j` (gapless).
6. Lines `INSERT … SELECT FROM unnest($2::uuid[], …, $5::numeric[], $6::smallint[], $7::bigint[])`
   (`LedgerPoster.ts:949`), v7 ids, through the partitioned parent.
7. Optional `ledger.entry_posted` outbox row (off by default).
- Kill switches read outside the schema: `LEDGER_RAW_SQL` (default raw path; `false` = ORM path),
  `LEDGER_STRICT_CONTEXT`. Rust implements the raw path only and refuses `LEDGER_RAW_SQL=false` with a startup error
  (recorded deviation; the ORM path is a TS fallback, not a contract).
- Locks: wallet debits first `pg_advisory_xact_lock(hashtextextended('wallet-balance:'||glAccountId, 0))`
  (`cashoutBalance.ts:42`); then shard rows in global (account, shard) order; `applyShardWidth` `FOR NO KEY UPDATE`.
- Invariants: system equation (`InvariantVerifier.ts:27`), per-shard checkpoint proof (`CheckpointService.ts`),
  shard repair (`ShardRepair.ts`). DB guards: amount > 0, `shard_seq > 0`, append-only triggers (SQLSTATE 55000;
  bypass `pgw.ledger_maintenance` GUC + role `pgw_ledger_maintenance`). The DB does not enforce balance.

## 15. Flow engine and slots

Sources: `engine/flow/DynamicRailEngine.ts` (`ALLOWED_TRANSITIONS` :295, checked :801, trusted statuses :330, confirm
input allowlist `["otp"]` :339), `engine/runtime/slotStore.ts`, `engine/guards/AttemptGuardPipeline.ts`,
`api/internal/checkout.ts`.

- 14 statuses; transitions copied from `ALLOWED_TRANSITIONS` (golden vector of the full table). CAS writes
  `UPDATE … WHERE id=$1 AND status=$expected`, 0 rows → `409 ATTEMPT_STATE_CONFLICT`; terminal writes set
  `terminal_at`, clear `next_check_at`, guard `terminal_at IS NULL`.
- Re-finalise guard: idempotent SUCCEEDED/PARTIALLY_REFUNDED/REFUNDED/DISPUTED; refuse CANCELLED/BLOCKED; allow rest.
- Trusted success: status ∈ {SUCCESS, SUCCEEDED, PAID, CAPTURED, CONFIRMED, APPROVED}, reference, amount within route
  tolerance, currency, environment. `MOVES_MONEY` steps never retry (timeout/5xx/missing output → UNKNOWN).
- Phases executed: PRE_INITIATE, INITIATE, SUBMIT, VERIFY, REFUND, VOID, CREDENTIAL_CHECK. CAPTURE, SETTLEMENT_FETCH,
  CANCEL have no executor (parity; E-F07). Native adapter registry unwired (parity). Compute ops registry: exactly
  `MOAMALAT_LIGHTBOX_PAYLOAD`, `NEOMPAY_QR_PAYLOAD`, `LOCAL_SETTLEMENT_RECONCILE`, else `UNKNOWN_COMPUTE_OPERATION`.
  Client actions: SHOW_OTP_FORM, HTTP_REDIRECT, RENDER_EMBEDDED, SHOW_QR_OR_CODE, SHOW_PUSH_OR_TRANSFER. Attempt log
  `clientAction` is hard-coded null (parity).
- Confirm claim (`checkout.ts:~1014`): one `UPDATE payment_attempts SET status='AUTHORIZING' … WHERE terminal_at IS
  NULL AND status IN (…) AND NOT (status IN ('UNKNOWN','VERIFYING') AND point_of_no_return)`; confirm key sha256 in
  `customer_fields_masked.confirm_idempotency_key_hash` (`#>>` read, `jsonb_set` write, `checkout.ts:1023-1036`).
- Slots: reserve `SELECT … FOR UPDATE` + increment `active_locked_count` when `infinite_use OR confirmed_count +
  active_locked_count < use_count`; commit increments `confirmed_count`, completes at `use_count`; release
  `GREATEST(0, active_locked_count − 1)`; overflow → SUSPENSE journal + auto-refund draft + P1 case.
- Attempt groups unique `(link_id, customer_fingerprint)`, fingerprint sha256 hex of `deviceFingerprint:phone:ip`
  (falsy parts dropped). `success_count` column dormant.
- Customer fields stored in `customer_fields_masked` **unmasked** (phone, ip, card_alias, device_fingerprint,
  walletId, arbitrary `customerFields`; `AttemptGuardPipeline.ts:754-761`); `context_ciphertext` written `""` at
  creation and encrypted later (`DynamicRailEngine.ts:1280,1351`). Parity; fixed by E-DB-03.

## 16. Idempotency

- Attempts unique `(link_id, idempotency_key)`; unique-violation race returns the existing attempt (201)
  (`AttemptGuardPipeline.ts:359,863`).
- Cash-out unique `(merchant_id, idempotency_key)`, body or `idempotency-key` header, 8–128 chars, required
  (`400 IDEMPOTENCY_KEY_REQUIRED`, `merchant.ts:2974-2983`).
- Confirm: idempotency hash + atomic claim (§15). Callbacks: `inbound_events (channel_id, dedupe_key)`. Ledger
  `(ref_type, ref_id)`. Webhook deliveries `(endpoint_id, event_id)`. Notifications `event_id`. Statements
  `(statement_source_id, file_hash)` (race surfaces raw P2002 today, GAP-018 — parity: map to the same 500).
- No TTL on any idempotency record.

## 17. Transaction boundaries and lock order (summary)

| Operation | Same transaction | Lock order |
| :--- | :--- | :--- |
| Ledger posting | entry + lines + shard upsert + optional outbox + caller's status/slot change + `writeAudit` when given tx | wallet advisory lock → shard rows sorted |
| `finalizeSuccess` | slot commit + ledger post + SUCCEEDED write + `attempt.transitioned` outbox | slot row → advisory → shards |
| Cash-out | balance check + request row + ledger hold | `wallet-balance:` advisory lock first (cash-out vs confirm deadlock test `test/cashout-lock-order.test.ts`, GAP-200) |
| Approval execution | approval state + subject mutation + audit | per subject (GovernanceExecution) |
| UoW (`uowAdapter.ts`) | buffered outbox + audit rows | `SET LOCAL statement_timeout = max(1000, timeoutMs−250)`; shards `FOR UPDATE` sorted |
| Audit append (audit DB) | trigger computes chain | `pg_advisory_xact_lock(994001)` |
| Refund inquiry, comms bootstrap | job + state | `pg_advisory_xact_lock(hashtextextended(key,0))`, `hashtext(name)` |

## 18. Database conventions and Prisma behaviours

- **Connection URLs written by deploy** contain `?sslmode=no-verify` (`deploy/lib/configSchema.ts:883-928`,
  `hostPlanner.ts:368`), accepted only by node-postgres. Rust must parse them: map `no-verify` → TLS required without
  certificate verification (sqlx `PgSslMode::Require`), also accept `connection_limit` / `pool_max` params. S-SEC-06
  moves deployments to `verify-full`.
- `application_name`: `pg-core-back` (main pool), `pg-core-back-leader` (leader connection),
  `report_engine_readonly_line` (report executor). Keep (DBA tooling and the platform monitor use them).
- Session timezone UTC (`options=-c timezone=UTC`, `lib/storageEngine/utcSession.ts:18`; not in
  `prisma/client/base.ts`, GAP-030); add `SET TIME ZONE 'UTC'` in the pool's `after_connect` because PgBouncer may
  drop startup options.
- **Prisma-managed values the DB does not set**: 89 `@updatedAt` columns (Rust sets `updated_at = now()` explicitly
  on every insert and update of those tables; some have no DB default, e.g. communication tables), 122 `@default(now())`
  (DB default exists for most — verify per table via codegen), `uuid(7)` ids, `cuid()`. Codegen (chapter 3 §5) emits
  per-table metadata `{updated_at: bool, id_kind: v7|v4|cuid}` and the repository layer applies it automatically.
- Interactive transaction defaults: Prisma timeout 5 s, maxWait 2 s (`PG_TX_MAX_WAIT_MS`, `lib/db/waitBudgets.ts`);
  Rust: pool acquire timeout = maxWait, `SET LOCAL statement_timeout` = tx timeout where TS used it.
- Json null vs DbNull: Prisma writes SQL `NULL` for `Prisma.DbNull` and JSON `null` for `Prisma.JsonNull`; codegen
  marks nullable Json columns and handlers must choose the same one TS uses (parity tests on affected tables).
- PgBouncer transaction mode; sqlx statement cache works while `max_prepared_statements > 0` (`PG_STATEMENT_CACHE`
  knob); leader election on a dedicated session connection, same lock keys
  `pg_try_advisory_lock(hashtextextended('worker:'||name, 0))`, ownership checked every tick via `pg_backend_pid()` +
  `pg_locks` (`leaderElection.ts:82-99`); `verifySessionSafety()` at boot.
- Pools: default 20 (`connection_limit`/`pool_max`), idle 30 s, connect timeout `PG_POOL_CONNECT_TIMEOUT_MS` 5000.
- Replica routing (`readStoreAdapter.ts`): 150 ms monitor (`pg_last_wal_replay_lsn()`, replay lag), 2 failures →
  unhealthy, round-robin, consistency `primary` | `replica` (≤ `READ_REPLICA_MAX_LAG_MS` 2000) | `{atLeastLsn,
  maxWaitMs}`, fallback primary; used by global search, admin merchant list, three merchant lists.
- SQLSTATE mapping (replacing Prisma codes): 23505 (P2002), 23503 (P2003), 40001/40P01 (P2034), 55000 (append-only),
  55P03; trigger `RAISE EXCEPTION` messages (plane fence, checker≠maker). Transient for retry: 08xxx, 53xxx, 57xxx,
  40001, 40P01, 55P03 (`callbackInboundHandler.ts`).
- Schema version: **no boot check** in TS core (parity). S-DB-01 adds it to both.
- Copy the 323 raw SQL statements verbatim; translate ~1,950 Prisma calls to SQL with parity tests.

## 19. Startup and shutdown

Reproduce chapter 1 §4 exactly: plane fence check → communication bootstrap (advisory lock
`pgw:communication-settings-bootstrap:v1`, failures logged and skipped) → worker preconditions → Redis invalidation
transport → server/storage → `verifySessionSafety()` → workers start → `reconcileReportChromeDefaults()` (async) →
listen (same log line) → SIGTERM/SIGINT stop workers, close Redis, shut storage, close server. Rust adds (recorded
deviation, invisible to clients): stop workers if `listen` fails.

## 20. Logging, health, telemetry

- Request log text format (`lib/requestLogger/index.ts`): `<ISO> #<6char> <METHOD padded to 6><path> <status> <dur
  ms|s> [<len>b] [← <ip>]` + indented `ℹ/⚠/✖ +<ms>ms` entries; ANSI only on TTY; 5xx/errors to stderr. `LOG_LEVEL` is
  declared but unused (parity: accept and ignore).
- Access-log sink → log DB `http_access_logs` (or bounded memory): `{requestId, channel, method, routePattern,
  statusCode, durationMs, dbQueries:0, dbDurationMs:0, actorId:null, clientIp, createdAt}`; batched
  (`STORAGE_LOG_BUFFER_MAX` 5000, flush 250 ms).
- Core `GET /health` (always 200): `{msg:"OK"|"DEGRADED", status:"ok"|"degraded", service:"core-back", release,
  commit, leader, queue:{enabled, queued, oldestQueuedAgeMs, thresholdMs, degraded, error?:"QUEUE_HEALTH_UNAVAILABLE"},
  workers:[…]}`; channel health `/internal/{admin,merchant,checkout}/health`; edge `/health` `{status:"ok", service,
  release, commit, uptime}`. Rust adds `impl:"rust"` (additive).
- Telemetry headers `x-pg-served-by`, `x-pg-min-lsn`, `x-pg-lsn` (checkout writes `checkout.ts:1434-1435,1690-1691`).
- Release/commit from `APP_RELEASE`, `APP_COMMIT`/`GIT_COMMIT`; node id `NODE_ID`.

## 21. Environment variables

- Core `core-back/lib/env/index.ts`: zod strict object, ~210 keys, booleans `true/1/yes/false/0/no`, exit 1 with
  `Invalid environment configuration: <paths>`; cross rule `WORKER_ENABLED && PGBOUNCER_ENABLED` ⇒
  `LEADER_ELECTION_DATABASE_URL` required and ≠ `DATABASE_URL`. `PLANE_FENCE_ALLOW_FAKE_RAILS_ON_LIVE` is in the
  schema. Declared but unused: `LOG_LEVEL`, `WORKER_CONCURRENCY`, `WORKER_REQUEST_TIMEOUT_MS`.
- Read outside the schema: `KMS_KEYS_JSON`, `APP_RELEASE`, `APP_COMMIT`, `GIT_COMMIT`, `NODE_ID`,
  `REDIS_VELOCITY_FAILURE_POLICY`, `REPORT_READONLY_DATABASE_URL`, `REPORT_MERCHANT_READONLY_DATABASE_URL`,
  `REPORT_READONLY_SERVED_BY`, `REPORT_ASSET_STORAGE_DIR`, `SANDBOX_DB_NAME`, `LEDGER_RAW_SQL`,
  `LEDGER_STRICT_CONTEXT`, `AUDIT_ANCHOR_KEY_ID`, `NOTIFICATION_WEBHOOK_URL`, `SYNTHETIC_*`.
- Edges `{admin,merchant,checkout}-back/lib/env/index.ts` (~25 keys each); backup daemon `src/config.ts` (86 keys);
  fake rails `lib/env/index.ts` (22 keys); object storage daemon `src/config.ts`.
- P0-T04 generates `env-schemas.json`; `pg-config` is tested against it. Rust-only knobs (`HTTP_WORKERS`,
  `WORKER_RUNTIME_THREADS`, `PG_STATEMENT_CACHE`, `METRICS_BIND`, `LOG_FORMAT`, `CREDENTIALS_DIRECTORY` support) have
  safe defaults.

## 22. Uploads, downloads, reconciliation

- Core receives raw bytes with `x-upload-filename` (URI-encoded), `x-upload-content-type`, `x-upload-metadata`
  (base64url JSON), `x-upload-size`, `x-upload-sha256`, `x-statement-source-id`; magic-byte checks
  (`merchant.ts:103-108`); bytes to the object-storage SDK with SHA-256. Edges parse multipart (multer memory).
- Downloads: `contentDisposition()` (RFC 6266 ASCII fallback + `filename*=UTF-8''`); regulatory outputs add
  `X-Content-SHA256` and hard-coded `report-<id>.xlsx|docx` names; CSV `merchant.ts:2196`; whole buffers.
- Exports: JSON of the list spec with `take: 5000`, `total`, `exported`, sometimes `truncated`, plus an audit row.
- Reconciliation (`engine/reconciliation/StatementIngestor.ts`): CSV (hand-written `parseCsvRows`, configurable
  delimiter, any Node `BufferEncoding`, `dateFormat` tokens, Africa/Tripoli default), JSON; **XLSX parser unwired**
  (`BackgroundJobHandlers.ts:345`, `sandboxControl.ts:1447` build the ingestor without it → `400
  XLSX_PARSER_UNAVAILABLE`). Upload answers 202 and enqueues `RECONCILIATION_RUN`. `postSettlementSweeps`,
  `ReconciliationFollowUp` follow.
- Report Studio PDF: `501 SERVER_PDF_NOT_CONFIGURED`.

## 23. SSE

- Checkout `GET /internal/checkout/pay/:linkKey/logs/:attemptId/status`: `event: status`, data `{attemptId,
  reference, status, substatus}`; realtime subscription + 2 s DB poll fallback; 10 min deadline; close on terminal.
- Merchant POS `GET /internal/merchant/pos/screens/:screenCode/stream`: `event: attempts` (JSON array), POS events,
  heartbeat; 15 min deadline.
- Headers: `content-type: text/event-stream`, `cache-control: no-cache, no-transform`, `connection: keep-alive`,
  `x-accel-buffering: no`. Edges stream through, abort upstream on disconnect, retry only before establishment.

## 24. Redis

- Connection `REDIS_URL` else `redis://<first REDIS_NODES>`.
- Invalidation bus: channel `payment-gateway:invalidation:<topic>`, message `{id:uuid, namespace:"payment-gateway",
  topic, payload, publishedAt}`; LRU dedupe 2048; drop foreign namespace; topics `credential:<id>`, `gateway:<id>`,
  `configuration:<scope>`, `attempt:transition` (bridged to `realtime:attempt`), `realtime:pos`; `*` patterns use
  PSUBSCRIBE; realtime payload adds `emittedAt`. Rust and TS must interoperate while both run.
- Cache `pgcache:` JSON + L1 30 s; velocity `pgcache:vel:<ruleId>:<scopeKey>:<windowSeconds>` ZSET members
  `<amountMinor>:<nowMs>:<seq>`, `VELOCITY_LUA_SCRIPT` EVALSHA→EVAL, 250 ms timeout, policy
  `REDIS_VELOCITY_FAILURE_POLICY` (`local-fallback` default, `fail-open`, `fail-closed`); auth `pgauth:` (§5).
- Settings caches (route health, merchant reports, communication) are local 5 s TTL; settings writes invalidate only
  the local node (parity; E-F01 fixes).

## 25. Communication engine, templates, tipping-off

Sources: `lib/communication/{settings,templates,policy,bootstrap}.ts`, `engine/notifications/*`,
`engine/compliance/tippingOff.ts`, `lib/{kybNotifications,commissionNotifications,staffInvitation,
automationNotices}.ts`, worker notice code.

- Channels EMAIL, SMS, IN_APP; languages AR, EN; confidentiality PUBLIC, MERCHANT, INTERNAL.
- Settings `communication.email`, `communication.sms`, `communication.policy`, `auth.google` (secrets in
  `platform_setting_secrets` under `platform-setting-secret`); 5 s cache; provider switching without restart; test
  delivery endpoint; `communication_channel_status` table.
- Email: SMTP with security modes TLS / STARTTLS / NONE and `allowInsecure`. Rust: `lettre` with equivalent modes;
  message headers and MIME structure compared in a golden test (subject encoding, multipart/alternative order).
- SMS policy modes OFF / AUTH_ONLY / CRITICAL_ONLY / ALL + template allow-list; `AUTH_TEMPLATE_CODES` and
  `DEFAULT_SMS_TEMPLATES` (`settings.ts:345`) are code constants.
- Templates: `NotificationTemplate` rows (`{{var}}`, versioned) plus **code-owned bilingual templates** inserted with
  `skipDuplicates` (`templates.ts:19-76`) and inline EN/AR text in ~15 files (KYB, commission, staff invitation,
  automation notices, worker notices, deadlines). Port every string byte-for-byte; P0-T06 extracts them into
  `notification-texts.json` and a test compares Rust output.
- Rendering `{{var}}` and the tipping-off guard: `assertNoTippingOff` refuses non-INTERNAL templates referencing AML
  variables; `redactAmlPayload`; INTERNAL-class content never logged. Golden vectors for render + guard outcomes.

## 26. Screening normalisation

Source: `engine/guards/ScreeningProvider.ts:91-132`.

- Normalise Arabic: strip diacritics (harakat), remove tatweel, fold alef variants, yaa/alef maqsura, taa marbuta,
  convert Arabic-Indic and Extended Arabic-Indic digits, lowercase, collapse whitespace. JS `\s` and `toLowerCase()`
  semantics differ from Rust defaults: implement with explicit character tables matching JS (`\s` = the ECMAScript
  WhiteSpace + LineTerminator set; `toLowerCase` = Unicode default case mapping, use `str::to_lowercase` which matches
  except for final sigma — add a golden case).
- Name similarity algorithm and thresholds: port as written; golden vectors over ≥ 500 name pairs (Arabic, Latin,
  mixed).
- Internal watchlist provider keeps pending results in process memory (parity).

## 27. Academy exam engine and certificates

Sources: `engine/academy/{catalog,examEngine,certificate}.ts`.

- Seed = first 32 bits (big-endian) of `sha256("<userId>:<examId>:<attempt>")`; mulberry32 PRNG; seeded shuffle using
  f64 arithmetic exactly as JS (`Math.floor(rand() * n)`); question selection must match for in-progress sessions.
  Golden vectors over ≥ 200 (user, exam, attempt) triples.
- Certificates: `publicId` = base64url(24 random bytes); `displayId` = `PG-AC-<hex>` (copy the exact hex length and
  case); supersede previous certificate inside one transaction; public verification route on checkout-back.

## 28. Gateway egress (API consumer) and SSRF rules

Sources: `engine/apiConsumer/ApiConsumer.ts`, `lib/webhooks/egress.ts`.

- 10 auth methods: NONE, API_KEY, PERMANENT_TOKEN, TOKEN_ENDPOINT, REFRESH_TOKEN, USERNAME_PASSWORD, BASIC,
  REQUEST_SIGNATURE (HMAC-SHA256/512), OAUTH2_CLIENT_CREDENTIALS, MUTUAL_TLS; applied in header/query/body. Token
  caching for client-credentials and refresh flows with 30 s refresh margin and ±10% jitter (`:877,902,915`).
- Per-credential-set client certificates (`mtls_cert_ciphertext`) passed via Bun's `fetch(..., {tls:{cert,key,ca}})`
  (`:543-556`). Rust: build one reqwest `Client` per credential set (identity from PEM), cached in `moka` and
  invalidated on `credential:<id>` bus events.
- Guards: HTTPS only, host allowlist, DNS resolution with private/loopback/link-local/CGNAT rejection (`ipaddr.js`
  ranges), credentials-in-URL rejection, WHATWG URL parsing semantics (Rust `url` crate is WHATWG-compliant), no
  redirects, 2 MiB response cap (`:1127`), JSON depth 64 (`:1008`). Pinned IP delivery for webhooks.
- Content types JSON, form, multipart, XML (string templates with escaping; DTD/ENTITY rejection on responses), text.

## 29. Report engine and spec importer artefacts (byte-identical)

- Report spec hashing (`specHash.ts`), transcripts (`ReportTranscriptBuilder.ts`, `ChromeTranscriptBuilder.ts`) and
  the migration prompt builder (`lib/reportEngineSdk/migrations/*`) are **released artefacts**: never overwrite a
  released snapshot (`project-design/parts/01-core-back/12-report-engine-sdk.md` §18). Rust output must be
  byte-identical for every stored spec and released transcript version.
- Spec importer transcript (`engine/specImporter/TranscriptBuilder.ts:396`) embeds
  `z.toJSONSchema(IntegrationSpecSchema, {io:"input", target:"draft-2020-12"})`, served at `admin.ts:12897`, plus
  `buildRepairPrompt`. Rust ships the JSON Schema as a **committed file generated by the TS code** (golden artefact)
  and embeds it; a test asserts the transcript bytes equal the TS output.
- Read-only executor (`PostgresReadOnlyExecutor.ts`): `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`,
  `SET LOCAL statement_timeout`, `lock_timeout 2000ms`, `idle_in_transaction_session_timeout 5000ms`, `work_mem`,
  `timezone UTC`, DML/DDL regex blocklist, `ROLLBACK`.
- XSD/XML: custom compiler/generator/validator (`XsdCompiler.ts` limits 2 MiB, depth 32, 5,000 repeats); generated XML
  byte-identical. XLSX (exceljs → rust_xlsxwriter) and DOCX (WordprocessingML strings + zip) compared after
  unzip-and-canonicalise.

## 30. Fake rails contracts

- SQLite schema `fake-rails-back/engine/db/schema.sql` (6 tables, WAL).
- Chaos PRNG: mulberry32 + FNV-1a (`engine/chaos/prng.ts`), deterministic per scenario seed (golden vectors).
- Magic OTPs `000000`, `999999`, `500500`, `408408`; magic phone suffixes `9901`–`9907`; faults (20 s hang then 504,
  socket reset, 500/503, 429, malformed 200); webhook delay/duplicate/out-of-order/corrupt signature.
- HMAC signing `engine/crypto/FakeCryptoSigner.ts`; portal HS256 JWT `lib/jwt.ts` (`FAKE_RAILS_JWT_SECRET`); seeder
  token header `x-fake-rails-seeder-token`; peer allowlist `FAKE_RAILS_ALLOWED_CIDRS`, `FAKE_RAILS_TRUST_PROXY`;
  outbound webhooks to `CORE_INBOUND_BASE_URL` (default `http://127.0.0.1:4103/api/v1/inbound`).
- Statements CSV / JSON / dependency-free XLSX; SDK/hosted JS generated per request.
