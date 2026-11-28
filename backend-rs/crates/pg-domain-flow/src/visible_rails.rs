//! Visible rails: the pure route-selection rule of the checkout.
//!
//! Port of the route part of `core-back/engine/flow/VisibleRailsResolver.ts:288-323` plus
//! `canarySelected` (`core-back/engine/routeHealth/decision.ts:128-138`), as documented in
//! `project-design/parts/01-core-back/02-engine.md` §3.10:
//!
//! ```text
//! visible = application whitelist ∩ link whitelist ∩ rail not blocked ∩ rail currency = link
//!           currency ∩ live commission profile ∩ ≥ 1 route with a verified credential set
//!           ∩ route ACTIVE ∩ route HEALTHY ∩ amount within min/max ∩ daily cap
//!           ∩ outside maintenance windows ∩ in scope
//! ```
//!
//! This module owns the **status/health/canary** slice of that formula. The rail-level filters
//! (blocked, currency, whitelist, commission profile), the credential-set resolution, the amount
//! bounds, the daily cap, maintenance windows and scope need the full records; they stay in the
//! repository layer that builds the candidates.
//!
//! Simplifications, recorded for `DEVIATIONS.md`:
//!
//! 1. Route ordering uses `weight` (descending, then `route_id`) instead of the three
//!    `routingStrategy` modes, because `EFFECTIVE_COST` needs the route cost model and the attempt
//!    amount. `WEIGHTED` (the default weight is 100) is therefore the reproduced strategy.
//! 2. `min_healthy` is a Rust-only policy knob that TS does not have. `None` (the default) is exact
//!    TS parity: a degraded route is only used by its canary cohort. `Some(n)` admits **all**
//!    degraded routes when fewer than `n` healthy routes survive, and reports the shortfall, so a
//!    caller can hold the payment instead of showing an empty rail.
//! 3. Degraded routes stay **first** in the order, as in the TS (`[...degraded, ...ranked]`), so
//!    canary traffic keeps probing them before the healthy fallback is used.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

/// `RouteStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RouteStatus {
    Active,
    Paused,
    Draining,
}

/// The health state routing sees *after* lazy override expiry (`effectiveRouteHealth`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RouteHealth {
    Healthy,
    Degraded,
    OpenBreaker,
}

/// One route of a rail, with everything the status/health slice needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RailCandidate {
    pub route_id: String,
    pub route_status: RouteStatus,
    /// `effectiveRouteHealth(route, now)`: an unexpired admin override already applied.
    pub health: RouteHealth,
    /// Ranking weight; TS defaults to 100 (`route.weight ?? 100`).
    pub weight: u32,
    /// `canarySelected(routeId, canaryKey, canaryPercent)` for the caller's cohort.
    pub canary: bool,
}

impl RailCandidate {
    /// A healthy, active route with the default weight.
    #[must_use]
    pub fn active(route_id: impl Into<String>) -> Self {
        Self {
            route_id: route_id.into(),
            route_status: RouteStatus::Active,
            health: RouteHealth::Healthy,
            weight: 100,
            canary: false,
        }
    }
}

/// The policy of the pure selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct VisibleRailsPolicy {
    /// Minimum healthy routes before degraded routes are admitted outside the canary cohort.
    /// `None` reproduces the TS exactly.
    pub min_healthy: Option<usize>,
    /// `route_health.policy.canaryPercent` (0..=100).
    pub canary_percent: u8,
}

/// Why a route is not visible.
///
/// The variant names keep the TS `RouteExclusionReason` strings (`ROUTE_NOT_ACTIVE`,
/// `ROUTE_NOT_HEALTHY`, `ROUTE_DEGRADED_CANARY_EXCLUDED`), so the shared prefix is intentional.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExclusionReason {
    /// `route.status !== "ACTIVE"`.
    RouteNotActive,
    /// `OPEN_BREAKER`, or `DEGRADED` while the canary is disabled.
    RouteNotHealthy,
    /// `DEGRADED` and this cohort is outside the canary percentage.
    RouteDegradedCanaryExcluded,
}

