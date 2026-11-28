//! `object-storage-daemon-rs` — the shared object vault (P1 pilot).
//!
//! Routes and responses are the TS daemon's contract (chapter 2 §7). mTLS runs in ntex/rustls
//! with the internal CA; the peer certificate is read from ntex's `PeerCertDer` connection
//! metadata and authorized by CN **or** DNS SAN against `OBJECT_STORAGE_ALLOWED_CLIENT_CNS`.
//!
//! The router is a pure function over [`RouteRequest`] so every route is unit-testable without a
//! socket, matching the TS `handler(req, res)` shape.

#![forbid(unsafe_code)]

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use std::collections::BTreeMap;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use ntex::http::StatusCode;
use ntex::web::{self, App, HttpRequest, HttpResponse, HttpServer};
use ntex::{time::Seconds, SharedCfg};
use ntex_tls::PeerCertDer;
use pg_config::{Env, ObjectStorageDaemonConfig};
use pg_objstore::blob_store::{BlobListEntry, BlobStore, BucketTier, FsBlobStore, StorageError};
use serde_json::json;
use tracing::{error, info, warn};

const DEFAULT_MAX_BODY_BYTES: usize = 1200 * 1024 * 1024;
const DAEMON_ERROR_FORBIDDEN: &str = "client certificate is not authorized";

#[derive(Parser, Debug)]
#[command(
    name = "object-storage-daemon-rs",
    version,
    about = "Shared object vault"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Run the mTLS/HTTP daemon.
    Serve,
    /// Verify the vault is readable and report object counts.
    Fsck {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Clone)]
struct DaemonState {
    store: Arc<FsBlobStore>,
    allowed_client_cns: Vec<String>,
    require_mtls: bool,
}

struct RouteRequest {
    method: String,
    path: String,
    query: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

impl RouteRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }
}

struct RouteResponse {
    status: StatusCode,
    content_type: &'static str,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl RouteResponse {
    fn json(status: StatusCode, value: serde_json::Value) -> Self {
        Self {
            status,
            content_type: "application/json; charset=utf-8",
            headers: Vec::new(),
            body: value.to_string().into_bytes(),
        }
    }

    fn daemon_error(status: StatusCode, code: &str, message: &str) -> Self {
        Self::json(status, json!({"error": {"code": code, "message": message}}))
    }

    fn into_http(self) -> HttpResponse {
        let mut builder = HttpResponse::builder(self.status);
        builder.content_type(self.content_type);
        for (name, value) in self.headers {
            builder.header(name, value);
        }
        builder.body(self.body)
    }
}

#[ntex::main(name = "object-storage-daemon-rs", signals = true)]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => serve().await,
        Command::Fsck { json } => {
            let env = Env::load_default().map_err(io_err)?;
            let config = ObjectStorageDaemonConfig::from_env(&env).map_err(io_err)?;
            let store = FsBlobStore::new(&config.root_dir).await.map_err(io_err)?;
            let report = fsck(&store).await.map_err(io_err)?;
            if json {
                println!("{}", serde_json::to_string(&report).unwrap_or_default());
            } else {
                println!(
                    "object storage fsck: {} objects, {} bytes, {} unreadable",
                    report["objects"], report["bytes"], report["unreadable"]
                );
            }
            Ok(())
        }
    }
}

