---
id: fake-rails.integration
title: Core Integration and Deployment
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - core-back/prisma/seedFakeRails.ts
  - core-back/engine/apiConsumer/fakeRailsAllowlist.ts
  - core-back/engine/apiConsumer/ApiConsumer.ts
  - core-back/engine/flow/StepExecutor.ts
  - core-back/prisma/syntheticSeeder/SeederSafetyGate.ts
  - core-back/prisma/syntheticSeeder/sync/fakeRailsBulkSyncClient.ts
  - deploy/lib/configSchema.ts
  - deploy/lib/hostPlanner.ts
  - deploy/lib/pkiManager.ts
  - deploy/lib/firewallConfigurator.ts
  - deploy/deploy.ts
  - deploy/templates/nginx.fakerails.conf.tpl
  - checkout-front/src/components/renderers/EmbeddedWidgetRenderer.tsx
design_sources:
  - design/fake_payment_rails_service_architecture.md#2-deployment-engine-integration-production-guardrails
  - design/fake_payment_rails_service_architecture.md#2-3-scoped-ssrf-tls-allowlist-in-core-back-for-fake-rails
  - design/fake_payment_rails_service_architecture.md#7-core-back-pre-seeded-fake-gateway-blueprints-seedfakerails-ts
tests:
  - core-back/test/fake-rails-allowlist.test.ts
  - core-back/test/exhaustive/10-seeder-and-deploy/synthetic-seeder-safety-and-audit.test.ts
  - deploy/test/fakeRails.test.ts
  - deploy/test/exhaustive-deploy-matrix.test.ts
gaps:
  - Only 13 of the 20 fake descriptors have seeded core gateways.
  - cbl_lypay and evo_pay seeded URLs do not match the fake route keys.
  - Default webhook URLs are routed to the wrong core path.
  - Embedded widget loading is blocked by the checkout CSP and renderer allowlist.
  - seedFakeRails updates only existing credential entries; it does not create a credential manifest.
---

# Core Integration and Deployment

## 1. Purpose and scope

This part describes how `core-back`, the synthetic seeder and `deploy/` connect to the fake rails tier:

- `seedFakeRails.ts` rewrites gateway environments, widget definitions, webhook channel tokens and credential secrets.
- The scoped SSRF allowlist permits a private fake rails host without opening private-address SSRF generally.
- The synthetic seeder requires fake rails and performs a handshake plus bulk sync.
- The deploy engine plans a sixth `fake-rails` role, generates a certificate, opens the portal port, renders an Nginx vhost and optionally seeds the blueprints.
- The checkout frontend must be able to load the fake widget scripts and message origins.

It does not document the emulator internals (`fake-rails.backend`), the rail protocol (`fake-rails.protocol`) or the tester portal (`fake-rails.chaos`).

## 2. Design intent (extracted and synthesized from ./design)

The integration is designed to make the platform work out of the box with the emulator:

1. Every seeded gateway environment gets a base URL of `${FAKE_RAILS_PUBLIC_BASE_URL}/rails/<gateway_code>` and an `allowed_hosts` entry for the fake host.
2. Moamalat and MPGS widget definitions load the emulator's SDK scripts.
3. Inbound-verify crypto secrets are derived from a shared seeder token, so signatures produced by the emulator verify with real cryptography and no bypassed checks.
4. `ALLOW_FAKE_RAILS_HOSTS` relaxes the private-IP guard only when the target host is in both `FAKE_RAILS_ALLOWED_HOSTS` and the gateway version's own `allowed_hosts`.
5. The deployment engine adds an optional `fake-rails` host role with its own backend port, Nginx port, TLS mode, certificate SAN, firewall scope and PM2 process.
6. The synthetic seeder refuses to run unless it is a declared test server, fake rails is enabled, production is explicitly opted in, every gateway host is fake, and the handshake succeeds.
7. The synthetic seeder bulk-syncs its historical transactions and step events into the emulator so the tester portal shows the same history as the gateway.

## 3. As-built architecture

### 3.1 `seedFakeRails.ts`

`core-back/prisma/seedFakeRails.ts` requires `FAKE_RAILS_SEEDER_TOKEN`. It then runs four update passes and one setting upsert.

**Environments.** `updateEnvironments()` loads every `gatewayVersion` with its gateway and environments. For each environment:

