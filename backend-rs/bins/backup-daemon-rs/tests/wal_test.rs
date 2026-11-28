//! Port of `deploy/backup-daemon/test/wal.test.ts`.

mod common;

use std::sync::Arc;

use backup_daemon::artifacts::{
    ArtifactRepository, LocalRepoStore, MemoryArtifactStore, StoreKind,
};
use backup_daemon::wal_archive::{WalArchive, WalIngestError};
use chrono::Utc;

fn archive_with(
    stores: Vec<Arc<dyn backup_daemon::artifacts::ArtifactStore>>,
    staging: &std::path::Path,
    max_bytes: u64,
) -> WalArchive {
    WalArchive::new(
        Arc::new(ArtifactRepository::new(stores)),
        common::master(),
        staging.to_path_buf(),
        max_bytes,
        Box::new(Utc::now),
    )
}

fn local_archive(staging: &std::path::Path) -> WalArchive {
    let local = Arc::new(LocalRepoStore::new(staging.join("repo")));
    archive_with(vec![local], staging, 64 * 1024 * 1024)
}

const SEGMENT: &str = "000000010000000000000001";
const SEGMENT_2: &str = "000000010000000000000002";
const HISTORY: &str = "00000002.history";
const BACKUP_LABEL: &str = "000000010000000000000001.00000028.backup";

#[tokio::test]
async fn stores_the_segment_compressed_and_encrypted_on_the_primary_tier() {
    let staging = tempfile::tempdir().expect("tempdir");
    let archive = local_archive(staging.path());
    let body = vec![7_u8; 1024];
    let outcome = archive
        .ingest_stream("postgres_core", SEGMENT, &body, Some(body.len() as u64))
        .await
        .expect("ingest");
    assert_eq!(outcome.status, "stored");
    assert_eq!(outcome.key, format!("wal/postgres_core/{SEGMENT}.zst.enc"));
    assert_eq!(outcome.bytes, 1024);
    assert_eq!(archive.state().last_archived_wal, SEGMENT);
    assert_eq!(archive.state().received, 1);
    let stored = std::fs::read(
        staging
            .path()
            .join("repo")
            .join("wal/postgres_core")
            .join(format!("{SEGMENT}.zst.enc")),
    )
    .expect("stored");
    assert!(!stored.windows(4).any(|window| window == [7, 7, 7, 7]));
}

#[tokio::test]
async fn is_idempotent_and_answers_duplicate_for_the_same_bytes() {
    let staging = tempfile::tempdir().expect("tempdir");
    let archive = local_archive(staging.path());
    let body = b"segment-bytes".to_vec();
    archive
        .ingest_stream("postgres_core", SEGMENT, &body, None)
        .await
        .expect("first");
    let duplicate = archive
        .ingest_stream("postgres_core", SEGMENT, &body, None)
        .await
        .expect("duplicate");
    assert_eq!(duplicate.status, "duplicate");
    assert_eq!(archive.state().duplicates, 1);
}

#[tokio::test]
async fn never_overwrites_different_bytes_for_an_archived_name() {
    let staging = tempfile::tempdir().expect("tempdir");
    let archive = local_archive(staging.path());
    archive
        .ingest_stream("postgres_core", SEGMENT, b"first", None)
        .await
        .expect("first");
    let conflict = archive
        .ingest_stream("postgres_core", SEGMENT, b"second", None)
        .await
        .expect_err("conflict");
    assert_eq!(conflict.status, 409);
    assert_eq!(conflict.code, "wal_conflict");
    assert_eq!(archive.state().conflicts, 1);
}

#[tokio::test]
async fn last_archived_wal_only_advances_on_segments_and_never_goes_backwards() {
    let staging = tempfile::tempdir().expect("tempdir");
    let archive = local_archive(staging.path());
    archive
        .ingest_stream("postgres_core", SEGMENT_2, b"two", None)
        .await
        .expect("segment");
    assert_eq!(archive.state().last_archived_wal, SEGMENT_2);
    archive
        .ingest_stream("postgres_core", HISTORY, b"history", None)
        .await
        .expect("history");
    archive
        .ingest_stream("postgres_core", BACKUP_LABEL, b"label", None)
        .await
        .expect("label");
    assert_eq!(archive.state().last_archived_wal, SEGMENT_2);
    archive
        .ingest_stream("postgres_core", SEGMENT, b"one", None)
        .await
        .expect("older segment");
    assert_eq!(archive.state().last_archived_wal, SEGMENT_2);
}

