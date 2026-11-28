//! Every mounted core route must exist in the committed TypeScript route inventory.
//!
//! `routes-policy.json` proves the binary and its own policy document agree; this test proves the
//! mounted table was not invented. The reverse direction (inventory routes not yet mounted) is
//! expected during P4-P8 and is reported, not asserted, until the cutover phase.
//!
//! Run with `cargo test -p core-rs --test inventory_parity`.

use std::collections::BTreeSet;

use core_rs::routes;
use serde_json::Value;

fn inventory() -> Vec<Value> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/golden-vectors/route-inventory/routes.json"
    );
    let raw = std::fs::read_to_string(path).expect("read the committed route inventory");
    serde_json::from_str(&raw).expect("route inventory is valid JSON")
}

#[test]
fn every_mounted_route_is_in_the_typescript_inventory() {
    let rows = inventory();
    let known: BTreeSet<(String, String)> = rows
        .iter()
        .filter_map(|row| {
            Some((
                row.get("method")?.as_str()?.to_ascii_uppercase(),
                row.get("fullPath")?.as_str()?.to_owned(),
            ))
        })
        .collect();

    let mut unknown = Vec::new();
    let mut wrong_file = Vec::new();
    for route in routes::mounted_routes() {
        let key = (
            route.policy.method.to_ascii_uppercase(),
            route.policy.path.clone(),
        );
        if !known.contains(&key) {
            unknown.push(format!("{} {}", key.0, key.1));
            continue;
        }
        let Some(row) = rows.iter().find(|row| {
            row.get("method").and_then(Value::as_str) == Some(key.0.as_str())
                && row.get("fullPath").and_then(Value::as_str) == Some(key.1.as_str())
        }) else {
            continue;
        };
        let file = row.get("file").and_then(Value::as_str).unwrap_or_default();
        if !route.policy.ts_origin.starts_with(file) {
            wrong_file.push(format!(
                "{} {}: policy origin `{}` does not start with inventory file `{}`",
                key.0, key.1, route.policy.ts_origin, file
            ));
        }
    }

    assert!(
        unknown.is_empty(),
        "mounted routes that are not in the TypeScript inventory:\n{}",
        unknown.join("\n")
    );
    assert!(
        wrong_file.is_empty(),
        "mounted routes whose tsOrigin names a different TypeScript file:\n{}",
        wrong_file.join("\n")
    );
}

#[test]
fn inventory_coverage_is_reported_for_the_cutover_phase() {
    let rows = inventory();
    let mounted: BTreeSet<(String, String)> = routes::mounted_routes()
        .into_iter()
        .map(|route| (route.policy.method.to_ascii_uppercase(), route.policy.path))
        .collect();
    let all: BTreeSet<(String, String)> = rows
        .iter()
        .filter_map(|row| {
            Some((
                row.get("method")?.as_str()?.to_ascii_uppercase(),
                row.get("fullPath")?.as_str()?.to_owned(),
            ))
        })
        .collect();
    let mut missing_get: Vec<&(String, String)> = all
        .difference(&mounted)
        .filter(|(method, _)| method == "GET")
        .collect();
    missing_get.sort();
    eprintln!(
        "inventory parity: {} mounted, {} inventory routes, {} GET routes still unmounted",
        mounted.len(),
        all.len(),
        missing_get.len()
    );
    if !missing_get.is_empty() {
        eprintln!(
            "unmounted GET routes:\n{}",
            missing_get
                .iter()
                .map(|(_, path)| format!("  GET {path}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
    // This is the P4 read-route milestone: the whole GET surface must be mounted once P4 closes.
    // Until then the list is printed for the coordinator; a later phase flips this to zero.
}
