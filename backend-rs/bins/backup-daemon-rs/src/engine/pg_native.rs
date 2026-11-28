//! The `pg-native` engine: `pg_basebackup` full/incremental backups, logical dumps,
//! `pg_verifybackup`, a signed manifest per backup, chain restore through `pg_combinebackup` and
//! policy-driven pruning. Port of `deploy/backup-daemon/src/pgNativeEngine.ts`.
//!
//! Deviations from the TS implementation are in `README.md` (notably: no continuous
//! `pg_receivewal` supervisor, and the archive is the local repository only).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio::fs;

use crate::artifacts::ArtifactRepository;
use crate::catalog::{BackupRun, RunPatch};
use crate::command_runner::CommandRunner;
use crate::config::{cluster_topology, is_audit_dedicated_cluster, Config};
use crate::crypto::{
    master_key_from_hex, sign_manifest, verify_manifest_signature, ArtifactRecord, BackupManifest,
    ManifestEncryption, PgVerifyBackup, SealOptions,
};
use crate::engine::{
    build_psql_command, build_redis_ping_command, build_redis_rdb_command,
    build_redis_snapshot_command, check_target, expand_targets, run_checked, wal_health_for,
    BackupEngine, BackupExecutionResult, BackupKind, BackupStorageTarget, BackupSummary,
    BackupTarget, EngineDeps, EngineError, EngineFuture, EngineHealth, PolicyView,
    RecoverLogicalRequest, RecoverRequest, RecoverResult, WalIngestOutcome,
};
use crate::logical_dump::{logical_manifest_key, LogicalDumpResult, LogicalDumper};
use crate::pg_tools::{
    build_base_backup_command, build_combine_backup_command, run_tool, BaseBackupOptions,
    PgCluster, ToolCommand,
};
use crate::util::{make_backup_id, path_exists, write_file_atomic};
use crate::wal_archive::{IngestResult, WalArchive};
use crate::wal_names::{lsn_to_segment_name, pg_recovery_timestamp, wal_segment_number, WalTarget};

type Clock = Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>;

/// Short id fragment for each physical backup target.
fn short_name(target: BackupTarget) -> &'static str {
    match target {
        BackupTarget::AuditDb => "audit",
        BackupTarget::Redis => "redis",
        _ => "core",
    }
}

/// Files a tar-format base backup of a default-tablespace cluster consists of. Anything else is an
/// extra tablespace.
pub const EXPECTED_BACKUP_FILES: [&str; 3] = ["base.tar", "pg_wal.tar", "backup_manifest"];

