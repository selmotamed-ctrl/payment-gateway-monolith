# db/

Reserved for the Rust-owned database migrations after P10-T01 (plan §6). Until the P10 gate, Prisma
migrations in `core-back/prisma/migrations` remain the only schema owner (AD-04); the Rust migrator
will import their history and keep `_prisma_migrations` compatible.

Planned contents: `migrations/`, `audit/`, `log/`, `sql-only-objects.allowlist.json` (with
definition fingerprints, S-DB-13) and `schema-snapshot.sql` generated after every migration.
