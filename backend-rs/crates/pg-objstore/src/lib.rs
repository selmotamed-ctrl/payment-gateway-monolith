//! Object storage: filesystem blob store, remote mTLS client and the `pgos1` envelope.
//!
//! Ports: `deploy/object-storage-daemon/src/shared/blobStore.ts` and
//! `core-back/lib/objectStorageSdk/{blobStore,crypto,sniff}.ts` (chapter 2 §7).

#![forbid(unsafe_code)]

pub mod blob_store;
pub mod pgos1;
pub mod remote;
pub mod sdk;
pub mod sniff;

pub use blob_store::{
    sanitize_rel_path, BlobHealthReport, BlobListEntry, BlobStore, BucketTier, FsBlobStore,
    StorageError,
};
pub use pgos1::{
    decrypt_pgos1, dev_kek_from_database_url, seal_pgos1, KekKeyring, ObjectCryptoMetadata,
    Pgos1Error,
};
pub use remote::{RemoteMtlsBlobStore, RemoteTlsConfig};
pub use sdk::{
    build_storage_key, gc_decision, gc_eligible_after_release, orphan_sweep_allowed,
    retention_until, validate_stage, ConfidentialityTier, GcCandidate, GcDecision, NamespacePolicy,
    StageError, StorageHolderType, StorageNamespace, StorageObjectStatus,
};
pub use sniff::{detect_mime, is_executable, DetectedKind};
