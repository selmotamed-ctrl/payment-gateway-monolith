//! Port of `deploy/backup-daemon/test/storage.test.ts`.

mod common;

use sha2::Digest;

use backup_daemon::artifacts::{
    assert_safe_key, build_repository, parse_bucket_spec, ArtifactRepository, ArtifactStore,
    LocalRepoStore, StoreError, StoreKind,
};
use common::make_config;

#[test]
fn artifact_keys_accept_the_documented_layout_and_refuse_traversal() {
    assert!(assert_safe_key("backups/postgres_core/bkp_1.tar.zst.enc").is_ok());
    assert!(assert_safe_key("wal/postgres_core/000000010000000000000001.zst.enc").is_ok());
    assert!(assert_safe_key("../escape").is_err());
    assert!(assert_safe_key("/absolute").is_err());
    assert!(assert_safe_key("a//b").is_err());
    assert!(assert_safe_key("").is_err());
    assert!(assert_safe_key("bad key").is_err());
}

#[tokio::test]
async fn local_repo_round_trips_files_and_buffers_atomically_and_lists_keys() {
    let directory = tempfile::tempdir().expect("tempdir");
    let store = LocalRepoStore::new(directory.path());
    let source = directory.path().join("source.bin");
    tokio::fs::write(&source, b"payload").await.expect("write");
    store
        .put_file("backups/postgres_core/a.enc", &source)
        .await
        .expect("put");
    store
        .put_buffer("wal/postgres_core/b.enc", b"wal")
        .await
        .expect("put buffer");
    assert_eq!(
        store
            .get_buffer("backups/postgres_core/a.enc")
            .await
            .expect("get")
            .expect("present"),
        b"payload"
    );
    let destination = directory.path().join("restored.bin");
    store
        .get_file("backups/postgres_core/a.enc", &destination)
        .await
        .expect("get file");
    assert_eq!(
        tokio::fs::read(&destination).await.expect("read"),
        b"payload"
    );
    assert_eq!(
        store.list("backups").await.expect("list"),
        vec!["backups/postgres_core/a.enc".to_owned()]
    );
    assert!(store
        .exists("wal/postgres_core/b.enc")
        .await
        .expect("exists"));
    assert!(!store.exists("nope").await.expect("exists"));
    // no temporary files are left behind
    let leftovers: Vec<String> = walk(directory.path())
        .into_iter()
        .filter(|path| path.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

fn walk(root: &std::path::Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                files.push(path.to_string_lossy().into_owned());
            }
        }
    }
    files
}

#[tokio::test]
async fn local_repo_cannot_be_coaxed_outside_its_root() {
    let directory = tempfile::tempdir().expect("tempdir");
    let store = LocalRepoStore::new(directory.path().join("repo"));
    assert!(store.path_for("../escape").is_err());
    assert!(store.put_buffer("a/../../escape", b"x").await.is_err());
}

#[tokio::test]
async fn local_repo_health_reports_writability() {
    let directory = tempfile::tempdir().expect("tempdir");
    let store = LocalRepoStore::new(directory.path().join("repo"));
    let health = store.health().await;
    assert!(health.healthy);
    assert!(health.detail.contains("writable"));
}

#[test]
fn bucket_specs_parse_s3_urls_and_bare_names() {
    assert_eq!(
        parse_bucket_spec("s3://bucket/some/prefix"),
        backup_daemon::artifacts::ParsedBucket {
            bucket: "bucket".to_owned(),
            prefix: "some/prefix".to_owned(),
        }
    );
    assert_eq!(parse_bucket_spec("bucket").bucket, "bucket");
}

#[tokio::test]
async fn repository_writes_to_every_tier_and_reads_fall_back() {
    let (repository, s3, vault) = common::memory_repository();
    let directory = tempfile::tempdir().expect("tempdir");
    let source = directory.path().join("artifact");
    tokio::fs::write(&source, b"artifact").await.expect("write");
    let outcome = repository
        .put_file("backups/postgres_core/a.enc", &source, None)
        .await
        .expect("put");
    assert_eq!(outcome.stored, vec!["primary-s3", "secondary-ssh"]);
    assert!(s3.object("backups/postgres_core/a.enc").is_some());
    assert!(vault.object("backups/postgres_core/a.enc").is_some());
    let destination = directory.path().join("got");
    assert_eq!(
        repository
            .get_file("backups/postgres_core/a.enc", &destination)
            .await
            .expect("get"),
        "primary-s3"
    );
    assert_eq!(
        tokio::fs::read(destination).await.expect("read"),
        b"artifact"
    );
}

