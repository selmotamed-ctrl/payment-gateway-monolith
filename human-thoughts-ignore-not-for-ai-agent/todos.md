# in office inshallah 
- build an ai assisted environment generator and update the deploy guide 
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

- sandbox environment
- resolve broken 3 tests -- 
- ai transcript report engine --
- auto system theme detection even on login page --
- make sure that there is no conflicts on the max width of shards for accounts --
- check ayoub report -- 
- missing automations --
- backup engine full check and understanding --

- object store
- what does merchant tab show in the report catalog