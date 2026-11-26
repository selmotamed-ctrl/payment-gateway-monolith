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

- there is confliction between ctrl+k for opening guide search and opening search everything, make the guide ctrl+shift+k and the global search ctrl+k (without shift)

- in https://admin-pg-dev.duckdns.org/guide/a/b06-13 there is a widget if all the fields are empty the widget disappear



- rails (whitelist) allow lists and tokens are missing from applicaitons and channels

- redesign the platform settings page, add instruction to the documentation for future platform settings to be added properly to the system, also the settings should be divided into sections in tabs with all settings tab (or small side drawer), and be searchable

- i want you to build a full plan to override the system communication channels, the main communication channel is email, sms is a secondary if its available/configured, for example sending and otp for login or password reset is via email mainly and if sms enabled and configured its also sent by sms, what im trying to say is that if a message need to be sent its either sent on email only or on email and sms based on its criticality an dtype, also registration should be with google or email+password only no phone registration, in addition the google authentication setup should be  in the platform settings, in addition to email, also if the email is not setup in the platform settings, the merchant ladnging page reigstration adn login shows the platform under maintanance, the email therefore must be configured and the authorized users must be notified if its not, for the current testing either create test email or let me give you a test email so you can run on, also provide the option that it can be configured the first time via deployment env file if its not configured or empty

- migrate all platforms that uses vue to vue 3.6 that uses vabor to improve performance critically and make sure that the tsx is using the real vabor which may require changing the vite plugin for the jsx/tsx on vue
