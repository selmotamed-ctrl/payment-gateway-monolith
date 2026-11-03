import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../generated/prisma/client";
import { buildMariaDbPoolConfig } from "../lib/db/connectionConfig";
import { LedgerPoster } from "../engine/ledger/LedgerPoster";
import { PrismaSlotReservationStore } from "../engine/runtime/slotStore";
import { InvariantVerifier } from "../engine/ledger/InvariantVerifier";
import { withTxRetry, snapshotTxRetryMetrics, resetTxRetryMetrics } from "../lib/db/withTxRetry";

const DATABASE_URL = process.env.BENCHMARK_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? "mysql://admin:admin@127.0.0.1:3306/payment_gateway_monolith";
const SOAK_SECONDS = Number(process.env.BENCHMARK_SOAK_SECONDS ?? 300);
const SOAK_WRITERS = Number(process.env.BENCHMARK_SOAK_WRITERS ?? 64);
const SOAK_RATE_MS = Number(process.env.BENCHMARK_SOAK_RATE_MS ?? 250);
const T2_CONCURRENCY = Number(process.env.BENCHMARK_T2_CONCURRENCY ?? 1000);
const PREFIX = `bench-${Date.now()}-${randomUUID().slice(0, 8)}`;

const connect = (): PrismaClient => new PrismaClient({
  adapter: new PrismaMariaDb(buildMariaDbPoolConfig(DATABASE_URL) as never),
  log: [],
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const firstValue = async (client: PrismaClient, sql: string): Promise<string> => {
  try {
    const rows = await client.$queryRawUnsafe(sql) as Array<Record<string, unknown>>;
    const value = rows[0]?.value;
    return value === null || value === undefined ? "" : String(value);
  } catch {
    return "";
  }
};

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

const planMetrics = (plan: unknown): Record<string, unknown> => {
  const text = JSON.stringify(plan ?? {}).toLowerCase();
  let found: Record<string, any> | undefined;
  const walk = (node: any): void => {
    if (!node || typeof node !== "object" || found) return;
    if (node.table_name) {
      found = node;
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
      } else {
        walk(value);
      }
    }
  };
  walk(plan);
  return {
    table: found?.table_name,
    accessType: found?.access_type,
    key: found?.key,
    rows: found?.rows === undefined ? null : Number(found.rows),
    rRows: found?.r_rows === undefined ? null : Number(found.r_rows),
    filesort: text.includes("filesort") || text.includes("using_filesort"),
    temporary: text.includes("temporary_table") || text.includes("using_temporary_table"),
  };
};

interface QueryCase {
  id: string;
  label: string;
  sql: string;
  binds?: unknown[];
  write?: boolean;
}

const catalogueQueries = (samples: Record<string, string>): QueryCase[] => {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const fallback = randomUUID();
  const value = (key: string): string => samples[key] || fallback;
  return [
    {
      id: "1", label: "Checkout page by link key",
      sql: "SELECT id, `key`, application_id, wallet_id, amount, currency, fee_bearer, infinite_use, use_count, confirmed_count, active_locked_count, state, expires_at FROM payment_links WHERE `key` = ?",
      binds: [value("linkKey")],
    },
    {
      id: "2", label: "Finite-link slot reservation", write: true,
      sql: "UPDATE payment_links SET active_locked_count = active_locked_count + 1, updated_at = NOW(3) WHERE id = ? AND infinite_use = 0 AND confirmed_count + active_locked_count < use_count",
      binds: [value("linkId")],
    },
    {
      id: "3", label: "Attempt-group create-or-get", write: true,
      sql: "INSERT INTO attempt_groups (id, link_id, customer_fingerprint, success_count) VALUES (?, ?, ?, 0) ON DUPLICATE KEY UPDATE id = id",
      binds: [randomUUID(), value("linkId"), "0".repeat(64)],
    },
    {
      id: "5", label: "Deadline create-or-update", write: true,
      sql: "INSERT INTO attempt_deadlines (attempt_id, kind, due_at, claimed_until, claimed_by) VALUES (?, 'EXPIRE', ?, NULL, NULL) ON DUPLICATE KEY UPDATE due_at = VALUES(due_at)",
      binds: [value("attemptId"), now],
    },
    {
      id: "6", label: "Confirm lock by reference",
      sql: "SELECT id, status, link_id, attempt_group_id, merchant_id, rail_id, route_id, credential_set_id, gateway_version_id, commission_profile_id, total_charged_amount, currency, expires_at, grace_expires_at, point_of_no_return FROM payment_attempts WHERE reference = ? FOR UPDATE",
      binds: [value("reference")],
    },
    {
      id: "7", label: "Attempt-group success guard", write: true,
      sql: "UPDATE attempt_groups SET success_count = success_count + 1 WHERE id = ? AND success_count = 0",
      binds: [randomUUID()],
    },
    {
      id: "8", label: "Deadline delete", write: true,
      sql: "DELETE FROM attempt_deadlines WHERE attempt_id = ?",
      binds: [value("attemptId")],
    },
    {
      id: "9", label: "Webhook by provider reference",
      sql: "SELECT id, merchant_id, status, total_charged_amount, currency FROM payment_attempts WHERE provider_reference = ? ORDER BY created_at DESC LIMIT 5",
      binds: [value("providerRef")],
    },
    {
      id: "10", label: "Webhook by gateway reference",
      sql: "SELECT id, merchant_id, status, total_charged_amount FROM payment_attempts WHERE gateway_reference = ? LIMIT 5",
      binds: [value("gatewayRef")],
    },
    {
      id: "11", label: "Statement match by provider reference",
      sql: "SELECT id, status, total_charged_amount, gateway_fee_amount, currency FROM payment_attempts WHERE provider_reference = ? LIMIT 1",
      binds: [value("providerRef")],
    },
    {
      id: "12", label: "Statement match by network reference",
      sql: "SELECT id, status, total_charged_amount FROM payment_attempts WHERE network_reference = ? LIMIT 1",
      binds: [value("networkRef")],
    },
    {
      id: "13", label: "Inbox claim",
      sql: "SELECT id, channel_id, gateway_id, env, source_ip, verified, dedupe_key, received_at, processed_at FROM inbound_events WHERE processed_at IS NULL ORDER BY received_at ASC LIMIT 50 FOR UPDATE SKIP LOCKED",
    },
    {
      id: "14", label: "Reconciliation item list",
      sql: "SELECT id, run_id, attempt_id, our_reference, provider_reference, statement_amount, statement_fee, result FROM reconciliation_items WHERE run_id = ? ORDER BY id LIMIT 100",
      binds: [value("runId")],
    },
    {
      id: "15", label: "Background job claim",
      sql: "SELECT id, job_type, reference_type, reference_id, payload_json, attempts FROM background_jobs WHERE state = 'QUEUED' AND available_at <= ? ORDER BY available_at ASC LIMIT 10 FOR UPDATE SKIP LOCKED",
      binds: [now],
    },
    {
      id: "16", label: "Merchant list default",
      sql: "SELECT id, reference, status, total_charged_amount, currency, created_at FROM payment_attempts WHERE merchant_id = ? ORDER BY created_at DESC, id DESC LIMIT 50",
      binds: [value("merchantId")],
    },
    {
      id: "17", label: "Merchant list by status",
      sql: "SELECT id, reference, status, total_charged_amount, currency, created_at FROM payment_attempts WHERE merchant_id = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT 50",
      binds: [value("merchantId"), "SUCCEEDED"],
    },
    {
      id: "18", label: "Admin global list by status",
      sql: "SELECT id, reference, merchant_id, status, total_charged_amount, created_at FROM payment_attempts WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT 50",
      binds: ["SUCCEEDED"],
    },
    {
      id: "19", label: "Admin merchant list by status",
      sql: "SELECT id, legalName, tradeName, status, kybStatus, created_at FROM merchants WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT 50",
      binds: ["ACTIVE"],
    },
    {
      id: "20", label: "Merchant name full-text search",
      sql: "SELECT id, legalName, tradeName, status FROM merchants WHERE MATCH(legalName, tradeName) AGAINST (? IN BOOLEAN MODE) LIMIT 20",
      binds: ["merchant*"],
    },
    {
      id: "21", label: "Merchant identifier search",
      sql: "SELECT id, legalName, taxId, registrationNo FROM merchants WHERE taxId = ? OR registrationNo = ? OR contactEmail = ? OR contactPhone = ? LIMIT 20",
      binds: ["none", "none", "none", "none"],
    },
    {
      id: "22", label: "Exact payment reference search",
      sql: "SELECT id, reference, merchant_id, status, total_charged_amount FROM payment_attempts WHERE reference = ? LIMIT 20",
      binds: [value("reference")],
    },
    {
      id: "23", label: "Sweeper claim",
      sql: "SELECT attempt_id, kind, due_at FROM attempt_deadlines WHERE kind IN (?) AND due_at <= ? AND (claimed_until IS NULL OR claimed_until < ?) ORDER BY due_at LIMIT 50 FOR UPDATE SKIP LOCKED",
      binds: ["EXPIRE", now, now],
    },
    {
      id: "24", label: "Poll claim",
      sql: "SELECT attempt_id, kind, due_at FROM attempt_deadlines WHERE kind IN (?) AND due_at <= ? AND (claimed_until IS NULL OR claimed_until < ?) ORDER BY due_at LIMIT 50 FOR UPDATE SKIP LOCKED",
      binds: ["POLL", now, now],
    },
    {
      id: "25", label: "Wallet balance (SYNC)",
      sql: "SELECT current_balance, balance_floor FROM gl_accounts WHERE id = ? AND balance_mode = 'SYNC'",
      binds: [value("syncAccountId")],
    },
    {
      id: "26", label: "Wallet balance (SHARDED)",
      sql: "SELECT shard_no, balance, line_count FROM gl_balance_shards WHERE gl_account_id = ?",
      binds: [value("shardAccountId")],
    },
    {
      id: "27", label: "Balance verification open window",
      sql: "SELECT created_at, direction, amount FROM journal_lines WHERE gl_account_id = ? AND created_at >= ? ORDER BY created_at",
      binds: [value("syncAccountId"), new Date(Date.now() - 30 * 86_400_000)],
    },
    {
      id: "28", label: "Route daily volume read",
      sql: "SELECT shard_no, succeeded_count, total_charged_amount FROM route_daily_volumes WHERE route_id = ? AND day_bucket = ?",
      binds: [value("routeId"), day],
    },
    {
      id: "29", label: "Route daily volume write", write: true,
      sql: "INSERT INTO route_daily_volumes (route_id, day_bucket, shard_no, succeeded_count, total_charged_amount) VALUES (?, ?, ?, 1, ?) ON DUPLICATE KEY UPDATE succeeded_count = succeeded_count + 1, total_charged_amount = total_charged_amount + VALUES(total_charged_amount)",
      binds: [value("routeId"), day, 0, "1.0000"],
    },
    {
      id: "30", label: "Velocity counter increment", write: true,
      sql: "INSERT INTO velocity_counters (scope_type, scope_key, granularity, bucket, attempts, succeeded, amount) VALUES (?, ?, ?, ?, 1, 0, ?) ON DUPLICATE KEY UPDATE attempts = attempts + 1, amount = amount + VALUES(amount)",
      binds: ["END_CLIENT_IP", value("scopeKey") || "0".repeat(64), 1, Math.floor(Date.now() / 60_000), "1.0000"],
    },
    {
      id: "31", label: "Velocity window read",
      sql: "SELECT bucket, attempts, succeeded, amount FROM velocity_counters WHERE scope_type = ? AND scope_key = ? AND granularity = ? AND bucket BETWEEN ? AND ?",
      binds: ["END_CLIENT_IP", value("scopeKey") || "0".repeat(64), 1, 0, Math.floor(Date.now() / 60_000)],
    },
    {
      id: "32", label: "KYB duplicate document",
      sql: "SELECT merchant_id FROM kyb_documents WHERE sha256 = ? AND merchant_id <> ? LIMIT 1",
      binds: [value("kybSha") || "0".repeat(64), value("merchantId")],
    },
    {
      id: "33", label: "Cache invalidation poll",
      sql: "SELECT event_seq, topic, payload_key, created_at FROM cache_invalidation_events WHERE event_seq > ? ORDER BY event_seq LIMIT 500",
      binds: [0],
    },
    {
      id: "34", label: "Cache invalidation purge", write: true,
      sql: "DELETE FROM cache_invalidation_events WHERE created_at < ? LIMIT 5000",
      binds: [new Date(Date.now() - 3_600_000)],
    },
  ];
};

const runCatalogue = async (client: PrismaClient): Promise<Array<Record<string, unknown>>> => {
  const samples: Record<string, string> = {
    linkKey: await firstValue(client, "SELECT `key` AS value FROM payment_links WHERE `state` = 'PENDING' LIMIT 1"),
    linkId: await firstValue(client, "SELECT id AS value FROM payment_links WHERE `state` = 'PENDING' LIMIT 1"),
    attemptId: await firstValue(client, "SELECT id AS value FROM payment_attempts LIMIT 1"),
    reference: await firstValue(client, "SELECT reference AS value FROM payment_attempts LIMIT 1"),
    providerRef: await firstValue(client, "SELECT provider_reference AS value FROM payment_attempts WHERE provider_reference IS NOT NULL LIMIT 1"),
    gatewayRef: await firstValue(client, "SELECT gateway_reference AS value FROM payment_attempts WHERE gateway_reference IS NOT NULL LIMIT 1"),
    networkRef: await firstValue(client, "SELECT network_reference AS value FROM payment_attempts WHERE network_reference IS NOT NULL LIMIT 1"),
    merchantId: await firstValue(client, "SELECT merchant_id AS value FROM payment_attempts LIMIT 1"),
    runId: await firstValue(client, "SELECT run_id AS value FROM reconciliation_items LIMIT 1"),
    routeId: await firstValue(client, "SELECT route_id AS value FROM rail_routes LIMIT 1"),
    syncAccountId: await firstValue(client, "SELECT id AS value FROM gl_accounts WHERE balance_mode = 'SYNC' LIMIT 1"),
    shardAccountId: await firstValue(client, "SELECT id AS value FROM gl_accounts WHERE balance_mode = 'SHARDED' LIMIT 1"),
    kybSha: await firstValue(client, "SELECT sha256 AS value FROM kyb_documents LIMIT 1"),
    scopeKey: await firstValue(client, "SELECT scope_key AS value FROM velocity_counters LIMIT 1"),
  };

  const results: Array<Record<string, unknown>> = [];
  for (const query of catalogueQueries(samples)) {
    const started = performance.now();
    try {
      const analyze = !query.write && !/FOR\s+UPDATE/i.test(query.sql);
      const sql = `${analyze ? "ANALYZE" : "EXPLAIN"} FORMAT=JSON ${query.sql}`;
      const raw = await client.$queryRawUnsafe(sql, ...(query.binds ?? [])) as unknown;
      const unwrap = (value: unknown): unknown => {
        if (typeof value === "string") {
          try { return JSON.parse(value); } catch { return value; }
        }
        if (Array.isArray(value) && value.length > 0) {
          const first = value[0];
          if (typeof first === "string") {
            try { return JSON.parse(first); } catch { return first; }
          }
          if (first && typeof first === "object") {
            const inner = Object.values(first)[0];
            if (typeof inner === "string") {
              try { return JSON.parse(inner); } catch { return first; }
            }
            return first;
          }
        }
        return value;
      };
      const parsed = unwrap(raw);
      results.push({
        id: query.id,
        label: query.label,
        write: Boolean(query.write),
        analyzed: analyze,
        elapsedMs: Number((performance.now() - started).toFixed(3)),
        ...planMetrics(parsed),
      });
    } catch (error) {
      results.push({
        id: query.id,
        label: query.label,
        write: Boolean(query.write),
        error: error instanceof Error ? error.message.split("\n").slice(-2).join(" ") : String(error),
      });
    }
  }
  return results;
};

const createAccounts = async (client: PrismaClient): Promise<Record<string, string>> => {
  const accounts: Record<string, string> = {};
  const insert = async (key: string, type: string, mode: "SYNC" | "SHARDED"): Promise<void> => {
    const id = randomUUID();
    await client.$executeRawUnsafe(
      "INSERT INTO gl_accounts (id, account_type, balance_mode, currency, current_balance) VALUES (?, ?, ?, 'LYD', 0)",
      id,
      type,
      mode,
    );
    accounts[key] = id;
  };
  await insert("TREASURY", "TREASURY", "SHARDED");
  await insert("GATEWAY_CLEARING", "GATEWAY_CLEARING", "SHARDED");
  await insert("PLATFORM_INCOME", "PLATFORM_INCOME", "SHARDED");
  for (let merchant = 0; merchant < 10; merchant += 1) {
    await insert(`MERCHANT_WALLET_${merchant}`, "MERCHANT_WALLET", "SYNC");
  }
  return accounts;
};

const deleteBatches = async (
  client: PrismaClient,
  sql: string,
  binds: unknown[],
): Promise<void> => {
  for (;;) {
    const affected = await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET @pg_allow_ledger_mutation = 1");
      const count = await tx.$executeRawUnsafe(sql, ...binds);
      await tx.$executeRawUnsafe("SET @pg_allow_ledger_mutation = 0");
      return Number(count);
    });
    if (affected === 0) {
      return;
    }
  }
};

