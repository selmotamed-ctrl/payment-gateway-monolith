# Two-Machine Multi-Topology Certification Report

Generated: 2026-11-03T20:37:34.353Z

| Topology | Name | Deploy | Gates | Gate status |
| :--- | :--- | :--- | :--- | :--- |
| T1 | Single-Host Multi-Node Density & Co-Located Storage (WAL-G on Same Host) | PASSED (187499ms) | 2/11 | FAILED |

## Gate detail

### T1 — Single-Host Multi-Node Density & Co-Located Storage (WAL-G on Same Host)

Started: 2026-11-03T20:34:15.619Z · Finished: 2026-11-03T20:37:34.353Z

- **Gate 1 Provisioning, UFW zero-trust and SAN mTLS** — PASSED (360ms)
  - PASS 10.209.250.48 pm2 pg-core-back-core-1 — status=online restarts=0
  - PASS 10.209.250.48 pm2 pg-core-back-core-2 — status=online restarts=0
  - PASS 10.209.250.48 pm2 pg-admin-back — status=online restarts=0
  - PASS 10.209.250.48 pm2 pg-merchant-back — status=online restarts=0
  - PASS 10.209.250.48 pm2 pg-checkout-back-chk-1 — status=online restarts=0
  - PASS 10.209.250.48 pm2 pg-checkout-back-chk-2 — status=online restarts=0
  - PASS 10.209.250.48 pm2 pg-fake-rails-back — status=online restarts=0
  - PASS 10.209.250.48 pg-backup-daemon — systemd=active
  - PASS 10.209.250.48 core-1 pg-core-back-core-1 /health (mTLS) — {"msg":"OK","status":"ok","service":"core-back","queue":{"enabled":true,"queued":0,"oldestQueuedAgeMs":null,"thresholdMs":300000,"degraded":false}}
  - PASS 10.209.250.48 core-2 pg-core-back-core-2 /health (mTLS) — {"msg":"OK","status":"ok","service":"core-back","queue":{"enabled":true,"queued":0,"oldestQueuedAgeMs":null,"thresholdMs":300000,"degraded":false}}
  - PASS 10.209.250.48 admin-back mTLS -> https://10.209.250.48:4000 /internal/admin/health — {"status":"ok","channel":"admin"}
  - PASS 10.209.250.48 admin-back mTLS -> https://10.209.250.48:4001 /internal/admin/health — {"status":"ok","channel":"admin"}
  - PASS 10.209.250.48 merchant-back mTLS -> https://10.209.250.48:4000 /internal/merchant/health — {"status":"ok","channel":"merchant"}
  - PASS 10.209.250.48 merchant-back mTLS -> https://10.209.250.48:4001 /internal/merchant/health — {"status":"ok","channel":"merchant"}
  - PASS 10.209.250.48 checkout-back mTLS -> https://10.209.250.48:4000 /internal/checkout/health — {"status":"ok","channel":"checkout"}
  - PASS 10.209.250.48 checkout-back mTLS -> https://10.209.250.48:4001 /internal/checkout/health — {"status":"ok","channel":"checkout"}
  - PASS core rejects a TLS client without a certificate — NO_CERT_REJECTED
  - PASS checkout certificate cannot enter the admin channel — http=403
- **Gate 2 Storage routing and LSN read-your-own-writes** — FAILED (43ms)
  - FAIL gate execution — admin merchants returned 403
  - error: admin merchants returned 403

## Ledger invariant

Every completed topology gate verifies double-entry drift and `gl_account_shards == journal_lines`. A non-zero drift is a hard failure.
