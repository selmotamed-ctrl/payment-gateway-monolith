//! Logical (`pg_dump --format=custom`) backups. Port of
//! `deploy/backup-daemon/src/logicalDump.ts`.
//!
//! They give every full backup a granular, cluster-free restore path and are the ONLY backup of the
//! audit database when it shares the primary cluster as a standalone target.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use tokio::fs;

use crate::artifacts::ArtifactRepository;
use crate::command_runner::CommandRunner;
use crate::config::{audit_endpoint, is_audit_dedicated_cluster, Config};
use crate::crypto::{
    open_to_file, seal_file, sign_manifest, verify_manifest_signature, ArtifactRecord,
    BackupManifest, ManifestEncryption, SealOptions,
};
use crate::pg_tools::{
    build_dump_command, build_restore_dump_command, build_restore_list_command, connection_env,
    pg_bin, run_tool, PgCluster, RestoreTarget,
};
use crate::util::{make_backup_id, temp_sibling};

pub type Clock = Box<dyn Fn() -> DateTime<Utc> + Send + Sync>;

pub struct LogicalDumpDeps {
    pub config: Arc<Config>,
    pub runner: Arc<dyn CommandRunner>,
    pub repository: Arc<ArtifactRepository>,
    pub master: Vec<u8>,
    pub clock: Clock,
}

#[derive(Debug, Clone)]
pub struct LogicalDumpResult {
    pub database: String,
    pub key: String,
    pub sha256_ciphertext: String,
    pub bytes: u64,
    pub storage_targets: Vec<String>,
}

#[must_use]
pub fn logical_dump_key(database: &str, backup_id: &str) -> String {
    format!("logical/{database}/{backup_id}.dump.enc")
}

#[must_use]
pub fn logical_manifest_key(target: &str, backup_id: &str) -> String {
    format!("backups/{target}/{backup_id}.manifest.json")
}

fn seal_target(database: &str) -> String {
    format!("logical:{database}")
}

pub struct LogicalDumper {
    deps: LogicalDumpDeps,
}

impl LogicalDumper {
    #[must_use]
    pub fn new(deps: LogicalDumpDeps) -> Self {
        Self { deps }
    }

    #[must_use]
    pub fn staging_dir(&self) -> PathBuf {
        PathBuf::from(&self.deps.config.staging_dir)
    }

    /// `pg_dump` -> header check with `pg_restore --list` -> encrypt -> every storage tier.
    pub async fn dump(
        &self,
        cluster: PgCluster,
        database: &str,
        backup_id: &str,
    ) -> Result<LogicalDumpResult, String> {
        let config = &self.deps.config;
        let work_dir =
            Path::new(&config.staging_dir).join(format!("{backup_id}-{}-dump", cluster.as_str()));
        fs::create_dir_all(&work_dir)
            .await
            .map_err(|error| error.to_string())?;
        let dump_file = work_dir.join(format!("{database}.dump"));
        let outcome = async {
            run_tool(
                self.deps.runner.as_ref(),
                &build_dump_command(config, cluster, database, &dump_file),
                &format!("pg_dump {database}"),
            )
            .await?;
            // A dump whose table of contents cannot be read is worthless; fail now, not at restore.
            let listing = run_tool(
                self.deps.runner.as_ref(),
                &build_restore_list_command(config, &dump_file),
                &format!("pg_restore --list {database}"),
            )
            .await?;
            if listing.stdout.trim().is_empty() {
                return Err(format!(
                    "pg_restore --list produced no table of contents for {database}"
                ));
            }
            let key = logical_dump_key(database, backup_id);
            // pg_dump already compressed the archive with zstd, so do not compress twice.
            let mut options =
                SealOptions::new(&self.deps.master, &seal_target(database), backup_id);
            options.compress = false;
            let temp_sealed = temp_sibling(&work_dir.join("dump.enc"));
            let seal = seal_file(&dump_file, &temp_sealed, &options)
                .await
                .map_err(|error| error.to_string())?;
            let outcome = self
                .deps
                .repository
                .put_file(&key, &temp_sealed, None)
                .await
                .map_err(|error| error.message);
            let _ = fs::remove_file(&temp_sealed).await;
            let outcome = outcome?;
            Ok::<LogicalDumpResult, String>(LogicalDumpResult {
                database: database.to_owned(),
                key,
                sha256_ciphertext: seal.sha256_ciphertext,
                bytes: seal.compressed_bytes,
                storage_targets: outcome.stored,
            })
        }
        .await;
        let _ = fs::remove_dir_all(&work_dir).await;
        outcome
    }

