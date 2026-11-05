# PCI DSS scope statement (GAP-026)

Status: normative for this repository. Owner: platform security.

## Statement

The Payment Gateway is **out of PCI DSS cardholder-data (CHD) scope by
design**. The platform never receives, processes, transmits, stores, or logs a
card primary account number (PAN), card verification value (CVV/CVC), PIN or
full magnetic-stripe/chip track data.

Card acceptance, where offered, is performed by an external PCI-compliant
processor or hosted payment page. The gateway only handles the processor's
non-sensitive result: opaque tokens/references, authorisation status, amounts,
currency, and (at most) the last four digits and brand for display.

## Boundaries

- In scope data classes: merchant, ledger, settlement, bank-rail and
  wallet/account-rail data; truncated card display data (BIN-less last4 + brand).
- Out of scope / forbidden: PAN, CVV/CVC, PIN, track data, expiry combined with
  PAN, and any "PAN rail" (a rail whose request/response carries a PAN).
- Schema, logs, audit entries, backups, exports and fixtures must not contain
  PAN-shaped values (Luhn-valid 13-19 digit sequences).

## Controls

1. Deploy config guard (`deploy/lib/configSchema.ts`, `panRailGuardProblems`):
   `loadDeployConfig` rejects any `deploy.env` key naming a PAN/CVV/card-number
   rail and any value holding a Luhn-valid 13-19 digit PAN-shaped token.
2. Core guard (to be implemented in `core-back`, owned by the core agent):
   rail/provider registration must reject a rail whose `kind` or capability set
   declares PAN handling, and request validation on payment-intent, checkout and
   webhook ingestion must reject PAN-shaped fields (Luhn + 13-19 digits) and
   fields named `pan`, `card_number`, `cvv`, `cvc` before persistence or logging.
   Log redaction must treat PAN-shaped strings as secrets.
3. Transport: all PostgreSQL TCP traffic is TLS-only (`hostssl` pg_hba rules,
   `ssl = on`); edge services use mTLS.
4. Secrets/KMS and key-management controls are unchanged (see storage and
   security design parts).

## Change rule

Any proposal to accept card data directly (a PAN rail) is a scope change: it
requires a formal PCI assessment (SAQ D / ROC), network segmentation, a CDE
design and a new design part, and must not be merged before that approval. The
guards above are expected to fail loudly until then.