const cleanupAccounts = async (client: PrismaClient, accounts: Record<string, string>, refPrefix: string): Promise<void> => {
  const ids = Object.values(accounts);
  await deleteBatches(
    client,
    "DELETE jl FROM journal_lines jl JOIN (SELECT id FROM journal_entries WHERE ref_id LIKE ? LIMIT 5000) e ON e.id = jl.entry_id",
    [`${refPrefix}%`],
  );
  await deleteBatches(
    client,
    "DELETE FROM journal_entries WHERE ref_id LIKE ? LIMIT 5000",
    [`${refPrefix}%`],
  );
  const placeholders = ids.map(() => "?").join(",");
  await client.$executeRawUnsafe(`DELETE FROM gl_balance_shards WHERE gl_account_id IN (${placeholders})`, ...ids);
  await client.$executeRawUnsafe(`DELETE FROM gl_period_totals WHERE gl_account_id IN (${placeholders})`, ...ids);
  await client.$executeRawUnsafe(`DELETE FROM gl_accounts WHERE id IN (${placeholders})`, ...ids);
};

const runConcurrency = async (client: PrismaClient): Promise<Record<string, unknown>> => {
  const linkId = randomUUID();
  const applicationId = await firstValue(client, "SELECT id AS value FROM applications LIMIT 1");
  const walletId = await firstValue(client, "SELECT id AS value FROM wallets LIMIT 1");
  await client.$executeRawUnsafe(
    `INSERT INTO payment_links (id, \`key\`, application_id, wallet_id, amount, currency, fee_bearer, infinite_use, use_count, confirmed_count, active_locked_count, state, updated_at)
     VALUES (?, ?, ?, ?, '1.0000', 'LYD', 'MERCHANT_ABSORBS', 1, 1, 0, 0, 'PENDING', NOW(3))`,
    linkId,
    `bench-${randomUUID().slice(0, 24)}`,
    applicationId,
    walletId,
  );
  const slotStore = new PrismaSlotReservationStore(client as never);
  const durations: number[] = [];
  const t1Started = performance.now();
  const t1 = await Promise.allSettled(Array.from({ length: 200 }, async (_, index) => {
    const started = performance.now();
    const result = await slotStore.reserveSlot({ id: `${PREFIX}-t1-${index}`, linkId } as never);
    durations.push(performance.now() - started);
    return result;
  }));
  const t1Result = {
    tasks: 200,
    fulfilled: t1.filter((entry) => entry.status === "fulfilled").length,
    rejected: t1.filter((entry) => entry.status === "rejected").length,
    elapsedMs: Number((performance.now() - t1Started).toFixed(3)),
    p50Ms: Number(percentile(durations, 0.5).toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
  };
  await client.$executeRawUnsafe("DELETE FROM payment_links WHERE id = ?", linkId);

  const accounts = await createAccounts(client);
  const refPrefix = `${PREFIX}-accounts`;
  const contexts = Array.from({ length: 10 }, (_, merchant) => ({
    accounts: {
      TREASURY: accounts.TREASURY!,
      GATEWAY_CLEARING: accounts.GATEWAY_CLEARING!,
      PLATFORM_INCOME: accounts.PLATFORM_INCOME!,
      MERCHANT_WALLET: accounts[`MERCHANT_WALLET_${merchant}`]!,
    },
  }));
  const poster = new LedgerPoster(client as never);

  resetTxRetryMetrics();
  const t2Started = performance.now();
  const t2 = await Promise.allSettled(Array.from({ length: T2_CONCURRENCY }, async (_, index) => {
    const context = contexts[index % contexts.length]!;
    return withTxRetry(() => poster.postScenario(
      "INTERNAL_CONFIRMATION",
      `${refPrefix}-t2-${index}`,
      { amount: "10.0000", commissionAmount: "0.3000" },
      context,
    ));
  }));
  const t2Result = {
    tasks: T2_CONCURRENCY,
    fulfilled: t2.filter((entry) => entry.status === "fulfilled").length,
    rejected: t2.filter((entry) => entry.status === "rejected").length,
    elapsedMs: Number((performance.now() - t2Started).toFixed(3)),
    tps: Number((T2_CONCURRENCY / ((performance.now() - t2Started) / 1000)).toFixed(1)),
    retryMetrics: snapshotTxRetryMetrics(),
  };
  const initialInvariant = await new InvariantVerifier(client as never).verify();
  const invariantAfterT2 = await new InvariantVerifier(client as never).verify();

  const crashRef = `${refPrefix}-crash-${randomUUID()}`;
  const crash = Bun.spawn(["bun", "scripts/db-benchmark.ts", "--crash-child"], {
    cwd: path.join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      BENCHMARK_DATABASE_URL: DATABASE_URL,
      CRASH_REF: crashRef,
      CRASH_TREASURY_ID: accounts.TREASURY!,
      CRASH_INCOME_ID: accounts.PLATFORM_INCOME!,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await sleep(2_000);
  crash.kill("SIGKILL");
  await crash.exited;

  const soakStarted = performance.now();
  const soakDeadline = Date.now() + SOAK_SECONDS * 1000;
  const soakCounts = new Array(SOAK_WRITERS).fill(0);
  await Promise.all(Array.from({ length: SOAK_WRITERS }, async (_, writer) => {
    let index = 0;
    while (Date.now() < soakDeadline) {
      const context = contexts[(writer + index) % contexts.length]!;
      try {
        await withTxRetry(() => poster.postScenario(
          "INTERNAL_CONFIRMATION",
          `${refPrefix}-t3-${writer}-${index}`,
          { amount: "10.0000", commissionAmount: "0.3000" },
          context,
        ));
        soakCounts[writer] = (soakCounts[writer] ?? 0) + 1;
      } catch {
        // Errors are reflected in the final invariant and retry counters.
      }
      index += 1;
      await sleep(SOAK_RATE_MS);
    }
  }));
  const invariantAfterSoak = await new InvariantVerifier(client as never).verify();
  const crashRows = await client.$queryRawUnsafe(
    "SELECT COUNT(*) AS count FROM journal_entries WHERE ref_id = ?",
    crashRef,
  ) as Array<{ count: bigint | number }>;

  const groupId = randomUUID();
  const groupLinkId = await firstValue(client, "SELECT id AS value FROM payment_links LIMIT 1") || randomUUID();
  await client.$executeRawUnsafe(
    "INSERT INTO attempt_groups (id, link_id, customer_fingerprint, success_count, updated_at) VALUES (?, ?, ?, 0, NOW(3))",
    groupId,
    groupLinkId,
    "f".repeat(64),
  );
  const t4 = await Promise.all(Array.from({ length: 2 }, () => client.$executeRawUnsafe(
    "UPDATE attempt_groups SET success_count = success_count + 1 WHERE id = ? AND success_count = 0",
    groupId,
  )));
  const groupRows = await client.$queryRawUnsafe(
    "SELECT success_count FROM attempt_groups WHERE id = ?",
    groupId,
  ) as Array<{ success_count: number | bigint }>;
  await client.$executeRawUnsafe("DELETE FROM attempt_groups WHERE id = ?", groupId);

  const totalPostings = soakCounts.reduce((sum, value) => sum + value, 0);
  const result = {
    T1: t1Result,
    T2: t2Result,
    T3: {
      writers: SOAK_WRITERS,
      seconds: SOAK_SECONDS,
      postings: totalPostings,
      tps: Number((totalPostings / SOAK_SECONDS).toFixed(1)),
      initialInvariant: initialInvariant.drift.toFixed(4),
      invariantAfterT2: invariantAfterT2.drift.toFixed(4),
      invariantAfterSoak: invariantAfterSoak.drift.toFixed(4),
      crashRefRowsAfterKill: Number(crashRows[0]?.count ?? 0),
      retryMetrics: snapshotTxRetryMetrics(),
    },
    T4: {
      updates: t4.map(Number),
      affected: t4.map(Number).reduce((sum, value) => sum + value, 0),
      successCount: Number(groupRows[0]?.success_count ?? 0),
    },
  };

  if (process.env.BENCHMARK_SKIP_CLEANUP !== "1") {
    await cleanupAccounts(client, accounts, refPrefix);
  }
  return result;
};

const crashChild = async (): Promise<void> => {
  const ref = process.env.CRASH_REF ?? `crash-${randomUUID()}`;
  const treasury = process.env.CRASH_TREASURY_ID ?? "";
  const income = process.env.CRASH_INCOME_ID ?? "";
  const client = connect();
  try {
    await client.$transaction(async (tx) => {
      const entryId = randomUUID();
      await tx.$executeRawUnsafe(
        "INSERT INTO journal_entries (id, ref_type, ref_id, description) VALUES (?, 'PAYMENT_ATTEMPT', ?, 'crash-child')",
        entryId,
        ref,
      );
      await tx.$executeRawUnsafe(
        "INSERT INTO journal_lines (entry_id, gl_account_id, direction, amount) VALUES (?, ?, 'DEBIT', '1.0000'), (?, ?, 'CREDIT', '1.0000')",
        entryId,
        treasury,
        entryId,
        income,
      );
      await tx.$executeRawUnsafe(
        "INSERT INTO gl_balance_shards (gl_account_id, shard_no, balance, line_count) VALUES (?, 0, '1.0000', 1) ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance), line_count = line_count + VALUES(line_count)",
        treasury,
      );
      console.log("CRASH_CHILD_READY");
      await sleep(30_000);
    });
  } finally {
    await client.$disconnect();
  }
};

const main = async (): Promise<void> => {
  if (process.argv.includes("--crash-child")) {
    await crashChild();
    return;
  }
  const client = connect();
  try {
    const version = await client.$queryRawUnsafe("SELECT VERSION() AS version") as Array<{ version: string }>;
    const pool = await client.$queryRawUnsafe("SELECT @@innodb_buffer_pool_size AS bytes") as Array<{ bytes: bigint | number }>;
    const tableNames = ["payment_attempts", "journal_lines", "payment_links", "audit_log", "inbound_events", "attempt_deadlines", "gl_accounts"];
    const tableCounts: Record<string, number> = {};
    for (const table of tableNames) {
      const rows = await client.$queryRawUnsafe(`SELECT COUNT(*) AS count FROM \`${table}\``) as Array<{ count: bigint | number }>;
      tableCounts[table] = Number(rows[0]?.count ?? 0);
    }
    const catalogue = await runCatalogue(client);
    const concurrency = await runConcurrency(client);
    const report = {
      environment: {
        startedAt: new Date().toISOString(),
        host: os.hostname(),
        platform: `${os.platform()} ${os.release()}`,
        cpu: os.cpus()[0]?.model ?? "unknown",
        cpuCount: os.cpus().length,
        ramBytes: os.totalmem(),
        mariadbVersion: version[0]?.version ?? "unknown",
        bufferPoolBytes: Number(pool[0]?.bytes ?? 0),
        tableCounts,
        soakSeconds: SOAK_SECONDS,
        soakWriters: SOAK_WRITERS,
        t2Concurrency: T2_CONCURRENCY,
      },
      catalogue,
      concurrency,
    };
    const output = process.env.BENCHMARK_OUTPUT ?? "/tmp/pg-db-benchmark.json";
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    const errors = catalogue.filter((row) => row.error).length;
    const flagged = catalogue.filter((row) => row.filesort || row.temporary).length;
    console.log(JSON.stringify({ output, environment: report.environment, catalogue: { total: catalogue.length, errors, filesortOrTemporary: flagged }, concurrency }, null, 2));
  } finally {
    await client.$disconnect();
  }
};

await main();
