# core-back blueprint

## Responsibilities

1. **Catalog** — the four layer model: `Gateway` → `CredentialSet` → `Rail` → `RailRoute`, with
   immutable, versioned `GatewayVersion` snapshots that every attempt pins at creation.
2. **Engine** — the declarative 10 phase flow engine (`CREDENTIAL_CHECK`, `PRE_INITIATE`,
   `INITIATE`, `SUBMIT`, `VERIFY`, `CANCEL`, `REFUND`, `VOID`, `CAPTURE`, `SETTLEMENT_FETCH`),
   the closed `TransformPipe[]` library, the `CryptoEngine` canonicalizers and the `ApiConsumer`
   registry with single flight token refresh.
3. **Trust** — the 13 state attempt machine, the trusted five fact success check, the durable
   webhook inbox and the automatic inquiry of unconfirmed outcomes.
4. **Ledger** — the ownership aware double-entry ledger: platform clearing, merchant direct
   commission receivable, the internal `INTERNAL-1` rule and the continuous invariant verifier.
5. **Governance** — maker/checker approvals, field level change history, AML cases, screening,
   reporting rules, disputes, reconciliation and the notification outbox.

## Entry points

| Route | Client certificate | Purpose |
| :--- | :--- | :--- |
| `/internal/admin/*` | `CN=admin-back` | Back office operations and governance |
| `/internal/merchant/*` | `CN=merchant-back` | Merchant portal and external `pg_live_` API |
| `/internal/checkout/*` | `CN=checkout-back` | Hosted checkout, inbound webhooks and returns |

## Invariants

- `confirmed_count + active_locked_count <= use_count` for single use links, enforced inside the
  reservation transaction.
- Money is posted only after a server verified confirmation; browser callbacks and return URL
  parameters are hints that only trigger an inquiry.
- Every ledger entry satisfies `SUM(DEBIT) = SUM(CREDIT) > 0` and is unique per
  `(ref_type, ref_id)`.
- `checkout-back` and `merchant-back` can never supply an amount or a currency for a checkout
  attempt; the amount is resolved from `payment_links` inside `core-back`.
