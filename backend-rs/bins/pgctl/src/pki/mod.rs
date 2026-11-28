//! PKI v2: in-process CA/leaf issuance, inventory, renewal, revocation, dev bundle and the
//! storage TLS plan section (D4-T01/T02).
//!
//! Chapter 7 §6 replaces the openssl-based `deploy/lib/pkiManager.ts` with `rcgen` and ECDSA
//! P-256, adds a per-environment intermediate CA, a deterministic inventory, a documented
//! revocation list/CRL and storage server certificates for PostgreSQL, PgBouncer and Redis. The
//! CN/SAN table reproduces the allow-lists in `pg-mtls` and the two daemons.

#![forbid(unsafe_code)]

pub mod catalog;
pub mod commands;
pub mod inventory;
pub mod issue;
pub mod revocation;
pub mod storage;
pub mod timeutil;
pub mod verify;
