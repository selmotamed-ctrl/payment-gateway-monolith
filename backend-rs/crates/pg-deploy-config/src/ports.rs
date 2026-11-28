//! Listener ports verified against the TypeScript deploy engine.
//!
//! Port of `deploy/lib/configSchema.ts` defaults and `deploy/lib/hostPlanner.ts` service names
//! (chapter 7 §7, D0-T01). Every value below was read from the TS source before being written
//! here; the file/line references are the evidence.
//!
//! | Service | Port | TS evidence |
//! | :--- | ---: | :--- |
//! | core (`pg-core-back`) | 4000 | `configSchema.ts` `CORE_PORT` default, `deploy.env.example:90` |
//! | sandbox core (`pg-core-sandbox`) | 4005 | `configSchema.ts` `SANDBOX_CORE_PORT`, `deploy.env.example:447` |
//! | admin edge (`pg-admin-back`) | 4101 | `configSchema.ts` `ADMIN_BACK_PORT`, `deploy.env.example:101` |
//! | merchant edge (`pg-merchant-back`) | 4102 | `configSchema.ts` `MERCHANT_BACK_PORT`, `deploy.env.example:117` |
//! | checkout edge (`pg-checkout-back`) | 4103 | `configSchema.ts` `CHECKOUT_BACK_PORT`, `deploy.env.example:136` |
//! | fake rails backend (`pg-fake-rails-back`) | 4104 | `configSchema.ts` `FAKE_RAILS_BACK_PORT`, `deploy.env.example:462` |
//! | admin nginx (LAN) | 8443 | `configSchema.ts` `ADMIN_NGINX_LAN_PORT`, `deploy.env.example:102` |
//! | fake rails nginx | 8444 | `configSchema.ts` `FAKE_RAILS_NGINX_PORT`, `deploy.env.example:463` |
//! | merchant public HTTP / HTTPS | 80 / 443 | `configSchema.ts` `MERCHANT_HTTP_PORT` / `MERCHANT_HTTPS_PORT` |
//! | merchant LAN | 8081 | `configSchema.ts` `MERCHANT_LAN_PORT`, `deploy.env.example:121` |
//! | checkout public HTTP / HTTPS | 80 / 443 | `configSchema.ts` `CHECKOUT_HTTP_PORT` / `CHECKOUT_HTTPS_PORT` |
//! | checkout LAN | 8082 | `configSchema.ts` `CHECKOUT_LAN_PORT`, `deploy.env.example:140` |
//! | PostgreSQL 18 | 5432 | `configSchema.ts` `DB_PORT`, `DEPLOYMENT_GUIDE.md:656` |
//! | PgBouncer | 6432 | `configSchema.ts` `PGBOUNCER_PORT`, `deploy.env.example:189` |
//! | Redis | 6379 | `DEPLOYMENT_GUIDE.md:661` (`REDIS_NODES` service port) |
//! | backup daemon | 4090 | `configSchema.ts` `BACKUP_DAEMON_PORT`, `deploy.env.example:307` |
//! | object storage daemon | 4095 | `configSchema.ts` `OBJECT_STORAGE_DAEMON_PORT`, `deploy.env.example:356` |
//! | backup drill scratch clusters | 55432 / 55433 | `configSchema.ts` `BACKUP_SCRATCH_PORT` / `BACKUP_SCRATCH_AUDIT_PORT` |
//! | managed MinIO console | 9001 | `configSchema.ts` `BACKUP_MINIO_CONSOLE_PORT` |
//!
//! The Rust coexistence ports (chapter 7 §10, P3-T11/D2-T01) are *additions*, not part of the
//! TypeScript plan: when `impl = "both"` the Rust core listens on 4010 (Live) and 4015 (Sandbox)
//! beside the TypeScript core on 4000/4005.

#![forbid(unsafe_code)]

/// TypeScript/Live core listener.
pub const CORE_PORT: u16 = 4000;
/// Sandbox core listener (parallel execution plane, v38/v39).
pub const CORE_SANDBOX_PORT: u16 = 4005;
/// Rust core coexistence listener while `impl = "both"` (chapter 7 §10).
pub const CORE_RS_COEXIST_PORT: u16 = 4010;
/// Rust sandbox core coexistence listener while `impl = "both"`.
pub const CORE_RS_COEXIST_SANDBOX_PORT: u16 = 4015;
/// Admin edge BFF.
pub const ADMIN_BACK_PORT: u16 = 4101;
/// Merchant edge BFF.
pub const MERCHANT_BACK_PORT: u16 = 4102;
/// Checkout edge BFF.
pub const CHECKOUT_BACK_PORT: u16 = 4103;
/// Fake Rails Express backend (loopback).
pub const FAKE_RAILS_BACK_PORT: u16 = 4104;
/// Fake Rails nginx listener (portal, hosted pages, gateway APIs).
pub const FAKE_RAILS_NGINX_PORT: u16 = 8444;
/// Admin portal nginx listener (LAN only, never forwarded).
pub const ADMIN_NGINX_LAN_PORT: u16 = 8443;
/// Merchant public plain-HTTP listener.
pub const MERCHANT_HTTP_PORT: u16 = 80;
/// Merchant public TLS listener.
pub const MERCHANT_HTTPS_PORT: u16 = 443;
/// Merchant LAN-only listener (no domain).
pub const MERCHANT_LAN_PORT: u16 = 8081;
/// Checkout public plain-HTTP listener.
pub const CHECKOUT_HTTP_PORT: u16 = 80;
/// Checkout public TLS listener.
pub const CHECKOUT_HTTPS_PORT: u16 = 443;
/// Checkout LAN-only listener (no domain).
pub const CHECKOUT_LAN_PORT: u16 = 8082;
/// PostgreSQL 18 (primary, replicas, audit and log databases).
pub const POSTGRES_PORT: u16 = 5432;
/// PgBouncer transaction/session pooler.
pub const PGBOUNCER_PORT: u16 = 6432;
/// Redis / Valkey.
pub const REDIS_PORT: u16 = 6379;
/// Shared object and asset storage daemon.
pub const OBJECT_STORAGE_PORT: u16 = 4095;
/// Backup daemon control plane.
pub const BACKUP_DAEMON_PORT: u16 = 4090;
/// Restore-drill scratch PostgreSQL cluster.
pub const BACKUP_SCRATCH_PORT: u16 = 55432;
/// Restore-drill scratch audit cluster.
pub const BACKUP_SCRATCH_AUDIT_PORT: u16 = 55433;
/// Managed MinIO console (the S3 API keeps the endpoint port).
pub const MINIO_CONSOLE_PORT: u16 = 9001;

