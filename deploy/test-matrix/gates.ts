import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadDeployConfig, type DeployConfig } from "../lib/configSchema";
import { planHosts, type DeployPlan, type NodePlan } from "../lib/hostPlanner";
import { probeCoreNodes, probeEdgeToCore, type ProbeResult } from "../lib/healthVerifier";
import { pgClusterFor } from "../provisioners/postgres18Provisioner";
import { GATE_IDS, selectedGates, type ChaosFaultType, type GateId, type ResolvedIntensity } from "./intensity";
import { machinePrivateIp, type LabConfig } from "./labConfig";
import { LabRemote, shellQuote } from "./remote";
import { runHotLinkContention, runPaymentBurst, runSustainedLoad, type PaymentTarget, type SustainedLoadResult } from "./stressWorkload";
import type { DerivedTopology } from "./topologyDerivation";
import type { CheckStatus, GateCheck, GateResult, GateStatus } from "./types";

export interface GateContext {
  lab: LabConfig;
  topology: DerivedTopology;
  intensity: ResolvedIntensity;
  configPath: string;
  config: DeployConfig;
  plan: DeployPlan;
  remote: LabRemote;
}

export const loadGateContext = (input: Omit<GateContext, "config" | "plan">): GateContext => {
  const loaded = loadDeployConfig(readFileSync(input.configPath, "utf8"));
  if (!loaded.ok || !loaded.config) throw new Error(`Invalid ${input.configPath}: ${loaded.problems.join("; ")}`);
  return { ...input, config: loaded.config, plan: planHosts(loaded.config) };
};

// ---------------------------------------------------------------------------
// Check helpers: PASS/FAIL only for measured values; SKIP never counts as pass.
// ---------------------------------------------------------------------------

type Measured = GateCheck["measured"];
const check = (name: string, ok: boolean, detail = "", measured?: Measured): GateCheck => ({ name, status: ok ? "PASS" : "FAIL", detail, measured });
const skip = (name: string, reason: string): GateCheck => ({ name, status: "SKIP", detail: reason });

export const gateStatusOf = (checks: GateCheck[]): GateStatus => {
  if (checks.some((entry) => entry.status === "FAIL")) return "FAILED";
  if (checks.length === 0 || checks.every((entry) => entry.status === "SKIP")) return "SKIPPED";
  return "PASSED";
};

const GATE_META: Record<GateId, { gate: number; name: string }> = {
  provisioning: { gate: 1, name: "Provisioning, UFW zero-trust and SAN mTLS" },
  "storage-routing": { gate: 2, name: "Storage routing and LSN read-your-own-writes" },
  "seeder-invariants": { gate: 3, name: "Fake Rails and synthetic seeder invariants" },
  "checkout-stress": { gate: 4, name: "Sustained checkout throughput, hot-link contention and sharded ledger" },
  "realtime-sse": { gate: 5, name: "Cross-node SSE and POS pairing" },
  workers: { gate: 6, name: "Concurrent workers and queue drain" },
  "audit-chain": { gate: 7, name: "Audit immutability and linear hash chain" },
  "log-db-outage": { gate: 8, name: "Dedicated log DB outage resilience" },
  search: { gate: 9, name: "Global search latency and AML redaction" },
  backup: { gate: 10, name: "Backup control plane and restore drill" },
  chaos: { gate: 12, name: "Chaos faults under load and recovery" },
  scale: { gate: 11, name: "Live scale-in / scale-out under load" },
};

const runGate = async (id: GateId, fn: () => Promise<GateCheck[]>): Promise<GateResult> => {
  const started = Date.now();
  const meta = GATE_META[id];
  try {
    const checks = await fn();
    return { gate: meta.gate, id, name: meta.name, status: gateStatusOf(checks), checks, durationMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { gate: meta.gate, id, name: meta.name, status: "FAILED", checks: [check("gate execution", false, message)], durationMs: Date.now() - started, error: message };
  }
};

/** SQL string literal (the archived gates used shell quoting for SQL values). */
export const sqlLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const b64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

const sessionKey = (kmsMasterKey: string): Buffer =>
  Buffer.from(hkdfSync("sha256", Buffer.from(kmsMasterKey, "utf8"), Buffer.from("payment-gateway-core", "utf8"), Buffer.from("session-signing", "utf8"), 32));

const signSession = (kmsMasterKey: string, userId: string, role: string): string => {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    sub: userId, typ: "session", role, merchantId: null, authorities: role === "GATEWAY_ADMIN" ? ["*"] : ["merchant:read", "gateway:read"],
    appScopeIds: [], mfa: true, iss: "payment-gateway-core", aud: "payment-gateway-admin", iat: now, exp: now + 3600,
  }));
  const signature = createHmac("sha256", sessionKey(kmsMasterKey)).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
};

const primaryNode = (ctx: GateContext) => {
  const primary = ctx.plan.storage.postgres.primary;
  if (!primary) throw new Error("topology has no PostgreSQL primary");
  return primary;
};

const primaryPsql = (ctx: GateContext, sql: string): string =>
  ctx.remote.psql({
    host: primaryNode(ctx).privateIp,
    port: primaryNode(ctx).servicePort,
    user: ctx.config.PG_DB_USER,
    password: ctx.config.PG_DB_PASSWORD,
    database: ctx.config.PG_DB_NAME,
    sql,
  });

const firstLine = (value: string): string => value.split("\n")[0]?.trim() ?? "";
const scalar = (ctx: GateContext, sql: string): number => Number(firstLine(primaryPsql(ctx, sql)));

const adminBaseUrl = (ctx: GateContext): string => {
  const admin = ctx.plan.nodes.admin[0];
  if (!admin) throw new Error("No admin node in topology");
  // admin-back listener directly: the Nginx vhost adds X-Forwarded-For, which
  // admin-back's rate limiter rejects when trust proxy is false.
  return `http://${admin.privateIp}:${admin.port}/api/v1/admin`;
};

const ensureLabUser = (ctx: GateContext, email: string, role: string, authoritiesJson: string): string => {
  const id = firstLine(primaryPsql(ctx, `INSERT INTO users (id, created_at, updated_at, email, role, authorities_map, status, mfa_required, is_maker, is_checker)
    VALUES (gen_random_uuid(), now(), now(), ${sqlLiteral(email)}, ${sqlLiteral(role)}, ${sqlLiteral(authoritiesJson)}::jsonb, 'ACTIVE', false, true, true)
    ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, authorities_map = EXCLUDED.authorities_map, status = 'ACTIVE', mfa_required = false
    RETURNING id`));
  if (!id) throw new Error(`Unable to provision lab user ${email}`);
  return id;
};

