//! Port of `deploy/backup-daemon/test/objectStorageManifest.test.ts`.

mod common;

use std::sync::Arc;

use backup_daemon::artifacts::{ArtifactRepository, MemoryArtifactStore, StoreKind};
use backup_daemon::object_storage::{
    build_object_storage_manifest, compare_object_storage_manifest, load_manifest,
    verify_manifest_parity, ManifestObject, OBJECT_STORAGE_MANIFEST_KEY,
};
use chrono::{DateTime, Utc};

fn object(id: &str, key: &str, hash: &str) -> ManifestObject {
    ManifestObject {
        id: id.to_owned(),
        bucket: "HOT".to_owned(),
        storage_key: key.to_owned(),
        sha256_hex: hash.to_owned(),
        byte_size: "10".to_owned(),
    }
}

fn manifest(objects: &[ManifestObject]) -> backup_daemon::object_storage::ObjectStorageManifest {
    let now = DateTime::parse_from_rfc3339("2026-11-06T00:00:00Z")
        .expect("date")
        .with_timezone(&Utc);
    build_object_storage_manifest(objects, now)
}

#[test]
fn matches_the_restored_active_set_exactly() {
    let objects = vec![object("a", "k/a", "h1"), object("b", "k/b", "h2")];
    let manifest = manifest(&objects);
    assert_eq!(manifest.count, 2);
    let (ok, detail) = compare_object_storage_manifest(&manifest, &objects);
    assert!(ok);
    assert!(detail.contains("matches 2 restored ACTIVE object(s)"));
}

#[test]
fn detects_a_row_missing_from_the_restored_database_or_the_backup() {
    let objects = vec![object("a", "k/a", "h1"), object("b", "k/b", "h2")];
    let manifest = manifest(&objects);
    let mut missing = objects.clone();
    missing.pop();
    let (ok, detail) = compare_object_storage_manifest(&manifest, &missing);
    assert!(!ok);
    assert!(detail.contains("missing=1"));
    let extra = {
        let mut rows = objects.clone();
        rows.push(object("c", "k/c", "h3"));
        rows
    };
    let (ok, detail) = compare_object_storage_manifest(&manifest, &extra);
    assert!(!ok);
    assert!(detail.contains("extra=1"));
}

#[test]
fn detects_a_changed_storage_key_or_hash() {
    let objects = vec![object("a", "k/a", "h1")];
    let manifest = manifest(&objects);
    let mut changed = objects;
    changed[0].storage_key = "k/moved".to_owned();
    let (ok, detail) = compare_object_storage_manifest(&manifest, &changed);
    assert!(!ok);
    assert!(detail.contains("changed=1"));
}

#[tokio::test]
async fn the_recorded_manifest_is_read_from_the_backup_repository() {
    let store = Arc::new(MemoryArtifactStore::new(
        "primary-s3",
        "Primary S3 Bucket",
        StoreKind::S3,
    ));
    let repository = Arc::new(ArtifactRepository::new(vec![store.clone()]));
    assert!(load_manifest(&repository).await.expect("load").is_none());

    let objects = vec![object("a", "k/a", "h1")];
    store.put_object(
        OBJECT_STORAGE_MANIFEST_KEY,
        serde_json::to_vec(&manifest(&objects)).expect("json"),
    );
    let recorded = load_manifest(&repository)
        .await
        .expect("load")
        .expect("manifest");
    assert_eq!(recorded.objects, objects);

    let (ok, detail) = verify_manifest_parity(&repository, &objects)
        .await
        .expect("parity")
        .expect("manifest");
    assert!(ok, "{detail}");
    let (ok, _) = verify_manifest_parity(&repository, &[])
        .await
        .expect("parity")
        .expect("manifest");
    assert!(!ok);
}