#[must_use]
pub fn unexpected_backup_files(names: &[String]) -> Vec<String> {
    names
        .iter()
        .filter(|name| !EXPECTED_BACKUP_FILES.contains(&name.as_str()))
        .cloned()
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalRange {
    pub timeline: u32,
    pub start_lsn: String,
    pub end_lsn: String,
}

pub fn parse_wal_ranges(manifest_json: &str) -> Result<Vec<WalRange>, serde_json::Error> {
    let parsed: Value = serde_json::from_str(manifest_json)?;
    let ranges = parsed
        .get("WAL-Ranges")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(ranges
        .into_iter()
        .map(|range| WalRange {
            timeline: range.get("Timeline").and_then(Value::as_u64).unwrap_or(1) as u32,
            start_lsn: range
                .get("Start-LSN")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            end_lsn: range
                .get("End-LSN")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        })
        .collect())
}

/// `restore_command` that decrypts WAL straight out of the repository. Single quotes doubled for
/// `postgresql.conf`.
#[must_use]
pub fn build_restore_command(
    target: WalTarget,
    _daemon_binary: &str,
    wal_fetch_binary: &str,
) -> String {
    let quoted = wal_fetch_binary.replace('\'', "");
    let command = format!("'{quoted}' wal-fetch {} %f %p", target.as_str());
    command.replace('\'', "''")
}

pub struct PgNativeEngine {
    config: Arc<Config>,
    runner: Arc<dyn CommandRunner>,
    repository: Arc<ArtifactRepository>,
    master: Vec<u8>,
    clock: Clock,
    policy: Option<Arc<dyn Fn() -> PolicyView + Send + Sync>>,
    dumper: LogicalDumper,
    wal_archive: WalArchive,
}

impl PgNativeEngine {
    pub fn new(
        config: Arc<Config>,
        runner: Arc<dyn CommandRunner>,
        repository: Arc<ArtifactRepository>,
        deps: EngineDeps,
    ) -> Result<Self, EngineError> {
        let master = master_key_from_hex(&config.encryption_key_hex)
            .map_err(|error| EngineError::Configuration(error.to_string()))?;
        let clock: Clock = deps.clock.unwrap_or_else(|| Arc::new(Utc::now));
        let dumper = LogicalDumper::new(crate::logical_dump::LogicalDumpDeps {
            config: Arc::clone(&config),
            runner: Arc::clone(&runner),
            repository: Arc::clone(&repository),
            master: master.clone(),
            clock: {
                let clock = Arc::clone(&clock);
                Box::new(move || clock())
            },
        });
        let wal_archive = WalArchive::new(
            Arc::clone(&repository),
            master.clone(),
            PathBuf::from(&config.staging_dir),
            config.wal_push_max_bytes,
            {
                let clock = Arc::clone(&clock);
                Box::new(move || clock())
            },
        );
        Ok(Self {
            policy: deps.get_policy,
            config,
            runner,
            repository,
            master,
            clock,
            dumper,
            wal_archive,
        })
    }

    #[must_use]
    pub fn repository(&self) -> Arc<ArtifactRepository> {
        Arc::clone(&self.repository)
    }

    #[must_use]
    pub fn state_dir(&self) -> PathBuf {
        Path::new(&self.config.catalog_path)
            .parent()
            .map(|parent| parent.join("manifests"))
            .unwrap_or_else(|| PathBuf::from("manifests"))
    }

    fn cluster_for(target: BackupTarget) -> PgCluster {
        if target == BackupTarget::AuditDb {
            PgCluster::Audit
        } else {
            PgCluster::Core
        }
    }

    fn connect_db(&self, cluster: PgCluster) -> String {
        if cluster == PgCluster::Audit {
            self.config.pg_audit_db_name.clone()
        } else {
            self.config.pg_primary_db_name.clone()
        }
    }

    async fn scalar(&self, cluster: PgCluster, sql: &str) -> Result<String, EngineError> {
        let endpoint = crate::pg_tools::sql_endpoint(&self.config, cluster);
        let command = build_psql_command(
            &self.config,
            sql,
            &self.connect_db(cluster),
            &endpoint,
            &endpoint.user,
        );
        let result = run_tool(self.runner.as_ref(), &command, "psql")
            .await
            .map_err(EngineError::Other)?;
        Ok(result.stdout.trim().to_owned())
    }

    /// "Now" according to the PRIMARY: manifest times are compared with recovery targets, which are
    /// commit times taken from the primary's clock.
    pub async fn primary_clock(&self, cluster: PgCluster) -> DateTime<Utc> {
        let sql = "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"');";
        if let Ok(value) = self.scalar(cluster, sql).await {
            if let Ok(parsed) = DateTime::parse_from_rfc3339(&value) {
                return parsed.with_timezone(&Utc);
            }
        }
        (self.clock)()
    }

    fn artifact_key(&self, target: BackupTarget, backup_id: &str) -> String {
        format!("backups/{}/{backup_id}.tar.zst.enc", target.as_str())
    }

    fn manifest_key(&self, target: BackupTarget, backup_id: &str) -> String {
        logical_manifest_key(target.as_str(), backup_id)
    }

    /// Every manifest of `target` whose HMAC verifies, oldest first. Tampered manifests are ignored
    /// loudly.
    pub async fn list_manifests(
        &self,
        target: BackupTarget,
    ) -> Result<Vec<BackupManifest>, EngineError> {
        let prefix = format!("backups/{}", target.as_str());
        let keys: Vec<String> = self
            .repository
            .list(&prefix)
            .await
            .into_iter()
            .filter(|key| key.ends_with(".manifest.json"))
            .collect();
        let mut manifests = Vec::new();
        for key in keys {
            let Some(raw) = self.repository.get_buffer(&key).await else {
                continue;
            };
            let Ok(manifest) = serde_json::from_slice::<BackupManifest>(&raw) else {
                tracing::error!(key = key.as_str(), "manifest is unreadable and was ignored");
                continue;
            };
            if !verify_manifest_signature(&manifest, &self.master) {
                tracing::error!(
                    key = key.as_str(),
                    "manifest failed signature verification and was ignored"
                );
                continue;
            }
            manifests.push(manifest);
        }
        manifests.sort_by(|left, right| left.completed_at.cmp(&right.completed_at));
        Ok(manifests)
    }

    async fn tar_create(&self, directory: &Path, destination: &Path) -> Result<(), EngineError> {
        let command = ToolCommand {
            command: "tar".to_owned(),
            args: vec![
                "-C".to_owned(),
                directory.to_string_lossy().into_owned(),
                "-cf".to_owned(),
                destination.to_string_lossy().into_owned(),
                ".".to_owned(),
            ],
            env: Vec::new(),
            timeout_ms: self.config.command_timeout_ms,
        };
        run_tool(self.runner.as_ref(), &command, "tar")
            .await
            .map(|_| ())
            .map_err(EngineError::Other)
    }

    async fn tar_extract(
        &self,
        source: &Path,
        destination: &Path,
        only_pattern: Option<&str>,
    ) -> Result<(), EngineError> {
        fs::create_dir_all(destination)
            .await
            .map_err(|error| EngineError::Other(error.to_string()))?;
        let mut args = vec![
            "-x".to_owned(),
            "-C".to_owned(),
            destination.to_string_lossy().into_owned(),
            "--no-same-owner".to_owned(),
        ];
        if let Some(pattern) = only_pattern {
            args.push("--wildcards".to_owned());
            args.push(pattern.to_owned());
        }
        args.push("-f".to_owned());
        args.push(source.to_string_lossy().into_owned());
        let command = ToolCommand {
            command: "tar".to_owned(),
            args,
            env: Vec::new(),
            timeout_ms: self.config.command_timeout_ms,
        };
        run_tool(self.runner.as_ref(), &command, "tar")
            .await
            .map(|_| ())
            .map_err(EngineError::Other)
    }

    // -----------------------------------------------------------------------
    // health
    // -----------------------------------------------------------------------

    async fn psql_target(&self, id: &str, name: &str, cluster: PgCluster) -> BackupStorageTarget {
        let endpoint = crate::pg_tools::sql_endpoint(&self.config, cluster);
        let command = build_psql_command(
            &self.config,
            "SELECT 1;",
            &self.connect_db(cluster),
            &endpoint,
            &endpoint.user,
        );
        check_target(self.runner.as_ref(), id, name, "database", &command).await
    }

    // -----------------------------------------------------------------------
    // backup
    // -----------------------------------------------------------------------

    async fn backup_physical(
        &self,
        target: BackupTarget,
        kind: BackupKind,
    ) -> Result<BackupExecutionResult, EngineError> {
        let cluster = Self::cluster_for(target);
        let started_at = self.primary_clock(cluster).await;
        let backup_id = make_backup_id((self.clock)(), short_name(target), kind.as_str());
        let staging = Path::new(&self.config.staging_dir).join(&backup_id);
        let _ = fs::remove_dir_all(&staging).await;
        fs::create_dir_all(&self.config.staging_dir)
            .await
            .map_err(|error| EngineError::backup(error.to_string(), target, kind))?;

        let mut parent: Option<BackupManifest> = None;
        let mut incremental_from: Option<PathBuf> = None;
        let mut written: Vec<String> = Vec::new();

        let outcome = async {
            if kind == BackupKind::Delta {
                let summarize = self.scalar(cluster, "SHOW summarize_wal;").await?;
                if summarize != "on" {
                    return Err(EngineError::backup(
                        format!(
                            "a delta backup needs summarize_wal = on on the {} cluster (it is \"{summarize}\"); enable it or run a full backup",
                            target.as_str()
                        ),
                        target,
                        kind,
                    ));
                }
                let history = self.list_manifests(target).await?;
                parent = history.last().cloned();
                let Some(parent_manifest) = &parent else {
                    return Err(EngineError::backup(
                        "a delta backup needs a previous full backup of this target",
                        target,
                        kind,
                    ));
                };
                incremental_from = Some(self.parent_backup_manifest(target, parent_manifest).await?);
            }

            // The native restore handles the default tablespace layout only. Refuse BEFORE producing
            // a backup that looks fine and cannot be restored.
            let extra_tablespaces: u64 = self
                .scalar(
                    cluster,
                    "SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default', 'pg_global');",
                )
                .await?
                .parse()
                .unwrap_or(0);
            if extra_tablespaces > 0 {
                return Err(EngineError::backup(
                    format!(
                        "the {} cluster has {extra_tablespaces} non-default tablespace(s); the pg-native engine cannot restore them, so no backup was taken",
                        target.as_str()
                    ),
                    target,
                    kind,
                ));
            }

            run_tool(
                self.runner.as_ref(),
                &build_base_backup_command(
                    &self.config,
                    cluster,
                    &BaseBackupOptions {
                        destination: staging.clone(),
                        label: backup_id.clone(),
                        incremental_from: incremental_from.clone(),
                    },
                ),
                &format!("pg_basebackup ({})", target.as_str()),
            )
            .await
            .map_err(EngineError::Other)?;

            let mut names = Vec::new();
            let mut entries = fs::read_dir(&staging)
                .await
                .map_err(|error| EngineError::backup(error.to_string(), target, kind))?;
            while let Some(entry) = entries
                .next_entry()
                .await
                .map_err(|error| EngineError::backup(error.to_string(), target, kind))?
            {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
            let produced = unexpected_backup_files(&names);
            if !produced.is_empty() {
                return Err(EngineError::backup(
                    format!(
                        "pg_basebackup produced unexpected files ({}): extra tablespaces are not supported by the pg-native restore",
                        produced.iter().take(3).cloned().collect::<Vec<_>>().join(", ")
                    ),
                    target,
                    kind,
                ));
            }

            // Tar-format verification cannot parse WAL (pg_verifybackup needs -n); the restore drill
            // proves the WAL.
            let verify = run_tool(
                self.runner.as_ref(),
                &ToolCommand {
                    command: crate::pg_tools::pg_bin(&self.config, "pg_verifybackup"),
                    args: vec![
                        "--format=tar".to_owned(),
                        "--no-parse-wal".to_owned(),
                        staging.to_string_lossy().into_owned(),
                    ],
                    env: Vec::new(),
                    timeout_ms: self.config.command_timeout_ms,
                },
                &format!("pg_verifybackup ({})", target.as_str()),
            )
            .await
            .map_err(EngineError::Other)?;

            let manifest_text = fs::read_to_string(staging.join("backup_manifest"))
                .await
                .map_err(|error| EngineError::backup(error.to_string(), target, kind))?;
            let ranges = parse_wal_ranges(&manifest_text)
                .map_err(|error| EngineError::backup(error.to_string(), target, kind))?;
            let first = ranges.first();
            let last = ranges.last();

            let artifact_key = self.artifact_key(target, &backup_id);
            let artifact_tar = Path::new(&self.config.staging_dir).join(format!("{backup_id}.tar"));
            self.tar_create(&staging, &artifact_tar).await?;
            let sealed = Path::new(&self.config.staging_dir).join(format!("{backup_id}.tar.enc"));
            let seal = crate::crypto::seal_file(
                &artifact_tar,
                &sealed,
                &SealOptions::new(&self.master, target.as_str(), &backup_id),
            )
            .await
            .map_err(|error| EngineError::backup(error.to_string(), target, kind))?;
            let put = self
                .repository
                .put_file(&artifact_key, &sealed, None)
                .await
                .map_err(|error| EngineError::backup(error.message, target, kind));
            let _ = fs::remove_file(&artifact_tar).await;
            let _ = fs::remove_file(&sealed).await;
            let put = put?;
            written.push(artifact_key);

            // Keep this backup's manifest so the NEXT delta can be taken against it.
            write_file_atomic(
                &self
                    .state_dir()
                    .join(target.as_str())
                    .join(format!("{backup_id}.backup_manifest")),
                manifest_text.as_bytes(),
            )
            .await
            .map_err(|error| EngineError::backup(error.to_string(), target, kind))?;

            let mut dumps: Vec<LogicalDumpResult> = Vec::new();
            if kind == BackupKind::Full {
                let database = if target == BackupTarget::AuditDb {
                    self.config.pg_audit_db_name.clone()
                } else {
                    self.config.pg_primary_db_name.clone()
                };
                let dump = self
                    .dumper
                    .dump(cluster, &database, &backup_id)
                    .await
                    .map_err(|error| EngineError::backup(error, target, kind))?;
                written.push(dump.key.clone());
                dumps.push(dump);
            }

            let mut artifacts = std::collections::BTreeMap::new();
            for dump in &dumps {
                artifacts.insert(
                    dump.key.clone(),
                    ArtifactRecord {
                        sha256_ciphertext: dump.sha256_ciphertext.clone(),
                        bytes: dump.bytes,
                    },
                );
            }
            let mut storage_targets: Vec<String> = put.stored.clone();
            for dump in &dumps {
                storage_targets.extend(dump.storage_targets.clone());
            }
            storage_targets.sort();
            storage_targets.dedup();
            let manifest = sign_manifest(
                &BackupManifest {
                    schema_version: 2,
                    backup_id: backup_id.clone(),
                    target: target.as_str().to_owned(),
                    kind: kind.as_str().to_owned(),
                    engine: "pg-native".to_owned(),
                    cluster_topology: cluster_topology(&self.config).to_owned(),
                    started_at: started_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    completed_at: self
                        .primary_clock(cluster)
                        .await
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    start_lsn: first.map(|range| range.start_lsn.clone()),
                    end_lsn: last.map(|range| range.end_lsn.clone()),
                    wal_segment_start: first
                        .and_then(|range| lsn_to_segment_name(&range.start_lsn, range.timeline, crate::wal_names::DEFAULT_WAL_SEGMENT_BYTES)),
                    wal_segment_end: last
                        .and_then(|range| lsn_to_segment_name(&range.end_lsn, range.timeline, crate::wal_names::DEFAULT_WAL_SEGMENT_BYTES)),
                    parent_backup_id: parent.as_ref().map(|entry| entry.backup_id.clone()),
                    uncompressed_bytes: seal.uncompressed_bytes,
                    compressed_bytes: seal.compressed_bytes,
                    sha256_plaintext: seal.sha256_plaintext.clone(),
                    sha256_ciphertext: seal.sha256_ciphertext.clone(),
                    encryption: ManifestEncryption {
                        algorithm: "AES-256-GCM".to_owned(),
                        kdf: "HKDF-SHA256".to_owned(),
                        salt_hex: seal.salt_hex.clone(),
                        iv_hex: seal.iv_hex.clone(),
                        auth_tag_hex: seal.auth_tag_hex.clone(),
                    },
                    pg_verify_backup: Some(PgVerifyBackup {
                        verified: true,
                        manifest_checksum_algorithm: "SHA256".to_owned(),
                        detail: verify
                            .stdout
                            .trim()
                            .rsplit('\n')
                            .next()
                            .unwrap_or("backup successfully verified")
                            .to_owned(),
                    }),
                    artifacts: (!artifacts.is_empty()).then_some(artifacts),
                    storage_targets: storage_targets.clone(),
                    signature: None,
                },
                &self.master,
            )
            .map_err(|error| EngineError::backup(error.to_string(), target, kind))?;
            // The manifest is written LAST: until it exists the backup does not exist.
            let manifest_outcome = self
                .repository
                .put_buffer(
                    &self.manifest_key(target, &backup_id),
                    format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap_or_default())
                        .as_bytes(),
                    None,
                )
                .await
                .map_err(|error| EngineError::backup(error.message, target, kind))?;
            written.push(self.manifest_key(target, &backup_id));

            let mut all_targets = storage_targets;
            all_targets.extend(manifest_outcome.stored);
            all_targets.sort();
            all_targets.dedup();
            Ok::<BackupExecutionResult, EngineError>(BackupExecutionResult {
                size_bytes: Some(seal.compressed_bytes + dumps.iter().map(|dump| dump.bytes).sum::<u64>()),
                start_lsn: first.map(|range| range.start_lsn.clone()),
                end_lsn: last.map(|range| range.end_lsn.clone()),
                storage_targets: all_targets,
            })
        }
        .await;

        let _ = fs::remove_dir_all(&staging).await;
        match outcome {
            Ok(result) => Ok(result),
            Err(error) => {
                for key in written {
                    self.repository.delete(&key).await;
                }
                Err(error)
            }
        }
    }

    /// Path to the parent backup's `backup_manifest`, recovered from the artifact itself when local
    /// state is gone.
    async fn parent_backup_manifest(
        &self,
        target: BackupTarget,
        parent: &BackupManifest,
    ) -> Result<PathBuf, EngineError> {
        let local = self
            .state_dir()
            .join(target.as_str())
            .join(format!("{}.backup_manifest", parent.backup_id));
        if path_exists(&local).await {
            return Ok(local);
        }
        let work = Path::new(&self.config.staging_dir).join(format!("parent-{}", parent.backup_id));
        fs::create_dir_all(&work)
            .await
            .map_err(|error| EngineError::Other(error.to_string()))?;
        let outcome = async {
            let sealed = work.join("artifact.enc");
            self.repository
                .get_file(&self.artifact_key(target, &parent.backup_id), &sealed)
                .await
                .map_err(|error| EngineError::Store(error.to_string()))?;
            let plain = work.join("artifact.tar");
            crate::crypto::open_to_file(
                &sealed,
                &plain,
                &self.master,
                target.as_str(),
                &parent.backup_id,
                true,
            )
            .await
            .map_err(|error| EngineError::Other(error.to_string()))?;
            let extract = work.join("extract");
            self.tar_extract(&plain, &extract, Some("*backup_manifest"))
                .await?;
            let extracted = extract.join("backup_manifest");
            if !path_exists(&extracted).await {
                return Err(EngineError::Other(
                    "backup_manifest not found in the parent artifact".to_owned(),
                ));
            }
            let bytes = fs::read(&extracted)
                .await
                .map_err(|error| EngineError::Other(error.to_string()))?;
            write_file_atomic(&local, &bytes)
                .await
                .map_err(|error| EngineError::Other(error.to_string()))?;
            Ok::<(), EngineError>(())
        }
        .await;
        let _ = fs::remove_dir_all(&work).await;
        outcome.map(|()| local)
    }

    async fn backup_redis(&self, kind: BackupKind) -> Result<BackupExecutionResult, EngineError> {
        let snapshot = build_redis_snapshot_command(&self.config).ok_or_else(|| {
            EngineError::backup("REDIS_URL is not configured", BackupTarget::Redis, kind)
        })?;
        run_checked(self.runner.as_ref(), &snapshot, BackupTarget::Redis, kind).await?;
        let started_at = (self.clock)();
        let backup_id = make_backup_id(started_at, "redis", kind.as_str());
        let work = Path::new(&self.config.staging_dir).join(&backup_id);
        fs::create_dir_all(&work)
            .await
            .map_err(|error| EngineError::backup(error.to_string(), BackupTarget::Redis, kind))?;
        let dump = work.join("dump.rdb");
        let outcome = async {
            let rdb = build_redis_rdb_command(&self.config, &dump).ok_or_else(|| {
                EngineError::backup("REDIS_URL is not configured", BackupTarget::Redis, kind)
            })?;
            run_checked(self.runner.as_ref(), &rdb, BackupTarget::Redis, kind).await?;
            let key = format!("backups/redis/{backup_id}.rdb.enc");
            let sealed = work.join("dump.rdb.enc");
            let seal = crate::crypto::seal_file(
                &dump,
                &sealed,
                &SealOptions::new(&self.master, "redis", &backup_id),
            )
            .await
            .map_err(|error| EngineError::backup(error.to_string(), BackupTarget::Redis, kind))?;
            let put = self
                .repository
                .put_file(&key, &sealed, None)
                .await
                .map_err(|error| EngineError::backup(error.message, BackupTarget::Redis, kind))?;
            let manifest = sign_manifest(
                &BackupManifest {
                    schema_version: 2,
                    backup_id: backup_id.clone(),
                    target: "redis".to_owned(),
                    kind: kind.as_str().to_owned(),
                    engine: "pg-native".to_owned(),
                    cluster_topology: cluster_topology(&self.config).to_owned(),
                    started_at: started_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    completed_at: (self.clock)()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    start_lsn: None,
                    end_lsn: None,
                    wal_segment_start: None,
                    wal_segment_end: None,
                    parent_backup_id: None,
                    uncompressed_bytes: seal.uncompressed_bytes,
                    compressed_bytes: seal.compressed_bytes,
                    sha256_plaintext: seal.sha256_plaintext,
                    sha256_ciphertext: seal.sha256_ciphertext,
                    encryption: ManifestEncryption {
                        algorithm: "AES-256-GCM".to_owned(),
                        kdf: "HKDF-SHA256".to_owned(),
                        salt_hex: seal.salt_hex,
                        iv_hex: seal.iv_hex,
                        auth_tag_hex: seal.auth_tag_hex,
                    },
                    pg_verify_backup: None,
                    artifacts: None,
                    storage_targets: put.stored.clone(),
                    signature: None,
                },
                &self.master,
            )
            .map_err(|error| EngineError::backup(error.to_string(), BackupTarget::Redis, kind))?;
            self.repository
                .put_buffer(
                    &self.manifest_key(BackupTarget::Redis, &backup_id),
                    format!(
                        "{}\n",
                        serde_json::to_string_pretty(&manifest).unwrap_or_default()
                    )
                    .as_bytes(),
                    None,
                )
                .await
                .map_err(|error| EngineError::backup(error.message, BackupTarget::Redis, kind))?;
            let mut targets = vec!["redis".to_owned()];
            targets.extend(put.stored);
            Ok::<BackupExecutionResult, EngineError>(BackupExecutionResult {
                size_bytes: Some(seal.compressed_bytes),
                start_lsn: None,
                end_lsn: None,
                storage_targets: targets,
            })
        }
        .await;
        let _ = fs::remove_dir_all(&work).await;
        outcome
    }

    /// Run history rebuilt from the signed manifests in the repository. Used on a replacement host
    /// when no (valid) mirrored catalog exists.
    pub async fn reconstruct_runs(&self) -> Vec<BackupRun> {
        let mut runs = Vec::new();
        for target in [
            BackupTarget::PostgresCore,
            BackupTarget::AuditDb,
            BackupTarget::Redis,
        ] {
            let Ok(manifests) = self.list_manifests(target).await else {
                continue;
            };
            for manifest in manifests {
                let started = DateTime::parse_from_rfc3339(&manifest.started_at)
                    .map(|value| value.timestamp_millis())
                    .unwrap_or_default();
                let completed = DateTime::parse_from_rfc3339(&manifest.completed_at)
                    .map(|value| value.timestamp_millis())
                    .unwrap_or(started);
                runs.push(BackupRun {
                    id: manifest.backup_id.clone(),
                    target: manifest.target.clone(),
                    kind: manifest.kind.clone(),
                    engine: "pg-native".to_owned(),
                    status: "PASSED".to_owned(),
                    started_at: manifest.started_at.clone(),
                    completed_at: Some(manifest.completed_at.clone()),
                    duration_ms: Some(completed.saturating_sub(started).max(0) as u64),
                    size_bytes: Some(manifest.compressed_bytes),
                    start_lsn: manifest.start_lsn.clone(),
                    end_lsn: manifest.end_lsn.clone(),
                    storage_targets: manifest.storage_targets.clone(),
                    error_message: None,
                });
            }
        }
        runs.sort_by(|left, right| right.started_at.cmp(&left.started_at));
        runs
    }

    /// The newest verified backup that finished at or before `target_time`, and its chain back to a
    /// full backup.
    pub async fn resolve_chain(
        &self,
        target: BackupTarget,
        target_time: DateTime<Utc>,
    ) -> Result<Vec<BackupManifest>, EngineError> {
        let manifests = self.list_manifests(target).await?;
        let by_id: std::collections::BTreeMap<String, BackupManifest> = manifests
            .iter()
            .map(|manifest| (manifest.backup_id.clone(), manifest.clone()))
            .collect();
        let eligible: Vec<&BackupManifest> = manifests
            .iter()
            .filter(|manifest| {
                DateTime::parse_from_rfc3339(&manifest.completed_at)
                    .map(|value| value.timestamp_millis() <= target_time.timestamp_millis())
                    .unwrap_or(false)
            })
            .collect();
        let Some(head) = eligible.last() else {
            return Err(EngineError::Backup {
                message: if manifests.is_empty() {
                    format!(
                        "no verified {} backup exists in the repository",
                        target.as_str()
                    )
                } else {
                    format!(
                        "no {} backup completed before the recovery target time {}",
                        target.as_str(),
                        target_time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                    )
                },
                target: target.as_str().to_owned(),
                kind: "full".to_owned(),
            });
        };
        let mut chain = vec![(*head).clone()];
        let mut cursor = (*head).clone();
        while cursor.kind == "delta" {
            let parent = cursor
                .parent_backup_id
                .as_ref()
                .and_then(|id| by_id.get(id))
                .cloned();
            let Some(parent) = parent else {
                return Err(EngineError::Backup {
                    message: format!(
                        "backup {} depends on {}, which is missing or failed verification",
                        cursor.backup_id,
                        cursor
                            .parent_backup_id
                            .clone()
                            .unwrap_or_else(|| "an unknown parent".to_owned())
                    ),
                    target: target.as_str().to_owned(),
                    kind: "full".to_owned(),
                });
            };
            chain.insert(0, parent.clone());
            cursor = parent;
        }
        Ok(chain)
    }

    async fn copy_directory(source: &Path, destination: &Path) -> Result<(), EngineError> {
        fs::create_dir_all(destination)
            .await
            .map_err(|error| EngineError::Other(error.to_string()))?;
        let mut stack = vec![source.to_path_buf()];
        while let Some(directory) = stack.pop() {
            let relative = directory
                .strip_prefix(source)
                .map_err(|_| EngineError::Other("copy source escaped".to_owned()))?;
            let target = destination.join(relative);
            fs::create_dir_all(&target)
                .await
                .map_err(|error| EngineError::Other(error.to_string()))?;
            let mut entries = fs::read_dir(&directory)
                .await
                .map_err(|error| EngineError::Other(error.to_string()))?;
            while let Some(entry) = entries
                .next_entry()
                .await
                .map_err(|error| EngineError::Other(error.to_string()))?
            {
                let path = entry.path();
                let target = destination.join(
                    path.strip_prefix(source)
                        .map_err(|_| EngineError::Other("copy source escaped".to_owned()))?,
                );
                let metadata = entry
                    .metadata()
                    .await
                    .map_err(|error| EngineError::Other(error.to_string()))?;
                if metadata.is_dir() {
                    stack.push(path);
                } else {
                    fs::copy(&path, &target)
                        .await
                        .map_err(|error| EngineError::Other(error.to_string()))?;
                }
            }
        }
        Ok(())
    }

    async fn recover_physical(
        &self,
        request: &RecoverRequest,
    ) -> Result<RecoverResult, EngineError> {
        let target = request.target.as_backup_target();
        let target_time = if request.latest {
            (self.clock)()
        } else {
            request.target_time
        };
        let chain = self.resolve_chain(target, target_time).await?;
        let newest = chain
            .last()
            .map(|manifest| manifest.backup_id.clone())
            .unwrap_or_default();
        let work = Path::new(&self.config.staging_dir).join(format!("restore-{newest}"));
        let _ = fs::remove_dir_all(&work).await;
        fs::create_dir_all(&work)
            .await
            .map_err(|error| EngineError::Other(error.to_string()))?;

        let outcome = async {
            let mut extracted_dirs: Vec<PathBuf> = Vec::new();
            for manifest in &chain {
                let sealed = work.join(format!("{}.enc", manifest.backup_id));
                // Gate 1: the ciphertext must be exactly what the signed manifest recorded. A
                // damaged copy on one tier is skipped in favour of a verified copy on another.
                self.repository
                    .get_file_verified(
                        &self.artifact_key(target, &manifest.backup_id),
                        &sealed,
                        &manifest.sha256_ciphertext,
                    )
                    .await
                    .map_err(|error| EngineError::Store(error.to_string()))?;
                let dir = work.join(&manifest.backup_id);
                let plain = work.join(format!("{}.tar", manifest.backup_id));
                crate::crypto::open_to_file(
                    &sealed,
                    &plain,
                    &self.master,
                    target.as_str(),
                    &manifest.backup_id,
                    true,
                )
                .await
                .map_err(|error| EngineError::Other(error.to_string()))?;
                self.tar_extract(&plain, &dir, None).await?;
                let _ = fs::remove_file(&sealed).await;
                let _ = fs::remove_file(&plain).await;
                extracted_dirs.push(dir);
            }

            let mut data_dirs: Vec<PathBuf> = Vec::new();
            for dir in &extracted_dirs {
                let data = dir.join("data");
                fs::create_dir_all(&data)
                    .await
                    .map_err(|error| EngineError::Other(error.to_string()))?;
                self.tar_extract(&dir.join("base.tar"), &data, None).await?;
                fs::copy(dir.join("backup_manifest"), data.join("backup_manifest"))
                    .await
                    .map_err(|error| EngineError::Other(error.to_string()))?;
                data_dirs.push(data);
            }

            fs::create_dir_all(&request.target_dir)
                .await
                .map_err(|error| EngineError::Other(error.to_string()))?;
            if data_dirs.len() == 1 {
                Self::copy_directory(&data_dirs[0], &request.target_dir).await?;
            } else {
                // pg_combinebackup wants an empty (or new) output directory.
                let _ = fs::remove_dir_all(&request.target_dir).await;
                run_tool(
                    self.runner.as_ref(),
                    &build_combine_backup_command(&self.config, &data_dirs, &request.target_dir),
                    "pg_combinebackup",
                )
                .await
                .map_err(EngineError::Other)?;
            }
            // The WAL streamed during the NEWEST backup carries the restore to a consistent state.
            let newest_dir = extracted_dirs
                .last()
                .cloned()
                .ok_or_else(|| EngineError::Other("backup chain is empty".to_owned()))?;
            self.tar_extract(
                &newest_dir.join("pg_wal.tar"),
                &request.target_dir.join("pg_wal"),
                None,
            )
            .await?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(
                    &request.target_dir,
                    std::fs::Permissions::from_mode(0o700),
                )
                .await;
            }

            let escaped = pg_recovery_timestamp(request.target_time);
            let wal_target = if target == BackupTarget::AuditDb {
                WalTarget::AuditDb
            } else {
                WalTarget::PostgresCore
            };
            let binary =
                std::env::var("WAL_FETCH_BIN").unwrap_or_else(|_| "backup-daemon-rs".to_owned());
            let recovery_conf = format!(
                "restore_command = '{}'\n{}",
                build_restore_command(wal_target, "", &binary),
                if request.latest {
                    String::new()
                } else {
                    format!(
                        "recovery_target_time = '{escaped}'\nrecovery_target_action = 'promote'\n"
                    )
                }
            );
            Ok::<RecoverResult, EngineError>(RecoverResult {
                replayed_lsn: None,
                recovery_conf: Some(recovery_conf),
                initialized_empty_dir: false,
            })
        }
        .await;
        let _ = fs::remove_dir_all(&work).await;
        outcome
    }

    // -----------------------------------------------------------------------
    // retention
    // -----------------------------------------------------------------------

    async fn delete_backup(&self, target: BackupTarget, manifest: &BackupManifest) {
        let mut keys = vec![self.artifact_key(target, &manifest.backup_id)];
        if let Some(artifacts) = &manifest.artifacts {
            keys.extend(artifacts.keys().cloned());
        }
        for key in keys {
            self.repository.delete(&key).await;
        }
        // Delete the manifest LAST so a crash mid-way never leaves a manifest pointing at nothing.
        self.repository
            .delete(&self.manifest_key(target, &manifest.backup_id))
            .await;
        let _ = fs::remove_file(
            self.state_dir()
                .join(target.as_str())
                .join(format!("{}.backup_manifest", manifest.backup_id)),
        )
        .await;
    }

    async fn prune_target(&self, target: BackupTarget, policy: PolicyView) {
        let Ok(manifests) = self.list_manifests(target).await else {
            return;
        };
        let fulls: Vec<&BackupManifest> = manifests
            .iter()
            .filter(|manifest| manifest.kind == "full")
            .collect();
        if fulls.is_empty() {
            return;
        }
        let now = (self.clock)().timestamp_millis();
        let backup_cutoff = now - i64::from(policy.full_retention_days) * 86_400_000;
        let wal_cutoff = now - i64::from(policy.wal_retention_days) * 86_400_000;
        let newest_full = fulls
            .last()
            .map(|manifest| manifest.backup_id.clone())
            .unwrap_or_default();

        // A "chain" is a full backup plus the deltas taken against it; chains are kept or dropped
        // whole.
        let chain_of = |head: &BackupManifest| -> Vec<BackupManifest> {
            let mut members = vec![head.clone()];
            for manifest in &manifests {
                let mut cursor = Some(manifest.clone());
                while let Some(current) = cursor.clone() {
                    if current.kind != "delta" {
                        break;
                    }
                    cursor = current
                        .parent_backup_id
                        .as_ref()
                        .and_then(|id| manifests.iter().find(|entry| &entry.backup_id == id))
                        .cloned();
                }
                if let Some(root) = cursor {
                    if root.backup_id == head.backup_id && manifest.backup_id != head.backup_id {
                        members.push(manifest.clone());
                    }
                }
            }
            members
        };

        let mut keep: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for full in &fulls {
            let completed = DateTime::parse_from_rfc3339(&full.completed_at)
                .map(|value| value.timestamp_millis())
                .unwrap_or(0);
            if full.backup_id == newest_full || completed >= backup_cutoff {
                for member in chain_of(full) {
                    keep.insert(member.backup_id);
                }
            }
        }
        for manifest in &manifests {
            if !keep.contains(&manifest.backup_id) {
                self.delete_backup(target, manifest).await;
            }
        }

        // WAL: nothing older than the oldest retained base backup's first segment is needed.
        let oldest_start = manifests
            .iter()
            .filter(|manifest| keep.contains(&manifest.backup_id) && manifest.kind == "full")
            .filter_map(|manifest| {
                manifest.wal_segment_start.as_deref().and_then(|name| {
                    wal_segment_number(name, crate::wal_names::DEFAULT_WAL_SEGMENT_BYTES)
                })
            })
            .min();
        if let Some(oldest_start) = oldest_start {
            self.prune_wal(target, oldest_start, wal_cutoff).await;
        }
    }

    async fn prune_wal(&self, target: BackupTarget, oldest_start_segment: u64, age_cutoff_ms: i64) {
        let keys = self
            .repository
            .list(&format!("wal/{}", target.as_str()))
            .await;
        for key in keys {
            let name = key
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .trim_end_matches(".zst.enc")
                .to_owned();
            if name.ends_with(".history") {
                continue; // timeline history is tiny and always needed
            }
            let Some(number) = name.get(..24).and_then(|prefix| {
                wal_segment_number(prefix, crate::wal_names::DEFAULT_WAL_SEGMENT_BYTES)
            }) else {
                continue;
            };
            if number >= oldest_start_segment {
                continue;
            }
            if let Some(local) = self.repository.local() {
                if let Some(path) = local.local_path(&key) {
                    if let Ok(metadata) = fs::metadata(&path).await {
                        if let Ok(modified) = metadata.modified() {
                            let modified_ms: i64 = modified
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|duration| duration.as_millis() as i64)
                                .unwrap_or(0);
                            if modified_ms > age_cutoff_ms {
                                continue; // still inside the WAL retention window
                            }
                        }
                    }
                }
            }
            self.repository.delete(&key).await;
        }
    }
}

