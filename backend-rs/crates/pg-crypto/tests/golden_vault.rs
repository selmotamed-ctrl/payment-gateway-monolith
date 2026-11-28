//! Cross-implementation vault vectors: the TS vault sealed these payloads with a fixed master key.

use std::collections::BTreeMap;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use pg_crypto::vault::{assert_valid_key_id, EnvironmentKeyResolver, Vault, VaultError};
use serde::Deserialize;

const VAULT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden-vectors/vault.json"
));

#[derive(Deserialize)]
struct File {
    #[serde(rename = "kmsMasterKey")]
    kms_master_key: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    kind: String,
    key_id: String,
    #[serde(default)]
    plaintext: String,
    #[serde(default)]
    payload: String,
    #[serde(default)]
    data: String,
    #[serde(default)]
    signature: String,
}

fn vault(file: &File) -> Vault<EnvironmentKeyResolver> {
    let mut env = BTreeMap::new();
    env.insert("KMS_MASTER_KEY".to_owned(), file.kms_master_key.clone());
    Vault::new(EnvironmentKeyResolver::from_map(env))
}

#[test]
fn opens_typescript_payloads_and_reencrypts() {
    let file: File = serde_json::from_str(VAULT).expect("vault vectors");
    let vault = vault(&file);
    let mut encrypts = 0;
    for case in file.cases.iter().filter(|case| case.kind == "encrypt") {
        encrypts += 1;
        assert!(assert_valid_key_id(&case.key_id).is_ok(), "{}", case.id);
        assert_eq!(
            vault.decrypt_secret(&case.payload).expect("decrypt"),
            case.plaintext,
            "{}",
            case.id
        );
        let parts: Vec<&str> = case.payload.split(':').collect();
        assert_eq!(parts.len(), 4, "{}", case.id);
        assert_eq!(parts[0], case.key_id);
        assert_eq!(STANDARD.decode(parts[1]).expect("iv").len(), 12);
        assert_eq!(STANDARD.decode(parts[2]).expect("tag").len(), 16);
        if case.plaintext.is_empty() {
            assert!(parts[3].is_empty());
        }

        let sealed = vault
            .encrypt_secret(&case.plaintext, &case.key_id)
            .expect("seal");
        assert!(sealed.starts_with(&format!("{}:", case.key_id)));
        assert_eq!(
            vault.decrypt_secret(&sealed).expect("reopen"),
            case.plaintext,
            "{}",
            case.id
        );
    }
    assert_eq!(encrypts, 9);
}

#[test]
fn signatures_match_and_uppercase_is_rejected() {
    let file: File = serde_json::from_str(VAULT).expect("vault vectors");
    let vault = vault(&file);
    let mut signs = 0;
    for case in file.cases.iter().filter(|case| case.kind == "sign") {
        signs += 1;
        assert_eq!(
            vault.sign(&case.data, &case.key_id).expect("sign"),
            case.signature,
            "{}",
            case.id
        );
        assert!(vault
            .verify_signature(&case.data, &case.signature, &case.key_id)
            .expect("verify"));
        assert!(!vault
            .verify_signature(&case.data, &case.signature.to_uppercase(), &case.key_id)
            .expect("uppercase"));
        assert!(!vault
            .verify_signature(&format!("{}x", case.data), &case.signature, &case.key_id)
            .expect("wrong data"));
    }
    assert_eq!(signs, 6);
}

#[test]
fn tampering_fails_without_panic() {
    let file: File = serde_json::from_str(VAULT).expect("vault vectors");
    let vault = vault(&file);
    let case = file
        .cases
        .iter()
        .find(|case| case.kind == "encrypt" && !case.payload.ends_with(':'))
        .expect("non-empty payload");
    let mut parts: Vec<String> = case.payload.split(':').map(str::to_owned).collect();
    let last = parts[3].pop().expect("ciphertext");
    parts[3].push(if last == 'A' { 'B' } else { 'A' });
    let tampered = parts.join(":");
    let result = vault.decrypt_secret(&tampered);
    assert!(result.is_err(), "tampered payload must not decrypt");
    if let Err(error) = result {
        assert!(
            matches!(
                error,
                VaultError::AuthenticationFailed | VaultError::InvalidPayload(_)
            ),
            "unexpected error: {error:?}"
        );
    }
    // A master key derives every valid key id; only a resolver with no material is unknown.
    let empty = Vault::new(EnvironmentKeyResolver::from_map(BTreeMap::new()));
    assert!(matches!(
        empty.encrypt_secret("x", "unknown-key"),
        Err(VaultError::KeyNotFound(_))
    ));
}
