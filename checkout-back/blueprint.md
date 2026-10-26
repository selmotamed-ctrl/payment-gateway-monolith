# checkout-back edge blueprint

- Public tier behind `https://pay.<domain>/api`, local port `4103`, upstream `https://core-back:4000/internal/checkout/*` over mTLS 1.3 with `CN=checkout-back`.
- Anonymous payers may only send `linkKey`, `railCode`, `subMode`, `formData`, `idempotencyKey`, `otp` and untrusted client events.
- `amount` and `currency` are never accepted: `core-back` resolves them from `payment_links`.
- Inbound gateway webhooks are captured as raw `Buffer` payloads with their original headers and forwarded unaltered to the core inbox.
- Realtime attempt state is proxied to the browser over SSE without buffering.