- It reads existing `baseUrls` and preserves the keys (or uses `api`).
- It sets every key to `${FAKE_RAILS_PUBLIC_BASE_URL}/rails/${gateway.code}`.
- It unions the environment's existing `allowedHosts` with the fake base host, optional `FAKE_RAILS_ALLOWED_HOSTS`, `127.0.0.1` and `localhost`.
- It sets `enabled=true`.

**Widgets.** `updateWidgets()` loads widget definitions through their route and gateway. For `moamalat` and `mpgs` it sets:

- `scriptUrls = [<base>/sdk/moamalat-lightbox.js]` or `[<base>/sdk/mpgs-session.js]`.
- `scriptSriHashes = []`.
- `allowedOrigins = [<base>]`.

No other widget is changed.

**Webhook channels.** `updateWebhookChannels()` scans `confirmationChannel` rows of type `WEBHOOK`. The first channel per gateway code receives `pathToken = ${code}-webhook`; later versions keep the existing token. It does not change the channel's verification method, signature header, IP allowlist or crypto-profile reference.

**Credential secrets.** `updateCredentialSecrets()` returns zero if the seeder token is empty. Otherwise, for every `PLATFORM` credential set, it walks existing entries. When an entry key matches a crypto profile `secretKeyRef`, it derives:

```text
HMAC-SHA256(seederToken, "fake-rails:<gatewayCode>:<purpose>")
```

where purpose is `webhook` if any matching profile is `INBOUND_VERIFY`, otherwise `sign`. The derived secret is encrypted through `Vault.encryptSecret(secret, "credential-set")`, the entry is marked secret and its `secretVersion` is incremented. Entries with no matching profile are left untouched. The credential set is marked `VERIFIED`.

**Environment mode.** `ensureEnvironmentSetting()` upserts `server.environment_mode = { mode: "TEST_SANDBOX" }`.

The script prints environment, widget, channel and credential counts and exits non-zero if the token is missing.

### 3.2 Seeded gateway count

`core-back/prisma/seedBlueprints.ts` creates thirteen distinct gateway codes:

`edfali`, `sadad`, `moamalat`, `cbl_lypay`, `mypay`, `tlync`, `mobicash`, `onepay`, `yussor`, `sahara`, `mpgs`, `evo_pay`, `neompay`.

The fake descriptor catalogue has twenty rail codes. Seven fake descriptors have no core gateway blueprint:

- `dpay`
- `plutu`
- `masrefy`
- `hawelli`
- `gpay_libya`
- `numo_pay`
- `libyana`

Conversely, the core uses `cbl_lypay` and `evo_pay`, while the fake routes use `ly_pay` and `evopay`. The counts therefore agree only in spirit: 13 core gateways versus 20 fake descriptors, with two code mismatches inside the overlap.

### 3.3 Scoped SSRF allowlist

`core-back/engine/apiConsumer/fakeRailsAllowlist.ts` implements `isFakeRailsHostAllowed(hostname, gatewayAllowedHosts)`:

1. `env.ALLOW_FAKE_RAILS_HOSTS` must be `true`.
2. The normalized hostname must appear in `FAKE_RAILS_ALLOWED_HOSTS`.
3. The same hostname must appear in the caller's `gatewayAllowedHosts`.
4. Trailing dots are stripped; comparison is lowercase.

`ApiConsumer.ts` and `StepExecutor.ts` call this check before URL validation. When true, `requireHttps` is set to false, allowing the private/loopback fake host over plain HTTP. The general SSRF guard still rejects `169.254.169.254`, unrelated private addresses, redirects, userinfo, fragments, CRLF and path traversal.

The allowlist test proves:

- Closed unless explicitly enabled.
- Both environment and gateway list must match.
- An empty gateway list never matches.
- A metadata address is refused even if listed.

### 3.4 Synthetic seeder integration

`core-back/prisma/syntheticSeeder/SeederSafetyGate.ts` enforces five gates:

1. `IS_TEST_SERVER=true`.
2. `FAKE_RAILS_ENABLED=true` and a public base URL.
3. Production requires `FAKE_RAILS_ALLOW_IN_PRODUCTION=true`.
4. At least one allowed host; every configured gateway environment URL must point at an allowed fake host, not an external host or metadata address.
5. The `POST /portal-api/internal/seeder-handshake` call must succeed with the seeder token.

`sync/fakeRailsBulkSyncClient.ts` posts transactions and step events to `/portal-api/internal/bulk-seed` with `x-fake-rails-seeder-token`. The emulator inserts both batches in one `BEGIN IMMEDIATE` transaction and broadcasts `seeder.bulk`.

