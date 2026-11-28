//! [`VaultPort`] on `pg-crypto::Vault`.
//!
//! Port of `engine/runtime/contextCipher.ts` (`VaultContextCipher`): the attempt context is sealed
//! with the key id `attempt-context`, and credential entries use `credential-set`, matching the
//! TypeScript call sites exactly.
//!
//! The wire format is the TS `Vault` format `keyId:iv:authTag:ciphertext` (base64), which the
//! `pg-crypto` golden vectors pin.

use std::collections::BTreeMap;

use pg_crypto::vault::EnvironmentKeyResolver;
use pg_crypto::Vault;

use crate::ports::VaultPort;

/// The attempt-context key id (`VaultContextCipher` default).
pub const ATTEMPT_CONTEXT_KEY: &str = "attempt-context";
/// The credential-set key id (`loadConsumerConfig`).
pub const CREDENTIAL_SET_KEY: &str = "credential-set";

/// [`VaultPort`] backed by the process KMS environment (`KMS_MASTER_KEY`/`KMS_KEYS_JSON`).
pub struct PgVaultAdapter {
    vault: Vault<EnvironmentKeyResolver>,
}

impl std::fmt::Debug for PgVaultAdapter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PgVaultAdapter")
            .finish_non_exhaustive()
    }
}

impl Default for PgVaultAdapter {
    fn default() -> Self {
        Self::from_process_env()
    }
}

impl PgVaultAdapter {
    /// The production vault (`process.env`, exactly like `new Vault()`).
    #[must_use]
    pub fn from_process_env() -> Self {
        Self {
            vault: Vault::new(EnvironmentKeyResolver::from_process_env()),
        }
    }

    /// A vault with an explicit environment map (tests, embedders).
    #[must_use]
    pub fn from_map(map: BTreeMap<String, String>) -> Self {
        Self {
            vault: Vault::new(EnvironmentKeyResolver::from_map(map)),
        }
    }

    /// Seals a plaintext under an explicit key id.
    pub fn seal_with(&self, plaintext: &str, key_id: &str) -> Result<String, String> {
        self.vault
            .encrypt_secret(plaintext, key_id)
            .map_err(|error| error.to_string())
    }

    /// Opens a payload sealed under an explicit key id.
    pub fn open_with(&self, sealed: &str, _key_id: &str) -> Result<String, String> {
        self.vault
            .decrypt_secret(sealed)
            .map_err(|error| error.to_string())
    }
}

impl VaultPort for PgVaultAdapter {
    fn seal(&self, plaintext: &str, key_id: &str) -> Result<String, String> {
        self.seal_with(plaintext, key_id)
    }

    fn open(&self, sealed: &str, key_id: &str) -> Result<String, String> {
        self.open_with(sealed, key_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> PgVaultAdapter {
        let mut map = BTreeMap::new();
        map.insert(
            "KMS_MASTER_KEY".to_owned(),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
        );
        PgVaultAdapter::from_map(map)
    }

    #[test]
    fn attempt_context_round_trips() {
        let vault = vault();
        let sealed = vault
            .seal(r#"{"process_id":"P-1"}"#, ATTEMPT_CONTEXT_KEY)
            .expect("seal");
        assert!(sealed.starts_with("attempt-context:"));
        assert_eq!(
            vault.open(&sealed, ATTEMPT_CONTEXT_KEY).expect("open"),
            r#"{"process_id":"P-1"}"#
        );
    }

    #[test]
    fn a_tampered_payload_is_refused() {
        let vault = vault();
        let sealed = vault.seal("secret", CREDENTIAL_SET_KEY).expect("seal");
        let mut parts: Vec<&str> = sealed.split(':').collect();
        parts[3] = "AAAAAAAAAAAAAAAAAAAAAA";
        assert!(vault.open(&parts.join(":"), CREDENTIAL_SET_KEY).is_err());
    }

    #[test]
    fn key_ids_are_the_ts_ones() {
        assert_eq!(ATTEMPT_CONTEXT_KEY, "attempt-context");
        assert_eq!(CREDENTIAL_SET_KEY, "credential-set");
    }
}
