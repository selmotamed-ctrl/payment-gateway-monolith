# in office inshallah 
- build an ai assisted environment generator and update the deploy guide
- incomplete work on automation design: ---
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
``` ---

- sandbox environment
- resolve broken 3 tests -- 
- ai transcript report engine --
- auto system theme detection even on login page --
- make sure that there is no conflicts on the max width of shards for accounts --
- check ayoub report -- 
- missing automations --
- backup engine full check and understanding --

- object store --
- what does merchant tab show in the report catalog

- reporting engine should track the version and any breaking change due to version changing (major version means previous reports specs wont work and must be regenerated and migrated with a proposed migration prompt), broken reports should not ever throw 500 error (currently that what happens) and should not allow runs and should be marked as needing migration and colored red, and there should be page of these reports, the catalog page should only show working reports, also there should be documentation on how to version transcripts for the ai agents that will develop changes on the report engine --

make sure that log partitioning runs on workers leader like the journal lines patitioning basedon "Time-bounded: monthly partitions created/dropped by ensure_log_partitions / LOG_RETENTION_MONTHS cron"

- convert thea attempt by state charts from line to bar --
- opening disputes from payment attempt details drawer does not work, the filter for the attemp uuid in the dispute table is probably missing 
- queue needing attention in dashboard needs to be fixed the numbers does not show always 0
- running report shows error that the zip asset file is missing from the vault, fix using the error code on the test-server opencode  session make sure to track the root cause 3e525d00-9bb9-40ea-9e28-9c32aa5999ba --
    - running report shows error that the zip asset file is missing from the vault, the run is on the running test server, it was running correctly yesterday, something must happened the report code is "gateway-performance-intelligence" the object id is " 3e525d00-9bb9-40ea-9e28-9c32aa5999ba"


- for `Gross Volume — sum of totalChargedAmount for attempts created in the selected period whose status is SUCCEEDED, PARTIALLY_REFUNDED, REFUNDED or DISPUTED (admin.ts:1139-1149). It is gross payer-charged amount (base + surcharge), not net wallet credit, not commission, and not all attempt amounts. The sub-label is all attempts created in the period. Caveat: the sum is not grouped by currency, while the card hard-codes “LYD”, so a mixed-currency dataset would be misleading.` fix gross volume metric in dashboard page, as of what i understand its the sum of totalChargedAmount for any type of currency on payment attempts whose state is success, partially refunded, refunded, disputed, it should be only for succeeded and for LYD currency only

- Open Action Queues — a current-state count, not period-filtered. Actual value = pending approvals (DRAFT/PENDING_REVIEW) + open operator cases (OPEN/IN_PROGRESS/PENDING_CHECKER) + open join requests + open AML cases (OPEN/IN_REVIEW/PENDING_CHECKER/FROZEN/ESCALATED_STR) (index.tsx:265-269). The sub-label only names approvals and operator cases, so the card under-describes what the number includes.