#[tokio::test]
async fn a_failed_required_tier_fails_the_write_and_a_failed_vault_does_not() {
    let (repository, s3, vault) = common::memory_repository();
    s3.set_fail_puts(true);
    assert!(repository
        .put_buffer("backups/x/a.enc", b"x", None)
        .await
        .is_err());
    s3.set_fail_puts(false);
    vault.set_fail_puts(true);
    let outcome = repository
        .put_buffer("backups/x/b.enc", b"x", None)
        .await
        .expect("best effort");
    assert_eq!(outcome.stored, vec!["primary-s3"]);
    assert_eq!(outcome.failed.len(), 1);
}

#[tokio::test]
async fn get_file_verified_skips_a_corrupt_copy_and_serves_the_next_tier() {
    let (repository, s3, vault) = common::memory_repository();
    s3.put_object("backups/x/a.enc", b"corrupt".to_vec());
    let good = b"the-good-ciphertext".to_vec();
    let expected = hex::encode(sha2::Sha256::digest(&good));
    vault.put_object("backups/x/a.enc", good.clone());
    let directory = tempfile::tempdir().expect("tempdir");
    let destination = directory.path().join("artifact");
    assert_eq!(
        repository
            .get_file_verified("backups/x/a.enc", &destination, &expected)
            .await
            .expect("verified"),
        "secondary-ssh"
    );
    assert_eq!(tokio::fs::read(&destination).await.expect("read"), good);

    s3.put_object("backups/x/a.enc", b"corrupt".to_vec());
    vault.put_object("backups/x/a.enc", b"also-corrupt".to_vec());
    assert!(repository
        .get_file_verified("backups/x/a.enc", &destination, &expected)
        .await
        .is_err());
}

#[tokio::test]
async fn get_file_reports_which_tiers_were_tried_when_nowhere() {
    let (repository, _s3, _vault) = common::memory_repository();
    let directory = tempfile::tempdir().expect("tempdir");
    let error = repository
        .get_file("missing/key", &directory.path().join("x"))
        .await
        .expect_err("missing");
    assert!(error
        .to_string()
        .contains("not available on any storage tier"));
}

#[tokio::test]
async fn list_merges_tiers_and_list_by_store_keeps_them_separate() {
    let (repository, s3, vault) = common::memory_repository();
    s3.put_object("backups/a", b"1".to_vec());
    vault.put_object("backups/a", b"1".to_vec());
    vault.put_object("backups/b", b"2".to_vec());
    assert_eq!(
        repository.list("backups").await,
        vec!["backups/a".to_owned(), "backups/b".to_owned()]
    );
    let by_store = repository.list_by_store("backups").await;
    assert_eq!(by_store["primary-s3"].len(), 1);
    assert_eq!(by_store["secondary-ssh"].len(), 2);
    repository.delete("backups/a").await;
    assert!(s3.object("backups/a").is_none());
}

#[test]
fn a_repository_needs_at_least_one_tier() {
    assert!(ArtifactRepository::try_new(Vec::new()).is_err());
}

#[test]
fn repository_tiers_are_ordered_local_then_s3_then_vault() {
    let config = make_config(&[
        ("BACKUP_ENGINE_MODE", "pg-native"),
        (
            "BACKUP_SECONDARY_SSH_TARGET",
            "vault@198.51.100.99:/mnt/offsite",
        ),
    ]);
    let runner = common::RecordingRunner::ok();
    let repository = build_repository(&config, &runner).expect("repository");
    let kinds: Vec<StoreKind> = repository
        .stores()
        .iter()
        .map(|store| store.kind())
        .collect();
    assert_eq!(kinds, vec![StoreKind::Local, StoreKind::S3, StoreKind::Ssh]);
}

#[tokio::test]
async fn s3_reports_s3_not_configured_instead_of_pretending_to_store_data() {
    let config = make_config(&[("BACKUP_ENGINE_MODE", "pg-native")]);
    let runner = common::RecordingRunner::ok();
    let repository = build_repository(&config, &runner).expect("repository");
    let s3 = repository
        .stores()
        .iter()
        .find(|store| store.kind() == StoreKind::S3)
        .expect("s3 tier");
    assert!(matches!(
        s3.put_buffer("backups/x", b"x").await,
        Err(StoreError::S3NotConfigured)
    ));
    let health = s3.health().await;
    assert!(!health.healthy);
    assert!(health.detail.contains("S3_NOT_CONFIGURED"));
}

#[tokio::test]
async fn pg_native_with_no_s3_gets_just_the_local_repository() {
    let config = make_config(&[
        ("BACKUP_ENGINE_MODE", "pg-native"),
        ("BACKUP_PRIMARY_S3_ENDPOINT", ""),
        ("BACKUP_PRIMARY_S3_BUCKET", ""),
        ("BACKUP_PRIMARY_S3_ACCESS_KEY", ""),
        ("BACKUP_PRIMARY_S3_SECRET_KEY", ""),
    ]);
    let runner = common::RecordingRunner::ok();
    let repository = build_repository(&config, &runner).expect("repository");
    assert_eq!(repository.stores().len(), 1);
    assert_eq!(repository.stores()[0].kind(), StoreKind::Local);
}
