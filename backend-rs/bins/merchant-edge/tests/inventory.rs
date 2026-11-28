//! The route table must cover every real merchant route of the generated inventory.
//!
//! `backend-rs/tests/golden-vectors/route-inventory/edge-routes.json` is produced from the
//! TypeScript AST (P0-T04). This test fails when a TS route is added/renamed and the Rust table is
//! not updated, and when the table invents a route the TS edge does not serve.

use std::collections::HashSet;

use merchant_edge::routes::ROUTES;
use serde_json::Value;

fn inventory() -> Vec<(String, String)> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/golden-vectors/route-inventory/edge-routes.json"
    );
    let raw = std::fs::read_to_string(path).expect("route inventory");
    let entries: Vec<Value> = serde_json::from_str(&raw).expect("json");
    entries
        .into_iter()
        .filter(|entry| entry["service"] == "merchant-back")
        .map(|entry| {
            (
                entry["method"].as_str().expect("method").to_owned(),
                entry["fullPath"].as_str().expect("path").to_owned(),
            )
        })
        .collect()
}

#[test]
fn every_inventory_route_is_registered() {
    let registered: HashSet<(String, String)> = ROUTES
        .iter()
        .filter(|route| route.method != "*")
        .map(|route| (route.method.to_owned(), route.pattern.to_owned()))
        .collect();
    let mut missing = Vec::new();
    for (method, path) in inventory() {
        if !registered.contains(&(method.clone(), path.clone())) {
            missing.push(format!("{method} {path}"));
        }
    }
    assert!(missing.is_empty(), "unregistered routes: {missing:#?}");
}

#[test]
fn the_table_only_adds_the_documented_sandbox_wildcard() {
    let inventory: HashSet<(String, String)> = inventory().into_iter().collect();
    let mut extra = Vec::new();
    for route in ROUTES.iter() {
        if route.method == "*" {
            continue;
        }
        if !inventory.contains(&(route.method.to_owned(), route.pattern.to_owned())) {
            extra.push(format!("{} {}", route.method, route.pattern));
        }
    }
    assert_eq!(
        extra,
        Vec::<String>::new(),
        "the table serves routes absent from the TS inventory"
    );
    let wildcard: Vec<&str> = ROUTES
        .iter()
        .filter(|route| route.method == "*")
        .map(|route| route.pattern)
        .collect();
    assert_eq!(wildcard, vec!["/api/v1/merchant/sandbox/{*rest}"]);
}

#[test]
fn the_inventory_has_the_documented_merchant_route_count() {
    // 105 API routes + `/health`. The `/sandbox` catch-all is not enumerable by the AST tool.
    assert_eq!(inventory().len(), 106);
    assert_eq!(ROUTES.len(), 107);
}
