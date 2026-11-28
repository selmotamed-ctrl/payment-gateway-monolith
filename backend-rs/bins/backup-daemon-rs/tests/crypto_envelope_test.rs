//! Port of `deploy/backup-daemon/test/cryptoEnvelope.test.ts`.

mod common;

use std::path::Path;

use backup_daemon::crypto::{
    derive_manifest_key, derive_payload_key, master_key_from_hex, open_to_buffer, open_to_file,
    seal_buffer, seal_file, sign_manifest, sign_text, verify_manifest_signature,
    verify_text_signature, ArtifactRecord, BackupManifest, ManifestEncryption, SealOptions,
    ENVELOPE_MAGIC, ENVELOPE_VERSION, HEADER_BYTES, IV_BYTES, SALT_BYTES, TAG_BYTES,
};
use common::master;

fn context(target: &str, id: &str) -> SealOptions {
    SealOptions::new(&master(), target, id)
}

fn seal_options(compress: bool) -> SealOptions {
    let mut options = context("postgres_core", "bkp_1");
    options.compress = compress;
    options
}

#[test]
fn hkdf_keys_are_deterministic_and_domain_separated() {
    let master = master();
    let salt = vec![7_u8; SALT_BYTES];
    let base = derive_payload_key(&master, &salt, "postgres_core", "bkp_1").expect("key");
    assert_eq!(
        base,
        derive_payload_key(&master, &salt, "postgres_core", "bkp_1").expect("key")
    );
    assert_eq!(base.len(), 32);
    let variants = [
        derive_payload_key(&master, &salt, "audit_db", "bkp_1").expect("key"),
        derive_payload_key(&master, &salt, "redis", "bkp_1").expect("key"),
        derive_payload_key(&master, &salt, "postgres_core", "bkp_2").expect("key"),
        derive_payload_key(&master, &[8_u8; SALT_BYTES], "postgres_core", "bkp_1").expect("key"),
        derive_payload_key(&[1_u8; 32], &salt, "postgres_core", "bkp_1").expect("key"),
    ];
    for variant in variants {
        assert_ne!(variant, base);
    }
    assert_ne!(
        derive_manifest_key(&master).expect("key"),
        derive_payload_key(&master, &[0_u8; SALT_BYTES], "catalog", "x").expect("key")
    );
    assert!(master_key_from_hex("abcd").is_err());
    assert!(master_key_from_hex(&"zz".repeat(16)).is_err());
    assert!(master_key_from_hex(&"a".repeat(33)).is_err());
}

#[tokio::test]
async fn a_multi_megabyte_partly_compressible_payload_survives_seal_and_open() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut plain = vec![0_u8; 3 * 1024 * 1024];
    for (index, byte) in plain.iter_mut().enumerate() {
        *byte = (index % 251) as u8;
    }
    plain.extend(std::iter::repeat_n(0x41_u8, 2 * 1024 * 1024));
    plain.extend_from_slice(b"TAIL-MARKER-0123456789");
    let source = dir.path().join("plain.bin");
    let sealed = dir.path().join("plain.bin.enc");
    tokio::fs::write(&source, &plain).await.expect("write");
    let result = seal_file(&source, &sealed, &context("postgres_core", "bkp_1"))
        .await
        .expect("seal");
    assert_eq!(result.uncompressed_bytes, plain.len() as u64);
    assert!(result.compressed_bytes < plain.len() as u64);
    assert_eq!(
        result.compressed_bytes,
        tokio::fs::metadata(&sealed).await.expect("stat").len()
    );
    assert_eq!(result.iv_hex.len(), IV_BYTES * 2);
    assert_eq!(result.auth_tag_hex.len(), TAG_BYTES * 2);
    assert_eq!(result.sha256_plaintext.len(), 64);
    let ciphertext = tokio::fs::read(&sealed).await.expect("read");
    assert!(!ciphertext
        .windows(b"TAIL-MARKER".len())
        .any(|window| window == b"TAIL-MARKER"));

    let restored = dir.path().join("restored.bin");
    let opened = open_to_file(
        &sealed,
        &restored,
        &master(),
        "postgres_core",
        "bkp_1",
        true,
    )
    .await
    .expect("open");
    assert_eq!(opened.sha256_plaintext, result.sha256_plaintext);
    assert_eq!(tokio::fs::read(&restored).await.expect("read"), plain);
}

#[tokio::test]
async fn fresh_salt_and_iv_make_two_seals_of_the_same_data_differ() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = seal_buffer(
        b"same data",
        &dir.path().join("a.enc"),
        &context("postgres_core", "bkp_1"),
    )
    .await
    .expect("seal");
    let second = seal_buffer(
        b"same data",
        &dir.path().join("b.enc"),
        &context("postgres_core", "bkp_1"),
    )
    .await
    .expect("seal");
    assert_ne!(first.salt_hex, second.salt_hex);
    assert_ne!(
        tokio::fs::read(dir.path().join("a.enc")).await.expect("a"),
        tokio::fs::read(dir.path().join("b.enc")).await.expect("b")
    );
}

