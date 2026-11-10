

- ai transcript report engine
- automated + manual journal archive 
- sandbox environment
- build an ai assisted environment generator and update the deploy guide 

- make sure that there is no conflicts on the max width of shards for accounts --
- check ayoub report -- 
- missing automations --
- backup engine full check and understanding --


- incomplete work on automation design:
```md
Not built or partial
- Deploy: the deploy engine does not install clamav-daemon or freshclam; you provision the daemon. Nothing runs the deploy on a schedule, so a certificate is only renewed when someone deploys inside the window.
- Reports: there is no goAML XML, XLSX output, incident return or regenerate-draft action.
- Audit anchor: it lives only in the core database, so someone holding both databases and the vault key could still rewrite history consistently.
- Webhooks: no attempt history, no payload viewer, and no partial-refund event.
- AUTO-07: no STATEMENT_FETCH pull job and no settlement-sweep scheduling.
- AUTO-12: the daily cap counters are not audited.
- Untouched: AUTO-09, 15, 29, 30, 31 and 32, the AUTO-10 scaling calibration and scale-down, AUTO-14, 17, 18 and 33, the emergency-extension UI button, and the cash-out P50/P90/P95 dashboard.
- From earlier: the dispute-loss booking stays a human step (the D1 deviation), and AUTO-26 refresh-failure counting is not built. The seeded MLRO and compliance users lack approval:check, which may be a seed gap.
```

- resolve broken 3 tests

- incident management (deferred from the regulatory reporting engine):
  - Add an `Incident` model (id, severity P0-P3, status, startedAt, detectedAt, endedAt, title, summary, cause, remediation, affected rails/merchants/payment count, linked operator cases and audit/backup findings) and an append-only incident timeline (actor, action, note, timestamp).
  - Sources: `PlatformMonitorWorker` P0/P1 findings, audit-chain anchor failures, backup failures/WAL lag, certificate expiry, PostgreSQL/Redis outages, security events and a manual "declare incident" action.
  - Lifecycle: DETECTED → ACKNOWLEDGED → MITIGATING → MONITORING → RESOLVED → POSTMORTEM; enforce exactly one active incident per key/source and do not auto-resolve without a human or a verified recovery signal.
  - INC return: add the `INC` reporting rule, declarative XML/XLSX/narrative schema, initial-notice (24 h) and final-report (10 business days) outputs, affected-scope aggregation, CBL filing channel, due-date escalation through `DeadlineWorker`, and no auto-filing.
  - UI: `/operations/incidents` list/detail, declare/acknowledge/mitigate/resolve actions, affected merchants/rails/payments, linked cases, timeline, postmortem editor, regulatory-report link, and dashboard/status-page banner.
  - Security: incident data is internal/confidential; no AML-confidential detail in merchant notices; all actions audited; no secrets or customer PII in the summary or regulatory payload.
  - Tests: source dedupe, lifecycle state machine, one active incident, duration threshold, affected-scope aggregation, INC XML/XLSX validation, due-date escalation, permissions and no auto-filing.