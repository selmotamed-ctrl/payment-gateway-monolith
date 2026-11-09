/**
 * Ledger write-path load + drift harness (NOT a unit test: run with `bun run test/load/ledger-load.ts`).
 *
 * Drives the PRODUCTION write path - createLedgerPoster(): journal entry + lines + shard projection +
 * transactional outbox event in ONE transaction - from several worker processes against a real PostgreSQL,
 * at rising concurrency, with a share of duplicate replays (same refType/refId), then proves after every
 * level that the double-entry books did not drift:
 *
 *   D1  every journal entry balances (sum DEBIT = sum CREDIT, per entry)
 *   D2  exactly one entry exists per distinct refId (retries/duplicates never double-post)
 *   D3  for every account touched, sum(gl_account_shards) = sum(journal_lines, debit-positive)
 *   D4  one ledger.entry_posted outbox event per created entry
 *   D5  system-wide: total DEBIT = total CREDIT over the level's lines
 *
 * Env: DATABASE_URL (a scratch database you can write to!)
 *   LOAD_LEVELS="8,32,64,128"  total concurrent posters per level     LOAD_DURATION_S=15
 *   LOAD_PROCS=4               worker processes                       LOAD_WALLETS=500 (merchant wallets)
 *   LOAD_HOT_WALLET_SHARE=0.2  share of posts that hit ONE hot wallet  LOAD_DUP_RATE=0.05
 *   LOAD_SHARDS=16             shards of the hot platform accounts (compare with 1)
 *   LOAD_HOT_SHARDS=1          shards of the single hot merchant wallet (1 = every post to it queues on one row)
 *   LOAD_WARMUP_S=2
 */
import { spawn } from "node:child_process";
import { Decimal } from "decimal.js";
import { createLedgerPoster } from "../../lib/storageEngine/ledgerPosterFactory";
import { buildPaymentConfirmationTemplate } from "../../engine/ledger/LedgerPoster";
import { createPrisma, seedGlAccount } from "../storage-engine/helpers/db";

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

interface Pool {
  treasury: string;
  clearing: string;
  income: string;
  wallets: string[];
  hotWallet: string;
  shards: number;
}

interface WorkerResult {
  created: number;
  /** creations in ANY window (incl. warm-up): the number of entries that MUST exist */
  createdAll: number;
  duplicates: number;
  duplicateMismatch: number;
  errors: number;
  errorSamples: string[];
  latencies: number[];
  distinctRefIds: number;
  elapsedS: number;
}

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