const adminToken = (ctx: GateContext): string =>
  signSession(ctx.config.KMS_MASTER_KEY, ensureLabUser(ctx, "lab-matrix-admin@payment-gateway.internal", "GATEWAY_ADMIN", '{"*": true}'), "GATEWAY_ADMIN");

const supportToken = (ctx: GateContext): string =>
  signSession(ctx.config.KMS_MASTER_KEY, ensureLabUser(ctx, "lab-matrix-support@payment-gateway.internal", "SUPPORT", '{"merchant:read": true, "gateway:read": true}'), "SUPPORT");

const adminFetch = async (ctx: GateContext, token: string, path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  return fetch(`${adminBaseUrl(ctx)}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(ctx.intensity.requestTimeoutMs) });
};

const invariantChecks = (ctx: GateContext): GateCheck[] => {
  const drift = firstLine(primaryPsql(ctx, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0)::text FROM journal_lines"));
  const shardMismatch = scalar(ctx, `SELECT count(*)::text FROM (
    SELECT gl_account_id, SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END) AS journal_total
    FROM journal_lines GROUP BY gl_account_id
  ) jl FULL OUTER JOIN (
    SELECT gl_account_id, SUM(current_balance) AS shard_total FROM gl_account_shards GROUP BY gl_account_id
  ) sh USING (gl_account_id)
  WHERE COALESCE(jl.journal_total, 0) <> COALESCE(sh.shard_total, 0)`);
  // Compare the decimal string exactly; never parse money into a float.
  const zero = /^-?0(\.0+)?$/.test(drift);
  return [
    check("double-entry drift is exactly zero", zero, `drift=${drift} LYD`, { drift }),
    check("gl_account_shards equals journal_lines", shardMismatch === 0, `mismatched accounts=${shardMismatch}`, { shardMismatch }),
  ];
};

const paymentTargets = (ctx: GateContext, nodes: NodePlan[] = ctx.plan.nodes.checkout): PaymentTarget[] => {
  const key = firstLine(primaryPsql(ctx, `SELECT pl.key FROM payment_links pl
    JOIN applications a ON a.id = pl.application_id
    JOIN merchants m ON m.id = a.merchant_id
    WHERE pl.state = 'PENDING' AND (pl.expires_at IS NULL OR pl.expires_at > now())
      AND m.status = 'ACTIVE' AND m.kyb_status = 'VERIFIED'
    ORDER BY pl.created_at ASC LIMIT 1`));
  const rail = firstLine(primaryPsql(ctx, `SELECT r.code FROM rails r
    LEFT JOIN rail_fields f ON f.rail_id = r.id
    GROUP BY r.code, r.collection_mode
    HAVING count(f.id) FILTER (WHERE f.required) = 0
    ORDER BY CASE r.collection_mode WHEN 'QR_DISPLAY' THEN 0 WHEN 'OTP_PULL' THEN 1 ELSE 2 END, r.code ASC
    LIMIT 1`));
  if (!key || !rail) throw new Error("No seeded payment link/rail found");
  return nodes.map((node) => ({ baseUrl: `http://${node.privateIp}:${node.port}`, linkKey: key, railCode: rail, nodeId: node.nodeId }));
};

/**
 * The synthetic history seeds velocity/AML rules. The throughput gates
 * disable the active ones so they measure checkout/ledger capacity, and
 * restore exactly those rules afterwards (the archived gate disabled every
 * rule permanently, changing behaviour for every later gate).
 */
const withRulesSuspended = async <T>(ctx: GateContext, fn: () => Promise<T>): Promise<T> => {
  const ids = (table: string): string[] =>
    primaryPsql(ctx, `UPDATE ${table} SET active = false WHERE active RETURNING id::text`).split("\n").map((line) => line.trim()).filter(Boolean);
  const velocity = ids("velocity_rules");
  const aml = ids("aml_rules");
  try {
    return await fn();
  } finally {
    const restore = (table: string, list: string[]): void => {
      if (list.length > 0) primaryPsql(ctx, `UPDATE ${table} SET active = true WHERE id::text IN (${list.map(sqlLiteral).join(",")})`);
    };
    restore("velocity_rules", velocity);
    restore("aml_rules", aml);
  }
};

const sustained = (ctx: GateContext, targets: () => PaymentTarget[], prefix: string, overrides: Partial<{ durationSec: number; rampUpSec: number }> = {}): Promise<SustainedLoadResult> =>
  runSustainedLoad({
    targets,
    targetTps: ctx.intensity.targetTps,
    rampUpSec: overrides.rampUpSec ?? ctx.intensity.rampUpSec,
    durationSec: overrides.durationSec ?? ctx.intensity.durationSec,
    concurrency: ctx.intensity.concurrency,
    timeoutMs: ctx.intensity.requestTimeoutMs,
    idempotencyPrefix: `${prefix}-${ctx.topology.slug}-${Date.now()}`,
  });

const loadSummary = (result: SustainedLoadResult): Measured => ({
  offered: result.offered,
  requests: result.total,
  succeeded: result.succeeded,
  failed: result.failed,
  saturated: result.saturated,
  achievedTps: Number(result.achievedTps.toFixed(2)),
  errorRate: Number(result.errorRate.toFixed(4)),
  p95Ms: Number(result.p95.toFixed(1)),
  p99Ms: Number(result.p99.toFixed(1)),
});

const tcpProbe = (ctx: GateContext, from: string, ip: string, port: number): "OPEN" | "BLOCKED" =>
  ctx.remote.capture(from, `timeout 3 bash -c '</dev/tcp/${ip}/${port}' >/dev/null 2>&1 && echo OPEN || echo BLOCKED`).trim() === "OPEN" ? "OPEN" : "BLOCKED";

// ---------------------------------------------------------------------------
// Gate 1 — provisioning, mTLS, DMZ zero-trust
// ---------------------------------------------------------------------------

const pm2Checks = (ctx: GateContext): GateCheck[] => {
  const checks: GateCheck[] = [];
  for (const host of ctx.plan.hosts) {
    const apps = ctx.remote.pm2List(host.ssh.host);
    for (const service of host.services) {
      const app = apps.find((entry) => entry.name === service.name);
      checks.push(check(`${host.ssh.host} pm2 ${service.name}`, app?.pm2_env?.status === "online", app ? `status=${app.pm2_env?.status} restarts=${app.pm2_env?.restart_time ?? 0}` : "missing"));
    }
  }
  if (ctx.plan.backup.enabled && ctx.plan.backup.node) {
    const host = ctx.plan.backup.node.sshHost;
    const status = ctx.remote.capture(host, "systemctl is-active pg-backup-daemon 2>/dev/null || true").trim();
    checks.push(check(`${host} pg-backup-daemon`, status === "active", `systemd=${status || "missing"}`));
  }
  return checks;
};