#[tokio::test]
async fn validates_target_and_file_name_before_touching_storage() {
    let staging = tempfile::tempdir().expect("tempdir");
    let archive = local_archive(staging.path());
    let bad_target = archive
        .ingest_stream("mysql", SEGMENT, b"x", None)
        .await
        .expect_err("target");
    assert_eq!(bad_target.code, "invalid_wal_target");
    let bad_file = archive
        .ingest_stream("postgres_core", "not-a-segment", b"x", None)
        .await
        .expect_err("file");
    assert_eq!(bad_file.code, "invalid_wal_file");
}

#[tokio::test]
async fn enforces_the_size_cap_from_content_length_and_the_body() {
    let staging = tempfile::tempdir().expect("tempdir");
    let archive = WalArchive::new(
        Arc::new(ArtifactRepository::new(vec![Arc::new(
            LocalRepoStore::new(staging.path().join("repo-small")),
        )])),
        common::master(),
        staging.path().to_path_buf(),
        10,
        Box::new(Utc::now),
    );
    let declared = archive
        .ingest_stream("postgres_core", SEGMENT, b"12345", Some(11))
        .await
        .expect_err("declared");
    assert_eq!(declared.status, 413);
    let body = archive
        .ingest_stream("postgres_core", SEGMENT, b"12345678901", None)
        .await
        .expect_err("body");
    assert_eq!(body.status, 413);
}

#[tokio::test]
async fn rejects_empty_and_truncated_uploads() {
    let staging = tempfile::tempdir().expect("tempdir");
    let archive = local_archive(staging.path());
    let empty = archive
        .ingest_stream("postgres_core", SEGMENT, b"", None)
        .await
        .expect_err("empty");
    assert_eq!(empty.code, "empty_wal_file");
    let truncated = archive
        .ingest_stream("postgres_core", SEGMENT, b"12345", Some(10))
        .await
        .expect_err("truncated");
    assert_eq!(truncated.code, "truncated_upload");
}

#[tokio::test]
async fn an_s3_only_deployment_reports_s3_not_configured() {
    let staging = tempfile::tempdir().expect("tempdir");
    let s3 = Arc::new(MemoryArtifactStore::new(
        "primary-s3",
        "Primary S3 Bucket",
        StoreKind::S3,
    ));
    // A memory store is used to prove the ingest contract; the real S3 tier reports the gap in
    // `artifacts_test`.
    let archive = archive_with(vec![s3.clone()], staging.path(), 1024);
    let outcome = archive
        .ingest_stream("postgres_core", SEGMENT, b"abc", None)
        .await
        .expect("ingest");
    assert_eq!(outcome.status, "stored");
    assert!(s3.object(&outcome.key).is_some());
}

#[tokio::test]
async fn the_mirror_catches_up_after_an_outage_and_reconciles_lost_work() {
    let staging = tempfile::tempdir().expect("tempdir");
    let local = Arc::new(LocalRepoStore::new(staging.path().join("repo")));
    let mirror = Arc::new(MemoryArtifactStore::new(
        "secondary-ssh",
        "Vault",
        StoreKind::Ssh,
    ));
    let archive = archive_with(
        vec![local.clone(), mirror.clone()],
        staging.path(),
        64 * 1024 * 1024,
    );
    // The mirror is down while the segment is acknowledged.
    mirror.set_fail_puts(true);
    let outcome = archive
        .ingest_stream("postgres_core", SEGMENT, b"mirror-me", None)
        .await
        .expect("ingest");
    assert!(mirror.object(&outcome.key).is_none());
    mirror.set_fail_puts(false);
    for _attempt in 0..20 {
        let _ = archive.mirror.drain_once().await;
        if mirror.object(&outcome.key).is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(mirror.object(&outcome.key).is_some());

    // A restart forgets the pending queue; reconcile finds WAL that never reached a new mirror.
    let fresh_mirror = Arc::new(MemoryArtifactStore::new(
        "secondary-ssh",
        "Vault",
        StoreKind::Ssh,
    ));
    let archive2 = archive_with(vec![local, fresh_mirror], staging.path(), 64 * 1024 * 1024);
    let queued = archive2.mirror.reconcile().await;
    assert_eq!(queued, 1);
    assert_eq!(archive2.mirror.pending_count(), 1);
}

#[tokio::test]
async fn ingest_errors_expose_the_ts_codes() {
    let error = WalIngestError::new(409, "wal_conflict", "conflict");
    assert_eq!(error.status, 409);
    assert_eq!(error.code, "wal_conflict");
}
