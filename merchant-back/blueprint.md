# merchant-back edge blueprint

- Public tier behind `https://merchant.<domain>/api`, local port `4102`, upstream `https://core-back:4000/internal/merchant/*` over mTLS 1.3 with `CN=merchant-back`.
- Two audiences share the process: the authenticated merchant portal under `/api/v1/merchant/*` and the merchant server API under `/api/v1/external/*` guarded by `pg_live_` bearer tokens.
- The edge validates identity payloads, KYB document magic bytes and upload sizes, then forwards raw validated bytes to `core-back`.
- Amounts and currencies are only accepted where the merchant portal owns link creation; `core-back` re-validates every monetary field.