const mTlsChecks = (ctx: GateContext): GateCheck[] => {
  const probes: ProbeResult[] = [...probeCoreNodes(ctx.remote.runner, ctx.plan, ctx.config)];
  for (const host of ctx.plan.hosts) probes.push(...probeEdgeToCore(ctx.remote.runner, host, ctx.config));
  return probes.map((probe) => check(`${probe.host} ${probe.check}`, probe.ok, probe.detail));
};

const negativeMtlsChecks = (ctx: GateContext): GateCheck[] => {
  const core = ctx.plan.nodes.core[0];
  const edge = ctx.plan.nodes.checkout[0];
  if (!core || !edge) return [check("core and checkout nodes exist", false)];
  const noCert = ctx.remote.capture(edge.privateIp, `curl -k -sS --max-time 5 https://${core.privateIp}:${core.port}/health >/dev/null 2>&1 && echo ACCEPTED || echo NO_CERT_REJECTED`).trim();
  const certDir = `${ctx.config.CHECKOUT_REMOTE_DIR}/shared/certs`;
  const wrongChannel = ctx.remote.capture(
    edge.privateIp,
    `curl -k -sS -o /dev/null -w '%{http_code}' --max-time 5 --cacert ${certDir}/internal-ca.crt --cert ${certDir}/checkout-back-client.crt --key ${certDir}/checkout-back-client.key https://${core.privateIp}:${core.port}/internal/admin/health || true`,
  ).trim();
  return [
    check("core rejects a TLS client without a certificate", noCert === "NO_CERT_REJECTED", noCert),
    check("checkout certificate cannot enter the admin channel", wrongChannel === "403", `http=${wrongChannel}`),
  ];
};

/** Every DMZ machine must reach core (positive control) and no private storage port. */
const dmzChecks = (ctx: GateContext): GateCheck[] => {
  const checks: GateCheck[] = [];
  for (const machineId of ctx.topology.features.dmzMachines) {
    const machine = ctx.remote.machine(machineId);
    const edgeIp = machinePrivateIp(machine);
    const core = ctx.plan.nodes.core.find((node) => node.privateIp !== edgeIp) ?? ctx.plan.nodes.core[0];
    if (core) {
      const reach = tcpProbe(ctx, machineId, core.privateIp, core.port);
      checks.push(check(`${machineId} reaches core ${core.nodeId} (positive control)`, reach === "OPEN", reach));
    }
    const pg = primaryNode(ctx);
    const endpoints: Array<[string, string, number]> = [
      ["PostgreSQL primary", pg.privateIp, pg.servicePort],
      ...ctx.plan.storage.postgres.replicas.map((replica): [string, string, number] => [`replica ${replica.nodeId}`, replica.privateIp, replica.servicePort]),
      ...(ctx.config.PGBOUNCER_ENABLED ? [["PgBouncer", pg.privateIp, ctx.config.PGBOUNCER_PORT] as [string, string, number]] : []),
      ...ctx.plan.storage.redis.map((redis): [string, string, number] => [`Redis ${redis.nodeId}`, redis.privateIp, redis.servicePort]),
      ...(ctx.plan.storage.auditDb ? [["audit DB", ctx.plan.storage.auditDb.privateIp, ctx.plan.storage.auditDb.servicePort] as [string, string, number]] : []),
      ...(ctx.plan.storage.logDb ? [["log DB", ctx.plan.storage.logDb.privateIp, ctx.plan.storage.logDb.servicePort] as [string, string, number]] : []),
    ];
    for (const [label, ip, port] of endpoints) {
      if (ip === edgeIp) {
        checks.push(check(`${label} is not placed on DMZ machine ${machineId}`, false, `${ip}:${port}`));
        continue;
      }
      const result = tcpProbe(ctx, machineId, ip, port);
      checks.push(check(`${machineId} cannot reach ${label} ${ip}:${port}`, result === "BLOCKED", result));
    }
  }
  return checks;
};

const gateProvisioning = (ctx: GateContext): Promise<GateCheck[]> => Promise.resolve([
  ...pm2Checks(ctx),
  ...mTlsChecks(ctx),
  ...negativeMtlsChecks(ctx),
  ...(ctx.topology.features.dmzMachines.length > 0 ? dmzChecks(ctx) : [skip("DMZ zero-trust", "topology has no DMZ edge machine")]),
]);

// ---------------------------------------------------------------------------
// Gate 2 — replica routing + RYOW
// ---------------------------------------------------------------------------

const gateStorageRouting = async (ctx: GateContext): Promise<GateCheck[]> => {
  const token = adminToken(ctx);
  await sleep(3_000); // let the 150 ms LSN monitor observe fresh replicas
  const served: string[] = [];
  for (let index = 0; index < ctx.intensity.readSamples; index += 1) {
    const response = await adminFetch(ctx, token, "/merchants?limit=1");
    if (!response.ok) throw new Error(`admin merchants returned ${response.status}`);
    served.push(response.headers.get("x-pg-served-by") ?? "");
    await response.arrayBuffer();
  }
  const replicas = ctx.plan.storage.postgres.replicas;
  const fromReplica = served.filter((entry) => entry.startsWith("replica")).length;
  const fromPrimary = served.filter((entry) => entry === "primary").length;
  const checks: GateCheck[] = [
    replicas.length > 0
      ? check(`${served.length} list reads are served by replicas`, fromReplica === served.length, `servedBy=${[...new Set(served)].join(",") || "missing"}`, { fromReplica, fromPrimary, samples: served.length })
      : check(`${served.length} list reads are served by the primary`, fromPrimary === served.length, `servedBy=${[...new Set(served)].join(",") || "missing"}`, { fromPrimary, samples: served.length }),
  ];
  const replica = replicas[0];
  if (!replica) {
    checks.push(skip("RYOW with a paused replica", "topology has no replica"));
    return checks;
  }
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  ctx.remote.run(replica.privateIp, `runuser -u postgres -- psql -p ${replica.servicePort} -c 'SELECT pg_wal_replay_pause()'`, { sudo: true });
  await sleep(500);
  try {
    const name = `RYOW ${suffix}`;
    const row = firstLine(primaryPsql(ctx, `INSERT INTO merchants (id, created_at, updated_at, legal_name, trade_name, onboarding_channel, country) VALUES (gen_random_uuid(), now(), now(), ${sqlLiteral(name)}, ${sqlLiteral(name)}, 'API', 'LY') RETURNING id`));
    const pg = primaryNode(ctx);
    ctx.remote.run(pg.privateIp, `runuser -u postgres -- psql -p ${pg.servicePort} -c 'SELECT pg_switch_wal()'`, { sudo: true });
    const lsn = firstLine(primaryPsql(ctx, "SELECT pg_current_wal_flush_lsn()::text"));
    const response = await adminFetch(ctx, token, `/merchants?search=${encodeURIComponent(name)}&limit=5`, { headers: { "x-pg-min-lsn": lsn } });
    const body = await response.json() as { merchants?: Array<{ id: string }> };
    const servedBy = response.headers.get("x-pg-served-by") ?? "";
    checks.push(check("RYOW read returns the just-committed merchant", (body.merchants ?? []).some((merchant) => merchant.id === row), `id=${row} servedBy=${servedBy}`));
    // With every replica possibly paused-or-behind, only the primary is safe.
    checks.push(check("RYOW read is served by the primary while the replica is paused", servedBy === "primary", `servedBy=${servedBy || "missing"}`));
  } finally {
    ctx.remote.run(replica.privateIp, `runuser -u postgres -- psql -p ${replica.servicePort} -c 'SELECT pg_wal_replay_resume()'`, { sudo: true });
  }
  return checks;
};

