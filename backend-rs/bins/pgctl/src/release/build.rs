//! `pgctl release build`: staged release tree, manifest, SBOM and deterministic tar.zst.

#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use pg_deploy_config::{ImplKind, PgctlConfig};
use pg_deploy_plan::{plan, render_systemd_unit, route_table_json, workers_json, WorkerTarget};

use crate::release::manifest::{sbom_for, validate_manifest, FileEntry, Manifest, MANIFEST_SCHEMA};
use crate::release::ReleaseError;
use crate::util;

/// Binaries shipped in every release (chapter 7 §10).
pub const RELEASE_BINARIES: &[&str] = &[
    "core-rs",
    "admin-edge",
    "merchant-edge",
    "checkout-edge",
    "fake-rails-rs",
    "backup-daemon-rs",
    "object-storage-daemon-rs",
    "pgctl",
    "wal-fetch",
];

/// Inputs of `release build`.
#[derive(Debug, Clone)]
pub struct BuildOptions {
    /// Output directory (archive, manifest, checksum).
    pub out_dir: PathBuf,
    /// Directory holding the compiled binaries (usually `target/release`).
    pub bin_dir: PathBuf,
    /// Release version.
    pub version: String,
    /// Git commit (short).
    pub commit: String,
    /// Target triple or `arch-os`.
    pub target: String,
    /// Build timestamp (SOURCE_DATE_EPOCH when set).
    pub built_at_unix: u64,
    /// Optional configuration used to render the plan, route table, workers and units.
    pub config: Option<PgctlConfig>,
    /// Which implementation owns the workers in the rendered handover document.
    pub workers_target: WorkerTarget,
}

/// Result of a build.
#[derive(Debug, Clone)]
pub struct BuildOutput {
    /// Archive path.
    pub archive: PathBuf,
    /// Manifest that was embedded.
    pub manifest: Manifest,
    /// Manifest copied next to the archive.
    pub manifest_path: PathBuf,
    /// Archive SHA-256.
    pub checksum: String,
    /// `<archive>.sha256` path.
    pub checksum_path: PathBuf,
}

/// Build a release archive.
pub fn build(options: &BuildOptions) -> Result<BuildOutput, ReleaseError> {
    std::fs::create_dir_all(&options.out_dir)
        .map_err(|error| ReleaseError::io(options.out_dir.display(), error))?;
    let staging = tempfile::Builder::new()
        .prefix("pgctl-release-")
        .tempdir()
        .map_err(|error| ReleaseError::io("temporary staging directory", error))?;

    // 1. Binaries.
    let bin_dir = staging.path().join("bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|error| ReleaseError::io(bin_dir.display(), error))?;
    for name in RELEASE_BINARIES {
        let source = options.bin_dir.join(name);
        if !source.is_file() {
            return Err(ReleaseError::MissingBinary((*name).to_owned()));
        }
        let target = bin_dir.join(name);
        std::fs::copy(&source, &target)
            .map_err(|error| ReleaseError::io(source.display(), error))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
                .map_err(|error| ReleaseError::io(target.display(), error))?;
        }
    }

    // 2. Rendered configuration (optional).
    if let Some(config) = &options.config {
        render_configuration(config, staging.path(), options.workers_target)?;
    }

    // 3. SBOM.
    let sbom_path = staging.path().join("sbom.json");
    // Binaries are collected first so the SBOM can list their hashes.
    let binaries = collect_entries(staging.path(), "bin")?;
    let sbom = sbom_for(&options.version, &options.commit, &binaries);
    let sbom_text = util::json_pretty(&sbom)?;
    util::write_atomic(&sbom_path, sbom_text.as_bytes(), 0o644)
        .map_err(|error| ReleaseError::io(sbom_path.display(), error))?;

    // 4. Manifest.
    let files = collect_entries(staging.path(), "")?;
    let manifest = Manifest {
        schema: MANIFEST_SCHEMA,
        name: "pg-release".to_owned(),
        version: options.version.clone(),
        commit: options.commit.clone(),
        target: options.target.clone(),
        built_at_unix: options.built_at_unix,
        binaries,
        files,
        sbom: "sbom.json".to_owned(),
        schema_min: None,
        schema_max: None,
    };
    validate_manifest(&manifest).map_err(ReleaseError::Manifest)?;
    let manifest_text = util::json_pretty(&manifest)?;
    util::write_atomic(
        &staging.path().join("manifest.json"),
        manifest_text.as_bytes(),
        0o644,
    )
    .map_err(|error| ReleaseError::io("manifest.json", error))?;

    // 5. Archive.
    let archive = options.out_dir.join(manifest.archive_name());
    create_archive(staging.path(), &archive, options.built_at_unix)?;

    // 6. Manifest and checksum next to the archive (used by `deploy` and `rollback`).
    let manifest_path = options.out_dir.join("manifest.json");
    std::fs::write(&manifest_path, manifest_text.as_bytes())
        .map_err(|error| ReleaseError::io(manifest_path.display(), error))?;
    let checksum =
        util::sha256_file(&archive).map_err(|error| ReleaseError::io(archive.display(), error))?;
    let checksum_path = PathBuf::from(format!("{}.sha256", archive.display()));
    let checksum_text = format!(
        "{checksum}  {}\n",
        archive
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    );
    util::write_atomic(&checksum_path, checksum_text.as_bytes(), 0o644)
        .map_err(|error| ReleaseError::io(checksum_path.display(), error))?;

    Ok(BuildOutput {
        archive,
        manifest,
        manifest_path,
        checksum,
        checksum_path,
    })
}

