//! Object & asset storage backup parity. Port of `deploy/backup-daemon/src/objectStorageBackup.ts`
//! (manifest half only).
//!
//! The blob copy, the KEK escrow and the pgos1 decryption sample are a documented gap in this
//! crate: they need the object-storage daemon's SDK. What IS implemented is the strongest cheap
//! proof: the ACTIVE control-plane rows restored from the database backup must match, exactly, the
//! `object-storage/active-manifest.json` captured at backup time (missing, extra and changed rows
//! each fail).

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::artifacts::ArtifactRepository;

pub const OBJECT_STORAGE_MANIFEST_KEY: &str = "object-storage/active-manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManifestObject {
    pub id: String,
    pub bucket: String,
    #[serde(rename = "storageKey")]
    pub storage_key: String,
    #[serde(rename = "sha256Hex")]
    pub sha256_hex: String,
    #[serde(rename = "byteSize")]
    pub byte_size: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectStorageManifest {
    pub version: u32,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    pub count: usize,
    pub objects: Vec<ManifestObject>,
}

#[must_use]
pub fn build_object_storage_manifest(
    objects: &[ManifestObject],
    now: chrono::DateTime<chrono::Utc>,
) -> ObjectStorageManifest {
    ObjectStorageManifest {
        version: 1,
        generated_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        count: objects.len(),
        objects: objects.to_vec(),
    }
}

/// Compare the restored active rows with the manifest captured at backup time.
#[must_use]
pub fn compare_object_storage_manifest(
    manifest: &ObjectStorageManifest,
    restored: &[ManifestObject],
) -> (bool, String) {
    let expected: BTreeMap<&str, &ManifestObject> = manifest
        .objects
        .iter()
        .map(|object| (object.id.as_str(), object))
        .collect();
    let actual: BTreeMap<&str, &ManifestObject> = restored
        .iter()
        .map(|object| (object.id.as_str(), object))
        .collect();
    let missing = expected
        .keys()
        .filter(|id| !actual.contains_key(*id))
        .count();
    let extra = actual
        .keys()
        .filter(|id| !expected.contains_key(*id))
        .count();
    let changed = expected
        .values()
        .filter(|object| {
            actual.get(object.id.as_str()).is_some_and(|row| {
                row.storage_key != object.storage_key
                    || row.bucket != object.bucket
                    || row.sha256_hex != object.sha256_hex
            })
        })
        .count();
    if missing + extra + changed > 0 {
        (
            false,
            format!("object manifest mismatch: missing={missing} extra={extra} changed={changed}"),
        )
    } else {
        (
            true,
            format!(
                "manifest matches {} restored ACTIVE object(s)",
                restored.len()
            ),
        )
    }
}

pub const OBJECT_STORAGE_EXISTS_QUERY: &str =
    "SELECT to_regclass('public.storage_objects') IS NOT NULL;";

pub const RESTORED_ACTIVE_REFS_QUERY: &str = "SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text FROM (SELECT id::text AS \"id\", bucket::text AS \"bucket\", storage_key AS \"storageKey\", sha256_hex AS \"sha256Hex\", byte_size::text AS \"byteSize\" FROM storage_objects WHERE status = 'ACTIVE') t;";

/// Reads the recorded manifest from the backup repository.
pub async fn load_manifest(
    repository: &ArtifactRepository,
) -> Result<Option<ObjectStorageManifest>, String> {
    let Some(raw) = repository.get_buffer(OBJECT_STORAGE_MANIFEST_KEY).await else {
        return Ok(None);
    };
    serde_json::from_slice(&raw)
        .map(Some)
        .map_err(|error| format!("object-storage active-manifest.json is unreadable: {error}"))
}

/// Parses the restored ACTIVE rows returned by [`RESTORED_ACTIVE_REFS_QUERY`].
pub fn parse_restored_objects(stdout: &str) -> Result<Vec<ManifestObject>, String> {
    let value: Value = serde_json::from_str(stdout.trim())
        .map_err(|error| format!("restored object query: {error}"))?;
    serde_json::from_value(value).map_err(|error| format!("restored object rows: {error}"))
}

/// The manifest parity half of the restore drill. Returns `None` when no manifest was recorded
/// (object storage was not configured at backup time).
pub async fn verify_manifest_parity(
    repository: &Arc<ArtifactRepository>,
    restored: &[ManifestObject],
) -> Result<Option<(bool, String)>, String> {
    let Some(manifest) = load_manifest(repository).await? else {
        return Ok(None);
    };
    Ok(Some(compare_object_storage_manifest(&manifest, restored)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(id: &str, key: &str, hash: &str) -> ManifestObject {
        ManifestObject {
            id: id.to_owned(),
            bucket: "HOT".to_owned(),
            storage_key: key.to_owned(),
            sha256_hex: hash.to_owned(),
            byte_size: "10".to_owned(),
        }
    }

    #[test]
    fn parity_requires_an_exact_active_set() {
        let objects = vec![object("a", "k/a", "h1"), object("b", "k/b", "h2")];
        let manifest = build_object_storage_manifest(
            &objects,
            chrono::DateTime::parse_from_rfc3339("2026-11-06T00:00:00Z")
                .expect("date")
                .with_timezone(&chrono::Utc),
        );
        assert!(compare_object_storage_manifest(&manifest, &objects).0);
        let mut missing = objects.clone();
        missing.pop();
        assert!(!compare_object_storage_manifest(&manifest, &missing).0);
        let mut changed = objects.clone();
        changed[0].storage_key = "k/other".to_owned();
        let (ok, detail) = compare_object_storage_manifest(&manifest, &changed);
        assert!(!ok);
        assert!(detail.contains("changed=1"));
    }
}
