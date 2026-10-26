# checkout-back edge blueprint

- Public tier behind `https://pay.<domain>/api`, local port `4103`, upstream `https://core-back:4000/internal/checkout/*` over mTLS 1.3 with `CN=checkout-back`.
- Anonymous payers may only send `linkKey`, `railCode`, `subMode`, `formData`, `idempotencyKey`, `otp` and untrusted client events.
- `amount` and `currency` are never accepted: `core-back` resolves them from `payment_links`.
- Inbound gateway webhooks are captured as raw `Buffer` payloads and forwarded byte for byte to the core inbox with an allowlisted set of headers only (`content-type`, `user-agent`, `content-length` and the gateway signature headers); credentials, cookies and every other `x-` header are dropped.
- Client events use the canonical core vocabulary (`completeCallback`, `errorCallback`, `widgetEvent`, `returnHint`); the legacy `COMPLETE_CALLBACK` style aliases are translated at the edge before forwarding.
- Inbound environments are accepted as `sandbox|test|uat|live|production` and translated to the canonical core pair `SANDBOX|LIVE`.
- Realtime attempt state is proxied to the browser over SSE without buffering.
