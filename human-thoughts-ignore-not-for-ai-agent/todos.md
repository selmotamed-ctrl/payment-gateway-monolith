- build an ai assisted environment generator and update the deploy guide

- make sure that log partitioning runs on workers leader like the journal lines patitioning basedon "Time-bounded: monthly partitions created/dropped by ensure_log_partitions / LOG_RETENTION_MONTHS cron"


- queue needing attention in dashboard needs to be fixed the numbers does not show always 0


- build a solid and comprehensive plan for optomized statistics and metrics to be added to the dashboard page (of course shown based on authorit, if someone allowed to see given chart or section its shown, if someting should redacted its redacted ...etc)
    - merchnats
    - aml
    - governence
    - routes/gateways health (in more details then the corrent state)
    - sla
    - webhook inbox lag
    - system health

- there is confliction between ctrl+k for opening guide search and opening search everything, make the guide ctrl+g 
- allow lists and tokens are missing from applicaitons and channels
- in https://admin-pg-dev.duckdns.org/guide/a/b06-13 there is a widget if all the fields are empty the widget disappear