fn render_configuration(
    config: &PgctlConfig,
    staging: &Path,
    workers_target: WorkerTarget,
) -> Result<(), ReleaseError> {
    let rendered = staging.join("rendered");
    std::fs::create_dir_all(&rendered)
        .map_err(|error| ReleaseError::io(rendered.display(), error))?;
    let desired = plan(config);

    let plan_text = util::json_pretty(&desired)?;
    util::write_atomic(&rendered.join("plan.json"), plan_text.as_bytes(), 0o644)
        .map_err(|error| ReleaseError::io("rendered/plan.json", error))?;

    let routes = route_table_json(config, &desired)?;
    util::write_atomic(&rendered.join("route-table.json"), routes.as_bytes(), 0o644)
        .map_err(|error| ReleaseError::io("rendered/route-table.json", error))?;

    let workers = workers_json(config, workers_target)?;
    util::write_atomic(&rendered.join("workers.json"), workers.as_bytes(), 0o644)
        .map_err(|error| ReleaseError::io("rendered/workers.json", error))?;

    let units = rendered.join("units");
    std::fs::create_dir_all(&units).map_err(|error| ReleaseError::io(units.display(), error))?;
    for service in desired
        .services
        .iter()
        .filter(|service| service.impl_ == ImplKind::Rs)
    {
        let unit = render_systemd_unit(service);
        let path = units.join(format!("{}.service", service.systemd_unit));
        util::write_atomic(&path, unit.as_bytes(), 0o644)
            .map_err(|error| ReleaseError::io(path.display(), error))?;
    }
    Ok(())
}

fn collect_entries(root: &Path, prefix: &str) -> Result<Vec<FileEntry>, ReleaseError> {
    let base = if prefix.is_empty() {
        root.to_path_buf()
    } else {
        root.join(prefix)
    };
    let mut entries = Vec::new();
    if !base.is_dir() {
        return Ok(entries);
    }
    for entry in walkdir::WalkDir::new(&base)
        .sort_by_file_name()
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path().to_path_buf();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| {
                ReleaseError::Manifest(format!("{} is outside the staging tree", path.display()))
            })?
            .to_string_lossy()
            .replace('\\', "/");
        let metadata =
            std::fs::metadata(&path).map_err(|error| ReleaseError::io(path.display(), error))?;
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o777
        };
        #[cfg(not(unix))]
        let mode = 0o644;
        entries.push(FileEntry {
            path: relative,
            sha256: util::sha256_file(&path)
                .map_err(|error| ReleaseError::io(path.display(), error))?,
            size: metadata.len(),
            mode,
        });
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

fn create_archive(staging: &Path, archive: &Path, mtime: u64) -> Result<(), ReleaseError> {
    let mtime_arg = format!("--mtime=@{mtime}");
    let mut tar = Command::new("tar")
        .args([
            "--sort=name",
            mtime_arg.as_str(),
            "--owner=0",
            "--group=0",
            "--numeric-owner",
            "--format=gnu",
            "-C",
        ])
        .arg(staging)
        .args(["-cf", "-", "."])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => ReleaseError::ToolMissing("tar"),
            _ => ReleaseError::io("tar", error),
        })?;
    let stdout = tar
        .stdout
        .take()
        .ok_or_else(|| ReleaseError::CommandFailed {
            program: "tar".to_owned(),
            status: None,
            stderr: "no stdout pipe".to_owned(),
        })?;
    let zstd_status = Command::new("zstd")
        .args(["-q", "-19", "-f", "--no-progress", "-o"])
        .arg(archive)
        .stdin(Stdio::from(stdout))
        .status()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => ReleaseError::ToolMissing("zstd"),
            _ => ReleaseError::io("zstd", error),
        })?;
    let tar_output = tar
        .wait_with_output()
        .map_err(|error| ReleaseError::io("tar", error))?;
    if !tar_output.status.success() {
        let _ = std::fs::remove_file(archive);
        let stderr = String::from_utf8_lossy(&tar_output.stderr);
        return Err(ReleaseError::CommandFailed {
            program: "tar".to_owned(),
            status: tar_output.status.code(),
            stderr: redact_tail(&stderr),
        });
    }
    if !zstd_status.success() {
        return Err(ReleaseError::CommandFailed {
            program: "zstd".to_owned(),
            status: zstd_status.code(),
            stderr: String::new(),
        });
    }
    Ok(())
}