// ---------------------------------------------------------------------------
// Gate 3 — seeder + Fake Rails
// ---------------------------------------------------------------------------

const gateSeeder = (ctx: GateContext): Promise<GateCheck[]> => {
  const attempts = scalar(ctx, "SELECT count(*)::text FROM payment_attempts");
  const fakeRailsHost = ctx.plan.hosts.find((host) => host.roles.includes("fake-rails"));
  const code = fakeRailsHost
    ? ctx.remote.capture(fakeRailsHost.ssh.host, `curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://${fakeRailsHost.ssh.host}:${ctx.config.FAKE_RAILS_NGINX_PORT}/health || true`).trim()
    : "no-host";
  return Promise.resolve([
    check("synthetic attempts were seeded", attempts > 0, `attempts=${attempts}`, { attempts }),
    check("Fake Rails /health returns 200", code === "200", `http=${code}`),
    ...invariantChecks(ctx),
  ]);
};

// ---------------------------------------------------------------------------
// Gate 4 — hot link + sustained throughput (measured TPS) + ledger
// ---------------------------------------------------------------------------

const gateCheckoutStress = (ctx: GateContext): Promise<GateCheck[]> => withRulesSuspended(ctx, async () => {
  const slo = ctx.intensity.slo;
  const targets = paymentTargets(ctx);
  const linkId = firstLine(primaryPsql(ctx, `SELECT id FROM payment_links WHERE key = ${sqlLiteral(targets[0]!.linkKey)}`));
  const useCount = ctx.intensity.hotLink.useCount;
  primaryPsql(ctx, `UPDATE payment_links SET use_count = ${useCount}, confirmed_count = 0, active_locked_count = 0, infinite_use = false, expires_at = now() + interval '1 hour' WHERE id = ${sqlLiteral(linkId)}`);
  const hot = await runHotLinkContention({ targets, attempts: ctx.intensity.hotLink.attempts, concurrency: ctx.intensity.hotLink.concurrency, timeoutMs: ctx.intensity.requestTimeoutMs });
  const [confirmed, active] = primaryPsql(ctx, `SELECT confirmed_count || '|' || active_locked_count FROM payment_links WHERE id = ${sqlLiteral(linkId)}`).split("|").map(Number);
  primaryPsql(ctx, `UPDATE payment_links SET confirmed_count = 0, active_locked_count = 0, infinite_use = true, expires_at = now() + interval '2 hours' WHERE id = ${sqlLiteral(linkId)}`);

  const load = await sustained(ctx, () => targets, "stress");
  const starved = targets.filter((target) => (load.perNode[target.nodeId ?? target.baseUrl]?.succeeded ?? 0) === 0).map((target) => target.nodeId);
  return [
    check("hot link: every attempt got a decision", hot.succeeded + hot.conflict + hot.failed === hot.total, `success=${hot.succeeded} conflict=${hot.conflict} failed=${hot.failed}`),
    check("hot link: never oversold", hot.succeeded <= useCount && (confirmed ?? 0) + (active ?? 0) <= useCount, `wins=${hot.succeeded} confirmed=${confirmed} active=${active} useCount=${useCount}`, { wins: hot.succeeded, useCount }),
    check("hot link: exactly useCount attempts win", hot.succeeded === useCount, `wins=${hot.succeeded} useCount=${useCount} failed=${hot.failed}`),
    check(`achieved TPS >= ${slo.minTps}`, load.achievedTps >= slo.minTps, `achieved=${load.achievedTps.toFixed(1)} offered=${ctx.intensity.targetTps} saturated=${load.saturated}`, loadSummary(load)),
    check(`p95 <= ${slo.maxP95Ms}ms`, load.p95 <= slo.maxP95Ms, `p95=${load.p95.toFixed(1)}ms`),
    check(`p99 <= ${slo.maxP99Ms}ms`, load.p99 <= slo.maxP99Ms, `p99=${load.p99.toFixed(1)}ms`),
    check(`error rate <= ${slo.maxErrorRate}`, load.errorRate <= slo.maxErrorRate, `errorRate=${load.errorRate.toFixed(4)} failed=${load.failed}/${load.total} ${load.errors.slice(0, 3).join(" | ")}`),
    check("every checkout node served successful checkouts", starved.length === 0, starved.length ? `no successes on ${starved.join(",")}` : `nodes=${targets.length}`),
    ...invariantChecks(ctx),
  ];
});

// ---------------------------------------------------------------------------
// Gate 5 — SSE bridge
// ---------------------------------------------------------------------------

const gateRealtime = async (ctx: GateContext): Promise<GateCheck[]> => {
  const redis = ctx.plan.storage.redis[0];
  const attempt = firstLine(primaryPsql(ctx, "SELECT a.id || '|' || pl.key FROM payment_attempts a JOIN payment_links pl ON pl.id = a.link_id WHERE a.status NOT IN ('SUCCEEDED','FAILED','EXPIRED','CANCELLED','BLOCKED','REFUNDED') LIMIT 1")).split("|");
  if (!redis) return [check("Redis node configured", false)];
  if (attempt.length < 2 || !attempt[0]) return [check("a pending attempt exists for the SSE probe", false, "none found")];
  const [attemptId, linkKey] = attempt as [string, string];
  const checkout = ctx.plan.nodes.checkout[ctx.plan.nodes.checkout.length - 1]!;
  const event = {
    id: randomUUID(), namespace: "payment-gateway", topic: "realtime:attempt",
    payload: { attemptId, status: "SUCCEEDED", substatus: null, emittedAt: new Date().toISOString() },
    publishedAt: new Date().toISOString(),
  };
  const out = `/tmp/pg-sse-${ctx.topology.slug}.out`;
  ctx.remote.run(checkout.privateIp, `rm -f ${out}; nohup timeout 8 curl -sS -N http://${checkout.privateIp}:${checkout.port}/api/v1/pay/${linkKey}/logs/${attemptId}/status > ${out} 2>&1 &`);
  await sleep(750);
  ctx.remote.run(redis.privateIp, `REDISCLI_AUTH=${shellQuote(ctx.config.REDIS_PASSWORD ?? "")} redis-cli -h ${redis.privateIp} -p ${redis.servicePort} PUBLISH ${shellQuote("payment-gateway:invalidation:realtime:attempt")} ${shellQuote(JSON.stringify(event))}`);
  await sleep(1_250);
  const stream = ctx.remote.capture(checkout.privateIp, `cat ${out} 2>/dev/null || true`);
  return [
    check("SSE stream is reachable", stream.includes("event: status"), stream.slice(0, 160)),
    check("SSE receives the cross-node transition", stream.includes("SUCCEEDED"), stream.slice(-160)),
  ];
};

