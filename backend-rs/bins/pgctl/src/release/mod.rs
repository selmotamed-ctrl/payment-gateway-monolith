//! Release artefacts: build, manifest, SBOM, minisign signature (D1-T01).
//!
//! Port of the release concept in chapter 7 §10: `pg-release-<version>-<git sha>.tar.zst` with
//! `bin/*`, rendered configuration, `manifest.json` and `sbom.json`, signed with minisign.
//! The archive itself is produced with the system `tar`/`zstd` (deterministic flags); signing and
//! verification use the `minisign` crate, never the external binary.

#![forbid(unsafe_code)]

pub mod build;
pub mod manifest;
pub mod sign;

use std::fmt;

pub use build::{build, BuildOptions};
pub use manifest::load_manifest;
pub use sign::{sign_file, verify_file};

/// Release errors. Messages never contain key material.
#[derive(Debug)]
pub enum ReleaseError {
    /// File IO.
    Io {
        /// Path involved.
        path: String,
        /// Underlying error.
        source: std::io::Error,
    },
    /// A binary the manifest promises is missing from the build directory.
    MissingBinary(String),
    /// A required external tool (`tar`, `zstd`) is not installed.
    ToolMissing(&'static str),
    /// An external command failed.
    CommandFailed {
        /// Program name.
        program: String,
        /// Exit status.
        status: Option<i32>,
        /// Redacted stderr tail.
        stderr: String,
    },
    /// JSON (de)serialisation failed.
    Json(String),
    /// Manifest validation failed.
    Manifest(String),
    /// Signing failed.
    Sign(String),
    /// Verification failed.
    Verify(String),
}

impl ReleaseError {
    /// Wrap an IO error with its path.
    #[must_use]
    pub fn io(path: impl fmt::Display, source: std::io::Error) -> Self {
        Self::Io {
            path: path.to_string(),
            source,
        }
    }
}

impl fmt::Display for ReleaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "{path}: {source}"),
            Self::MissingBinary(name) => write!(
                f,
                "release binary '{name}' is missing from the build directory"
            ),
            Self::ToolMissing(tool) => write!(
                f,
                "'{tool}' is required for release archives but is not installed"
            ),
            Self::CommandFailed {
                program,
                status,
                stderr,
            } => write!(
                f,
                "{program} failed (status {}){}{}",
                status.map_or_else(|| "signal".to_owned(), |code| code.to_string()),
                if stderr.is_empty() { "" } else { ": " },
                stderr
            ),
            Self::Json(message) => write!(f, "release JSON: {message}"),
            Self::Manifest(message) => write!(f, "release manifest: {message}"),
            Self::Sign(message) => write!(f, "release signature: {message}"),
            Self::Verify(message) => write!(f, "release verification: {message}"),
        }
    }
}

impl std::error::Error for ReleaseError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<serde_json::Error> for ReleaseError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error.to_string())
    }
}
