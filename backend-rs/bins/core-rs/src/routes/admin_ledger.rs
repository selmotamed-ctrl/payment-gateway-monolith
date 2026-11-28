//! `GET` routes of the admin finance ledger and audit log (P4-T04 chunk).
//!
//! Port of the read half of `core-back/api/internal/{adminLedger,ledgerLines}.ts`, the finance
//! dashboard handlers of `core-back/api/internal/admin.ts` and the audit-log handlers of the same
//! file:
//!
//! | Route | Authority | TS origin |
//! | :--- | :--- | :--- |
//! | `GET /internal/admin/finance/journal-entries/summary` | `finance:read` | `adminLedger.ts:127` |
//! | `GET /internal/admin/finance/journal-entries/summary/export` | `finance:read` | `adminLedger.ts:132` |
//! | `GET /internal/admin/finance/journal-entries` | `finance:read` | `adminLedger.ts:153` |
//! | `GET /internal/admin/finance/journal-entries/:id` | `finance:read` | `adminLedger.ts:218` |
//! | `GET /internal/admin/finance/gl-accounts/:id/lines` | `finance:read` | `adminLedger.ts:336` |
//! | `GET /internal/admin/finance/gl-accounts/:id` | `finance:read` | `adminLedger.ts:346` |
//! | `GET /internal/admin/finance/gl-accounts/:id/shards/:shardId/repair-plan` | `finance:read` | `adminLedger.ts:478` |
//! | `GET /internal/admin/finance/profitability` | `finance:read` | `admin.ts:19340` |
//! | `GET /internal/admin/finance/profitability/export` | `finance:read` | `admin.ts:19345` |
//! | `GET /internal/admin/finance/route-caps` | `finance:read` | `admin.ts:19383` |
//! | `GET /internal/admin/finance/liquidity` | `finance:read` | `admin.ts:19625` |
//! | `GET /internal/admin/finance/liquidity/export` | `finance:read` | `admin.ts:19630` |
//! | `GET /internal/admin/finance/invariant-check` | `finance:read` | `admin.ts:19717` |
//! | `GET /internal/admin/finance/invariant-check/export` | `finance:read` | `admin.ts:19722` |
//! | `GET /internal/admin/audit-logs` | `security:read` | `admin.ts:20005` |
//! | `GET /internal/admin/audit-logs/export` | `security:read` | `admin.ts:20056` |
//! | `GET /internal/admin/audit-logs/summary` | `security:read` | `admin.ts:20147` |
//! | `GET /internal/admin/audit-logs/summary/export` | `security:read` | `admin.ts:20152` |
//! | `GET /internal/admin/audit-logs/:id` | `security:read` | `admin.ts:20184` |
//!
//! Payload parity notes:
//!
//! - money leaves as `Money4` (`toFixed(4)`), the route-cap utilisation as `toFixed(2)`;
//! - list envelopes are the shared `{<key>, total, page, pageSize, nextCursor?}` contract from
//!   `lib/listQuery.ts` (`pg_db::build_list_query`/`list_response`), including keyset cursors;
//! - timestamps are `toISOString()` (three fraction digits, `Z`);
//! - `journal_lines` and `audit_log` are read-only here; the `*/export` handlers append the same
//!   audit rows the TS handlers append (never a ledger posting).
//!
//! `pg_db::list_query` builds the WHERE/ORDER BY; each submodule owns its SQL so it can be read
//! next to the TypeScript source. `routes/admin_ledger/support.rs` carries the slice helpers.

#![forbid(unsafe_code)]

mod audit;
mod finance;
mod journal;
mod support;

use pg_http::{Authn, BodyRule, Channel, Policy};

use super::{CustomHandler, Handler, MountedRoute, PrincipalGuard};

const FINANCE_READ: &[&str] = &["finance:read"];
const SECURITY_READ: &[&str] = &["security:read"];

fn admin_get(
    path: &str,
    origin: &str,
    authorities: &[&str],
    handler: CustomHandler,
) -> MountedRoute {
    MountedRoute {
        policy: Policy::new("GET", path, Channel::Admin, Authn::Session, origin)
            .authorities(authorities)
            .body(BodyRule::None),
        handler: Handler::Custom(handler),
        guard: PrincipalGuard::Staff,
    }
}

