//! Port of `checkout-back/test/env-isolation.test.ts`.
//!
//! The TS edge does not cache the environment under `NODE_ENV=test`; the Rust loader never caches,
//! so one process can build several configurations.

use checkout_edge::config::CheckoutConfig;
use pg_config::Env;

fn env_with(url: &str) -> Env {
    Env::process()
        .with_value("NODE_ENV", "test")
        .with_value("CORE_BACK_URL", url)
        .with_value("MTLS_CLIENT_CERT_PATH", "/tmp/edge-isolation/client.crt")
        .with_value("MTLS_CLIENT_KEY_PATH", "/tmp/edge-isolation/client.key")
        .with_value("MTLS_CA_CERT_PATH", "/tmp/edge-isolation/ca.crt")
}

#[test]
fn the_environment_is_not_cached_between_loads() {
    let first = CheckoutConfig::load(&env_with("https://first.internal:4000")).expect("first");
    assert_eq!(first.live_urls(), ["https://first.internal:4000"]);
    let second = CheckoutConfig::load(&env_with("https://second.internal:4000")).expect("second");
    assert_eq!(second.live_urls(), ["https://second.internal:4000"]);
    assert_ne!(first.live_urls(), second.live_urls());
}

#[test]
fn sandbox_configuration_can_change_between_loads() {
    let live_only = CheckoutConfig::load(&env_with("https://live.internal:4000")).expect("live");
    assert!(live_only.sandbox_urls().is_none());

    let with_sandbox = CheckoutConfig::load(
        &env_with("https://live.internal:4000")
            .with_value("SANDBOX_CORE_BACK_URL", "https://sandbox.internal:4005"),
    )
    .expect("sandbox");
    assert_eq!(
        with_sandbox.sandbox_urls().expect("sandbox"),
        ["https://sandbox.internal:4005"]
    );
}
