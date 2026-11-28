//! Small shared helpers for `pgctl` (hashing, JSON, atomic files, paths).
//!
//! No crypto beyond SHA-256 and no floats: the deploy engine hashes files, writes them atomically
//! and keeps timestamps explicit so manifests and archives are reproducible.

#![forbid(unsafe_code)]

use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Lowercase hex of arbitrary bytes.
#[must_use]
pub fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Lowercase hex SHA-256 of a byte slice.
#[must_use]
pub fn sha256_bytes(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

/// Lowercase hex SHA-256 of a file (streamed, bounded memory).
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

/// Seconds since the Unix epoch, or 0 when the clock is before 1970.
#[must_use]
pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Keep `[A-Za-z0-9._-]`, replace everything else with `-`, collapse leading/trailing dashes.
#[must_use]
pub fn sanitize_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_owned();
    if trimmed.is_empty() {
        "unknown".to_owned()
    } else {
        trimmed
    }
}

/// Write a file atomically (temp file in the same directory, fsync, rename) with a mode.
pub fn write_atomic(path: &Path, data: &[u8], mode: u32) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    if !parent.as_os_str().is_empty() {
        std::fs::create_dir_all(parent)?;
    }
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_owned());
    let temp = parent.join(format!(".{name}.pgctl-tmp-{}", std::process::id()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(data)?;
        file.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(mode))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// Pretty JSON with a trailing newline (stable field order thanks to `serde_json/preserve_order`).
pub fn json_pretty<T: serde::Serialize>(value: &T) -> serde_json::Result<String> {
    let mut text = serde_json::to_string_pretty(value)?;
    text.push('\n');
    Ok(text)
}

/// Expand a leading `~` to `$HOME`; other paths are returned unchanged.
#[must_use]
pub fn expand_tilde(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_the_vectors() {
        assert_eq!(
            sha256_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_bytes(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sanitize_keeps_safe_characters() {
        assert_eq!(sanitize_component("2026.11.28"), "2026.11.28");
        assert_eq!(sanitize_component("v1/abc def"), "v1-abc-def");
        assert_eq!(sanitize_component("///"), "unknown");
    }

    #[test]
    fn atomic_write_sets_mode_and_replaces() {
        let dir = std::env::temp_dir().join(format!("pgctl-util-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("state.json");
        write_atomic(&path, b"one", 0o600).expect("write");
        write_atomic(&path, b"two", 0o600).expect("replace");
        assert_eq!(std::fs::read(&path).expect("read"), b"two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).expect("meta").permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn json_has_a_trailing_newline() {
        let value = serde_json::json!({"b": 1, "a": 2});
        let text = json_pretty(&value).expect("json");
        assert!(text.ends_with('\n'));
        assert!(text.starts_with('{'));
    }
}