/// Routes owned by this module (19 GETs).
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        admin_get(
            "/internal/admin/finance/journal-entries/summary",
            "core-back/api/internal/adminLedger.ts:127",
            FINANCE_READ,
            journal::journal_summary,
        ),
        admin_get(
            "/internal/admin/finance/journal-entries/summary/export",
            "core-back/api/internal/adminLedger.ts:132",
            FINANCE_READ,
            journal::journal_summary_export,
        ),
        admin_get(
            "/internal/admin/finance/journal-entries",
            "core-back/api/internal/adminLedger.ts:153",
            FINANCE_READ,
            journal::journal_entries,
        ),
        admin_get(
            "/internal/admin/finance/journal-entries/:id",
            "core-back/api/internal/adminLedger.ts:218",
            FINANCE_READ,
            journal::journal_entry_detail,
        ),
        admin_get(
            "/internal/admin/finance/gl-accounts/:id/lines",
            "core-back/api/internal/adminLedger.ts:336",
            FINANCE_READ,
            journal::gl_account_lines,
        ),
        admin_get(
            "/internal/admin/finance/gl-accounts/:id",
            "core-back/api/internal/adminLedger.ts:346",
            FINANCE_READ,
            journal::gl_account,
        ),
        admin_get(
            "/internal/admin/finance/gl-accounts/:id/shards/:shardId/repair-plan",
            "core-back/api/internal/adminLedger.ts:478",
            FINANCE_READ,
            journal::repair_plan,
        ),
        admin_get(
            "/internal/admin/finance/profitability",
            "core-back/api/internal/admin.ts:19340",
            FINANCE_READ,
            finance::profitability,
        ),
        admin_get(
            "/internal/admin/finance/profitability/export",
            "core-back/api/internal/admin.ts:19345",
            FINANCE_READ,
            finance::profitability_export,
        ),
        admin_get(
            "/internal/admin/finance/route-caps",
            "core-back/api/internal/admin.ts:19383",
            FINANCE_READ,
            finance::route_caps,
        ),
        admin_get(
            "/internal/admin/finance/liquidity",
            "core-back/api/internal/admin.ts:19625",
            FINANCE_READ,
            finance::liquidity,
        ),
        admin_get(
            "/internal/admin/finance/liquidity/export",
            "core-back/api/internal/admin.ts:19630",
            FINANCE_READ,
            finance::liquidity_export,
        ),
        admin_get(
            "/internal/admin/finance/invariant-check",
            "core-back/api/internal/admin.ts:19717",
            FINANCE_READ,
            finance::invariant_check,
        ),
        admin_get(
            "/internal/admin/finance/invariant-check/export",
            "core-back/api/internal/admin.ts:19722",
            FINANCE_READ,
            finance::invariant_export,
        ),
        admin_get(
            "/internal/admin/audit-logs",
            "core-back/api/internal/admin.ts:20005",
            SECURITY_READ,
            audit::audit_logs,
        ),
        admin_get(
            "/internal/admin/audit-logs/export",
            "core-back/api/internal/admin.ts:20056",
            SECURITY_READ,
            audit::audit_logs_export,
        ),
        admin_get(
            "/internal/admin/audit-logs/summary",
            "core-back/api/internal/admin.ts:20147",
            SECURITY_READ,
            audit::audit_summary,
        ),
        admin_get(
            "/internal/admin/audit-logs/summary/export",
            "core-back/api/internal/admin.ts:20152",
            SECURITY_READ,
            audit::audit_summary_export,
        ),
        admin_get(
            "/internal/admin/audit-logs/:id",
            "core-back/api/internal/admin.ts:20184",
            SECURITY_READ,
            audit::audit_log_detail,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_route_is_an_admin_session_get_with_its_ts_authority() {
        let routes = routes();
        assert_eq!(routes.len(), 19);
        for route in &routes {
            assert_eq!(route.policy.method, "GET");
            assert_eq!(route.policy.channel, Channel::Admin);
            assert_eq!(route.policy.authn, Authn::Session);
            assert_eq!(route.guard, PrincipalGuard::Staff);
            assert!(matches!(route.handler, Handler::Custom(_)));
            assert!(!route.policy.ts_origin.trim().is_empty());
            let expected = if route.policy.path.starts_with("/internal/admin/audit-logs") {
                SECURITY_READ
            } else {
                FINANCE_READ
            };
            let expected: Vec<String> = expected.iter().map(|value| (*value).to_owned()).collect();
            assert_eq!(route.policy.authorities, expected);
        }
    }

    #[test]
    fn the_inventory_paths_are_mounted_once() {
        let routes = routes();
        let paths: Vec<&str> = routes
            .iter()
            .map(|route| route.policy.path.as_str())
            .collect();
        for path in [
            "/internal/admin/finance/journal-entries/summary",
            "/internal/admin/finance/journal-entries",
            "/internal/admin/finance/journal-entries/:id",
            "/internal/admin/finance/gl-accounts/:id",
            "/internal/admin/finance/gl-accounts/:id/lines",
            "/internal/admin/finance/gl-accounts/:id/shards/:shardId/repair-plan",
            "/internal/admin/finance/profitability",
            "/internal/admin/finance/route-caps",
            "/internal/admin/finance/liquidity",
            "/internal/admin/finance/invariant-check",
            "/internal/admin/audit-logs",
            "/internal/admin/audit-logs/summary",
            "/internal/admin/audit-logs/:id",
        ] {
            assert_eq!(
                paths.iter().filter(|candidate| **candidate == path).count(),
                1,
                "{path}"
            );
        }
    }
}