// ---------------------------------------------------------------------------
// Gate 6 — workers
// ---------------------------------------------------------------------------

const gateWorkers = async (ctx: GateContext): Promise<GateCheck[]> => {
  const staleSql = "SELECT count(*)::text FROM payment_attempts WHERE expires_at <= now() - interval '1 minute' AND status NOT IN ('SUCCEEDED','FAILED','EXPIRED','CANCELLED','BLOCKED','REFUNDED')";
  const inboundSql = "SELECT count(*)::text FROM inbound_events WHERE processed_at IS NULL";
  const outboxSql = "SELECT count(*)::text FROM outbox_events WHERE processed_at IS NULL";
  const before = { stale: scalar(ctx, staleSql), inbound: scalar(ctx, inboundSql), outbox: scalar(ctx, outboxSql) };
  await sleep(ctx.intensity.slo.queueDrainSec * 1000);
  const after = { stale: scalar(ctx, staleSql), inbound: scalar(ctx, inboundSql), outbox: scalar(ctx, outboxSql) };
  const drain = (label: string, from: number, to: number): GateCheck =>
    from === 0 && to === 0
      ? skip(`${label} queue drains`, "queue was empty; nothing to measure")
      : check(`${label} queue drains within ${ctx.intensity.slo.queueDrainSec}s`, to === 0 || to < from, `before=${from} after=${to}`, { before: from, after: to });
  return [
    check("expiry worker leaves no stale non-terminal attempts", after.stale === 0 || after.stale < before.stale, `before=${before.stale} after=${after.stale}`, { before: before.stale, after: after.stale }),
    drain("inbound", before.inbound, after.inbound),
    drain("outbox", before.outbox, after.outbox),
  ];
};

// ---------------------------------------------------------------------------
// Gate 7 — audit chain
// ---------------------------------------------------------------------------

const gateAudit = (ctx: GateContext): Promise<GateCheck[]> => {
  const audit = ctx.plan.storage.auditDb;
  if (!audit) return Promise.resolve([check("audit database configured", false)]);
  const psql = (sql: string): string => ctx.remote.capture(audit.privateIp, `PGPASSWORD=${shellQuote(ctx.config.AUDIT_DB_PASSWORD ?? "")} psql -X -h 127.0.0.1 -p ${audit.servicePort} -U ${ctx.config.AUDIT_DB_USER} -d ${ctx.config.AUDIT_DB_NAME} -tAc ${shellQuote(sql)} 2>&1 || true`);
  const rows = Number(firstLine(psql("SELECT count(*) FROM audit_records")));
  const tamper = psql("UPDATE audit_records SET action='HACKED' WHERE seq_no = (SELECT min(seq_no) FROM audit_records)");
  const deleted = psql("DELETE FROM audit_records WHERE seq_no = (SELECT min(seq_no) FROM audit_records)");
  const chain = firstLine(psql("SELECT valid::text || '|' || verified_count::text || '|' || COALESCE(first_broken_id::text,'') FROM verify_audit_chain()"));
  if (!(rows > 0)) return Promise.resolve([check("audit records exist to tamper with", false, `rows=${rows}`)]);
  return Promise.resolve([
    check("audit UPDATE is rejected", /AUDIT_TAMPER_PROHIBITED|permission denied/i.test(tamper), tamper.slice(0, 160)),
    check("audit DELETE is rejected", /AUDIT_TAMPER_PROHIBITED|permission denied/i.test(deleted), deleted.slice(0, 160)),
    check("audit hash chain verifies every row", chain.startsWith("true|") && Number(chain.split("|")[1]) >= rows, `verify_audit_chain=${chain} rows=${rows}`, { rows }),
  ]);
};

// ---------------------------------------------------------------------------
// Gate 8 — log DB outage
// ---------------------------------------------------------------------------

const gateLogOutage = async (ctx: GateContext): Promise<GateCheck[]> => {
  const log = ctx.plan.storage.logDb;
  if (!log) return [check("log database configured", false)];
  const cluster = pgClusterFor(ctx.config, "log", { privateIp: log.privateIp, servicePort: log.servicePort });
  const logCount = (): number => Number(firstLine(ctx.remote.psql({ host: log.privateIp, port: log.servicePort, user: ctx.config.LOG_DB_USER, password: ctx.config.LOG_DB_PASSWORD ?? "", database: ctx.config.LOG_DB_NAME, sql: "SELECT count(*) FROM attempt_step_logs" })));
  const logsBefore = logCount();
  const attemptsBefore = scalar(ctx, "SELECT count(*)::text FROM payment_attempts");
  // Stop exactly the log cluster. The archived gate fell back to
  // `systemctl stop postgresql`, which stops every cluster on the host —
  // including a co-located primary.
  ctx.remote.run(log.privateIp, `systemctl stop ${shellQuote(cluster.service)}`, { sudo: true });
  const state = ctx.remote.capture(log.privateIp, `systemctl is-active ${shellQuote(cluster.service)} 2>/dev/null || true`).trim();
  let load: SustainedLoadResult | undefined;
  try {
    if (state === "active") return [check(`log cluster ${cluster.service} stopped`, false, `systemd=${state}`)];
    load = await withRulesSuspended(ctx, () => sustained(ctx, () => paymentTargets(ctx), "log-outage", { durationSec: Math.min(ctx.intensity.durationSec, 30), rampUpSec: 0 }));
  } finally {
    ctx.remote.run(log.privateIp, `systemctl start ${shellQuote(cluster.service)}`, { sudo: true });
  }
  let logsAfter = logsBefore;
  const deadline = Date.now() + ctx.intensity.slo.queueDrainSec * 1000;
  while (Date.now() < deadline) {
    await sleep(1_000);
    try {
      logsAfter = logCount();
      if (logsAfter > logsBefore) break;
    } catch {
      // cluster still starting
    }
  }
  const attemptsAfter = scalar(ctx, "SELECT count(*)::text FROM payment_attempts");
  if (!load) return [check("log outage workload ran", false)];
  return [
    check(`checkouts keep working while the log DB is down (error rate <= ${ctx.intensity.slo.maxErrorRate})`, load.errorRate <= ctx.intensity.slo.maxErrorRate && load.succeeded > 0, `succeeded=${load.succeeded} failed=${load.failed}`, loadSummary(load)),
    check("buffered step logs are flushed after recovery", logsAfter > logsBefore, `attempt_step_logs ${logsBefore} -> ${logsAfter}`, { logsBefore, logsAfter }),
    check("every successful checkout during the outage is durable", attemptsAfter - attemptsBefore >= load.succeeded, `attempts +${attemptsAfter - attemptsBefore} vs succeeded ${load.succeeded}`),
  ];
};