/// The complete port table, for documentation, tests and `pgctl plan --json` consumers.
pub const VERIFIED_PORTS: &[(&str, u16)] = &[
    ("core", CORE_PORT),
    ("core-sandbox", CORE_SANDBOX_PORT),
    ("core-rs-coexist", CORE_RS_COEXIST_PORT),
    ("core-rs-coexist-sandbox", CORE_RS_COEXIST_SANDBOX_PORT),
    ("admin", ADMIN_BACK_PORT),
    ("merchant", MERCHANT_BACK_PORT),
    ("checkout", CHECKOUT_BACK_PORT),
    ("fake-rails", FAKE_RAILS_BACK_PORT),
    ("fake-rails-nginx", FAKE_RAILS_NGINX_PORT),
    ("admin-nginx", ADMIN_NGINX_LAN_PORT),
    ("merchant-http", MERCHANT_HTTP_PORT),
    ("merchant-https", MERCHANT_HTTPS_PORT),
    ("merchant-lan", MERCHANT_LAN_PORT),
    ("checkout-http", CHECKOUT_HTTP_PORT),
    ("checkout-https", CHECKOUT_HTTPS_PORT),
    ("checkout-lan", CHECKOUT_LAN_PORT),
    ("postgres", POSTGRES_PORT),
    ("pgbouncer", PGBOUNCER_PORT),
    ("redis", REDIS_PORT),
    ("object-storage", OBJECT_STORAGE_PORT),
    ("backup", BACKUP_DAEMON_PORT),
    ("backup-scratch", BACKUP_SCRATCH_PORT),
    ("backup-scratch-audit", BACKUP_SCRATCH_AUDIT_PORT),
    ("minio-console", MINIO_CONSOLE_PORT),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_defaults_are_reproduced() {
        assert_eq!(CORE_PORT, 4000);
        assert_eq!(CORE_SANDBOX_PORT, 4005);
        assert_eq!(ADMIN_BACK_PORT, 4101);
        assert_eq!(MERCHANT_BACK_PORT, 4102);
        assert_eq!(CHECKOUT_BACK_PORT, 4103);
        assert_eq!(FAKE_RAILS_BACK_PORT, 4104);
        assert_eq!(FAKE_RAILS_NGINX_PORT, 8444);
        assert_eq!(ADMIN_NGINX_LAN_PORT, 8443);
        assert_eq!(MERCHANT_LAN_PORT, 8081);
        assert_eq!(CHECKOUT_LAN_PORT, 8082);
        assert_eq!(POSTGRES_PORT, 5432);
        assert_eq!(PGBOUNCER_PORT, 6432);
        assert_eq!(REDIS_PORT, 6379);
        assert_eq!(OBJECT_STORAGE_PORT, 4095);
        assert_eq!(BACKUP_DAEMON_PORT, 4090);
    }

    #[test]
    fn backend_listeners_do_not_collide() {
        let backends = [
            CORE_PORT,
            CORE_SANDBOX_PORT,
            ADMIN_BACK_PORT,
            MERCHANT_BACK_PORT,
            CHECKOUT_BACK_PORT,
            FAKE_RAILS_BACK_PORT,
            BACKUP_DAEMON_PORT,
            OBJECT_STORAGE_PORT,
            POSTGRES_PORT,
            PGBOUNCER_PORT,
            REDIS_PORT,
            ADMIN_NGINX_LAN_PORT,
            FAKE_RAILS_NGINX_PORT,
            MERCHANT_LAN_PORT,
            CHECKOUT_LAN_PORT,
        ];
        let mut seen = std::collections::BTreeSet::new();
        for port in backends {
            assert!(seen.insert(port), "port {port} is claimed twice");
        }
    }

    #[test]
    fn every_documented_port_has_a_unique_name() {
        let mut names = std::collections::BTreeSet::new();
        for (name, port) in VERIFIED_PORTS {
            assert!(names.insert(*name), "duplicate name {name}");
            assert_ne!(*port, 0);
        }
        // 80 and 443 are legitimately shared by the two public vhosts (server_name routing).
        assert_eq!(VERIFIED_PORTS.len(), 24);
    }
}