    /// Standalone backup of the audit database when it shares the primary cluster: logical dump +
    /// signed manifest in the `audit_db` prefix. Never needs `PG_AUDIT_DATA_DIR`.
    pub async fn backup_shared_audit(
        &self,
        engine: &str,
        skip_if_missing: bool,
    ) -> Result<(Vec<String>, u64, Option<String>), String> {
        let config = &self.deps.config;
        let database = &config.pg_audit_db_name;
        if !self.database_exists("audit", database).await? {
            if skip_if_missing {
                return Ok((
                    Vec::new(),
                    0,
                    Some(format!(
                        "audit database {database} does not exist in the primary cluster"
                    )),
                ));
            }
            return Err(format!(
                "audit database {database} does not exist in the primary cluster"
            ));
        }
        let started_at = (self.deps.clock)();
        let backup_id = make_backup_id(started_at, "audit", "full");
        let dump = self.dump(PgCluster::Audit, database, &backup_id).await?;
        self.write_manifest(crate::logical_dump::ManifestInput {
            target: "audit_db",
            backup_id: &backup_id,
            started_at: &started_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            dumps: std::slice::from_ref(&dump),
            engine,
            cluster_topology: "shared-audit",
        })
        .await?;
        Ok((dump.storage_targets, dump.bytes, None))
    }

    /// Whether `database` exists. `pg_database` is cluster-wide, so any database the role may
    /// connect to answers: the audit database itself on a dedicated cluster, the core database when
    /// the audit database shares the primary cluster.
    pub async fn database_exists(&self, cluster: &str, database: &str) -> Result<bool, String> {
        let config = &self.deps.config;
        let dedicated = cluster == "audit" && is_audit_dedicated_cluster(config);
        let endpoint = if cluster == "audit" {
            audit_endpoint(config)
        } else {
            crate::config::PgEndpoint {
                host: config.pg_primary_host.clone(),
                port: config.pg_primary_port,
                user: config.pg_primary_user.clone(),
                password: config.pg_primary_password.clone(),
            }
        };
        let connect_db = if dedicated {
            config.pg_audit_db_name.clone()
        } else {
            config.pg_primary_db_name.clone()
        };
        let query = format!(
            "SELECT 1 FROM pg_database WHERE datname = '{}'",
            database.replace('\'', "''")
        );
        let result = self
            .deps
            .runner
            .run(
                &pg_bin(config, "psql"),
                &[
                    "-h".to_owned(),
                    endpoint.host.clone(),
                    "-p".to_owned(),
                    endpoint.port.to_string(),
                    "-U".to_owned(),
                    endpoint.user.clone(),
                    "-d".to_owned(),
                    connect_db,
                    "-X".to_owned(),
                    "-A".to_owned(),
                    "-t".to_owned(),
                    "-w".to_owned(),
                    "-v".to_owned(),
                    "ON_ERROR_STOP=1".to_owned(),
                    "-c".to_owned(),
                    query,
                ],
                crate::command_runner::RunOptions {
                    env: connection_env(config, &endpoint.password, &config.pg_sslmode),
                    input: None,
                    timeout_ms: Some(config.command_timeout_ms),
                },
            )
            .await
            .map_err(|error| format!("could not check for database {database}: {error}"))?;
        if result.code != 0 {
            return Err(format!(
                "could not check for database {database}: {}",
                result.stderr.trim().chars().take(300).collect::<String>()
            ));
        }
        Ok(result.stdout.trim() == "1")
    }

    /// Signed manifest for a standalone logical backup (shared-cluster audit database).
    pub async fn write_manifest(&self, input: ManifestInput<'_>) -> Result<BackupManifest, String> {
        let primary = input
            .dumps
            .first()
            .ok_or_else(|| "a logical backup manifest needs at least one dump".to_owned())?;
        let mut artifacts = std::collections::BTreeMap::new();
        for dump in input.dumps {
            artifacts.insert(
                dump.key.clone(),
                ArtifactRecord {
                    sha256_ciphertext: dump.sha256_ciphertext.clone(),
                    bytes: dump.bytes,
                },
            );
        }
        let mut storage_targets: Vec<String> = input
            .dumps
            .iter()
            .flat_map(|dump| dump.storage_targets.clone())
            .collect();
        storage_targets.sort();
        storage_targets.dedup();
        let manifest = sign_manifest(
            &BackupManifest {
                schema_version: 2,
                backup_id: input.backup_id.to_owned(),
                target: input.target.to_owned(),
                kind: "full".to_owned(),
                engine: input.engine.to_owned(),
                cluster_topology: input.cluster_topology.to_owned(),
                started_at: input.started_at.to_owned(),
                completed_at: (self.deps.clock)()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                start_lsn: None,
                end_lsn: None,
                wal_segment_start: None,
                wal_segment_end: None,
                parent_backup_id: None,
                uncompressed_bytes: 0,
                compressed_bytes: input.dumps.iter().map(|dump| dump.bytes).sum(),
                sha256_plaintext: String::new(),
                sha256_ciphertext: primary.sha256_ciphertext.clone(),
                encryption: ManifestEncryption {
                    algorithm: "AES-256-GCM".to_owned(),
                    kdf: "HKDF-SHA256".to_owned(),
                    salt_hex: String::new(),
                    iv_hex: String::new(),
                    auth_tag_hex: String::new(),
                },
                pg_verify_backup: None,
                artifacts: Some(artifacts),
                storage_targets,
                signature: None,
            },
            &self.deps.master,
        )
        .map_err(|error| error.to_string())?;
        self.deps
            .repository
            .put_buffer(
                &logical_manifest_key(input.target, input.backup_id),
                format!(
                    "{}\n",
                    serde_json::to_string_pretty(&manifest).unwrap_or_default()
                )
                .as_bytes(),
                None,
            )
            .await
            .map_err(|error| error.message)?;
        Ok(manifest)
    }