#[tokio::test]
async fn handles_empty_and_tiny_payloads_with_and_without_compression() {
    let dir = tempfile::tempdir().expect("tempdir");
    for compress in [true, false] {
        for payload in [Vec::new(), b"x".to_vec(), vec![9_u8; 17]] {
            let file = dir
                .path()
                .join(format!("t-{}-{}.enc", compress, payload.len()));
            let mut options = context("postgres_core", "bkp_1");
            options.compress = compress;
            seal_buffer(&payload, &file, &options).await.expect("seal");
            let opened = open_to_buffer(&file, &master(), "postgres_core", "bkp_1", compress)
                .await
                .expect("open");
            assert_eq!(opened, payload);
        }
    }
}

#[tokio::test]
async fn the_envelope_has_the_documented_layout() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("layout.enc");
    seal_buffer(b"hello", &file, &seal_options(false))
        .await
        .expect("seal");
    let bytes = tokio::fs::read(&file).await.expect("read");
    assert_eq!(&bytes[..6], ENVELOPE_MAGIC);
    assert_eq!(bytes[6], ENVELOPE_VERSION);
    assert_eq!(bytes.len(), HEADER_BYTES + 5 + TAG_BYTES);
}

#[tokio::test]
async fn a_failed_seal_removes_the_destination_and_temporary_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    let dest = dir.path().join("never.enc");
    // A directory as the source makes the read fail before anything is written.
    let source = dir.path().join("source");
    tokio::fs::create_dir(&source).await.expect("mkdir");
    assert!(
        seal_file(&source, &dest, &context("postgres_core", "bkp_1"))
            .await
            .is_err()
    );
    let entries: Vec<String> = std::fs::read_dir(dir.path())
        .expect("read_dir")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert!(!entries.contains(&"never.enc".to_owned()));
    assert!(!entries.iter().any(|name| name.ends_with(".tmp")));
}

async fn seal_one() -> (tempfile::TempDir, std::path::PathBuf, Vec<u8>) {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("victim.enc");
    let payload: Vec<u8> = (0..200_000).map(|index| (index % 251) as u8).collect();
    seal_buffer(&payload, &file, &context("postgres_core", "bkp_1"))
        .await
        .expect("seal");
    let bytes = tokio::fs::read(&file).await.expect("read");
    (dir, file, bytes)
}

fn flip_bit(bytes: &[u8], offset: usize) -> Vec<u8> {
    let mut copy = bytes.to_vec();
    copy[offset] ^= 0x01;
    copy
}

