//! `backup-daemon-rs` — backup control plane and restore drill engine (P9-T02).
//!
//! Port of `deploy/backup-daemon/src/**` (chapter 2 §8). The module layout follows the
//! TypeScript originals:
//!
//! | module | TypeScript source |
//! | :--- | :--- |
//! | [`config`] | `src/config.ts` |
//! | [`cron`] | `src/cron.ts` |
//! | [`crypto`] | `src/cryptoEnvelope.ts` |
//! | [`command_runner`] | `src/commandRunner.ts` |
//! | [`artifacts`] | `src/artifactStore.ts` + `src/repository.ts` |
//! | [`catalog`] | `src/catalogStore.ts` + `src/catalogMirror.ts` |
//! | [`job_queue`] | `src/jobQueue.ts` |
//! | [`instance_lock`] | `src/instanceLock.ts` |
//! | [`pg_tools`] | `src/pgTools.ts` |
//! | [`wal_names`] | `src/walNames.ts` |
//! | [`wal_archive`] | `src/walArchive.ts` |
//! | [`logical_dump`] | `src/logicalDump.ts` |
//! | [`engine`] | `src/backupEngine.ts` + `src/pgNativeEngine.ts` |
//! | [`drill`] | `src/restoreDrillRunner.ts` |
//! | [`scheduler`] | `src/scheduler.ts` |
//! | [`server`] | `src/server.ts` |
//! | [`object_storage`] | `src/objectStorageBackup.ts` (manifest parity only) |
//!
//! Deviations from the TypeScript implementation are listed in `README.md`.

#![forbid(unsafe_code)]

pub mod artifacts;
pub mod catalog;
pub mod command_runner;
pub mod config;
pub mod cron;
pub mod crypto;
pub mod drill;
pub mod engine;
pub mod instance_lock;
pub mod job_queue;
pub mod logical_dump;
pub mod object_storage;
pub mod pg_tools;
pub mod scheduler;
pub mod server;
pub mod startup;
pub mod util;
pub mod wal_archive;
pub mod wal_names;

/// Version reported by `GET /health` when the caller does not inject one.
pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");