fn io_err(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

async fn serve() -> std::io::Result<()> {
    let env = Env::load_default().map_err(io_err)?;
    let config = ObjectStorageDaemonConfig::from_env(&env).map_err(io_err)?;
    let store = Arc::new(FsBlobStore::new(&config.root_dir).await.map_err(io_err)?);
    let state = DaemonState {
        store: store.clone(),
        allowed_client_cns: config.allowed_client_cns.clone(),
        require_mtls: config.require_mtls,
    };
    let tls = if config.require_mtls {
        let paths = pg_mtls::ServerTlsPaths {
            ca_cert: config
                .tls_ca_cert_path
                .clone()
                .map(std::path::PathBuf::from)
                .ok_or_else(|| io_err("OBJECT_STORAGE_DAEMON_TLS_CA_PATH is required"))?,
            server_cert: config
                .tls_server_cert_path
                .clone()
                .map(std::path::PathBuf::from)
                .ok_or_else(|| io_err("OBJECT_STORAGE_DAEMON_TLS_CERT_PATH is required"))?,
            server_key: config
                .tls_server_key_path
                .clone()
                .map(std::path::PathBuf::from)
                .ok_or_else(|| io_err("OBJECT_STORAGE_DAEMON_TLS_KEY_PATH is required"))?,
        };
        Some(pg_mtls::server_config(&paths).map_err(io_err)?)
    } else {
        None
    };

    let bind = format!("{}:{}", config.bind_host, config.port);
    let server = HttpServer::new(async move |_| {
        let state = state.clone();
        App::new().service(web::resource("/{tail}*").to(
            async move |req: HttpRequest, body: web::types::Payload| {
                dispatch(state.clone(), req, body).await
            },
        ))
    })
    .workers(worker_count())
    .graceful_shutdown_timeout(Seconds(10));
    let server = match &tls {
        Some(tls) => server.bind_rustls(
            bind.clone(),
            &tls.config,
            SharedCfg::new("pg-object-storage-daemon"),
        )?,
        None => server.bind(bind.clone(), SharedCfg::new("pg-object-storage-daemon"))?,
    };
    info!(
        bind = %bind,
        root = %config.root_dir,
        mtls = config.require_mtls,
        "object-storage-daemon listening"
    );
    let _ = sd_notify::notify(&[sd_notify::NotifyState::Ready]);
    server.run().await
}

fn worker_count() -> usize {
    std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(1)
}

async fn dispatch(state: DaemonState, req: HttpRequest, body: web::types::Payload) -> HttpResponse {
    if state.require_mtls {
        match peer_identity(&req) {
            Some(identity) if identity.allowed_by_cn_or_san(&state.allowed_client_cns) => {}
            Some(identity) => {
                warn!(
                    cn = identity.primary_cn().unwrap_or("none"),
                    "rejected mTLS client identity"
                );
                return RouteResponse::daemon_error(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    DAEMON_ERROR_FORBIDDEN,
                )
                .into_http();
            }
            None => {
                return RouteResponse::daemon_error(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    DAEMON_ERROR_FORBIDDEN,
                )
                .into_http()
            }
        }
    }
    let max_body = if req.path().starts_with("/v1/blobs/") {
        DEFAULT_MAX_BODY_BYTES
    } else {
        4096
    };
    let body = match read_body(body, max_body).await {
        Ok(body) => body,
        Err(error) => {
            return RouteResponse::json(StatusCode::BAD_REQUEST, json!({"error": error}))
                .into_http()
        }
    };
    let mut headers = BTreeMap::new();
    for (name, value) in req.headers() {
        if let Ok(value) = value.to_str() {
            headers.insert(name.as_str().to_ascii_lowercase(), value.to_owned());
        }
    }
    let response = handle_route(
        &state,
        RouteRequest {
            method: req.method().as_str().to_owned(),
            path: req.path().to_owned(),
            query: req.query_string().to_owned(),
            headers,
            body,
        },
    )
    .await;
    response.into_http()
}

async fn handle_route(state: &DaemonState, request: RouteRequest) -> RouteResponse {
    if request.method == "GET" && request.path == "/v1/health" {
        let health = state.store.health_check().await;
        let status = if health.ok {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        };
        return RouteResponse::json(status, serde_json::to_value(health).unwrap_or_default());
    }

    if let Some(rest) = request.path.strip_prefix("/v1/blobs/") {
        let Some((bucket, rel)) = split_bucket(rest) else {
            return RouteResponse::json(
                StatusCode::BAD_REQUEST,
                json!({"error": "MISSING_BUCKET_OR_PATH"}),
            );
        };
        let Ok(rel) = percent_decode(rel) else {
            return RouteResponse::json(
                StatusCode::BAD_REQUEST,
                json!({"error": "INVALID_PERCENT_ENCODING"}),
            );
        };
        return match request.method.as_str() {
            "PUT" => {
                if let Some(expected) = request
                    .header("x-content-sha256")
                    .filter(|value| value.len() == 64)
                {
                    let actual = hex::encode(pg_crypto::sha256(&request.body));
                    if actual != expected {
                        return RouteResponse::json(
                            StatusCode::BAD_REQUEST,
                            json!({
                                "error": "SHA256_MISMATCH_ON_PUT",
                                "expectedSha": expected,
                                "actualSha": actual
                            }),
                        );
                    }
                }
                match state.store.put(bucket, &rel, &request.body).await {
                    Ok((byte_size, sha256_hex)) => RouteResponse::json(
                        StatusCode::CREATED,
                        json!({"byteSize": byte_size, "sha256Hex": sha256_hex}),
                    ),
                    Err(error) => storage_error_response(error),
                }
            }
            "HEAD" => match state.store.stat(bucket, &rel).await {
                Ok((false, _)) => RouteResponse {
                    status: StatusCode::NOT_FOUND,
                    content_type: "application/octet-stream",
                    headers: Vec::new(),
                    body: Vec::new(),
                },
                Ok((true, size)) => RouteResponse {
                    status: StatusCode::OK,
                    content_type: "application/octet-stream",
                    headers: vec![
                        ("content-length".to_owned(), size.to_string()),
                        ("x-blob-byte-size".to_owned(), size.to_string()),
                    ],
                    body: Vec::new(),
                },
                Err(error) => storage_error_response(error),
            },
            "GET" => match state.store.read_bytes(bucket, &rel).await {
                Ok(bytes) => RouteResponse {
                    status: StatusCode::OK,
                    content_type: "application/octet-stream",
                    headers: vec![("content-length".to_owned(), bytes.len().to_string())],
                    body: bytes,
                },
                Err(StorageError::NotFound) => {
                    RouteResponse::json(StatusCode::NOT_FOUND, json!({"error": "BLOB_NOT_FOUND"}))
                }
                Err(error) => storage_error_response(error),
            },
            _ => RouteResponse::json(
                StatusCode::METHOD_NOT_ALLOWED,
                json!({"error": "METHOD_NOT_ALLOWED", "path": request.path}),
            ),
        };
    }

    if request.method == "POST" {
        if let Some(rest) = request.path.strip_prefix("/v1/trash/") {
            let Some((bucket, rel)) = split_bucket(rest) else {
                return RouteResponse::json(
                    StatusCode::BAD_REQUEST,
                    json!({"error": "MISSING_BUCKET_OR_PATH"}),
                );
            };
            let Ok(rel) = percent_decode(rel) else {
                return RouteResponse::json(
                    StatusCode::BAD_REQUEST,
                    json!({"error": "INVALID_PERCENT_ENCODING"}),
                );
            };
            let trash_date = if request.body.is_empty() {
                None
            } else {
                match serde_json::from_slice::<serde_json::Value>(&request.body) {
                    Ok(value) => value
                        .get("trashDateIso")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned),
                    Err(error) => {
                        return RouteResponse::json(
                            StatusCode::BAD_REQUEST,
                            json!({"error": format!("INVALID_JSON: {error}")}),
                        )
                    }
                }
            };
            return match state
                .store
                .move_to_trash(bucket, &rel, trash_date.as_deref())
                .await
            {
                Ok(()) => RouteResponse::json(StatusCode::OK, json!({"ok": true})),
                Err(error) => storage_error_response(error),
            };
        }
        if request.path == "/v1/purge-trash" {
            let cutoff = serde_json::from_slice::<serde_json::Value>(&request.body)
                .ok()
                .and_then(|value| {
                    value
                        .get("cutoffDateIso")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_default();
            if !valid_day(&cutoff) {
                return RouteResponse::json(
                    StatusCode::BAD_REQUEST,
                    json!({"error": "INVALID_CUTOFF_DATE"}),
                );
            }
            return match state.store.purge_trash_older_than(&cutoff).await {
                Ok(purged) => {
                    RouteResponse::json(StatusCode::OK, json!({"ok": true, "purgedCount": purged}))
                }
                Err(error) => storage_error_response(error),
            };
        }
    }

    if request.method == "GET" {
        if let Some(raw_bucket) = request.path.strip_prefix("/v1/list/") {
            let Ok(bucket_raw) = percent_decode(raw_bucket) else {
                return RouteResponse::json(
                    StatusCode::BAD_REQUEST,
                    json!({"error": "INVALID_PERCENT_ENCODING"}),
                );
            };
            let Some(bucket) = BucketTier::parse(&bucket_raw) else {
                return RouteResponse::json(
                    StatusCode::BAD_REQUEST,
                    json!({"error": format!("Invalid storage bucket tier: {bucket_raw}")}),
                );
            };
            let prefix = query_value(&request.query, "prefix").unwrap_or_default();
            return match state.store.list(bucket, &prefix).await {
                Ok(items) => RouteResponse::json(StatusCode::OK, json!({"items": items})),
                Err(error) => storage_error_response(error),
            };
        }
    }

    RouteResponse::json(
        StatusCode::NOT_FOUND,
        json!({"error": "ROUTE_NOT_FOUND", "path": request.path}),
    )
}

fn peer_identity(req: &HttpRequest) -> Option<pg_mtls::PeerIdentity> {
    let io = req.io()?;
    let certificate = io.query::<PeerCertDer>().into_inner()?;
    pg_mtls::identity_from_ntex(&certificate.0).ok()
}

fn split_bucket(rest: &str) -> Option<(BucketTier, &str)> {
    let (bucket_raw, rel) = rest.split_once('/')?;
    let bucket_raw = percent_decode(bucket_raw).ok()?;
    let bucket = BucketTier::parse(&bucket_raw)?;
    if rel.is_empty() {
        return None;
    }
    Some((bucket, rel))
}

fn query_value(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == key {
            return percent_decode(value).ok();
        }
    }
    None
}

fn percent_decode(value: &str) -> Result<String, ()> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(());
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).map_err(|_| ())?;
            let decoded = u8::from_str_radix(hex, 16).map_err(|_| ())?;
            output.push(decoded);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| ())
}

