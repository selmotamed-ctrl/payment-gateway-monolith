//! The backup control client for the two admin backup reads.
//!
//! Port of `core-back/lib/storageEngine/backupControlClient.ts` (the read half): base URL
//! `BACKUP_DAEMON_URL`, timeout `BACKUP_DAEMON_TIMEOUT_MS` (default 15 s, capped at 120 s),
//! `GET /v1/overview`, `accept: application/json`, TLS 1.3 with `BACKUP_DAEMON_CA_CERT_PATH` /
//! `BACKUP_DAEMON_CLIENT_CERT_PATH` / `BACKUP_DAEMON_CLIENT_KEY_PATH` for an `https:` endpoint and
//! the same error mapping (`envelope.error.message`/`code` when the daemon answers an error,
//! otherwise the transport message).
//!
//! The daemon's overview is never fabricated: when the daemon is absent the handler reports
//! `configured/daemonReachable` and falls back to the local catalog, exactly like TS.

#![forbid(unsafe_code)]

use std::time::Duration;

use serde_json::Value;

const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// `isBackupDaemonConfigured`.
#[must_use]
pub(crate) fn is_configured() -> bool {
    base_url().is_some()
}

fn base_url() -> Option<String> {
    std::env::var("BACKUP_DAEMON_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
}

fn timeout_ms() -> u64 {
    std::env::var("BACKUP_DAEMON_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map_or(DEFAULT_TIMEOUT_MS, |value| value.min(MAX_TIMEOUT_MS))
}

/// `getBackupControlClient().overview()`; the error is the message alone because that is all the
/// overview response surfaces (`daemonError`).
pub(crate) async fn overview() -> Result<Value, String> {
    let base = base_url().ok_or_else(|| "BACKUP_DAEMON_URL is not configured".to_owned())?;
    let url = format!("{base}/v1/overview");
    let timeout = Duration::from_millis(timeout_ms());
    let request = build_client(&url)?.get(url.as_str()).timeout(timeout);
    let response = request
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let bytes = response
        .body()
        .limit(MAX_RESPONSE_BYTES)
        .await
        .map_err(|error| error.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    let parsed: Value = serde_json::from_str(text.trim())
        .unwrap_or_else(|_| serde_json::json!({ "raw": text.to_string() }));
    if (200..300).contains(&status) {
        return Ok(parsed);
    }
    let message = parsed
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map_or_else(
            || format!("Backup daemon returned HTTP {status}"),
            str::to_owned,
        );
    Err(message)
}

/// Build a client for this endpoint. An `https:` URL with all three certificate paths uses the
/// internal mTLS trust anchor; without them the default web roots apply, so an internal certificate
/// fails the handshake the way Node's `rejectUnauthorized` does.
fn build_client(url: &str) -> Result<ntex::client::Client, String> {
    let builder = ntex::client::Client::builder();
    let builder = if url.starts_with("https:") {
        let (ca, cert, key) = (
            std::env::var("BACKUP_DAEMON_CA_CERT_PATH").ok(),
            std::env::var("BACKUP_DAEMON_CLIENT_CERT_PATH").ok(),
            std::env::var("BACKUP_DAEMON_CLIENT_KEY_PATH").ok(),
        );
        match (ca, cert, key) {
            (Some(ca), Some(cert), Some(key)) => {
                let paths = pg_mtls::ClientTlsPaths {
                    ca_cert: ca.trim().into(),
                    client_cert: cert.trim().into(),
                    client_key: key.trim().into(),
                };
                let tls = pg_mtls::client_config(&paths).map_err(|error| error.to_string())?;
                builder.rustls((*tls.config).clone())
            }
            _ => builder,
        }
    } else {
        builder
    };
    Ok(builder.build(ntex::SharedCfg::default()))
}
