# admin-back edge blueprint

- Private LAN tier behind `https://admin.internal:8443/api`, local port `4101`, upstream `https://core-back:4000/internal/admin/*` over mTLS 1.3 with `CN=admin-back`.
- The listener binds to the LAN interface only and every admin API call is checked against `ADMIN_LAN_CIDRS` before any forwarding happens.
- The edge exposes the full operator surface: join requests and KYB review, merchants and applications, four eyes approvals, AML screening and cases, operator cases, gateway catalog and the eight step wizard, rails and routes, assets, reconciliation, disputes, adjustments, cash-outs, commission and velocity rules, finance dashboards and platform settings.
- Authority hints are advisory; `core-back` re-verifies the session, the maker checker invariant and the `authorities_map` before acting.