/// One selected route and its position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisibleRoute {
    pub route_id: String,
    /// 1-based position in the resolution result.
    pub rank: usize,
    pub health: RouteHealth,
    pub weight: u32,
}

/// A route that did not make the visible set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExcludedRoute {
    pub route_id: String,
    pub reason: ExclusionReason,
}

/// The selection result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisibleRoutes {
    /// Degraded (canary) routes first, then healthy ones, each by weight.
    pub routes: Vec<VisibleRoute>,
    pub excluded: Vec<ExcludedRoute>,
    /// True when `min_healthy` admitted degraded routes outside their canary cohort.
    pub degraded_shortfall: bool,
}

impl VisibleRoutes {
    /// True when at least one route is visible.
    #[must_use]
    pub fn is_visible(&self) -> bool {
        !self.routes.is_empty()
    }

    /// The route ids in order.
    #[must_use]
    pub fn route_ids(&self) -> Vec<&str> {
        self.routes
            .iter()
            .map(|route| route.route_id.as_str())
            .collect()
    }
}

/// `canarySelected(routeId, canaryKey, percent)`.
///
/// FNV-1a over the UTF-16 code units of `"<routeId>:<canaryKey>"` (the `Math.imul` loop of the TS),
/// `% 100 < percent`. No cohort key or `percent == 0` disables the canary; `percent >= 100` selects
/// every route. The FNV constants are duplicated from `pg-crypto::fnv1a32_utf16` because this crate
/// does not depend on `pg-crypto`; the algorithm is identical.
#[must_use]
pub fn canary_selected(route_id: &str, canary_key: Option<&str>, percent: u8) -> bool {
    let Some(canary_key) = canary_key else {
        return false;
    };
    if percent == 0 {
        return false;
    }
    if percent >= 100 {
        return true;
    }
    let mut hash: u32 = 0x811c_9dc5;
    for unit in format!("{route_id}:{canary_key}").encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    (hash % 100) < u32::from(percent)
}

