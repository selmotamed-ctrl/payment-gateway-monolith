# Chapter 5 — Security v2

> Part of the Rust/ntex port plan (`porting_to_ntex_rust.md`). Threat model, the known weaknesses (with sources),
> and their fixes as **S-SEC** items (both implementations, during coexistence) or **E-SEC** items (after
> retirement). Database-level security items are in chapter 4 (S-DB-02/03/05/12, E-DB-03/04/05).

---

## 1. Threat model (summary)

| Asset | Threats | Primary controls today | Gaps |
| :--- | :--- | :--- | :--- |
| Ledger and balances | tampering, double posting, insider manipulation | append-only triggers, maker-checker, idempotency, invariants | no DB balance check, audit delete bypass (S-DB-02) |
| Payer and merchant PII, bank details | exfiltration via app bug, SQL access, backups, logs | vault for some fields, encrypted backups | plaintext identifiers and bank details (E-DB-03), no RLS (E-DB-04) |
| Gateway credentials, webhook secrets, keys | theft from env/process listing, memory, disk | vault, 0600 env files | secrets in env and some remote argv (AD-13, D-items), no HSM |
| Sessions and API tokens | theft, replay, privilege escalation | HS256 JWT verified in core, revocation, throttles | tokens in browser storage by default (S-SEC-01), MFA only at login (S-SEC-04), scope gaps (S-SEC-02) |
| Internal network | MITM, lateral movement | mTLS edge↔core and daemons, UFW | DB/Redis TLS unverified or absent (S-SEC-06), TOFU SSH in deploy, firewall can be missing |
| Supply chain | malicious dependency, tampered artefact | lockfiles, pinned Bun hash | 14 core advisories (GAP-081), unsigned release artefacts |
| Availability | DoS on public checkout, resource exhaustion | Nginx `limit_req`, per-process limiters | limiters per process (E-SEC-10), unbounded buffers in places |

---

## 2. S-SEC items (land in TS and Rust together)