### 3.5 Deployment configuration

`deploy/lib/configSchema.ts` defines the fake rails keys and validates:

- Host, key path and private IP when enabled.
- Tester username/password/JWT/seeder token.
- Production opt-in.
- Password length and non-collision of backend/Nginx ports with every other role and public port.
- `RUN_SYNTHETIC_HISTORY_SEED` requires an enabled test server and fake rails.

`deploy/lib/hostPlanner.ts` maps the role to:

- Service `pg-fake-rails-back`, source `fake-rails-back`, port `FAKE_RAILS_BACK_PORT`.
- Environment with `NODE_ENV`, `HOST`, `PORT`, `FAKE_RAILS_ENABLED`, `FAKE_RAILS_ALLOW_IN_PRODUCTION`, public base URL, data directory, admin credentials, secrets, CIDRs and `CORE_INBOUND_BASE_URL`.
- Nginx site `fake-rails` on `FAKE_RAILS_NGINX_PORT` with `FAKE_RAILS_SSL`, domain, certificate paths and static root `current/fake-rails-front/dist`.
- Certificate bundle `fake-rails-server`.
- Firewall rules for SSH and the portal port restricted to `FAKE_RAILS_ALLOWED_CIDRS` plus core/checkout private IPs.

`deploy/lib/pkiManager.ts` includes `fakeRails` in the PKI bundle with SAN `DNS:<domain>`, `IP:<private-ip>` and `IP:127.0.0.1`. `deploy/deploy.ts` builds the SPA, deploys backend plus `dist`, renders the vhost and optionally runs `bun run seed-fake-rails` on the core host.

`deploy/templates/nginx.fakerails.conf.tpl` proxies `/rails`, `/sdk`, `/portal-api` and `/hosted` to the backend and serves the SPA. Its CSP allows `script-src 'self' 'unsafe-inline'` and `frame-ancestors 'self' *`.

### 3.6 Embedded widget and CSP block

The embedded flow cannot currently load the emulator widget end to end:

1. `checkout-front/src/components/renderers/EmbeddedWidgetRenderer.tsx` hard-codes `SCRIPT_ALLOWLIST_HOSTS` to public HTTPS partners (`payments.moamalat.ly`, `secure.moamalat.ly`, `test.mpgmerchant.test`, `pay.evowallet.net`, `js.numo-pay.com`). A fake URL such as `http://127.0.0.1:8444/sdk/moamalat-lightbox.js` fails `isAllowlistedScript()` for both protocol and host.
2. Even if the renderer allowed it, the checkout Nginx templates set `script-src 'self'` with no fake origin.
3. The seeded widget `cspAdditions` remain `frame-src https://*.moamalat.example.ly` and `frame-src https://*.mpgs.example.ly`; `seedFakeRails.ts` does not rewrite them.
4. `seedFakeRails.ts` writes an empty SRI array, so `EmbeddedWidgetRenderer` cannot apply an integrity hash.

The redirect flow is unaffected because it uses a browser navigation to the hosted URL, subject to the checkout redirect allowlist.

### 3.7 Webhook and callback gaps

- **Wrong path.** `WebhookDispatcher.defaultUrlFor()` inserts `/webhook/` between the inbound base and `:gateway`, while the checkout route is `/api/v1/inbound/:gateway/:env/:pathToken`.
- **Token mismatch.** The default token is `${gateway_code}-webhook`. Blueprint tokens are not uniformly that string (for example `cbl-lypay-webhook`); `seedFakeRails.ts` rewrites the first webhook channel per code to `${code}-webhook`, so the default works only after that pass and only for the rewritten channel.
- **No fake-side verification.** The emulator signs outbound webhooks but never verifies core-originated requests.
- **Credential coverage.** `updateCredentialSecrets()` only updates existing credential entries whose key matches a crypto profile. A gateway with no secret entry or a different key shape remains unconfigured.
- **Crypto-profile mismatch.** The emulator has six explicit webhook signature profiles plus a generic fallback. `evo_pay`'s blueprint declares RSA-SHA256 with a private key, but the fake profile for `evo_pay` is not defined, so it falls back to HMAC.
- **Statement channels.** The core seeds statement channel rows with `<code>-statement` tokens but has no `SETTLEMENT_FETCH` flow and no fetch URL. The fake `/statement` endpoint is not consumed automatically.

### 3.8 Deploy environment keys

