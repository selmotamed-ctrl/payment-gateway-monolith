//! `wal-fetch` — `restore_command` for the pg-native backup repository.
//!
//! Port of the `wal-fetch` CLI of `deploy/backup-daemon` (chapter 9 P9-T03): PostgreSQL calls
//! `restore_command = 'wal-fetch <target> %f %p'` for every WAL segment it needs during recovery.
//! The contract is strict:
//!
//! - a missing archive file must exit non-zero so PostgreSQL can ask for another segment;
//! - `%p` must only appear complete: the copy is written to a temporary file, `fsync`ed and then
//!   atomically renamed, so a crashed recovery never leaves a truncated segment behind;
//! - nothing is printed on stdout (PostgreSQL ignores it); diagnostics go to stderr where the
//!   server log collects them;
//! - the SHA-256 of the copied segment is logged once, so an operator can match it against the
//!   backup manifest.
//!
//! Supported targets in this build:
//!
//! | Target | Behaviour |
//! | :--- | :--- |
//! | `/path`, `file:///path` | local directory; the archive is read from `<target>/<file>` |
//! | `s3://bucket/prefix` | `S3_NOT_CONFIGURED`, exit 3 (the S3 client lands with the backup daemon) |
//! | anything else | `UNSUPPORTED_TARGET`, exit 3 |

#![forbid(unsafe_code)]

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

/// Exit codes shared with the rest of the CLI family (chapter 3 §10).
pub const EXIT_OK: u8 = 0;
/// The segment could not be fetched (missing, unreadable, unsafe name).
pub const EXIT_FAILURE: u8 = 1;
/// The target needs a backend this build does not have.
pub const EXIT_PRECONDITION: u8 = 3;

/// Parsed archive target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// A local directory holding the WAL archive.
    Local(PathBuf),
    /// An S3 URL (not available in this build).
    S3(String),
    /// Any other scheme.
    Unsupported(String),
}

/// Parse the target argument.
#[must_use]
pub fn parse_target(raw: &str) -> Target {
    if let Some(rest) = raw.strip_prefix("file://") {
        return Target::Local(PathBuf::from(rest));
    }
    if raw.starts_with("s3://") {
        return Target::S3(raw.to_owned());
    }
    if raw.contains("://") {
        return Target::Unsupported(raw.to_owned());
    }
    Target::Local(PathBuf::from(raw))
}

/// True for a plain WAL file name: no separator, no parent directory, not absolute.
///
/// PostgreSQL passes `%f` (a file name such as `000000010000000000000001`, `00000002.history`,
/// `000000010000000000000001.partial` or a `.backup` file). Anything with a slash or `..` is
/// refused, so a malicious `%f` can never escape the archive directory.
#[must_use]
pub fn is_safe_wal_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 128 || name == "." || name == ".." {
        return false;
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return false;
    }
    if name.starts_with('.') {
        return false;
    }
    let path = Path::new(name);
    path.components()
        .all(|component| matches!(component, Component::Normal(_)))
}

/// A successful fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchOutcome {
    /// File that was requested.
    pub file: String,
    /// Where it was written.
    pub destination: PathBuf,
    /// Size in bytes.
    pub bytes: u64,
    /// Lowercase hex SHA-256 of the copied bytes.
    pub sha256: String,
}

/// Why a fetch failed.
#[derive(Debug)]
pub enum FetchError {
    /// The archive does not contain the segment (PostgreSQL will retry another one).
    NotFound {
        /// Path that was looked up.
        path: PathBuf,
    },
    /// The file name is not a plain WAL name.
    UnsafeName {
        /// Rejected name.
        file: String,
    },
    /// Any other IO failure, with the path that failed.
    Io {
        /// Path involved.
        path: PathBuf,
        /// Underlying error.
        source: std::io::Error,
    },
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound { path } => write!(f, "segment not found: {}", path.display()),
            Self::UnsafeName { file } => write!(f, "refusing unsafe WAL file name '{file}'"),
            Self::Io { path, source } => write!(f, "{}: {source}", path.display()),
        }
    }
}