| ID | Weakness (source) | Fix | TS change | Verification |
| :--- | :--- | :--- | :--- | :--- |
| S-SEC-01 | Session tokens in browser storage by default (GAP-019) | Turn on HttpOnly cookie mode by default for admin and merchant portals once both frontends pass their journeys in cookie mode; keep bearer for API clients | config default + frontend verification | Playwright live journeys in cookie mode; CSRF header enforced |
| S-SEC-02 | `requireMerchantScope` exported but unused and fails open on null `merchantId` (`authDoubleCheck.ts:448-460`, `merchant.ts:4315`) | Fail closed: merchant principal without `merchantId` → `403 MERCHANT_SCOPE_REQUIRED`; every merchant route's policy declares `merchant_scope: Required` and the handler loads data only through tenant-filtered repositories | TS patch: guard applied to the merchant router + fix call sites | IDOR test matrix (merchant A cannot read merchant B for every route with an id parameter) |
| S-SEC-03 | Admin `auth/me` registered before authentication (`02-security` §7) | Move behind `requireAuthentication` | TS patch | Unauthenticated call → 401 |
| S-SEC-04 | `mfa` claim never re-checked after login | Users with MFA enabled must present sessions with `mfa:true` on every staff route and on merchant routes flagged sensitive (cash-out, tokens, webhooks, payout details, user management); otherwise `403 MFA_REQUIRED` | TS patch in `resolveSessionPrincipal` + route flags | Test with an `mfa:false` token |
| S-SEC-05 | Core trusts `x-real-client-ip` without verifying the sender (`02-security` §7) | Core honours `x-real-client-ip` only on requests from edge CNs (always true on `/internal/*`) and records the edge CN with the IP in audit rows; edges overwrite the header (already) | TS patch (audit field) | API-token IP allowlist tests |
| S-SEC-06 | Storage links unverified: PostgreSQL self-signed + `sslmode=no-verify`, PgBouncer `server_tls_sslmode=require`, Redis without TLS (D-08, GAP-022/037/057) | Internal-CA certificates for PostgreSQL, PgBouncer, Redis (pgctl, chapter 7 §6); clients use `sslmode=verify-full` with `sslrootcert`, client certificates (`pg-client`, `redis-client` — already generated but unused); PgBouncer `server_tls_sslmode=verify-full`; Redis 7 / Valkey 8 `tls-port` with `tls-auth-clients yes`, ACL users per service (`core`, `worker`, `backup`) | node-postgres and node-redis already support these URL options: config only | `openssl s_client` checks in pgctl verify; connection fails with a wrong CA |
| S-SEC-07 | No PAN guard in core (GAP-026) | Reject request fields whose names or values look like PAN/CVV (Luhn-valid 13–19 digit strings, keys `pan`, `card_number`, `cvv`, `cvc`…) with `400 PAN_NOT_ACCEPTED` on all inbound payer/merchant APIs except allowlisted rails (none today); redact PAN-shaped strings in logs, step logs and error details | TS patch | Fuzz test with Luhn-valid numbers |
| S-SEC-08 | `redirectDomainAllowlist` stored but not enforced (GAP-010) | Enforce on link creation and return redirects; unknown domain → `400 REDIRECT_DOMAIN_NOT_ALLOWED` | TS patch | Tests |
| S-SEC-09 | Backup daemon accepts any CA-signed client for control operations (SC-014); cert files root-owned while the daemon runs as `pgbackup` | Bind CN → operation set (`backup-client`: read+trigger+drill; `wal-archive-client`: WAL PUT only; admin-only `policy` change requires `backup-admin` CN used solely by core's approved policy execution); pgctl installs cert files owned by the daemon user, mode 0400 | daemon patch | Negative tests per CN |
| S-SEC-10 | Fake rails: plain HTTP, unauthenticated inbound, raw headers/bodies stored (D-18) | TLS via internal CA on the fake-rails listener; HMAC-authenticated control and seeder APIs; redact authorization headers in stored step events; still refused in production | fake-rails patch | Tests |
| S-SEC-11 | MFA leftovers: expired challenges never purged; pre-migration notifications hold plaintext codes (GAP-036) | Housekeeping purges expired `mfa_challenges`; one-off scrub of plaintext codes in `notifications.payload_json` | TS patch + migration | Query shows zero plaintext codes |
| S-SEC-12 | Merchant can reactivate an INACTIVE POS terminal (GAP-043) | Reactivation requires staff approval (`POS_TERMINAL` subject) | TS patch | Tests |
| S-SEC-13 | Client-side exports/copies without server audit (GAP-073) | Export endpoints write audit rows (already for server exports); add `POST /audit/client-export` called by frontends | TS + frontend | Audit rows present |
| S-SEC-14 | Dependency advisories (GAP-081, 14 core, 3 high via Prisma) | Upgrade or mitigate before P0 ends; CI `bun audit` gate for TS until retirement; `cargo audit` + `cargo deny` for Rust | dependency bumps | CI green |
| S-SEC-15 | Secrets visible in process listings during deploy (`healthVerifier.ts:294,340`, `freshStorage.ts:98,202`, test-matrix) | pgctl passes secrets through stdin/temp files 0600 or `PGPASSFILE`, never argv (chapter 7 §5) | D-track | `ps` capture during deploy shows no secrets |
| S-SEC-16 | SSH `StrictHostKeyChecking=accept-new` (TOFU) | pgctl pins host keys in `pgctl.known_hosts` (fingerprints recorded at enrolment, verified every connection) | D-track | Changed host key → refuse |
| S-SEC-17 | Firewall optional on install failure; never verified; TCP only | pgctl uses nftables with atomic ruleset load, refuses to continue without a firewall, verifies the loaded ruleset matches the rendered one | D-track | Verify step diff empty |

---

## 3. Internal TLS model (target)

- One internal CA (ECDSA P-256 root offline on the operator workstation + an intermediate per environment used by
  pgctl; RSA kept only where a component requires it). Leaves: ECDSA P-256, validity 90 days (configurable), SANs per
  host IP/DNS, EKU per role.
- Every internal link uses mutual TLS with full verification:

  | Link | Server cert | Client cert / auth |
  | :--- | :--- | :--- |
  | edge → core | `core-back.internal` | `admin-back` / `merchant-back` / `checkout-back` |
  | core → backup daemon | `backup-daemon` | `backup-client`, `backup-admin` (S-SEC-09) |
  | PostgreSQL WAL archive → backup daemon | `backup-daemon` | `wal-archive-client` |
  | core/backup → object storage | `object-storage-daemon` | `object-storage-client`, `backup-daemon` |
  | core → PgBouncer → PostgreSQL | `pgbouncer`, `postgres-<cluster>` | `pg-client` (+ SCRAM password) |
  | core → Redis | `redis` | `redis-client` (+ ACL user) |
  | core → audit/log DB | `postgres-audit`, `postgres-log` | `audit-db-client`, `log-db-client` |
  | sandbox core → fake rails | `fake-rails` | `fake-rails-client` (S-SEC-10) |

- Rotation: pgctl renews leaves at 2/3 of lifetime; services reload certificates on SIGHUP without restart (Rust
  servers rebuild the rustls config atomically; PostgreSQL `pg_reload_conf()`; PgBouncer `RELOAD`; Redis
  `CONFIG SET tls-cert-file` + reload). CRL distributed to servers that support it (PostgreSQL `ssl_crl_file`, Rust
  verifier). Revocation of a leaf = remove from allowlist + CRL + rotate.

---

## 4. Authorisation model (target)

1. **Route policy registry** (chapter 3 §6) is the single source of truth: authentication method, authorities (OR),
   merchant scope, MFA, maker-checker subject, rate class, audit class. CI fails if any route lacks a policy or if the
   policy table differs from the reviewed snapshot without an approved change.
2. **Tenant isolation in depth**: policy (`merchant_scope: Required`) → repository filters → RLS (E-DB-04).
3. **Maker-checker coverage** (E-F06): every sensitive mutation is an approval subject, including those that are
   single-actor today (`APPLICATION`, `CASHOUT_REQUEST`, `PLATFORM_SETTING`, commission profile and velocity rule
   creation, backup trigger/drill/restore).
4. **Edges** stop doing advisory authority decoding once E-SEC-01 lands: they verify the session signature with the
   public key and enforce the same policy table (core still re-verifies).

---

## 5. E-SEC items (after retirement)

| ID | Change | Details |
| :--- | :--- | :--- |
| E-SEC-01 | **Asymmetric session tokens** | EdDSA (Ed25519) signed sessions with `kid`; core holds the private key (credential), edges hold the public JWKS; dual-accept HS256 + EdDSA for 12 h (one session lifetime) during rollout; key rotation every 90 days with overlap; revocation unchanged (jti list) |
| E-SEC-02 | **Session lifecycle** | idle timeout (configurable, default 30 min for staff), absolute lifetime 12 h, refresh with rotation and reuse detection, optional device binding (cookie + fingerprint hash), "log out everywhere" |
| E-SEC-03 | **Vault v2** | format `v2:<keyId>:<keyVersion>:<b64 iv>:<b64 ct||tag>`; AAD = `table|column|rowId|keyId|keyVersion`; per-key versions with active version; reader accepts v1 and v2; rewrap worker migrates v1→v2 and old versions→active in batches; key ids per data class (`pii-enc`, `pii-blind-index`, …) |
| E-SEC-04 | **API tokens v2** | token = `pg_<plane>_<publicId>_<secret>`; lookup by `publicId` (no hash scan), verify `HMAC-SHA256(pepper, secret)` (pepper in credentials); scopes per route from the policy registry (catalogue extended beyond `link:*`/`payment:read`); per-token rate limits; last-used IP |
| E-SEC-05 | **Key management** | `KeyProvider` trait with implementations: file/credential (default), PKCS#11 HSM (`cryptoki`), cloud KMS (optional); envelope encryption so data keys are wrapped by the provider; documented rotation runbooks for every key (§6) |
| E-SEC-06 | **Short-lived internal certificates** | 30-day leaves, automatic renewal by `pgctl pki renew` timer on the operator host or a renewal agent; hot reload in all services |
| E-SEC-07 | **Global rate limiting** | Redis-backed sliding window shared by all nodes (Lua), with local fallback; replaces per-process limiters for auth and pay endpoints |
| E-SEC-08 | **Audit anchoring** | daily anchor (already HMAC) also published to an external WORM target (object storage bucket with object lock, or signed email to compliance) so a full DB compromise cannot rewrite history silently |
| E-SEC-09 | **Inbound callback authentication policy** | per-gateway required signature mode; callbacks without a valid signature rejected before processing (today depends on rail spec); replay window with nonce/timestamp store |
| E-SEC-10 | **Browser security headers** | pgctl Nginx templates add CSP (script-src self + hashes), `Strict-Transport-Security`, `Permissions-Policy` for all portals |

---

## 6. Key and secret inventory

| Secret | Today | Target storage | Rotation procedure |
| :--- | :--- | :--- | :--- |
| `KMS_MASTER_KEY` (vault master, session HKDF input) | env | systemd credential (AD-13); E-SEC-05 provider | v2 key versions + rewrap worker; sessions: E-SEC-01 separate signing key |
| Session signing key | derived from master | E-SEC-01 Ed25519 keypair in credentials | 90-day rotation with JWKS overlap |
| `OBJECT_STORAGE_KEK_KEYRING` | env | credential | add vN+1, set active, rewrap worker, retire old |
| `BACKUP_ENCRYPTION_KEY_HEX` | env | credential (backup host) | new key for new backups; keep old in escrow for restore; catalog records key id |
| Webhook secrets (`whsec_`) | vault | vault v2 | existing rotation (24 h dual-sign) |
| Gateway credentials | vault (`credential-set`) | vault v2 | per credential set; expiry notices exist |
| DB passwords (owner, app, replication, audit, log) | env / pgbouncer userlist | credentials + SCRAM; client certs added (S-SEC-06) | `pgctl secrets rotate db` (ALTER ROLE + userlist + credential update + rolling restart) |
| Redis password | env + redis config plaintext | ACL users per service, credentials | `pgctl secrets rotate redis` |
| SMTP / SMS / Google secrets | platform setting secrets (vault) | unchanged | admin settings flow |
| Fake rails JWT secret, seeder token | env | credentials | redeploy |
| PII blind-index key (E-DB-03) | n/a | credential; never rotated without re-index plan | rotation = new column + re-index job |
| Internal CA keys | `deploy/.certs` (0700) | root offline; intermediate in pgctl encrypted store (`age`) | §3 |
| Deploy secrets (`deploy.env`) | plaintext 0600 file | `pgctl` encrypted secrets store (`secrets.age`, decrypted in memory with the operator's age identity) | `pgctl secrets set/rotate` |

---

## 7. Supply chain and build security

- Rust: `cargo deny` (licenses, bans, advisories, sources = crates.io only), `cargo audit` daily in CI, `Cargo.lock`
  committed, `--locked` builds, `cargo-cyclonedx` SBOM attached to every release.
- Reproducible builds: pinned toolchain, `cargo zigbuild` pinned glibc, `SOURCE_DATE_EPOCH`, build in CI only.
- Release artefacts signed with `minisign` (public key pinned in pgctl); pgctl verifies signature and SHA-256 before
  install.
- No network access at runtime for builds on hosts (no `bun install`/`cargo build` on production hosts after D7).
- TS side until retirement: `bun audit` gate (S-SEC-14).

---

## 8. Security testing

- IDOR matrix (every route with an id path parameter, two merchants, two staff roles).
- Policy snapshot test (route → policy) reviewed on change.
- Fuzzing (`cargo fuzz`): vault decoder, pgos1 reader, PGBKv2 reader, multipart parser, cursor decoder, CryptoEngine
  canonicaliser, XSD validator, CSV statement parser, JSON body parsers with depth limits.
- Negative TLS tests per link (wrong CA, wrong CN, expired, revoked).
- Secrets-in-logs scanner over test logs (regex for known secret shapes, PAN, `whsec_`, `pg_live_`).
- Annual external penetration test before and after cutover.
