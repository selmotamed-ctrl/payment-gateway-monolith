//! Secret redaction for everything `pgctl` prints.
//!
//! The port rule is absolute (`AGENTS.md`, chapter 3 §10): no command may print a secret value.
//! `pgctl` mostly prints key *names* (the importer never copies a value), but verbose logs and
//! operator-facing diagnostics still go through this filter as defence in depth.

#![forbid(unsafe_code)]

/// Words that make a key name a secret (case insensitive), per the CLI contract.
const SECRET_WORDS: &[&str] = &["KEY", "SECRET", "PASSWORD", "TOKEN"];

/// Suffixes that describe *where* or *which* thing, not a secret value, so operators still see
/// them (`SSH_KEY_PATH`, `KMS_MASTER_KEY_ID`, `BACKUP_ENCRYPTION_KEY_DIR`).
const NON_SECRET_SUFFIXES: &[&str] = &[
    "_PATH", "_DIR", "_ID", "_NAME", "_MODE", "_VERSION", "_COUNT",
];

/// True when a key name holds a secret value.
#[must_use]
pub fn is_secret_name(name: &str) -> bool {
    let upper = name.trim().to_ascii_uppercase();
    if upper.is_empty() {
        return false;
    }
    if NON_SECRET_SUFFIXES
        .iter()
        .any(|suffix| upper.ends_with(suffix))
    {
        return false;
    }
    SECRET_WORDS.iter().any(|word| upper.contains(word))
}

/// The replacement marker. It must never be mistakable for a real value.
pub const REDACTED: &str = "***";

/// Redact `KEY=value` pairs inside one line.
///
/// Only the `KEY=value` form is treated as a value: problem messages use `code: message` prose, and
/// redacting a colon would mangle them (they never carry a value in the first place). A line may
/// carry several pairs (`env DB_PASSWORD=x TOKEN=y`).
#[must_use]
pub fn redact_line(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while !rest.is_empty() {
        let (candidate, tail) =
            match rest.find(|ch: char| ch.is_whitespace() || ch == ',' || ch == ';') {
                Some(index) => (&rest[..index], &rest[index..]),
                None => (rest, ""),
            };
        if let Some((key, _value)) = candidate.split_once('=') {
            if is_secret_name(key) {
                out.push_str(key);
                out.push('=');
                out.push_str(REDACTED);
            } else {
                out.push_str(candidate);
            }
        } else {
            out.push_str(candidate);
        }
        if let Some(separator) = tail.chars().next() {
            out.push(separator);
            rest = &tail[separator.len_utf8()..];
        } else {
            rest = "";
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_names_are_detected() {
        for name in [
            "DB_PASSWORD",
            "KMS_MASTER_KEY",
            "KMS_MASTER_KEY_HEX",
            "FAKE_RAILS_JWT_SECRET",
            "FAKE_RAILS_SEEDER_TOKEN",
            "OBJECT_STORAGE_KEK_KEYRING",
            "API_TOKEN",
            "ACCESS_SECRET",
        ] {
            assert!(is_secret_name(name), "{name}");
        }
    }

    #[test]
    fn paths_and_identifiers_are_not_secrets() {
        for name in [
            "SSH_KEY_PATH",
            "PG_SSH_KEY_PATH",
            "KMS_MASTER_KEY_ID",
            "BACKUP_DAEMON_CERT_DIR",
            "DEPLOY_ENV",
            "SMTP_FROM_EMAIL",
            "TOKEN_COUNT",
            "",
        ] {
            assert!(!is_secret_name(name), "{name}");
        }
    }

    #[test]
    fn lines_keep_their_shape() {
        let line = "env DB_PASSWORD=hunter2 DEPLOY_ENV=production JWT_SECRET:abc";
        assert_eq!(
            redact_line(line),
            "env DB_PASSWORD=*** DEPLOY_ENV=production JWT_SECRET:abc"
        );
    }

    #[test]
    fn a_line_without_pairs_is_untouched() {
        assert_eq!(redact_line("planning 5 services"), "planning 5 services");
    }
}