impl std::error::Error for FetchError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// Copy `<target>/<file>` to `destination` through a temporary file and an atomic rename.
///
/// Port of the local `restore_command` path of `deploy/backup-daemon` (P9-T03).
pub fn fetch_local(
    target: &Path,
    file: &str,
    destination: &Path,
) -> Result<FetchOutcome, FetchError> {
    if !is_safe_wal_name(file) {
        return Err(FetchError::UnsafeName {
            file: file.to_owned(),
        });
    }
    let source = target.join(file);
    let mut input = match std::fs::File::open(&source) {
        Ok(input) => input,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(FetchError::NotFound { path: source })
        }
        Err(source_error) => {
            return Err(FetchError::Io {
                path: source,
                source: source_error,
            })
        }
    };

    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let temp_name = format!(
        ".{}.wal-fetch-{}-{}",
        destination
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "segment".to_owned()),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    );
    let temp = parent.join(temp_name);

    let result = copy_and_sync(&mut input, &temp);
    let (bytes, sha256) = match result {
        Ok(result) => result,
        Err(source_error) => {
            let _ = std::fs::remove_file(&temp);
            return Err(FetchError::Io {
                path: temp,
                source: source_error,
            });
        }
    };
    if let Err(source_error) = std::fs::rename(&temp, destination) {
        let _ = std::fs::remove_file(&temp);
        return Err(FetchError::Io {
            path: destination.to_path_buf(),
            source: source_error,
        });
    }
    Ok(FetchOutcome {
        file: file.to_owned(),
        destination: destination.to_path_buf(),
        bytes,
        sha256,
    })
}

fn copy_and_sync(input: &mut std::fs::File, temp: &Path) -> std::io::Result<(u64, String)> {
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        std::io::Write::write_all(&mut output, &buffer[..read])?;
        total += read as u64;
    }
    output.sync_all()?;
    // Hex-encode the digest; hashing it again would produce SHA-256(SHA-256(data)).
    Ok((total, hex_lower(&hasher.finalize())))
}

/// Lowercase hex of arbitrary bytes (the `hex` crate is not a dependency of this binary).
fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Lowercase hex SHA-256 of `bytes`. Test helper: the copy path hashes incrementally.
#[cfg(test)]
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