fn valid_day(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

async fn read_body(mut body: web::types::Payload, max: usize) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;
    let mut output = Vec::new();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|error| format!("PAYLOAD_ERROR: {error}"))?;
        if output.len() + chunk.len() > max {
            return Err(format!("Request body exceeds {max} bytes"));
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn storage_error_response(error: StorageError) -> RouteResponse {
    let client = matches!(
        error,
        StorageError::UnsafePath(_)
            | StorageError::Traversal(_)
            | StorageError::InvalidBucket(_)
            | StorageError::BodyTooLarge(_)
    );
    if client {
        RouteResponse::json(StatusCode::BAD_REQUEST, json!({"error": error.to_string()}))
    } else if matches!(error, StorageError::NotFound) {
        RouteResponse::json(StatusCode::NOT_FOUND, json!({"error": "BLOB_NOT_FOUND"}))
    } else {
        error!(error = %error, "object storage failure");
        RouteResponse::json(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": error.to_string()}),
        )
    }
}

async fn fsck(store: &FsBlobStore) -> Result<serde_json::Value, StorageError> {
    let mut objects = 0_u64;
    let mut bytes = 0_u64;
    let mut unreadable = 0_u64;
    for bucket in [BucketTier::Hot, BucketTier::Cold, BucketTier::Quarantine] {
        for BlobListEntry {
            rel_path,
            byte_size,
            ..
        } in store.list(bucket, "").await?
        {
            objects += 1;
            bytes += byte_size;
            if store.read_bytes(bucket, &rel_path).await.is_err() {
                unreadable += 1;
            }
        }
    }
    let health = store.health_check().await;
    Ok(json!({
        "ok": unreadable == 0 && health.ok,
        "objects": objects,
        "bytes": bytes,
        "unreadable": unreadable,
        "rootDir": store.root_dir().display().to_string(),
        "freeBytes": health.free_bytes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn state() -> (tempfile::TempDir, DaemonState) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = FsBlobStore::new(dir.path()).await.expect("store");
        (
            dir,
            DaemonState {
                store: Arc::new(store),
                allowed_client_cns: vec!["object-storage-client".to_owned()],
                require_mtls: false,
            },
        )
    }

    fn request(method: &str, path: &str, body: &[u8]) -> RouteRequest {
        RouteRequest {
            method: method.to_owned(),
            path: path.to_owned(),
            query: String::new(),
            headers: BTreeMap::new(),
            body: body.to_vec(),
        }
    }

    #[tokio::test]
    async fn put_get_head_and_missing() {
        let (_dir, state) = state().await;
        let put = handle_route(
            &state,
            request("PUT", "/v1/blobs/HOT/2026/11/a.bin", b"hello"),
        )
        .await;
        assert_eq!(put.status, StatusCode::CREATED);
        let body: serde_json::Value = serde_json::from_slice(&put.body).expect("json");
        assert_eq!(body["byteSize"], 5);

        let get = handle_route(&state, request("GET", "/v1/blobs/HOT/2026/11/a.bin", b"")).await;
        assert_eq!(get.status, StatusCode::OK);
        assert_eq!(get.body, b"hello");

        let head = handle_route(&state, request("HEAD", "/v1/blobs/HOT/2026/11/a.bin", b"")).await;
        assert_eq!(head.status, StatusCode::OK);
        assert!(head
            .headers
            .iter()
            .any(|(name, value)| name == "x-blob-byte-size" && value == "5"));

        let missing = handle_route(
            &state,
            request("GET", "/v1/blobs/HOT/2026/11/nope.bin", b""),
        )
        .await;
        assert_eq!(missing.status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn sha256_guard_rejects_mismatch() {
        let (_dir, state) = state().await;
        let mut request = request("PUT", "/v1/blobs/HOT/a.bin", b"hello");
        request
            .headers
            .insert("x-content-sha256".to_owned(), "0".repeat(64));
        let response = handle_route(&state, request).await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST);
        assert!(String::from_utf8_lossy(&response.body).contains("SHA256_MISMATCH_ON_PUT"));
    }

    #[tokio::test]
    async fn trash_list_and_purge() {
        let (_dir, state) = state().await;
        handle_route(&state, request("PUT", "/v1/blobs/COLD/2026/11/a.bin", b"x")).await;
        let list = handle_route(&state, request("GET", "/v1/list/COLD", b"")).await;
        assert_eq!(list.status, StatusCode::OK);
        assert!(String::from_utf8_lossy(&list.body).contains("2026/11/a.bin"));

        let mut trash = request("POST", "/v1/trash/COLD/2026/11/a.bin", b"");
        trash.body = br#"{"trashDateIso":"2026-11-01"}"#.to_vec();
        assert_eq!(handle_route(&state, trash).await.status, StatusCode::OK);

        let purge = request(
            "POST",
            "/v1/purge-trash",
            br#"{"cutoffDateIso":"2026-11-02"}"#,
        );
        let response = handle_route(&state, purge).await;
        assert_eq!(response.status, StatusCode::OK);
        assert!(String::from_utf8_lossy(&response.body).contains("\"purgedCount\":1"));
    }

    #[tokio::test]
    async fn unknown_routes_and_traversal() {
        let (_dir, state) = state().await;
        let unknown = handle_route(&state, request("GET", "/v1/nope", b"")).await;
        assert_eq!(unknown.status, StatusCode::NOT_FOUND);
        let traversal = handle_route(&state, request("PUT", "/v1/blobs/HOT/../escape", b"x")).await;
        assert_eq!(traversal.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn percent_decodes_paths() {
        assert_eq!(percent_decode("a%20b").expect("decode"), "a b");
        assert_eq!(percent_decode("a/b").expect("decode"), "a/b");
        assert!(percent_decode("%zz").is_err());
    }

    #[test]
    fn splits_bucket_and_path() {
        let (bucket, rel) = split_bucket("HOT/2026/11/a.bin").expect("split");
        assert_eq!(bucket, BucketTier::Hot);
        assert_eq!(rel, "2026/11/a.bin");
        assert!(split_bucket("HOT").is_none());
        assert!(split_bucket("NOPE/a").is_none());
    }
}
