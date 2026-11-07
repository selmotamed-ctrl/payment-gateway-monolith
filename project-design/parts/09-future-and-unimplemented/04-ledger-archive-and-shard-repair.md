---
id: future.ledger-archive
title: Ledger Archive and Shard Repair Anchors (Future)
status: missing
confidence: high
last_verified: 2026-11-08
verified_against: working-tree
code:
design_sources:
tests:
gaps:
  - No journal archive exists. `journal_lines` is never purged (`RetentionWorker` deliberately excludes the ledger) and there is no archive store, manifest or restore path.
  - `planShardRepair`, the restore-drill parity query and the deploy gate all assume that EVERY journal line of a shard is in `journal_lines`; archiving without changing them would make a repair compute a wrong, smaller balance.
---

# Ledger Archive and Shard Repair Anchors (Future)

## 1. Purpose and scope

This part records a design decision for a feature that does **not exist yet**: moving old journal lines out of `journal_lines` into an archive to keep the live table small, and what that means for the per-shard checkpoints and for shard repair (`core.ledger` sections 3.6 and 3.10). It is not current behaviour. When archiving is implemented, move this part out of `09-future-and-unimplemented/` into `01-core-back/` and update `project-design/TRACKER.md`.

## 2. Owner decision: the archive is the default source of truth for a repair

Once old lines are archived, a shard's balance can no longer be recomputed from the live table alone. A repair of a damaged shard (RECOMPUTE or REBASELINE) has two possible sources:

1. **Archive plus live** — sum every line that ever existed: the archived lines of the shard plus its live lines. This is the strongest source.
2. **Anchor plus live** — start from the shard's last trusted checkpoint (its balance at the archive cut) and add the live lines after it. This is cheap and needs no archive access, but it is only as trustworthy as that checkpoint.

**Decision (2026-11-08):** a repair uses **archive plus live by default**. The **anchor shortcut is used only when the deployment explicitly enables it through a deploy environment variable** (to be named when the feature is built, for example `LEDGER_SHARD_REPAIR_USE_ANCHOR`, default `false`, defined in `core-back/lib/env/index.ts`, `deploy/lib/configSchema.ts`, `deploy/lib/hostPlanner.ts` and the deploy env examples). With the variable off, a repair that cannot read the archive must refuse, never fall back silently to the anchor.

## 3. Requirements for the feature

These are what makes either source safe:

- **Archive only below a verified checkpoint.** A shard's lines are archived up to a sequence number whose checkpoint was proven (`CheckpointService.captureShard`) at that moment.
- **A per-shard anchor.** Record `archived_through_seq`, the balance at that point and a manifest of the archived range (line count, signed sum, content hash). The archive is verified against the manifest before the live rows are deleted.
- **The archive is immutable and independently readable.** An archive that cannot be read must make a default-mode repair fail with a clear error.
- **Repair planning is source-aware.** `planShardRepair` takes the line source (archive plus live, or anchor plus live), checks that the archive agrees with the anchor manifest in the default mode and reports any difference, and records the source used in `gl_shard_repairs.details_json` and the audit row.
- **The other deep checks follow the same rule.** The restore drill parity query and the deploy gate count only the lines above the archive anchor (the same way they already honour `baseline_seq`), or read the archive in default mode.
- **Append-only protection.** The archive path needs its own guards: the ledger triggers still reject deletes, so the archiver is a deliberate maintenance operation (`pgw.ledger_maintenance`), audited, and never part of the general retention worker.
- **`baseline_seq` stays compatible.** A re-baselined shard keeps its exemption for the damaged history; the archive anchor must not be placed below an unrepaired gap.

## 4. Verification when implemented

Real-PostgreSQL tests with a small archive: repair from archive plus live equals the pre-archive repair result; the anchor mode equals it when the checkpoint was proven; a tampered archive (manifest mismatch) is detected; a default-mode repair refuses when the archive is unreadable; the restore drill and deploy gate pass on a shard with an archived prefix.