async fn expect_rejected(file: &Path, bytes: &[u8]) {
    tokio::fs::write(file, bytes).await.expect("write");
    assert!(
        open_to_buffer(file, &master(), "postgres_core", "bkp_1", true)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn tampering_fails_closed() {
    let (_dir, file, bytes) = seal_one().await;
    // ciphertext body
    expect_rejected(&file, &flip_bit(&bytes, HEADER_BYTES + 100)).await;
    // IV
    expect_rejected(&file, &flip_bit(&bytes, 7 + SALT_BYTES + 3)).await;
    // salt (different derived key)
    expect_rejected(&file, &flip_bit(&bytes, 7 + 1)).await;
    // authentication tag
    expect_rejected(&file, &flip_bit(&bytes, bytes.len() - 3)).await;
    // magic and version
    expect_rejected(&file, &flip_bit(&bytes, 0)).await;
    expect_rejected(&file, &flip_bit(&bytes, 6)).await;
    // truncation and appended garbage
    expect_rejected(&file, &bytes[..bytes.len() - 1]).await;
    expect_rejected(&file, &bytes[..bytes.len() - TAG_BYTES]).await;
    expect_rejected(&file, &bytes[..10]).await;
    expect_rejected(&file, &[]).await;
    let mut appended = bytes.clone();
    appended.extend_from_slice(b"extra");
    expect_rejected(&file, &appended).await;
}

#[tokio::test]
async fn the_wrong_master_key_target_or_backup_id_cannot_open_it() {
    let (_dir, file, bytes) = seal_one().await;
    tokio::fs::write(&file, &bytes).await.expect("write");
    assert!(
        open_to_buffer(&file, &[3_u8; 32], "postgres_core", "bkp_1", true)
            .await
            .is_err()
    );
    assert!(open_to_buffer(&file, &master(), "audit_db", "bkp_1", true)
        .await
        .is_err());
    assert!(
        open_to_buffer(&file, &master(), "postgres_core", "bkp_2", true)
            .await
            .is_err()
    );
    assert_eq!(
        open_to_buffer(&file, &master(), "postgres_core", "bkp_1", true)
            .await
            .expect("right context")
            .len(),
        200_000
    );
}

#[tokio::test]
async fn open_to_file_never_leaves_a_partial_plaintext_file() {
    let (dir, file, bytes) = seal_one().await;
    tokio::fs::write(&file, flip_bit(&bytes, HEADER_BYTES + 10))
        .await
        .expect("write");
    let dest = dir.path().join("should-not-exist.bin");
    assert!(
        open_to_file(&file, &dest, &master(), "postgres_core", "bkp_1", true)
            .await
            .is_err()
    );
    assert!(!dest.exists());
    let leftovers: Vec<String> = std::fs::read_dir(dir.path())
        .expect("read_dir")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name != "victim.enc")
        .collect();
    assert!(leftovers.is_empty(), "leftovers: {leftovers:?}");
}

fn unsigned_manifest() -> BackupManifest {
    BackupManifest {
        schema_version: 2,
        backup_id: "bkp_20261106T020000Z_core_full".to_owned(),
        target: "postgres_core".to_owned(),
        kind: "full".to_owned(),
        engine: "pg-native".to_owned(),
        cluster_topology: "shared-audit".to_owned(),
        started_at: "2026-11-06T02:00:00.000Z".to_owned(),
        completed_at: "2026-11-06T02:01:14.210Z".to_owned(),
        start_lsn: Some("0/18000028".to_owned()),
        end_lsn: Some("0/180001A0".to_owned()),
        wal_segment_start: None,
        wal_segment_end: None,
        parent_backup_id: None,
        uncompressed_bytes: 148_291_584,
        compressed_bytes: 19_482_112,
        sha256_plaintext: "a".repeat(64),
        sha256_ciphertext: "b".repeat(64),
        encryption: ManifestEncryption {
            algorithm: "AES-256-GCM".to_owned(),
            kdf: "HKDF-SHA256".to_owned(),
            salt_hex: "00".to_owned(),
            iv_hex: "11".to_owned(),
            auth_tag_hex: "22".to_owned(),
        },
        pg_verify_backup: Some(backup_daemon::crypto::PgVerifyBackup {
            verified: true,
            manifest_checksum_algorithm: "SHA256".to_owned(),
            detail: "backup successfully verified".to_owned(),
        }),
        artifacts: Some(std::collections::BTreeMap::from([(
            "logical/payment_gateway_prod/bkp.dump.enc".to_owned(),
            ArtifactRecord {
                sha256_ciphertext: "c".repeat(64),
                bytes: 1024,
            },
        )])),
        storage_targets: vec!["local-repo".to_owned(), "primary-s3".to_owned()],
        signature: None,
    }
}

#[test]
fn signed_manifests_verify_and_every_field_is_covered() {
    let master = master();
    let signed = sign_manifest(&unsigned_manifest(), &master).expect("sign");
    assert!(verify_manifest_signature(&signed, &master));
    let signature = signed.signature.clone().expect("signature");
    assert_eq!(signature.len(), 64);

    #[allow(clippy::type_complexity)]
    let mutations: Vec<Box<dyn Fn(&mut BackupManifest)>> = vec![
        Box::new(|manifest| manifest.backup_id = "bkp_other".to_owned()),
        Box::new(|manifest| manifest.kind = "delta".to_owned()),
        Box::new(|manifest| manifest.end_lsn = Some("0/FFFFFFFF".to_owned())),
        Box::new(|manifest| manifest.sha256_ciphertext = "c".repeat(64)),
        Box::new(|manifest| manifest.compressed_bytes += 1),
        Box::new(|manifest| manifest.encryption.iv_hex = "ff".to_owned()),
        Box::new(|manifest| manifest.encryption.auth_tag_hex = "ff".to_owned()),
        Box::new(|manifest| {
            if let Some(verify) = &mut manifest.pg_verify_backup {
                verify.verified = false;
            }
        }),
        Box::new(|manifest| manifest.storage_targets.push("evil".to_owned())),
        Box::new(|manifest| manifest.parent_backup_id = Some("bkp_planted".to_owned())),
    ];
    for mutate in mutations {
        let mut copy = signed.clone();
        mutate(&mut copy);
        assert!(!verify_manifest_signature(&copy, &master));
    }
}

#[test]
fn a_missing_truncated_non_hex_or_wrong_key_signature_fails_closed() {
    let master = master();
    let signed = sign_manifest(&unsigned_manifest(), &master).expect("sign");
    let mut missing = signed.clone();
    missing.signature = None;
    assert!(!verify_manifest_signature(&missing, &master));
    let mut empty = signed.clone();
    empty.signature = Some(String::new());
    assert!(!verify_manifest_signature(&empty, &master));
    let mut short = signed.clone();
    short.signature = signed
        .signature
        .as_ref()
        .map(|value| value[..32].to_owned());
    assert!(!verify_manifest_signature(&short, &master));
    let mut non_hex = signed.clone();
    non_hex.signature = Some("zz".repeat(32));
    assert!(!verify_manifest_signature(&non_hex, &master));
    assert!(!verify_manifest_signature(&signed, &[9_u8; 32]));
}

#[test]
fn text_signatures_verify_and_reject_tampering() {
    let master = master();
    let signature = sign_text(r#"{"runs":[]}"#, &master).expect("sign");
    assert!(verify_text_signature(r#"{"runs":[]}"#, &signature, &master));
    assert!(!verify_text_signature(
        r#"{"runs":[1]}"#,
        &signature,
        &master
    ));
    assert!(!verify_text_signature(
        r#"{"runs":[]}"#,
        &signature[..20],
        &master
    ));
}