/* ------------------------------------------------------------------ worker ------------------------------------------------------------------ */
const runWorker = async (): Promise<void> => {
  const pool = JSON.parse(process.env.LOAD_POOL!) as Pool;
  const prefix = process.env.LOAD_PREFIX!;
  const concurrency = Number(process.env.LOAD_WORKER_CONCURRENCY);
  const durationMs = Number(process.env.LOAD_WORKER_DURATION_MS);
  const warmupMs = Number(process.env.LOAD_WARMUP_MS ?? 0);
  const dupRate = num("LOAD_DUP_RATE", 0.05);
  const hotShare = num("LOAD_HOT_WALLET_SHARE", 0.2);
  const workerId = process.env.LOAD_WORKER_ID ?? "0";

  const client = createPrisma({ max: concurrency + 2 });
  // emitOutbox is opt-in on master (the topic has no consumer); the harness keeps it ON so D4 can prove atomicity.
  const poster = createLedgerPoster(client, { emitOutbox: true });

  const result: WorkerResult = {
    created: 0, createdAll: 0, duplicates: 0, duplicateMismatch: 0, errors: 0, errorSamples: [], latencies: [], distinctRefIds: 0, elapsedS: 0,
  };
  const t0 = performance.now();
  const measureFrom = t0 + warmupMs;
  const deadline = measureFrom + durationMs;
  let counter = 0;

  const loop = async (lane: number): Promise<void> => {
    const recent: Array<{ refId: string; amount: string }> = [];
    while (performance.now() < deadline) {
      const replay = recent.length > 0 && Math.random() < dupRate;
      let refId: string;
      let amountText: string;
      if (replay) {
        const picked = recent[Math.floor(Math.random() * recent.length)]!;
        refId = picked.refId;
        amountText = picked.amount;
      } else {
        counter += 1;
        refId = `${prefix}w${workerId}-l${lane}-${counter}`;
        amountText = new Decimal(1 + Math.random() * 4999).toFixed(4);
      }
      const amount = new Decimal(amountText);
      const commission = amount.mul("0.015").toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      const providerFee = amount.mul("0.005").toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      const walletId = Math.random() < hotShare ? pool.hotWallet : pool.wallets[Math.floor(Math.random() * pool.wallets.length)]!;
      const template = buildPaymentConfirmationTemplate({
        ownershipMode: "PLATFORM_CLEARING",
        amount: amount.toFixed(4),
        commissionAmount: commission.toFixed(4),
        providerFeeAmount: providerFee.toFixed(4),
        feeBearer: "MERCHANT_ABSORBS",
      });
      const body = { ...template, refType: "PAYMENT_ATTEMPT", refId, description: "load" };
      const started = performance.now();
      try {
        const posted = await poster.post(body, {
          accounts: { TREASURY: pool.treasury, GATEWAY_CLEARING: pool.clearing, PLATFORM_INCOME: pool.income, MERCHANT_WALLET: walletId },
        });
        const ms = performance.now() - started;
        if (posted.created) result.createdAll += 1;
        if (started >= measureFrom) {
          result.latencies.push(ms);
          if (posted.created) result.created += 1;
          else result.duplicates += 1;
        }
        if (replay && posted.created) result.duplicateMismatch += 1; // a replay must NEVER create a second entry
        if (!replay) recent.push({ refId, amount: amountText });
        if (recent.length > 50) recent.shift();
      } catch (error) {
        result.errors += 1;
        if (result.errorSamples.length < 5) {
          const e = error as { code?: string; message?: string; meta?: unknown };
          const lines = String(e?.message ?? error).split("\n").map((l) => l.trim()).filter(Boolean);
          result.errorSamples.push(`${e?.code ?? "error"}: ${lines[lines.length - 1]?.slice(0, 200) ?? ""} ${e?.meta ? JSON.stringify(e.meta).slice(0, 120) : ""}`);
        }
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, (_, lane) => loop(lane)));
  result.elapsedS = (performance.now() - measureFrom) / 1000;
  result.distinctRefIds = counter;
  await client.$disconnect().catch(() => undefined);
  process.stdout.write(`\n@@RESULT@@${JSON.stringify(result)}\n`);
  process.exit(0);
};

/* ----------------------------------------------------------------- orchestrator ----------------------------------------------------------------- */
const runWorkers = (pool: Pool, prefix: string, total: number, procs: number, durationS: number): Promise<WorkerResult[]> => {
  const perProc = Math.max(1, Math.floor(total / procs));
  const warmupMs = num("LOAD_WARMUP_S", 2) * 1000;
  return Promise.all(
    Array.from({ length: procs }, (_, index) =>
      new Promise<WorkerResult>((resolve, reject) => {
        const child = spawn(process.execPath, [process.argv[1]!], {
          env: {
            ...process.env,
            LOAD_ROLE: "worker",
            LOAD_POOL: JSON.stringify(pool),
            LOAD_PREFIX: prefix,
            LOAD_WORKER_ID: String(index),
            LOAD_WORKER_CONCURRENCY: String(perProc),
            LOAD_WORKER_DURATION_MS: String(durationS * 1000),
            LOAD_WARMUP_MS: String(warmupMs),
          },
          stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.on("exit", () => {
          const marker = out.lastIndexOf("@@RESULT@@");
          if (marker < 0) return reject(new Error(`worker ${index} produced no result`));
          resolve(JSON.parse(out.slice(marker + "@@RESULT@@".length).trim()) as WorkerResult);
        });
      }),
    ),
  );
};

interface Check { name: string; ok: boolean; detail: string }

/**
 * minEntries = posts the workers saw succeed (these MUST exist exactly once);
 * maxEntries = minEntries + errored first-posts (an errored post may or may not have committed, never twice).
 */
const verifyLevel = async (client: ReturnType<typeof createPrisma>, prefix: string, pool: Pool, minEntries: number, maxEntries: number): Promise<Check[]> => {
  const like = `${prefix}%`;
  const checks: Check[] = [];
  const q = async <T>(sql: string, ...args: unknown[]): Promise<T[]> => (await client.$queryRawUnsafe(sql, ...args)) as T[];

  const unbalanced = await q<{ n: bigint }>(
    `SELECT count(*)::bigint AS n FROM (
       SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
       WHERE e.ref_id LIKE $1 GROUP BY e.id
       HAVING sum(CASE WHEN l.direction = 'DEBIT' THEN l.amount ELSE -l.amount END) <> 0) x`, like);
  checks.push({ name: "D1 every entry balances", ok: Number(unbalanced[0]!.n) === 0, detail: `${unbalanced[0]!.n} unbalanced entries` });

  const entries = await q<{ n: bigint; d: bigint }>(
    `SELECT count(*)::bigint AS n, count(DISTINCT ref_id)::bigint AS d FROM journal_entries WHERE ref_id LIKE $1`, like);
  checks.push({
    name: "D2 one entry per distinct refId",
    ok: Number(entries[0]!.n) === Number(entries[0]!.d)
      && Number(entries[0]!.n) >= minEntries && Number(entries[0]!.n) <= maxEntries,
    detail: `entries=${entries[0]!.n} distinct=${entries[0]!.d} workers saw ${minEntries} succeed (+${maxEntries - minEntries} errored)`,
  });

  const ids = [pool.treasury, pool.clearing, pool.income, pool.hotWallet, ...pool.wallets];
  const parity = await q<{ id: string; lines: string; shards: string }>(
    `SELECT a.id,
            COALESCE((SELECT sum(CASE WHEN l.direction='DEBIT' THEN l.amount ELSE -l.amount END) FROM journal_lines l WHERE l.gl_account_id = a.id),0)::text AS lines,
            COALESCE((SELECT sum(s.current_balance) FROM gl_account_shards s WHERE s.gl_account_id = a.id),0)::text AS shards
       FROM gl_accounts a WHERE a.id = ANY($1::uuid[])`, ids);
  const drifted = parity.filter((row) => !new Decimal(row.lines).eq(new Decimal(row.shards)));
  checks.push({
    name: "D3 shard totals = journal lines (every account)",
    ok: drifted.length === 0,
    detail: drifted.length === 0 ? `${parity.length} accounts match` : `${drifted.length} drifted, e.g. ${drifted[0]!.id} lines=${drifted[0]!.lines} shards=${drifted[0]!.shards}`,
  });

  const outbox = await q<{ n: bigint }>(
    `SELECT count(*)::bigint AS n FROM outbox_events WHERE topic = 'ledger.entry_posted' AND payload_json->>'refId' LIKE $1`, like);
  checks.push({
    name: "D4 one outbox event per entry",
    ok: Number(outbox[0]!.n) === Number(entries[0]!.n),
    detail: `outbox=${outbox[0]!.n} entries=${entries[0]!.n}`,
  });

  const totals = await q<{ d: string; c: string }>(
    `SELECT COALESCE(sum(l.amount) FILTER (WHERE l.direction='DEBIT'),0)::text AS d,
            COALESCE(sum(l.amount) FILTER (WHERE l.direction='CREDIT'),0)::text AS c
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.ref_id LIKE $1`, like);
  checks.push({ name: "D5 total debit = total credit", ok: new Decimal(totals[0]!.d).eq(totals[0]!.c), detail: `debit=${totals[0]!.d} credit=${totals[0]!.c}` });
  return checks;
};

const runOrchestrator = async (): Promise<void> => {
  const levels = (process.env.LOAD_LEVELS ?? "8,32,64,128").split(",").map((v) => Number(v.trim())).filter((v) => v > 0);
  const durationS = num("LOAD_DURATION_S", 15);
  const procs = Math.max(1, num("LOAD_PROCS", 4));
  const wallets = num("LOAD_WALLETS", 500);
  const shards = num("LOAD_SHARDS", 16);
  const runId = crypto.randomUUID().slice(0, 8);

  const client = createPrisma({ max: 5 });
  console.log(`# ledger load: levels=${levels.join(",")} duration=${durationS}s procs=${procs} wallets=${wallets} hotShare=${num("LOAD_HOT_WALLET_SHARE", 0.2)} dupRate=${num("LOAD_DUP_RATE", 0.05)} shards=${shards}`);
  const treasury = await seedGlAccount(client, { accountType: "TREASURY", shardCount: shards });
  const clearing = await seedGlAccount(client, { accountType: "GATEWAY_CLEARING", shardCount: shards });
  const income = await seedGlAccount(client, { accountType: "PLATFORM_INCOME", shardCount: shards });
  const hot = await seedGlAccount(client, { accountType: "MERCHANT_WALLET", shardCount: num("LOAD_HOT_SHARDS", 1) });
  const walletIds: string[] = [];
  for (let i = 0; i < wallets; i += 1) walletIds.push((await seedGlAccount(client, { accountType: "MERCHANT_WALLET", shardCount: 1 })).id);
  const pool: Pool = { treasury: treasury.id, clearing: clearing.id, income: income.id, wallets: walletIds, hotWallet: hot.id, shards };

  const rows: string[] = [];
  let allOk = true;
  for (const level of levels) {
    const prefix = `load-${runId}-c${level}-`;
    const started = performance.now();
    const results = await runWorkers(pool, prefix, level, Math.min(procs, level), durationS);
    const wall = (performance.now() - started) / 1000;
    const created = results.reduce((s, r) => s + r.created, 0);
    const dups = results.reduce((s, r) => s + r.duplicates, 0);
    const errors = results.reduce((s, r) => s + r.errors, 0);
    const mismatch = results.reduce((s, r) => s + r.duplicateMismatch, 0);
    const lat = results.flatMap((r) => r.latencies).sort((a, b) => a - b);
    const measured = Math.max(...results.map((r) => r.elapsedS));
    const createdAll = results.reduce((s, r) => s + r.createdAll, 0);
    const checks = await verifyLevel(client, prefix, pool, createdAll, createdAll + errors);
    const ok = checks.every((c) => c.ok) && mismatch === 0 && errors === 0;
    allOk = allOk && ok;
    const tps = (created + dups) / measured;
    rows.push(`${String(level).padStart(5)} | ${tps.toFixed(0).padStart(7)} | ${(created / measured).toFixed(0).padStart(7)} | ${percentile(lat, 50).toFixed(1).padStart(7)} | ${percentile(lat, 95).toFixed(1).padStart(7)} | ${percentile(lat, 99).toFixed(1).padStart(7)} | ${errors.toString().padStart(6)} | ${ok ? "PASS" : "FAIL"}`);
    console.log(`\n## level ${level}: ${created} created, ${dups} idempotent replays, ${errors} errors, wall ${wall.toFixed(1)}s`);
    for (const check of checks) console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}  (${check.detail})`);
    if (mismatch > 0) console.log(`  FAIL  a replay created a second entry ${mismatch}x`);
    for (const sample of results.flatMap((r) => r.errorSamples).slice(0, 5)) console.log(`  error sample: ${sample}`);
  }
  console.log("\nconcur |  posts/s | created/s |  p50 ms |  p95 ms |  p99 ms | errors | books");
  console.log("-------+---------+---------+---------+---------+---------+--------+------");
  for (const row of rows) console.log(row);
  await client.$disconnect().catch(() => undefined);
  process.exit(allOk ? 0 : 1);
};

if (process.env.LOAD_ROLE === "worker") await runWorker();
else await runOrchestrator();