| Key | Meaning |
| :--- | :--- |
| `FAKE_RAILS_ENABLED` | Build and deploy the tier |
| `FAKE_RAILS_ALLOW_IN_PRODUCTION` | Explicit production opt-in |
| `IS_TEST_SERVER` | Enables fake rails and synthetic seeding |
| `FAKE_RAILS_SSH_HOST` / `_PORT` / `_USER` / `_KEY_PATH` / `_SUDO_PASSWORD` | Host access |
| `FAKE_RAILS_PRIVATE_IP` | Internal address and SAN |
| `FAKE_RAILS_BACK_PORT` | Express port, default 4104 |
| `FAKE_RAILS_NGINX_PORT` | Public portal/API port, default 8444 |
| `FAKE_RAILS_SSL` / `_SSL_MODE` / `_DOMAIN` | TLS and vhost identity |
| `FAKE_RAILS_PUBLIC_BASE_URL` | Rewritten into gateway base URLs |
| `FAKE_RAILS_REMOTE_DIR` | Release and data root |
| `FAKE_RAILS_ALLOWED_CIDRS` | Firewall and service CIDR contract |
| `FAKE_RAILS_ALLOWED_HOSTS` | Scoped SSRF allowlist |
| `FAKE_RAILS_ADMIN_USER` / `_PASSWORD` | Tester login |
| `FAKE_RAILS_JWT_SECRET` / `_SEEDER_TOKEN` | Signing and seeder auth |
| `SEED_FAKE_RAILS_BLUEPRINTS` | Run `seed-fake-rails` after deploy |

`deploy/deploy.env.example` keeps `FAKE_RAILS_ENABLED="false"` by default. The example sets `FAKE_RAILS_SSL="false"` and an HTTP public base URL; enabling TLS requires staging verification.

### 3.9 Local all-in-one path

`scripts/deploy-localhost.sh` reads `deploy/deploy.env` when present, otherwise uses local defaults. It starts:

- `pg-fake-rails-back` on port 4104 with `FAKE_RAILS_ALLOW_IN_PRODUCTION=true`.
- `CORE_INBOUND_BASE_URL=http://127.0.0.1:4103/api/v1/inbound`.
- `FAKE_RAILS_DATA_DIR` under `.local/fake-rails-data` unless a deployed data directory exists.
- `pg-fake-rails-front` preview on 5104.

It then runs `seedFakeRails.ts` with `FAKE_RAILS_ALLOWED_HOSTS=127.0.0.1,localhost`.

## 4. Contracts and invariants

1. **The SSRF relaxation is triple-gated.** Environment flag, environment host list and gateway host list must all agree.
2. **The fake host never becomes a general private-address exception.** Metadata and unrelated private ranges remain blocked.
3. **Derived secrets must match on both sides.** Both implementations hash `fake-rails:<gatewayCode>:<purpose>` with the seeder token.
4. **Seeded environments are enabled and point only at the fake base URL.** The pass overwrites every existing base-url key.
5. **The synthetic seeder cannot run against real gateways.** Gate 4 rejects any non-fake host.
6. **Deployment production mode requires an explicit opt-in at both config and process level.**
7. **The fake rails host exposes only its portal/Nginx port.** Backend port stays loopback.

## 5. Data / API / config / deployment surface

- Core seeding: `seedFakeRails.ts`, `seedBlueprints.ts`.
- Core URL validation: `fakeRailsAllowlist.ts`, `ApiConsumer.ts`, `StepExecutor.ts`.
- Core seeder gate: `SeederSafetyGate.ts`, `fakeRailsBulkSyncClient.ts`.
- Deploy schema/planner: `configSchema.ts`, `hostPlanner.ts`.
- Deploy PKI/firewall: `pkiManager.ts`, `firewallConfigurator.ts`.
- Deploy pipeline/template: `deploy.ts`, `templates/nginx.fakerails.conf.tpl`.
- Checkout renderer: `EmbeddedWidgetRenderer.tsx`.
- Local stack: `scripts/deploy-localhost.sh`.

## 6. Operational usage

```bash
# Seed the fake gateway catalog in core-back
cd core-back
FAKE_RAILS_PUBLIC_BASE_URL=http://127.0.0.1:8444 \
FAKE_RAILS_SEEDER_TOKEN='0123456789abcdef0123456789abcdef' \
FAKE_RAILS_ALLOWED_HOSTS=127.0.0.1,localhost \
bun run seed-fake-rails

# Check the scoped allowlist test
bun test test/fake-rails-allowlist.test.ts

# Deploy only the fake rails role
cd deploy
bun run deploy.ts --only=fake-rails
```