// ---------------------------------------------------------------------------
// Gate 9 — search
// ---------------------------------------------------------------------------

const gateSearch = async (ctx: GateContext): Promise<GateCheck[]> => {
  const token = adminToken(ctx);
  const latencies: number[] = [];
  for (let index = 0; index < ctx.intensity.searchQueries; index += 1) {
    const started = performance.now();
    const response = await adminFetch(ctx, token, "/search", { method: "POST", body: JSON.stringify({ query: "شركة" }) });
    if (!response.ok) throw new Error(`search returned ${response.status}`);
    await response.arrayBuffer();
    latencies.push(performance.now() - started);
  }
  latencies.sort((left, right) => left - right);
  const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] ?? 0;
  const aml = await adminFetch(ctx, supportToken(ctx), "/search", { method: "POST", body: JSON.stringify({ query: "aml" }) });
  const amlBody = await aml.text();
  return [
    check(`search p95 <= ${ctx.intensity.slo.searchP95Ms}ms`, p95 <= ctx.intensity.slo.searchP95Ms, `p95=${p95.toFixed(1)}ms over ${latencies.length} queries`, { p95Ms: Number(p95.toFixed(1)), queries: latencies.length }),
    // A failed request must not count as "nothing exposed".
    check("SUPPORT search succeeds and does not expose AML groups", aml.ok && !/"group"\s*:\s*"aml/i.test(amlBody), `http=${aml.status} ${amlBody.slice(0, 120)}`),
  ];
};

// ---------------------------------------------------------------------------
// Gate 10 — backup
// ---------------------------------------------------------------------------

const gateBackup = async (ctx: GateContext): Promise<GateCheck[]> => {
  const token = adminToken(ctx);
  const overview = await adminFetch(ctx, token, "/system/backups/overview");
  const overviewBody = await overview.json().catch(() => ({})) as Record<string, unknown>;
  const trigger = await adminFetch(ctx, token, "/system/backups/trigger", { method: "POST", body: JSON.stringify({ target: "all", kind: "full" }) });
  const triggerBody = await trigger.json().catch(() => ({})) as { backupJobId?: string };
  let finalStatus = "UNKNOWN";
  const started = Date.now();
  while (trigger.ok && triggerBody.backupJobId && Date.now() - started < ctx.intensity.slo.backupTimeoutSec * 1000) {
    await sleep(2_000);
    const runs = await adminFetch(ctx, token, "/system/backups/overview");
    const body = await runs.json().catch(() => ({})) as { backups?: Array<{ id?: string; status?: string }> };
    const run = (body.backups ?? []).find((entry) => entry.id === triggerBody.backupJobId);
    finalStatus = run?.status ?? finalStatus;
    if (["PASSED", "SUCCEEDED", "COMPLETED", "FAILED"].includes(finalStatus)) break;
  }
  const drill = await adminFetch(ctx, token, "/system/backups/drill", { method: "POST", body: JSON.stringify({}) });
  const drillBody = await drill.json().catch(() => ({})) as { drillId?: string };
  // The drill is asynchronous: poll the overview until THIS drill reaches a
  // terminal status, then assert the restored copy is internally consistent.
  interface LatestDrill {
    id?: string;
    status?: string;
    doubleEntryDrift?: number | string | null;
    balanceMismatches?: number | null;
    auditBrokenLinks?: number | null;
  }
  let latestDrill: LatestDrill | undefined;
  const drillStarted = Date.now();
  while (drill.ok && drillBody.drillId && Date.now() - drillStarted < ctx.intensity.slo.backupTimeoutSec * 1000) {
    await sleep(2_000);
    const response = await adminFetch(ctx, token, "/system/backups/overview");
    const body = await response.json().catch(() => ({})) as { latestDrill?: LatestDrill | null };
    if (body.latestDrill?.id === drillBody.drillId) {
      latestDrill = body.latestDrill;
      if (latestDrill.status === "PASSED" || latestDrill.status === "FAILED") break;
    }
  }
  const drillDone = latestDrill?.status === "PASSED" || latestDrill?.status === "FAILED";
  const drillSummary = `drill=${drillBody.drillId ?? "none"} status=${latestDrill?.status ?? "UNKNOWN"} after ${Math.round((Date.now() - drillStarted) / 1000)}s`;
  return [
    check("backup overview is reachable", overview.ok, `status=${overview.status}`),
    check("backup overview reports WAL archiving healthy", overviewBody.walArchiveHealthy === true, JSON.stringify(overviewBody).slice(0, 200)),
    check(`full backup completes within ${ctx.intensity.slo.backupTimeoutSec}s`, ["PASSED", "SUCCEEDED", "COMPLETED"].includes(finalStatus), `trigger=${trigger.status} job=${triggerBody.backupJobId ?? "none"} status=${finalStatus} after ${Math.round((Date.now() - started) / 1000)}s`),
    check("restore drill is accepted", drill.ok && Boolean(drillBody.drillId), `status=${drill.status} drill=${drillBody.drillId ?? "none"}`),
    check("restore drill completes and passes", drillDone && latestDrill?.status === "PASSED", drillSummary, latestDrill ? { drillStatus: latestDrill.status ?? "UNKNOWN", doubleEntryDrift: String(latestDrill.doubleEntryDrift), balanceMismatches: String(latestDrill.balanceMismatches), auditBrokenLinks: String(latestDrill.auditBrokenLinks) } : undefined),
    check("restored copy has zero double-entry drift", drillDone && Number(latestDrill?.doubleEntryDrift) === 0, `doubleEntryDrift=${String(latestDrill?.doubleEntryDrift)}`),
    check("restored copy has no balance mismatches", drillDone && latestDrill?.balanceMismatches === 0, `balanceMismatches=${String(latestDrill?.balanceMismatches)}`),
    check("restored audit chain has no broken links", drillDone && latestDrill?.auditBrokenLinks === 0, `auditBrokenLinks=${String(latestDrill?.auditBrokenLinks)}`),
  ];
};