/// Render the one-line success diagnostic (stderr; stdout stays empty for `restore_command`).
#[must_use]
pub fn success_line(outcome: &FetchOutcome) -> String {
    format!(
        "wal-fetch: {} -> {} sha256={} bytes={}",
        outcome.file,
        outcome.destination.display(),
        outcome.sha256,
        outcome.bytes
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let unique = format!(
            "wal-fetch-{}-{}-{label}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn targets_are_parsed() {
        assert_eq!(
            parse_target("/var/lib/pg-backup/repo/wal"),
            Target::Local(PathBuf::from("/var/lib/pg-backup/repo/wal"))
        );
        assert_eq!(
            parse_target("file:///var/lib/pg-backup/repo/wal"),
            Target::Local(PathBuf::from("/var/lib/pg-backup/repo/wal"))
        );
        assert_eq!(
            parse_target("s3://pg-backups/prod/wal"),
            Target::S3("s3://pg-backups/prod/wal".to_owned())
        );
        assert_eq!(
            parse_target("https://example.invalid/wal"),
            Target::Unsupported("https://example.invalid/wal".to_owned())
        );
    }

    #[test]
    fn wal_names_are_restricted_to_a_single_component() {
        for name in [
            "000000010000000000000001",
            "000000010000000000000001.partial",
            "00000002.history",
            "000000010000000000000001.00000028.backup",
        ] {
            assert!(is_safe_wal_name(name), "{name}");
        }
        for name in [
            "",
            ".",
            "..",
            "../etc/passwd",
            "/etc/passwd",
            "a/b",
            ".hidden",
            "a\\b",
        ] {
            assert!(!is_safe_wal_name(name), "{name}");
        }
    }

    #[test]
    fn sha256_matches_the_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn a_segment_is_copied_atomically_and_hashed() {
        let dir = temp_dir("copy");
        let archive = dir.join("wal");
        let destination_dir = dir.join("pg_wal");
        std::fs::create_dir_all(&archive).expect("archive");
        std::fs::create_dir_all(&destination_dir).expect("destination");
        let payload = vec![0xABu8; 200_000];
        std::fs::write(archive.join("000000010000000000000001"), &payload).expect("segment");

        let destination = destination_dir.join("000000010000000000000001");
        let outcome =
            fetch_local(&archive, "000000010000000000000001", &destination).expect("fetched");
        assert_eq!(outcome.bytes, payload.len() as u64);
        assert_eq!(outcome.sha256, sha256_hex(&payload));
        assert_eq!(std::fs::read(&destination).expect("read"), payload);
        // No temporary file survived.
        let leftovers: Vec<_> = std::fs::read_dir(&destination_dir)
            .expect("list")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("wal-fetch"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        assert!(success_line(&outcome).contains("sha256="));
    }

    #[test]
    fn an_existing_destination_is_replaced() {
        let dir = temp_dir("replace");
        let archive = dir.join("wal");
        let destination_dir = dir.join("pg_wal");
        std::fs::create_dir_all(&archive).expect("archive");
        std::fs::create_dir_all(&destination_dir).expect("destination");
        std::fs::write(archive.join("00000002.history"), b"new").expect("segment");
        let destination = destination_dir.join("00000002.history");
        std::fs::write(&destination, b"old").expect("old");
        let outcome = fetch_local(&archive, "00000002.history", &destination).expect("fetched");
        assert_eq!(outcome.bytes, 3);
        assert_eq!(std::fs::read(&destination).expect("read"), b"new");
    }

    #[test]
    fn a_missing_segment_fails_without_creating_the_destination() {
        let dir = temp_dir("missing");
        let archive = dir.join("wal");
        let destination_dir = dir.join("pg_wal");
        std::fs::create_dir_all(&archive).expect("archive");
        std::fs::create_dir_all(&destination_dir).expect("destination");
        let destination = destination_dir.join("000000010000000000000002");
        let error =
            fetch_local(&archive, "000000010000000000000002", &destination).expect_err("missing");
        assert!(matches!(error, FetchError::NotFound { .. }));
        assert!(!destination.exists());
    }

    #[test]
    fn unsafe_names_are_refused_before_touching_the_filesystem() {
        let dir = temp_dir("unsafe");
        let destination = dir.join("segment");
        let error = fetch_local(&dir, "../../etc/passwd", &destination).expect_err("unsafe");
        assert!(matches!(error, FetchError::UnsafeName { .. }));
        assert!(!destination.exists());
    }

    #[test]
    fn a_missing_destination_directory_is_an_io_error() {
        let dir = temp_dir("no-dest-dir");
        let archive = dir.join("wal");
        std::fs::create_dir_all(&archive).expect("archive");
        std::fs::write(archive.join("00000003.history"), b"x").expect("segment");
        let error = fetch_local(
            &archive,
            "00000003.history",
            &dir.join("missing-dir/segment"),
        )
        .expect_err("destination directory missing");
        assert!(matches!(error, FetchError::Io { .. }));
    }

    #[test]
    fn an_empty_segment_is_copied() {
        let dir = temp_dir("empty");
        let archive = dir.join("wal");
        std::fs::create_dir_all(&archive).expect("archive");
        std::fs::write(archive.join("00000004.history"), b"").expect("segment");
        let destination = dir.join("00000004.history");
        let outcome = fetch_local(&archive, "00000004.history", &destination).expect("fetched");
        assert_eq!(outcome.bytes, 0);
        assert_eq!(outcome.sha256, sha256_hex(b""));
    }
}