- If the seeded base URL is wrong, rerun `seed-fake-rails`; it overwrites existing keys.
- If core cannot reach fake rails, check `ALLOW_FAKE_RAILS_HOSTS`, both host lists and the gateway environment's `allowed_hosts`.
- If the embedded widget does not load, inspect the checkout CSP, the renderer allowlist and `cspAdditions` before debugging the emulator.
- If the seeder blocks, read the gate name in the error; each gate has a stable prefix.

## 7. Status and deviations

### Implemented

- `seedFakeRails.ts` updates environments, widget URLs, webhook tokens and existing credential secrets.
- Deterministic HMAC secret derivation shared by both sides.
- Triple-gated SSRF allowlist with tests.
- Five synthetic-seeder safety gates.
- Deploy schema, host planning, certificate SAN, firewall rules, Nginx template and optional seeding.
- Local all-in-one script that starts and seeds the emulator.

### Partial

- Thirteen seeded core gateways versus twenty fake descriptors.
- `cbl_lypay` and `evo_pay` URL mismatches.
- Webhook token/path mismatch.
- Embedded widget blocked by CSP and renderer allowlist.
- Credential coverage only updates existing entries.
- Fake inbound requests are not verified.
- Statement channels not connected to a fetch flow.

### Missing / deferred

- Core blueprints for the seven unseeded fake rails.
- Automatic reconciliation pull from `/rails/:gateway/statement`.
- SRI generation and propagation for fake SDK scripts.
- A deployment smoke test that performs a full initiate/confirm/webhook flow through a seeded gateway.
- TLS verification of the fake rails certificate from core in the local script.

### Known bugs / risks

- **Code bug:** `cbl_lypay` and `evo_pay` cannot call their fake URLs.
- **Code bug:** default webhook URL path is invalid.
- **Code bug:** embedded widget loads are filtered out before CSP is even evaluated.
- **Security risk:** `ALLOW_FAKE_RAILS_HOSTS=true` plus a broad `FAKE_RAILS_ALLOWED_HOSTS` value weakens SSRF protection for every gateway that also lists the host. Keep the list to the fake host only.
- **Deployment risk:** the example uses HTTP; enabling HTTPS requires certificate trust in core.

## 8. Verification and tests

- `core-back/test/fake-rails-allowlist.test.ts` covers the triple gate, metadata refusal and empty-list refusal.
- `core-back/test/exhaustive/10-seeder-and-deploy/synthetic-seeder-safety-and-audit.test.ts` covers all five seeder gates, handshake failure and the 3.5-year timeline audit.
- `deploy/test/fakeRails.test.ts` covers host planning, production guard, credential requirement, port collision, synthetic-seed requirement, Arch/localhost support.
- `deploy/test/exhaustive-deploy-matrix.test.ts` covers one-, two-, five- and six-host topologies, firewall unions, PKI SANs and Nginx rendering.
- There is no test for `seedFakeRails.ts` itself, no full-flow test through a seeded core gateway, and no test that the embedded widget scripts load under the checkout CSP.

## 9. Source references

### Old design sections

- `design/fake_payment_rails_service_architecture.md` section 2.
- `design/fake_payment_rails_service_architecture.md` section 2.3 and 2.4.
- `design/fake_payment_rails_service_architecture.md` section 7.

### Code paths

- `core-back/prisma/seedFakeRails.ts`
- `core-back/prisma/seedBlueprints.ts`
- `core-back/engine/apiConsumer/fakeRailsAllowlist.ts`
- `core-back/engine/apiConsumer/ApiConsumer.ts`
- `core-back/engine/flow/StepExecutor.ts`
- `core-back/prisma/syntheticSeeder/SeederSafetyGate.ts`
- `core-back/prisma/syntheticSeeder/sync/fakeRailsBulkSyncClient.ts`
- `deploy/lib/configSchema.ts`
- `deploy/lib/hostPlanner.ts`
- `deploy/lib/pkiManager.ts`
- `deploy/deploy.ts`
- `deploy/templates/nginx.fakerails.conf.tpl`
- `checkout-front/src/components/renderers/EmbeddedWidgetRenderer.tsx`
- `scripts/deploy-localhost.sh`

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03: initial canonical part. Verified against `5a24f6f+working-tree`.
