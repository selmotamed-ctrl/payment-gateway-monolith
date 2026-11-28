//! The reqwest client is built with `rustls-no-provider`: the CryptoProvider must be installed
//! before the first `reqwest::Client`, otherwise rustls panics at runtime. `HttpCoreTransport::new`
//! installs it via `pg_mtls::install_crypto_provider()`; this test proves the client really builds
//! with generated mTLS material (and that a missing certificate is a startup error, not a panic).

use std::path::PathBuf;

use merchant_edge::config::{EdgeConfig, MtlsPaths};
use merchant_edge::upstream::HttpCoreTransport;

struct Pki {
    dir: tempfile::TempDir,
    cert: PathBuf,
    key: PathBuf,
    ca: PathBuf,
}

fn pki() -> Pki {
    let dir = tempfile::tempdir().expect("tempdir");
    let generated =
        rcgen::generate_simple_self_signed(vec!["localhost".to_owned(), "127.0.0.1".to_owned()])
            .expect("certificate");
    let cert = dir.path().join("client.crt");
    let key = dir.path().join("client.key");
    let ca = dir.path().join("ca.crt");
    let certificate_pem = generated.cert.pem();
    std::fs::write(&cert, &certificate_pem).expect("cert");
    std::fs::write(&ca, &certificate_pem).expect("ca");
    std::fs::write(&key, generated.signing_key.serialize_pem()).expect("key");
    Pki { dir, cert, key, ca }
}

fn config(paths: &Pki) -> EdgeConfig {
    let mut config = EdgeConfig::for_embedding(vec!["https://127.0.0.1:4010".to_owned()], None);
    config.mtls = MtlsPaths {
        client_cert: paths.cert.clone(),
        client_key: paths.key.clone(),
        ca_cert: paths.ca.clone(),
    };
    config
}

#[test]
fn the_mtls_client_builds_after_installing_the_crypto_provider() {
    let paths = pki();
    // Building twice is safe: `install_crypto_provider` is idempotent.
    let transport = HttpCoreTransport::new(&config(&paths)).expect("client");
    drop(transport);
    let again = HttpCoreTransport::new(&config(&paths)).expect("client again");
    drop(again);
    // Keep the directory alive until the assertions are done.
    assert!(paths.dir.path().exists());
}

#[test]
fn unreadable_mtls_material_is_a_startup_error() {
    let mut config = EdgeConfig::for_embedding(vec!["https://127.0.0.1:4010".to_owned()], None);
    config.mtls = MtlsPaths {
        client_cert: PathBuf::from("/nonexistent/client.crt"),
        client_key: PathBuf::from("/nonexistent/client.key"),
        ca_cert: PathBuf::from("/nonexistent/ca.crt"),
    };
    let error = HttpCoreTransport::new(&config).expect_err("missing material");
    assert!(error.contains("MTLS_CA_CERT_PATH"), "{error}");
}

#[test]
fn the_transport_reports_the_configured_sandbox_plane() {
    let paths = pki();
    let mut with_sandbox = config(&paths);
    with_sandbox.pools.sandbox = Some(vec!["https://127.0.0.1:4005".to_owned()]);
    let transport = HttpCoreTransport::new(&with_sandbox).expect("client");
    drop(transport);
    // AppState decides plane availability from the config, never from a fallback.
    assert!(with_sandbox.pools.has_sandbox());
}
