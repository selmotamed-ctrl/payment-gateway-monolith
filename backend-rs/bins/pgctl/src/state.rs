//! Local release state (`pgctl.state.json`) for deploy/rollback (D3-T03).
//!
//! The file records the releases known to this operator workstation and which one is current.
//! It never contains host secrets and is written 0600 atomically.

#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::util;

/// State schema.
pub const STATE_SCHEMA: u32 = 1;

/// One installed release.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseRecord {
    /// Release version.
    pub version: String,
    /// Git commit.
    pub commit: String,
    /// Archive path.
    pub archive: String,
    /// Manifest path.
    pub manifest: String,
    /// When it was recorded (Unix seconds).
    pub installed_at_unix: u64,
    /// Minimum database schema (when the manifest declares it).
    #[serde(default)]
    pub schema_min: Option<u32>,
    /// Maximum database schema (when the manifest declares it).
    #[serde(default)]
    pub schema_max: Option<u32>,
}

impl ReleaseRecord {
    /// `version-commit`, the identifier used by `rollback --to`.
    #[must_use]
    pub fn release_id(&self) -> String {
        format!("{}-{}", self.version, self.commit)
    }
}

/// `pgctl.state.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseState {
    /// Schema.
    pub schema: u32,
    /// Current release.
    pub current: Option<ReleaseRecord>,
    /// Chronological history, oldest first.
    pub history: Vec<ReleaseRecord>,
}

impl Default for ReleaseState {
    fn default() -> Self {
        Self {
            schema: STATE_SCHEMA,
            current: None,
            history: Vec::new(),
        }
    }
}

impl ReleaseState {
    /// Default path: `$XDG_STATE_HOME/pgctl/state.json` or `~/.local/state/pgctl/state.json`.
    #[must_use]
    pub fn default_path() -> PathBuf {
        if let Some(state_home) = std::env::var_os("XDG_STATE_HOME") {
            return PathBuf::from(state_home).join("pgctl/state.json");
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join(".local/state/pgctl/state.json")
    }

    /// Load; a missing file is a fresh state.
    pub fn load(path: &Path) -> Result<Self, String> {
        match std::fs::read_to_string(path) {
            Ok(text) => {
                let state: Self = serde_json::from_str(&text)
                    .map_err(|error| format!("{}: {error}", path.display()))?;
                if state.schema != STATE_SCHEMA {
                    return Err(format!(
                        "{}: state schema {} is not supported (expected {STATE_SCHEMA})",
                        path.display(),
                        state.schema
                    ));
                }
                Ok(state)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(format!("{}: {error}", path.display())),
        }
    }

    /// Save atomically with mode 0600.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let text = util::json_pretty(self).map_err(|error| error.to_string())?;
        util::write_atomic(path, text.as_bytes(), 0o600)
            .map_err(|error| format!("{}: {error}", path.display()))
    }

    /// Record a release as current (history keeps every distinct version/commit once).
    pub fn record(&mut self, record: ReleaseRecord) {
        if !self
            .history
            .iter()
            .any(|existing| existing.release_id() == record.release_id())
        {
            self.history.push(record.clone());
        }
        self.current = Some(record);
    }

    /// The release installed before the current one.
    #[must_use]
    pub fn previous(&self) -> Option<&ReleaseRecord> {
        let current = self.current.as_ref()?;
        let index = self
            .history
            .iter()
            .position(|record| record.release_id() == current.release_id())?;
        index
            .checked_sub(1)
            .and_then(|previous| self.history.get(previous))
    }

    /// Find a release by `version` or `version-commit`.
    #[must_use]
    pub fn find(&self, wanted: &str) -> Option<&ReleaseRecord> {
        self.history
            .iter()
            .find(|record| record.release_id() == wanted || record.version == wanted)
    }

    /// Make `target` current (or the previous release when `target` is `None`).
    pub fn rollback_to(&mut self, target: Option<&str>) -> Result<ReleaseRecord, String> {
        let record = match target {
            Some(wanted) => self
                .find(wanted)
                .cloned()
                .ok_or_else(|| format!("release '{wanted}' is not in the local state"))?,
            None => self
                .previous()
                .cloned()
                .ok_or_else(|| "there is no previous release to roll back to".to_owned())?,
        };
        if !self
            .history
            .iter()
            .any(|existing| existing.release_id() == record.release_id())
        {
            self.history.push(record.clone());
        }
        self.current = Some(record.clone());
        Ok(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(version: &str) -> ReleaseRecord {
        ReleaseRecord {
            version: version.to_owned(),
            commit: "abc1234".to_owned(),
            archive: format!("/releases/{version}.tar.zst"),
            manifest: format!("/releases/{version}.json"),
            installed_at_unix: 0,
            schema_min: None,
            schema_max: None,
        }
    }

    #[test]
    fn record_and_rollback_follow_history() {
        let mut state = ReleaseState::default();
        state.record(record("1"));
        state.record(record("2"));
        assert_eq!(
            state.current.as_ref().map(|r| r.version.as_str()),
            Some("2")
        );
        assert_eq!(state.previous().map(|r| r.version.as_str()), Some("1"));
        let target = state.rollback_to(None).expect("rollback");
        assert_eq!(target.version, "1");
        assert_eq!(
            state.current.as_ref().map(|r| r.version.as_str()),
            Some("1")
        );
        // Rolling forward to an explicit release works and dedupes history.
        let target = state.rollback_to(Some("2-abc1234")).expect("roll forward");
        assert_eq!(target.version, "2");
        assert_eq!(state.history.len(), 2);
        assert!(state.rollback_to(Some("nope")).is_err());
    }

    #[test]
    fn state_round_trips_with_mode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("pgctl.state.json");
        let mut state = ReleaseState::default();
        state.record(record("1"));
        state.save(&path).expect("save");
        let loaded = ReleaseState::load(&path).expect("load");
        assert_eq!(loaded, state);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).expect("meta").permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn a_missing_state_is_empty_and_a_bad_schema_is_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("state.json");
        assert_eq!(
            ReleaseState::load(&path).expect("missing"),
            ReleaseState::default()
        );
        std::fs::write(&path, r#"{"schema":99,"current":null,"history":[]}"#).expect("write");
        assert!(ReleaseState::load(&path).is_err());
    }
}