/// Resolve the visible routes of one rail.
#[must_use]
pub fn resolve_visible_routes(
    candidates: &[RailCandidate],
    policy: VisibleRailsPolicy,
) -> VisibleRoutes {
    let mut excluded = Vec::new();
    let mut healthy: Vec<&RailCandidate> = Vec::new();
    let mut degraded: Vec<&RailCandidate> = Vec::new();

    for candidate in candidates {
        if candidate.route_status != RouteStatus::Active {
            excluded.push(ExcludedRoute {
                route_id: candidate.route_id.clone(),
                reason: ExclusionReason::RouteNotActive,
            });
            continue;
        }
        match candidate.health {
            RouteHealth::Healthy => healthy.push(candidate),
            RouteHealth::OpenBreaker => excluded.push(ExcludedRoute {
                route_id: candidate.route_id.clone(),
                reason: ExclusionReason::RouteNotHealthy,
            }),
            RouteHealth::Degraded => {
                // The flag carries the canary decision for this cohort; `canary_percent` only
                // selects the exclusion reason the caller sees.
                if candidate.canary {
                    degraded.push(candidate);
                } else if policy.canary_percent > 0 {
                    excluded.push(ExcludedRoute {
                        route_id: candidate.route_id.clone(),
                        reason: ExclusionReason::RouteDegradedCanaryExcluded,
                    });
                } else {
                    excluded.push(ExcludedRoute {
                        route_id: candidate.route_id.clone(),
                        reason: ExclusionReason::RouteNotHealthy,
                    });
                }
            }
        }
    }

    // Rust-only shortfall policy: too few healthy routes and the caller asked for a floor.
    let mut degraded_shortfall = false;
    if let Some(min_healthy) = policy.min_healthy {
        if healthy.len() < min_healthy {
            let mut admitted: Vec<&RailCandidate> = excluded
                .iter()
                .filter(|entry| {
                    matches!(
                        entry.reason,
                        ExclusionReason::RouteDegradedCanaryExcluded
                            | ExclusionReason::RouteNotHealthy
                    )
                })
                .filter_map(|entry| {
                    candidates.iter().find(|candidate| {
                        candidate.route_id == entry.route_id
                            && candidate.route_status == RouteStatus::Active
                            && candidate.health == RouteHealth::Degraded
                    })
                })
                .collect();
            admitted.extend(degraded.iter().copied());
            if !admitted.is_empty() {
                degraded_shortfall = true;
                excluded.retain(|entry| {
                    !matches!(
                        entry.reason,
                        ExclusionReason::RouteDegradedCanaryExcluded
                            | ExclusionReason::RouteNotHealthy
                    )
                });
                degraded = admitted;
            }
        }
    }

    let by_weight = |left: &&RailCandidate, right: &&RailCandidate| {
        right
            .weight
            .cmp(&left.weight)
            .then_with(|| left.route_id.cmp(&right.route_id))
    };
    degraded.sort_by(by_weight);
    healthy.sort_by(by_weight);

    let mut routes = Vec::with_capacity(degraded.len() + healthy.len());
    for candidate in degraded.into_iter().chain(healthy) {
        routes.push(VisibleRoute {
            route_id: candidate.route_id.clone(),
            rank: routes.len() + 1,
            health: candidate.health,
            weight: candidate.weight,
        });
    }
    VisibleRoutes {
        routes,
        excluded,
        degraded_shortfall,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn degraded(route_id: &str, canary: bool) -> RailCandidate {
        RailCandidate {
            route_status: RouteStatus::Active,
            health: RouteHealth::Degraded,
            canary,
            ..RailCandidate::active(route_id)
        }
    }

    #[test]
    fn only_active_healthy_routes_are_visible_by_default() {
        let candidates = vec![
            RailCandidate::active("healthy-1"),
            RailCandidate {
                route_status: RouteStatus::Paused,
                ..RailCandidate::active("paused")
            },
            RailCandidate {
                route_status: RouteStatus::Draining,
                ..RailCandidate::active("draining")
            },
            RailCandidate {
                health: RouteHealth::OpenBreaker,
                ..RailCandidate::active("open")
            },
            degraded("degraded", false),
        ];
        let result = resolve_visible_routes(&candidates, VisibleRailsPolicy::default());
        assert_eq!(result.route_ids(), ["healthy-1"]);
        assert!(result.is_visible());
        assert_eq!(result.excluded.len(), 4);
        assert_eq!(
            result.excluded[0],
            ExcludedRoute {
                route_id: "paused".to_owned(),
                reason: ExclusionReason::RouteNotActive
            }
        );
        assert_eq!(result.excluded[1].reason, ExclusionReason::RouteNotActive);
        assert_eq!(result.excluded[2].reason, ExclusionReason::RouteNotHealthy);
        // Without a canary percentage a degraded route is simply unhealthy.
        assert_eq!(result.excluded[3].reason, ExclusionReason::RouteNotHealthy);
        // A canary cohort cannot rescue it when the percentage is 0.
        assert!(!result.degraded_shortfall);
    }

    #[test]
    fn degraded_routes_are_canary_only_and_come_first() {
        let candidates = vec![
            RailCandidate::active("healthy-1"),
            degraded("degraded-canary", true),
            degraded("degraded-other", false),
        ];
        let policy = VisibleRailsPolicy {
            min_healthy: None,
            canary_percent: 25,
        };
        let result = resolve_visible_routes(&candidates, policy);
        assert_eq!(result.route_ids(), ["degraded-canary", "healthy-1"]);
        assert_eq!(result.excluded.len(), 1);
        assert_eq!(
            result.excluded[0].reason,
            ExclusionReason::RouteDegradedCanaryExcluded
        );
        // Ranks are 1-based over the ordered result.
        assert_eq!(result.routes[0].rank, 1);
        assert_eq!(result.routes[1].rank, 2);
        assert_eq!(result.routes[0].health, RouteHealth::Degraded);
    }

    #[test]
    fn weight_orders_within_each_group() {
        let mut heavy = RailCandidate::active("b-heavy");
        heavy.weight = 200;
        let mut light = RailCandidate::active("a-light");
        light.weight = 10;
        let result = resolve_visible_routes(
            &[light, heavy, RailCandidate::active("c-default")],
            VisibleRailsPolicy::default(),
        );
        // 200, then the two defaults of 100 ordered by id, then 10.
        assert_eq!(result.route_ids(), ["b-heavy", "c-default", "a-light"]);
        assert_eq!(result.routes[0].rank, 1);
        assert_eq!(result.routes[2].rank, 3);
    }

    #[test]
    fn no_route_yields_an_empty_but_non_error_result() {
        let result = resolve_visible_routes(&[], VisibleRailsPolicy::default());
        assert!(!result.is_visible());
        assert!(result.routes.is_empty());
        assert!(result.excluded.is_empty());
    }

    #[test]
    fn min_healthy_admits_degraded_routes_and_flags_the_shortfall() {
        let candidates = vec![degraded("degraded-a", false), degraded("degraded-b", false)];
        // Default policy: invisible (no healthy route and no canary cohort).
        let default = resolve_visible_routes(&candidates, VisibleRailsPolicy::default());
        assert!(!default.is_visible());
        // With a floor of one healthy route the degraded routes are admitted and flagged.
        let forced = resolve_visible_routes(
            &candidates,
            VisibleRailsPolicy {
                min_healthy: Some(1),
                canary_percent: 0,
            },
        );
        assert!(forced.degraded_shortfall);
        assert_eq!(forced.route_ids(), ["degraded-a", "degraded-b"]);
        assert!(forced.excluded.is_empty());
        // The floor is satisfied, so nothing changes.
        let satisfied = resolve_visible_routes(
            &[
                RailCandidate::active("healthy-1"),
                degraded("degraded-a", false),
            ],
            VisibleRailsPolicy {
                min_healthy: Some(1),
                canary_percent: 0,
            },
        );
        assert!(!satisfied.degraded_shortfall);
        assert_eq!(satisfied.route_ids(), ["healthy-1"]);
        assert_eq!(satisfied.excluded.len(), 1);
    }

    #[test]
    fn open_breaker_is_never_admitted_by_the_floor() {
        let candidates = vec![RailCandidate {
            health: RouteHealth::OpenBreaker,
            ..RailCandidate::active("open")
        }];
        let result = resolve_visible_routes(
            &candidates,
            VisibleRailsPolicy {
                min_healthy: Some(1),
                canary_percent: 100,
            },
        );
        assert!(!result.is_visible());
        assert_eq!(result.excluded[0].reason, ExclusionReason::RouteNotHealthy);
    }

    #[test]
    fn canary_selection_is_deterministic_and_percentage_bounded() {
        // No key or 0 %: never.
        assert!(!canary_selected("route-1", None, 50));
        assert!(!canary_selected("route-1", Some("link-1"), 0));
        // 100 %: always, with a key.
        assert!(canary_selected("route-1", Some("link-1"), 100));
        assert!(canary_selected("route-1", Some("link-1"), 255));
        // Deterministic for the same inputs.
        let first = canary_selected("route-1", Some("link-abc"), 10);
        let second = canary_selected("route-1", Some("link-abc"), 10);
        assert_eq!(first, second);
        // Different cohorts spread over the bucket space.
        let selected = (0..1000)
            .filter(|index| canary_selected("route-1", Some(&format!("link-{index}")), 10))
            .count();
        assert!(
            (50_usize..=200).contains(&selected),
            "10 % of 1000 cohorts selected {selected}"
        );
        // A 1 % cohort is rarer than a 50 % one.
        let one_percent = (0..1000)
            .filter(|index| canary_selected("route-1", Some(&format!("link-{index}")), 1))
            .count();
        assert!(one_percent <= selected);
    }
}