// ---------------------------------------------------------------------------
// Gate 12 — chaos
// ---------------------------------------------------------------------------

interface FaultAction {
  label: string;
  inject: () => Promise<{ ok: boolean; output: string }>;
  restore: () => Promise<{ ok: boolean; output: string }>;
  verifyRestored: () => Promise<boolean>;
}

const pm2 = '"$HOME/.bun/bin/pm2"';

const faultAction = (ctx: GateContext, type: ChaosFaultType): FaultAction | string => {
  const core = ctx.plan.nodes.core[ctx.plan.nodes.core.length - 1];
  const replica = ctx.plan.storage.postgres.replicas[ctx.plan.storage.postgres.replicas.length - 1];
  const redis = ctx.plan.storage.redis[0];
  const log = ctx.plan.storage.logDb;
  const systemd = (host: string, unit: string, label: string): FaultAction => ({
    label,
    inject: () => ctx.remote.runAsync(host, `systemctl stop ${shellQuote(unit)}`, { sudo: true }),
    restore: () => ctx.remote.runAsync(host, `systemctl start ${shellQuote(unit)}`, { sudo: true }),
    verifyRestored: async () => (await ctx.remote.runAsync(host, `systemctl is-active ${shellQuote(unit)}`)).output.trim() === "active",
  });
  const pm2Online = (node: NodePlan) => async (): Promise<boolean> => {
    const result = await ctx.remote.runAsync(node.ssh.host, `${pm2} jlist`);
    try {
      return (JSON.parse(result.output) as Array<{ name: string; pm2_env?: { status?: string } }>).some((app) => app.name === node.serviceName && app.pm2_env?.status === "online");
    } catch {
      return false;
    }
  };
  switch (type) {
    case "core-restart":
      if (!core || ctx.plan.nodes.core.length < 2) return "needs at least two core nodes";
      return { label: `pm2 restart ${core.serviceName}`, inject: () => ctx.remote.runAsync(core.ssh.host, `${pm2} restart ${core.serviceName}`), restore: () => Promise.resolve({ ok: true, output: "" }), verifyRestored: pm2Online(core) };
    case "core-kill":
      if (!core || ctx.plan.nodes.core.length < 2) return "needs at least two core nodes";
      return {
        label: `SIGKILL + stop ${core.serviceName}`,
        inject: () => ctx.remote.runAsync(core.ssh.host, `kill -9 $(${pm2} pid ${core.serviceName}) 2>/dev/null; ${pm2} stop ${core.serviceName}`),
        restore: () => ctx.remote.runAsync(core.ssh.host, `${pm2} start ${core.serviceName}`),
        verifyRestored: pm2Online(core),
      };
    case "replica-stop": {
      if (!replica) return "topology has no replica";
      const cluster = pgClusterFor(ctx.config, "replica", { nodeId: replica.nodeId, privateIp: replica.privateIp, servicePort: replica.servicePort });
      return systemd(replica.privateIp, cluster.service, `stop ${cluster.service}`);
    }
    case "redis-stop":
      if (!redis) return "topology has no Redis node";
      return systemd(redis.privateIp, "redis-server", "stop redis-server");
    case "log-db-stop": {
      if (!log) return "topology has no log DB";
      const cluster = pgClusterFor(ctx.config, "log", { privateIp: log.privateIp, servicePort: log.servicePort });
      return systemd(log.privateIp, cluster.service, `stop ${cluster.service}`);
    }
    case "primary-pitr":
      return "not implemented: primary wipe + PITR restore orchestration is pending";
  }
};

const probeRecovered = async (ctx: GateContext, withinSec: number): Promise<number | null> => {
  const started = Date.now();
  while (Date.now() - started < withinSec * 1000) {
    const probe = await runPaymentBurst({ targets: paymentTargets(ctx), total: 10, concurrency: 5, idempotencyPrefix: `recover-${Date.now()}`, timeoutMs: 5_000 });
    if (probe.failed === 0) return (Date.now() - started) / 1000;
    await sleep(1_000);
  }
  return null;
};

const gateChaos = async (ctx: GateContext): Promise<GateCheck[]> => {
  if (!ctx.topology.features.chaos) return [skip("chaos faults", "only the 'chaos' topology family injects faults")];
  if (!ctx.intensity.chaos.enabled) return [skip("chaos faults", `chaos disabled by intensity preset '${ctx.intensity.preset}' (set intensity.overrides.chaos.enabled=true)`)];
  const checks: GateCheck[] = [];
  const scheduled: Array<{ fault: FaultAction; everySec: number; downSec: number; type: ChaosFaultType }> = [];
  for (const fault of ctx.intensity.chaos.faults) {
    const action = faultAction(ctx, fault.type);
    if (typeof action === "string") checks.push(skip(`fault ${fault.type}`, action));
    else scheduled.push({ fault: action, everySec: fault.everySec, downSec: fault.downSec, type: fault.type });
  }
  if (scheduled.length === 0) return checks.length > 0 ? checks : [skip("chaos faults", "no faults configured")];

  const injections: Array<{ type: ChaosFaultType; atSec: number; ok: boolean; output: string }> = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const pendingRestores = new Set<Promise<unknown>>();
  const startedAt = Date.now();
  const totalSec = ctx.intensity.rampUpSec + ctx.intensity.durationSec;
  for (const entry of scheduled) {
    for (let at = entry.everySec; at + entry.downSec < totalSec; at += entry.everySec) {
      timers.push(setTimeout(() => {
        const run = (async () => {
          const result = await entry.fault.inject();
          injections.push({ type: entry.type, atSec: Math.round((Date.now() - startedAt) / 1000), ok: result.ok, output: result.output.slice(0, 200) });
          await sleep(entry.downSec * 1000);
          await entry.fault.restore();
        })();
        pendingRestores.add(run);
        void run.finally(() => pendingRestores.delete(run));
      }, at * 1000));
    }
  }
  let load: SustainedLoadResult;
  try {
    load = await withRulesSuspended(ctx, () => sustained(ctx, () => paymentTargets(ctx), "chaos"));
  } finally {
    timers.forEach(clearTimeout);
    await Promise.allSettled([...pendingRestores]);
    // Always restore, even when a fault was mid-flight or the load threw.
    for (const entry of scheduled) await entry.fault.restore();
  }
  for (const entry of scheduled) {
    const mine = injections.filter((injection) => injection.type === entry.type);
    checks.push(check(`fault ${entry.type} injected (${entry.fault.label})`, mine.length > 0 && mine.every((injection) => injection.ok), mine.length === 0 ? "never injected: duration shorter than everySec + downSec" : mine.map((injection) => `t=${injection.atSec}s ${injection.ok ? "ok" : `failed: ${injection.output}`}`).join("; "), { injections: mine.length }));
    checks.push(check(`fault ${entry.type} target restored`, await entry.fault.verifyRestored(), entry.fault.label));
  }
  const recoverySec = await probeRecovered(ctx, ctx.intensity.slo.recoverySec);
  checks.push(check(`error rate under faults <= ${ctx.intensity.slo.chaosMaxErrorRate}`, load.errorRate <= ctx.intensity.slo.chaosMaxErrorRate, `errorRate=${load.errorRate.toFixed(4)} failed=${load.failed}/${load.total}`, loadSummary(load)));
  checks.push(check(`checkouts fully recover within ${ctx.intensity.slo.recoverySec}s`, recoverySec !== null, recoverySec === null ? "still failing" : `recovered after ${recoverySec.toFixed(1)}s`));
  checks.push(...invariantChecks(ctx));
  return checks;
};