    /// Newest verified logical dump of `database`, or None.
    pub async fn latest(&self, database: &str) -> Option<(String, String)> {
        let keys: Vec<String> = self
            .deps
            .repository
            .list(&format!("logical/{database}"))
            .await
            .into_iter()
            .filter(|key| key.ends_with(".dump.enc"))
            .collect();
        let mut candidates: Vec<(String, String, String)> = Vec::new();
        for key in keys {
            let backup_id = key
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .trim_end_matches(".dump.enc")
                .to_owned();
            for target in ["audit_db", "postgres_core"] {
                let Some(raw) = self
                    .deps
                    .repository
                    .get_buffer(&logical_manifest_key(target, &backup_id))
                    .await
                else {
                    continue;
                };
                let Ok(manifest) = serde_json::from_slice::<BackupManifest>(&raw) else {
                    continue;
                };
                if verify_manifest_signature(&manifest, &self.deps.master)
                    && manifest
                        .artifacts
                        .as_ref()
                        .is_some_and(|artifacts| artifacts.contains_key(&key))
                {
                    candidates.push((key.clone(), backup_id.clone(), manifest.completed_at));
                    break;
                }
            }
        }
        candidates.sort_by(|left, right| right.2.cmp(&left.2));
        candidates
            .into_iter()
            .next()
            .map(|(key, backup_id, _)| (key, backup_id))
    }

    /// Restores the newest verified dump of `database` into a running (scratch) cluster.
    pub async fn restore_latest(
        &self,
        request: &crate::engine::RecoverLogicalRequest,
    ) -> (bool, String) {
        let config = &self.deps.config;
        let Some((key, backup_id)) = self.latest(&request.database).await else {
            return (
                false,
                format!("no verified logical dump of {} exists", request.database),
            );
        };
        let work_dir = Path::new(&config.staging_dir)
            .join(format!("restore-{backup_id}-{}", request.database));
        if let Err(error) = fs::create_dir_all(&work_dir).await {
            return (false, error.to_string());
        }
        let outcome = async {
            let sealed = work_dir.join("dump.enc");
            self.deps
                .repository
                .get_file(&key, &sealed)
                .await
                .map_err(|error| error.to_string())?;
            let plain = work_dir.join("dump");
            open_to_file(
                &sealed,
                &plain,
                &self.deps.master,
                &seal_target(&request.database),
                &backup_id,
                false,
            )
            .await
            .map_err(|error| error.to_string())?;
            let create = self
                .deps
                .runner
                .run(
                    &pg_bin(config, "psql"),
                    &[
                        "-h".to_owned(),
                        request.host.clone(),
                        "-p".to_owned(),
                        request.port.to_string(),
                        "-U".to_owned(),
                        request.user.clone(),
                        "-d".to_owned(),
                        "postgres".to_owned(),
                        "-X".to_owned(),
                        "-A".to_owned(),
                        "-t".to_owned(),
                        "-w".to_owned(),
                        "-v".to_owned(),
                        "ON_ERROR_STOP=1".to_owned(),
                        "-c".to_owned(),
                        format!(
                            "CREATE DATABASE \"{}\"",
                            request.database.replace('"', "\"\"")
                        ),
                    ],
                    crate::command_runner::RunOptions {
                        env: vec![("PGSSLMODE".to_owned(), "prefer".to_owned())],
                        input: None,
                        timeout_ms: Some(config.command_timeout_ms),
                    },
                )
                .await
                .map_err(|error| error.to_string())?;
            if create.code != 0 {
                return Err(format!(
                    "CREATE DATABASE {} failed: {}",
                    request.database,
                    create.stderr.trim().chars().take(300).collect::<String>()
                ));
            }
            run_tool(
                self.deps.runner.as_ref(),
                &build_restore_dump_command(
                    config,
                    &plain,
                    &RestoreTarget {
                        host: request.host.clone(),
                        port: request.port,
                        user: request.user.clone(),
                        database: request.database.clone(),
                    },
                ),
                &format!("pg_restore {}", request.database),
            )
            .await?;
            Ok::<(), String>(())
        }
        .await;
        let _ = fs::remove_dir_all(&work_dir).await;
        match outcome {
            Ok(()) => (
                true,
                format!(
                    "restored logical dump {backup_id} into {}",
                    request.database
                ),
            ),
            Err(error) => (false, error.chars().take(400).collect()),
        }
    }
}

pub struct ManifestInput<'a> {
    pub target: &'a str,
    pub backup_id: &'a str,
    pub started_at: &'a str,
    pub dumps: &'a [LogicalDumpResult],
    pub engine: &'a str,
    pub cluster_topology: &'a str,
}
