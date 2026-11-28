//! `$CREDENTIALS_DIRECTORY` support (systemd `LoadCredential=`), AD-13.
//!
//! A credential file wins over the process environment and the `.env` file. File names are the
//! environment key exactly; contents are read as UTF-8 and trailing newlines are trimmed.

#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};

use zeroize::{Zeroize, ZeroizeOnDrop};

/// A secret string that zeroizes its buffer on drop and never shows its value in `Debug`.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretValue(String);

impl SecretValue {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Explicitly expose the secret for a crypto call. Callers must not log the result.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretValue([redacted])")
    }
}

/// A directory of systemd credentials.
#[derive(Debug, Clone)]
pub struct CredentialsDirectory {
    path: PathBuf,
}

impl CredentialsDirectory {
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// `CREDENTIALS_DIRECTORY` when set and a directory.
    #[must_use]
    pub fn from_process() -> Option<Self> {
        let raw = std::env::var("CREDENTIALS_DIRECTORY").ok()?;
        let path = PathBuf::from(raw);
        path.is_dir().then_some(Self { path })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read `$CREDENTIALS_DIRECTORY/<key>`. Missing, unreadable or non-UTF-8 files are ignored so
    /// the environment remains the fallback (never fail startup because a credential is absent).
    #[must_use]
    pub fn read(&self, key: &str) -> Option<String> {
        // Defence in depth: never allow a key to escape the credentials directory.
        if key.is_empty()
            || key.contains('/')
            || key.contains('\\')
            || key.contains("..")
            || key.contains('\0')
        {
            return None;
        }
        let path = self.path.join(key);
        let bytes = std::fs::read(path).ok()?;
        let text = String::from_utf8(bytes).ok()?;
        let trimmed = text.trim_end_matches(['\r', '\n']).to_owned();
        (!trimmed.is_empty()).then_some(trimmed)
    }
}