fn redact_tail(text: &str) -> String {
    crate::redact::redact_line(text.lines().last().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pg_deploy_config::Environment;

    fn tool(name: &str) -> bool {
        Command::new(name)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn fake_bin_dir(root: &Path) {
        std::fs::create_dir_all(root).expect("bin dir");
        for name in RELEASE_BINARIES {
            std::fs::write(root.join(name), format!("#!/bin/true\n# {name}\n")).expect("binary");
        }
    }

    fn options(root: &Path, out: &Path, config: Option<PgctlConfig>) -> BuildOptions {
        BuildOptions {
            out_dir: out.to_path_buf(),
            bin_dir: root.join("bin"),
            version: "2026.11.28".to_owned(),
            commit: "abc1234".to_owned(),
            target: "x86_64-unknown-linux-gnu".to_owned(),
            built_at_unix: 0,
            config,
            workers_target: WorkerTarget::Rs,
        }
    }

    fn demo_config() -> PgctlConfig {
        let mut config = PgctlConfig::new(Environment::Development);
        config.deployment.name = "release-test".to_owned();
        config.services.core.implementation = ImplKind::Both;
        config.hosts.push(pg_deploy_config::Host {
            name: "core-1".to_owned(),
            address: "10.0.0.11".to_owned(),
            roles: vec![pg_deploy_config::Role::Core],
            private_ip: "10.0.0.11".to_owned(),
            ..pg_deploy_config::Host::default()
        });
        config
    }

    #[test]
    fn a_release_without_config_has_binaries_sbom_and_manifest() {
        let dir = tempfile::tempdir().expect("tempdir");
        fake_bin_dir(&dir.path().join("bin"));
        let out = dir.path().join("out");
        let output = build(&options(dir.path(), &out, None)).expect("build");
        assert!(output.archive.is_file());
        assert!(output.manifest_path.is_file());
        assert!(output.checksum_path.is_file());
        assert_eq!(output.manifest.binaries.len(), RELEASE_BINARIES.len());
        assert!(output.manifest.file("bin/core-rs").is_some());
        assert!(output.manifest.file("sbom.json").is_some());
        assert!(output.manifest.file("rendered/plan.json").is_none());
        assert_eq!(output.manifest.built_at_unix, 0);
        validate_manifest(&output.manifest).expect("valid manifest");
        assert_eq!(
            std::fs::read_to_string(&output.checksum_path)
                .expect("checksum")
                .split_whitespace()
                .next(),
            Some(output.checksum.as_str())
        );
    }

    #[test]
    fn a_release_with_config_renders_plan_routes_workers_and_units() {
        let dir = tempfile::tempdir().expect("tempdir");
        fake_bin_dir(&dir.path().join("bin"));
        let out = dir.path().join("out");
        let output = build(&options(dir.path(), &out, Some(demo_config()))).expect("build");
        for path in [
            "rendered/plan.json",
            "rendered/route-table.json",
            "rendered/workers.json",
            "rendered/units/pg-core-back-rs.service",
        ] {
            assert!(output.manifest.file(path).is_some(), "{path} is missing");
        }
        // The TypeScript core has no Rust unit; only `impl = rs` services get one.
        assert!(output
            .manifest
            .file("rendered/units/pg-core-back.service")
            .is_none());
    }

    #[test]
    fn archives_are_byte_identical_for_the_same_epoch() {
        if !tool("tar") || !tool("zstd") {
            eprintln!("tar/zstd not installed; archive determinism test skipped");
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        fake_bin_dir(&dir.path().join("bin"));
        let first = build(&options(
            dir.path(),
            &dir.path().join("a"),
            Some(demo_config()),
        ))
        .expect("first");
        let second = build(&options(
            dir.path(),
            &dir.path().join("b"),
            Some(demo_config()),
        ))
        .expect("second");
        assert_eq!(first.checksum, second.checksum, "archives differ");
        assert_eq!(first.manifest.files, second.manifest.files);
    }

    #[test]
    fn a_missing_binary_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        fake_bin_dir(&dir.path().join("bin"));
        std::fs::remove_file(dir.path().join("bin/core-rs")).expect("remove");
        let error =
            build(&options(dir.path(), &dir.path().join("out"), None)).expect_err("missing binary");
        assert!(matches!(error, ReleaseError::MissingBinary(name) if name == "core-rs"));
    }
}
