//! Release manifest and SBOM (D1-T01).
//!
//! `manifest.json` is the only authority on what a release contains: version, commit, target,
//! every file with its SHA-256/size/mode, the binary subset and the SBOM reference. The manifest is
//! deterministic except for `built_at_unix`, which honours `SOURCE_DATE_EPOCH`.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

/// Manifest schema version.
pub const MANIFEST_SCHEMA: u32 = 1;

/// One file inside the release.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    /// Path inside the archive (`bin/core-rs`, `rendered/plan.json`, ...).
    pub path: String,
    /// Lowercase hex SHA-256.
    pub sha256: String,
    /// Size in bytes.
    pub size: u64,
    /// Unix mode bits (e.g. 493 = 0755).
    pub mode: u32,
}

/// `manifest.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    /// Manifest schema.
    pub schema: u32,
    /// Release name (`pg-release`).
    pub name: String,
    /// Release version.
    pub version: String,
    /// Git commit (short).
    pub commit: String,
    /// Target triple or `arch-os` fallback.
    pub target: String,
    /// Build timestamp, from `SOURCE_DATE_EPOCH` when set.
    pub built_at_unix: u64,
    /// Binaries shipped (subset of `files`).
    pub binaries: Vec<FileEntry>,
    /// Every file in the archive except this manifest.
    pub files: Vec<FileEntry>,
    /// SBOM file name inside the archive.
    pub sbom: String,
    /// Minimum database schema this release can run against, when known.
    pub schema_min: Option<u32>,
    /// Maximum database schema this release can run against, when known.
    pub schema_max: Option<u32>,
}

impl Manifest {
    /// Release identifier used in directory and archive names.
    #[must_use]
    pub fn release_id(&self) -> String {
        format!(
            "{}-{}",
            crate::util::sanitize_component(&self.version),
            crate::util::sanitize_component(&self.commit)
        )
    }

    /// Archive file name.
    #[must_use]
    pub fn archive_name(&self) -> String {
        format!("pg-release-{}.tar.zst", self.release_id())
    }

    /// Look up a file by path.
    #[must_use]
    pub fn file(&self, path: &str) -> Option<&FileEntry> {
        self.files.iter().find(|entry| entry.path == path)
    }
}

/// SPDX-lite SBOM: one package per shipped binary with its checksum.
///
/// It is deliberately honest: it lists the release artefacts, not their transitive crates. A
/// `cargo-sbom`/`cargo-cyclonedx` document can replace it later without changing the manifest shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sbom {
    /// `SPDX-2.3`.
    pub spdx_version: String,
    /// `SPDXRef-DOCUMENT`.
    pub spdx_id: String,
    /// Document name.
    pub name: String,
    /// Version.
    pub version: String,
    /// Packages.
    pub packages: Vec<SbomPackage>,
}

/// One SBOM package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SbomPackage {
    /// Binary name.
    pub name: String,
    /// Release version.
    pub version: String,
    /// Lowercase hex SHA-256.
    pub checksum_sha256: String,
    /// Path inside the archive.
    pub file: String,
}

/// Build the SBOM for a release.
#[must_use]
pub fn sbom_for(version: &str, commit: &str, binaries: &[FileEntry]) -> Sbom {
    Sbom {
        spdx_version: "SPDX-2.3".to_owned(),
        spdx_id: "SPDXRef-DOCUMENT".to_owned(),
        name: format!("pg-release-{version}-{commit}"),
        version: version.to_owned(),
        packages: binaries
            .iter()
            .map(|entry| SbomPackage {
                name: entry
                    .path
                    .rsplit('/')
                    .next()
                    .unwrap_or(&entry.path)
                    .to_owned(),
                version: version.to_owned(),
                checksum_sha256: entry.sha256.clone(),
                file: entry.path.clone(),
            })
            .collect(),
    }
}

/// Validate that a manifest does not claim duplicate files or a missing SBOM entry.
pub fn validate_manifest(manifest: &Manifest) -> Result<(), String> {
    if manifest.schema != MANIFEST_SCHEMA {
        return Err(format!(
            "manifest schema {} is not supported (expected {MANIFEST_SCHEMA})",
            manifest.schema
        ));
    }
    if manifest.version.trim().is_empty() || manifest.commit.trim().is_empty() {
        return Err("manifest version and commit must not be empty".to_owned());
    }
    let mut seen = std::collections::BTreeSet::new();
    for entry in &manifest.files {
        if !seen.insert(entry.path.as_str()) {
            return Err(format!("duplicate file in manifest: {}", entry.path));
        }
        if entry.sha256.len() != 64 {
            return Err(format!("invalid sha256 for {}", entry.path));
        }
    }
    if manifest.file(&manifest.sbom).is_none() {
        return Err("manifest does not list its SBOM file".to_owned());
    }
    for binary in &manifest.binaries {
        if manifest.file(&binary.path).is_none() {
            return Err(format!("binary {} is not listed in files", binary.path));
        }
    }
    Ok(())
}

/// Load a manifest from a file.
pub fn load_manifest(path: &std::path::Path) -> Result<Manifest, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str) -> FileEntry {
        FileEntry {
            path: path.to_owned(),
            sha256: "a".repeat(64),
            size: 10,
            mode: 0o755,
        }
    }

    fn sample_manifest() -> Manifest {
        Manifest {
            schema: MANIFEST_SCHEMA,
            name: "pg-release".to_owned(),
            version: "2026.11.28".to_owned(),
            commit: "abc1234".to_owned(),
            target: "x86_64-unknown-linux-gnu".to_owned(),
            built_at_unix: 0,
            binaries: vec![entry("bin/core-rs")],
            files: vec![entry("bin/core-rs"), entry("sbom.json")],
            sbom: "sbom.json".to_owned(),
            schema_min: None,
            schema_max: None,
        }
    }

    #[test]
    fn release_names_are_sanitized() {
        let manifest = sample_manifest();
        assert_eq!(manifest.release_id(), "2026.11.28-abc1234");
        assert_eq!(
            manifest.archive_name(),
            "pg-release-2026.11.28-abc1234.tar.zst"
        );
    }

    #[test]
    fn validation_rejects_duplicates_and_missing_sbom() {
        let mut manifest = sample_manifest();
        assert!(validate_manifest(&manifest).is_ok());
        manifest.files.push(entry("sbom.json"));
        assert!(validate_manifest(&manifest).is_err());
        let mut manifest = sample_manifest();
        manifest.sbom = "missing.json".to_owned();
        assert!(validate_manifest(&manifest).is_err());
    }

    #[test]
    fn sbom_lists_every_binary() {
        let manifest = sample_manifest();
        let sbom = sbom_for(&manifest.version, &manifest.commit, &manifest.binaries);
        assert_eq!(sbom.spdx_version, "SPDX-2.3");
        assert_eq!(sbom.packages.len(), 1);
        assert_eq!(sbom.packages[0].name, "core-rs");
        assert_eq!(sbom.packages[0].checksum_sha256, "a".repeat(64));
    }
}