impl BackupEngine for PgNativeEngine {
    fn overview_health(&self) -> EngineFuture<'_, EngineHealth> {
        Box::pin(async move {
            let mut targets: Vec<BackupStorageTarget> = Vec::new();
            for store in self.repository.stores() {
                let health = store.health().await;
                targets.push(BackupStorageTarget {
                    id: store.id().to_owned(),
                    name: store.name().to_owned(),
                    kind: match store.kind() {
                        crate::artifacts::StoreKind::Local => "database".to_owned(),
                        other => other.as_str().to_owned(),
                    },
                    healthy: health.healthy,
                    detail: health.detail,
                });
            }
            targets.push(
                self.psql_target("postgres-primary", "PostgreSQL Primary", PgCluster::Core)
                    .await,
            );
            if is_audit_dedicated_cluster(&self.config) {
                targets.push(
                    self.psql_target(
                        "postgres-audit",
                        "PostgreSQL Audit Cluster",
                        PgCluster::Audit,
                    )
                    .await,
                );
            }
            if let Some(redis) = build_redis_ping_command(&self.config) {
                targets.push(
                    check_target(
                        self.runner.as_ref(),
                        "redis",
                        "Redis Snapshots",
                        "redis",
                        &redis,
                    )
                    .await,
                );
            }
            let wal = wal_health_for(&self.config, self.runner.as_ref()).await;
            let healthy = targets.iter().all(|target| target.healthy)
                && wal.archive_lag_seconds <= u64::from(self.config.alert_lag_seconds);
            Ok(EngineHealth {
                healthy,
                wal,
                targets,
            })
        })
    }

    fn trigger_backup(
        &self,
        target: BackupTarget,
        kind: BackupKind,
    ) -> EngineFuture<'_, BackupExecutionResult> {
        Box::pin(async move {
            let requested = expand_targets(&self.config, target);
            let mut storage_targets: Vec<String> = Vec::new();
            let mut size_bytes = 0_u64;
            let mut start_lsn: Option<String> = None;
            let mut end_lsn: Option<String> = None;
            for requested_target in requested {
                if requested_target == BackupTarget::Redis {
                    let redis = self.backup_redis(kind).await?;
                    storage_targets.extend(redis.storage_targets);
                    size_bytes += redis.size_bytes.unwrap_or(0);
                    continue;
                }
                if requested_target == BackupTarget::AuditDb
                    && !is_audit_dedicated_cluster(&self.config)
                {
                    let (targets, bytes, _skipped) = self
                        .dumper
                        .backup_shared_audit("pg-native", target == BackupTarget::All)
                        .await
                        .map_err(|error| EngineError::backup(error, target, kind))?;
                    storage_targets.extend(targets);
                    size_bytes += bytes;
                    continue;
                }
                let result = self.backup_physical(requested_target, kind).await?;
                storage_targets.extend(result.storage_targets);
                size_bytes += result.size_bytes.unwrap_or(0);
                if requested_target == BackupTarget::PostgresCore
                    || (start_lsn.is_none() && end_lsn.is_none())
                {
                    start_lsn = result.start_lsn.clone();
                    end_lsn = result.end_lsn.clone();
                }
            }
            storage_targets.sort();
            storage_targets.dedup();
            Ok(BackupExecutionResult {
                size_bytes: Some(size_bytes),
                start_lsn,
                end_lsn,
                storage_targets,
            })
        })
    }

    fn list_backups(
        &self,
        limit: usize,
        target: Option<BackupTarget>,
    ) -> EngineFuture<'_, Vec<BackupSummary>> {
        Box::pin(async move {
            let target = match target {
                Some(BackupTarget::All) | None => BackupTarget::PostgresCore,
                Some(target) => target,
            };
            let mut manifests = self.list_manifests(target).await?;
            manifests.reverse();
            Ok(manifests
                .into_iter()
                .take(limit)
                .map(|manifest| BackupSummary {
                    backup_id: manifest.backup_id,
                    started_at: manifest.started_at,
                    completed_at: Some(manifest.completed_at),
                    size_bytes: Some(manifest.compressed_bytes),
                    start_lsn: manifest.start_lsn,
                    end_lsn: manifest.end_lsn,
                })
                .collect())
        })
    }

    fn ingest_wal(
        &self,
        target: &str,
        file: &str,
        body: Vec<u8>,
        declared_length: Option<u64>,
    ) -> EngineFuture<'_, WalIngestOutcome> {
        let target = target.to_owned();
        let file = file.to_owned();
        Box::pin(async move {
            let result: IngestResult = self
                .wal_archive
                .ingest_stream(&target, &file, &body, declared_length)
                .await
                .map_err(EngineError::Wal)?;
            Ok(WalIngestOutcome {
                status: result.status,
                key: result.key,
                bytes: result.bytes,
            })
        })
    }

    fn recover(&self, request: RecoverRequest) -> EngineFuture<'_, RecoverResult> {
        Box::pin(async move { self.recover_physical(&request).await })
    }

    fn restore_logical(&self, request: RecoverLogicalRequest) -> EngineFuture<'_, (bool, String)> {
        Box::pin(async move { Ok(self.dumper.restore_latest(&request).await) })
    }

    fn prune(&self, target: BackupTarget, kind: Option<BackupKind>) -> EngineFuture<'_, ()> {
        Box::pin(async move {
            if kind.unwrap_or(BackupKind::Full) != BackupKind::Full {
                return Ok(());
            }
            let policy = self.policy.as_ref().map(|get| get()).unwrap_or(PolicyView {
                full_retention_days: self.config.retention_full_count * 7,
                wal_retention_days: self.config.retention_wal_days,
            });
            let targets = expand_targets(&self.config, target)
                .into_iter()
                .filter(|entry| *entry != BackupTarget::Redis);
            for entry in targets {
                if entry == BackupTarget::AuditDb && !is_audit_dedicated_cluster(&self.config) {
                    continue; // the shared audit database has no WAL-G/physical backup set to prune
                }
                self.prune_target(entry, policy).await;
            }
            Ok(())
        })
    }

    fn reconstruct_runs(&self) -> EngineFuture<'_, Vec<BackupRun>> {
        Box::pin(async move { Ok(self.reconstruct_runs().await) })
    }

    fn wal_status(&self) -> Option<Value> {
        let mut value =
            serde_json::to_value(self.wal_archive.state()).unwrap_or_else(|_| json!({}));
        if let Value::Object(map) = &mut value {
            map.insert("streams".to_owned(), json!([]));
            map.insert(
                "mirror".to_owned(),
                json!({
                    "pending": self.wal_archive.mirror.pending_count(),
                    "mirrored": self.wal_archive.mirror.mirrored(),
                    "lastError": self.wal_archive.mirror.last_error(),
                }),
            );
        }
        Some(value)
    }

    fn repository(&self) -> Option<Arc<ArtifactRepository>> {
        Some(Arc::clone(&self.repository))
    }

    fn start(&self) -> EngineFuture<'_, ()> {
        Box::pin(async {
            self.wal_archive.mirror.start(30_000);
            Ok(())
        })
    }

    fn stop(&self) -> EngineFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }

    fn supports_wal_ingest(&self) -> bool {
        true
    }
}

/// Persist a run patch (used by tests and the scheduler).
#[must_use]
pub fn patch_status(status: &str) -> RunPatch {
    RunPatch {
        status: Some(status.to_owned()),
        ..RunPatch::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unexpected_files_are_extra_tablespaces() {
        let names = vec![
            "base.tar".to_owned(),
            "pg_wal.tar".to_owned(),
            "backup_manifest".to_owned(),
        ];
        assert!(unexpected_backup_files(&names).is_empty());
        assert_eq!(
            unexpected_backup_files(&["16409.tar".to_owned()]),
            vec!["16409.tar".to_owned()]
        );
    }

    #[test]
    fn restore_command_quotes_for_postgresql_conf() {
        let command = build_restore_command(WalTarget::PostgresCore, "/bin/daemon", "wal-fetch");
        assert!(command.contains("wal-fetch postgres_core %f %p"));
    }
}