// ---------------------------------------------------------------------------
// Gate 11 — scale in / out under load
// ---------------------------------------------------------------------------

const gateScale = async (ctx: GateContext): Promise<GateCheck[]> => {
  const scalable = ctx.topology.features.scalableNodeIds;
  if (scalable.length === 0) return [skip("scale in/out", "only the 'scale' topology family has scalable nodes")];
  const nodes = [...ctx.plan.nodes.core, ...ctx.plan.nodes.checkout].filter((node) => scalable.includes(node.nodeId));
  const allTargets = paymentTargets(ctx);
  const stopped = new Set<string>();
  // Clients address checkout nodes directly, so a stopped checkout node is
  // removed from the live set when it is stopped (what a load balancer drain
  // does); core scale-in is absorbed by the edge CORE_BACK_URLS pools.
  const live = (): PaymentTarget[] => allTargets.filter((target) => !stopped.has(target.nodeId ?? ""));
  const totalSec = ctx.intensity.rampUpSec + ctx.intensity.durationSec;
  const actions: string[] = [];
  const scaleIn = setTimeout(() => {
    for (const node of nodes) stopped.add(node.nodeId);
    void Promise.all(nodes.map((node) => ctx.remote.runAsync(node.ssh.host, `${pm2} stop ${node.serviceName}`)))
      .then((results) => actions.push(`scale-in t=${Math.round(totalSec / 3)}s ${results.every((r) => r.ok) ? "ok" : "partial"}`));
  }, (totalSec / 3) * 1000);
  let scaleOutDone: Promise<unknown> = Promise.resolve();
  const scaleOut = setTimeout(() => {
    scaleOutDone = Promise.all(nodes.map((node) => ctx.remote.runAsync(node.ssh.host, `${pm2} start ${node.serviceName}`)))
      .then(async (results) => {
        actions.push(`scale-out t=${Math.round((2 * totalSec) / 3)}s ${results.every((r) => r.ok) ? "ok" : "partial"}`);
        await sleep(3_000); // let the started nodes bind before they get traffic
        stopped.clear();
      });
  }, ((2 * totalSec) / 3) * 1000);
  let load: SustainedLoadResult;
  try {
    load = await withRulesSuspended(ctx, () => sustained(ctx, live, "scale"));
  } finally {
    clearTimeout(scaleIn);
    clearTimeout(scaleOut);
    await scaleOutDone;
    for (const node of nodes) ctx.remote.run(node.ssh.host, `${pm2} start ${node.serviceName} >/dev/null 2>&1 || true`);
  }
  const restartedCheckout = allTargets.filter((target) => nodes.some((node) => node.nodeId === target.nodeId));
  const after = restartedCheckout.length > 0
    ? await runPaymentBurst({ targets: restartedCheckout, total: restartedCheckout.length * 5, concurrency: 5, idempotencyPrefix: `scaled-out-${Date.now()}`, timeoutMs: ctx.intensity.requestTimeoutMs })
    : undefined;
  return [
    check("scale-in and scale-out both executed during the run", actions.length === 2 && actions.every((action) => action.endsWith("ok")), actions.join("; ") || "no action ran"),
    check(`error rate during scaling <= ${ctx.intensity.slo.maxErrorRate}`, load.errorRate <= ctx.intensity.slo.maxErrorRate, `errorRate=${load.errorRate.toFixed(4)}`, loadSummary(load)),
    after
      ? check("scaled-out checkout nodes serve traffic", after.failed === 0 && after.succeeded > 0, `success=${after.succeeded} failed=${after.failed}`)
      : skip("scaled-out checkout nodes serve traffic", "no checkout node was scaled"),
    ...invariantChecks(ctx),
  ];
};

const GATE_FNS: Record<GateId, (ctx: GateContext) => Promise<GateCheck[]>> = {
  provisioning: gateProvisioning,
  "storage-routing": gateStorageRouting,
  "seeder-invariants": gateSeeder,
  "checkout-stress": gateCheckoutStress,
  "realtime-sse": gateRealtime,
  workers: gateWorkers,
  "audit-chain": gateAudit,
  "log-db-outage": gateLogOutage,
  search: gateSearch,
  backup: gateBackup,
  scale: gateScale,
  chaos: gateChaos,
};

export const gateMeta = (id: GateId): { gate: number; name: string } => GATE_META[id];

/**
 * Runs the gates the intensity selects, in GATE_IDS order (scale before the
 * destructive chaos gate). A provisioning failure stops the topology; other
 * failures stop it only when continueOnGateFailure=false. Gates that do not
 * run are reported as NOT_RUN instead of being silently dropped.
 */
export const runAllGates = async (ctx: GateContext, log: (message: string) => void = console.log): Promise<GateResult[]> => {
  const selected = new Set(selectedGates(ctx.intensity));
  const results: GateResult[] = [];
  let stopReason: string | null = null;
  for (const id of GATE_IDS) {
    if (!selected.has(id)) continue;
    if (stopReason) {
      results.push({ ...GATE_META[id], id, status: "NOT_RUN", checks: [], durationMs: 0, error: stopReason });
      continue;
    }
    const result = await runGate(id, () => GATE_FNS[id](ctx));
    results.push(result);
    log(`  Gate ${result.gate} ${id}: ${result.status} (${result.durationMs}ms)`);
    if (result.status === "FAILED" && (id === "provisioning" || !ctx.intensity.continueOnGateFailure)) {
      stopReason = `not run: gate ${result.gate} (${id}) failed`;
    }
  }
  return results;
};

export const topologyPassed = (deployOk: boolean, gates: GateResult[]): boolean =>
  deployOk && gates.length > 0 && gates.every((gate) => gate.status === "PASSED" || gate.status === "SKIPPED") && gates.some((gate) => gate.status === "PASSED");

export type { CheckStatus };
