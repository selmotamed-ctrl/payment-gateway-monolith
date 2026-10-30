# Deployable Fake Rails — Design

## Purpose

Provide four development/staging rails that work end-to-end through hosted checkout and the real core engine, deployed only when explicitly enabled.

## Rails

| Rail | Mode | Behaviour |
| :--- | :--- | :--- |
| `demo-otp` | `OTP_PULL` | OTP `123456` succeeds; wrong OTP retries. |
| `demo-qr` | `QR_DISPLAY` | QR/pay code; status succeeds after a short delay. |
| `demo-push` | `PUSH_APPROVAL` | Push approval auto-approves or fails by scenario. |
| `demo-redirect` | `REDIRECT` | Redirects to a fake checkout page and returns to checkout. |

## Architecture

- Embedded fake provider inside `core-back`, started only when `FAKE_RAILS_ENABLED=true`.
- Binds to loopback; never published by Nginx.
- Reuses deterministic behaviour from `MockGatewayServer`.
- Stateless signed tokens survive core restarts.
- Narrow outbound exception for the exact fake host/port only.

## Redirect flow

1. Core INITIATE calls loopback `/redirect/initiate`.
2. Provider returns a URL on the checkout frontend origin.
3. Checkout frontend route `/pay/fake-provider/:token` shows Approve/Decline.
4. The page calls the normal checkout confirm endpoint with evidence.
5. Core calls the loopback provider `/redirect/complete` during SUBMIT.
6. The attempt succeeds or fails through the normal engine and ledger.

The checkout summary must return the fake redirect host in `allowlistedRedirectHosts` only when fake rails are enabled.

## Provider endpoints

`/health`, `/otp/initiate`, `/otp/confirm`, `/otp/resend`, `/qr/initiate`, `/qr/status`, `/push/initiate`, `/push/status`, `/redirect/initiate`, `/redirect/complete`, `/inquiry`, `/refund`.

## Scenario profiles

- `happy`: all succeed.
- `mixed`: realistic success/failure/pending/unknown mix.
- `chaos`: timeouts, malformed responses, duplicate callbacks, late success, amount mismatch.

Deterministic triggers by amount/reference suffix are supported for tests.

## Seed

`core-back/prisma/seedFakeRails.ts` creates/updates:

- gateway `demo-rails`
- LIVE version, environments, API-key auth and encrypted credential set
- four rails and bilingual fields
- four routes with cost models and poll policies
- commission profiles
- INITIATE/SUBMIT/VERIFY/REFUND flows, parameters, outputs and status rules
- help guides

The seed is idempotent and only runs when fake rails are enabled.

## Configuration

| Variable | Default |
| :--- | :--- |
| `FAKE_RAILS_ENABLED` | `false` |
| `FAKE_RAILS_BIND_HOST` | `127.0.0.1` |
| `FAKE_RAILS_PORT` | `4300` |
| `FAKE_RAILS_BASE_URL` | `http://127.0.0.1:4300` |
| `FAKE_RAILS_ALLOWED_HOSTS` | `127.0.0.1` |
| `FAKE_RAILS_ALLOW_PRIVATE_NETWORK` | `false` |
| `FAKE_RAILS_ALLOW_HTTP` | `false` |
| `FAKE_RAILS_API_KEY` | required when enabled |
| `FAKE_RAILS_SCENARIO_PROFILE` | `mixed` |
| `FAKE_RAILS_PUBLIC_BASE_URL` | checkout front URL |
| `RUN_FAKE_RAILS_SEED` | `false` |
| `FAKE_RAILS_ALLOW_PRODUCTION` | `false` |

## Security

- Loopback bind only.
- Exact host/port allowlist for private HTTP.
- All other private/HTTP targets remain blocked.
- Production requires explicit opt-in.
- Secrets come from `deploy.env`, never source code.
- Provider is never exposed publicly.

## Acceptance criteria

- Disabled mode starts no provider and seeds nothing.
- Enabled mode shows all four rails in checkout.
- OTP, QR, push and redirect complete through checkout.
- Successes post balanced ledger entries and update link counters.
- Refund/inquiry paths work.
- Provider survives restart.
- Provider is unreachable publicly.
- Other private targets remain blocked.
