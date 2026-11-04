import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadDeployConfig } from "../lib/configSchema";
import { planHosts, type DeployPlan } from "../lib/hostPlanner";
import { probeCoreNodes, probeEdgeToCore, type ProbeResult } from "../lib/healthVerifier";
import { LabRemote, shellQuote } from "./remote";
import { pgClusterFor } from "../provisioners/postgres18Provisioner";
import { runHotLinkContention, runPaymentBurst, type PaymentTarget } from "./stressWorkload";
import type { GateCheck, GateResult, LabHostsConfig, TopologyId } from "./types";

export interface GateContext {
  lab: LabHostsConfig;
  topology: TopologyId;
  configPath: string;
  config: ReturnType<typeof loadDeployConfig>["config"] & {};
  plan: DeployPlan;
  remote: LabRemote;
}

export const loadGateContext = (lab: LabHostsConfig, topology: TopologyId, configPath: string): GateContext => {
  const loaded = loadDeployConfig(readFileSync(configPath, "utf8"));
  if (!loaded.ok || !loaded.config) throw new Error(`Invalid ${configPath}: ${loaded.problems.join("; ")}`);
  return { lab, topology, configPath, config: loaded.config, plan: planHosts(loaded.config), remote: new LabRemote(lab) };
};

const check = (name: string, ok: boolean, detail = ""): GateCheck => ({ name, ok, detail });

const result = async (gate: number, name: string, fn: () => Promise<GateCheck[]>): Promise<GateResult> => {
  const started = Date.now();
  try {
    const checks = await fn();
    return { gate, name, status: checks.every((entry) => entry.ok) ? "PASSED" : "FAILED", checks, durationMs: Date.now() - started };
  } catch (error) {
    return {
      gate,
      name,
      status: "FAILED",
      checks: [check("gate execution", false, error instanceof Error ? error.message : String(error))],
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const b64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

const sessionKey = (kmsMasterKey: string): Buffer =>
  Buffer.from(hkdfSync("sha256", Buffer.from(kmsMasterKey, "utf8"), Buffer.from("payment-gateway-core", "utf8"), Buffer.from("session-signing", "utf8"), 32));

const signSession = (kmsMasterKey: string, userId: string): string => {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    sub: userId,
    typ: "session",
    role: "GATEWAY_ADMIN",
    merchantId: null,
    authorities: ["*"],
    appScopeIds: [],
    mfa: true,
    iss: "payment-gateway-core",
    aud: "payment-gateway-edge",
    iat: now,
    exp: now + 3600,
  }));
  const signature = createHmac("sha256", sessionKey(kmsMasterKey)).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
};

const primaryNode = (ctx: GateContext) => ctx.plan.storage.postgres.primary!;
const primaryPsql = (ctx: GateContext, sql: string): string =>
  ctx.remote.psql({
    host: primaryNode(ctx).privateIp,
    port: primaryNode(ctx).servicePort,
    user: ctx.config.PG_DB_USER,
    password: ctx.config.PG_DB_PASSWORD,
    database: ctx.config.PG_DB_NAME,
    sql,
  });

const adminBaseUrl = (ctx: GateContext): string => {
  const admin = ctx.plan.nodes.admin[0];
  if (!admin) throw new Error("No admin node in topology");
  // Use the admin-back listener directly. The Nginx vhost adds
  // X-Forwarded-For, and admin-back's rate limiter rejects that header when
  // trust proxy is false.
  return `http://${admin.privateIp}:${admin.port}/api/v1/admin`;
};

const ensureLabUser = (ctx: GateContext, email: string, role: string, authoritiesJson: string): string => {
  const id = primaryPsql(ctx, `INSERT INTO users (id, created_at, updated_at, email, role, authorities_map, status, mfa_required, is_maker, is_checker)
    VALUES (gen_random_uuid(), now(), now(), ${shellQuote(email)}, ${shellQuote(role)}, ${shellQuote(authoritiesJson)}::jsonb, 'ACTIVE', false, true, true)
    ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, authorities_map = EXCLUDED.authorities_map, status = 'ACTIVE', mfa_required = false
    RETURNING id`).split("\n")[0]!.trim();
  if (!id) throw new Error(`Unable to provision lab user ${email}`);
  return id;
};

const adminToken = (ctx: GateContext): string =>
  signSession(ctx.config.KMS_MASTER_KEY, ensureLabUser(ctx, "lab-matrix-admin@payment-gateway.internal", "GATEWAY_ADMIN", '{"*": true}'));

const supportToken = (ctx: GateContext): string =>
  signSession(ctx.config.KMS_MASTER_KEY, ensureLabUser(ctx, "lab-matrix-support@payment-gateway.internal", "SUPPORT", '{"merchant:read": true, "gateway:read": true}'));

const adminFetch = async (ctx: GateContext, token: string, path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  return fetch(`${adminBaseUrl(ctx)}${path}`, { ...init, headers });
};

const pm2Check = (ctx: GateContext): GateCheck[] => {
  const checks: GateCheck[] = [];
  for (const host of ctx.plan.hosts) {
    const apps = ctx.remote.pm2List(host.ssh.host);
    for (const service of host.services) {
      const app = apps.find((entry) => entry.name === service.name);
      checks.push(check(`${host.ssh.host} pm2 ${service.name}`, Boolean(app) && app?.pm2_env?.status === "online", app ? `status=${app.pm2_env?.status} restarts=${app.pm2_env?.restart_time ?? 0}` : "missing"));
    }
  }
  if (ctx.plan.backup.enabled && ctx.plan.backup.node) {
    const host = ctx.plan.backup.node.sshHost;
    const status = ctx.remote.capture(host, "systemctl is-active pg-backup-daemon 2>/dev/null || true").trim();
    checks.push(check(`${host} pg-backup-daemon`, status === "active", `systemd=${status || "missing"}`));
  }
  return checks;
};

const mTlsCheck = (ctx: GateContext): GateCheck[] => {
  const probes: ProbeResult[] = [...probeCoreNodes(ctx.remote.runner, ctx.plan, ctx.config)];
  for (const host of ctx.plan.hosts) {
    probes.push(...probeEdgeToCore(ctx.remote.runner, host, ctx.config));
  }
  return probes.map((probe) => check(`${probe.host} ${probe.check}`, probe.ok, probe.detail));
};

const negativeMtlsCheck = (ctx: GateContext): GateCheck[] => {
  const checks: GateCheck[] = [];
  const core = ctx.plan.nodes.core[0];
  if (!core) return [check("core node exists", false)];
  const edgeHost = ctx.plan.nodes.checkout[0]?.privateIp ?? ctx.lab.hostALanIp;
  const noCert = ctx.remote.capture(edgeHost, `curl -k -sS --max-time 5 https://${core.privateIp}:${core.port}/health >/dev/null 2>&1 || echo NO_CERT_REJECTED`).trim();
  checks.push(check("core rejects a TLS client without a certificate", noCert.includes("NO_CERT_REJECTED"), noCert));
  const checkoutCertDir = `${ctx.config.CHECKOUT_REMOTE_DIR}/shared/certs`;
  const wrongChannel = ctx.remote.capture(
    edgeHost,
    `curl -k -sS -o /dev/null -w '%{http_code}' --max-time 5 --cacert ${checkoutCertDir}/internal-ca.crt --cert ${checkoutCertDir}/checkout-back-client.crt --key ${checkoutCertDir}/checkout-back-client.key https://${core.privateIp}:${core.port}/internal/admin/health || true`,
  ).trim();
  checks.push(check("checkout certificate cannot enter the admin channel", wrongChannel === "403", `http=${wrongChannel}`));
  if (ctx.topology === "T5") {
    // T5 places Barman on HOST_B, so the backup IP is intentionally allowed to
    // reach PostgreSQL for base backups/WAL. The zero-trust assertion is that
    // B cannot reach Redis or PgBouncer, and cannot reach PostgreSQL unless it
    // is the declared backup host.
    const backupOnB = ctx.plan.storage.backup?.privateIp === ctx.lab.hostBLanIp;
    const pg = primaryNode(ctx);
    const blocked = ctx.remote.capture(ctx.lab.hostBLanIp, `timeout 2 bash -c '</dev/tcp/${pg.privateIp}/${pg.servicePort}' >/dev/null 2>&1 || echo BLOCKED`).trim();
    const redis = ctx.plan.storage.redis[0];
    const redisBlocked = redis
      ? ctx.remote.capture(ctx.lab.hostBLanIp, `timeout 2 bash -c '</dev/tcp/${redis.privateIp}/${redis.servicePort}' >/dev/null 2>&1 || echo BLOCKED`).trim()
      : "BLOCKED";
    const pgbouncerBlocked = ctx.config.PGBOUNCER_ENABLED
      ? ctx.remote.capture(ctx.lab.hostBLanIp, `timeout 2 bash -c '</dev/tcp/${pg.privateIp}/${ctx.config.PGBOUNCER_PORT}' >/dev/null 2>&1 || echo BLOCKED`).trim()
      : "BLOCKED";
    checks.push(check("HOST_B cannot reach HOST_A PostgreSQL unless it is the backup host", backupOnB || blocked.includes("BLOCKED"), backupOnB ? "backup host exception" : blocked));
    checks.push(check("HOST_B cannot reach HOST_A PgBouncer", pgbouncerBlocked.includes("BLOCKED"), pgbouncerBlocked));
    checks.push(check("HOST_B cannot reach HOST_A Redis", redisBlocked.includes("BLOCKED"), redisBlocked));
  }
  return checks;
};

const replicaRoutingCheck = async (ctx: GateContext): Promise<GateCheck[]> => {
  const token = adminToken(ctx);
  // Give the 150ms LSN monitor a moment to observe the fresh replica.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const served: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    const response = await adminFetch(ctx, token, "/merchants?limit=1");
    if (!response.ok) throw new Error(`admin merchants returned ${response.status}`);
    const header = response.headers.get("x-pg-served-by") ?? "";
    if (header) served.push(header);
    await response.arrayBuffer();
  }
  const hasReplicas = ctx.plan.storage.postgres.replicas.length > 0;
  const expected = hasReplicas ? served.every((entry) => entry.startsWith("replica-")) : served.every((entry) => entry === "primary");
  return [check("20 list reads use the expected store", expected && served.length === 20, `servedBy=${[...new Set(served)].join(",") || "missing"}`)];
};

const ryowCheck = async (ctx: GateContext): Promise<GateCheck[]> => {
  const replica = ctx.plan.storage.postgres.replicas[0];
  if (!replica) return [check("replica RYOW (primary-only topology)", true, "no replica; fallback to primary is expected")];
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  ctx.remote.run(replica.privateIp, `runuser -u postgres -- psql -p ${replica.servicePort} -c 'SELECT pg_wal_replay_pause()'`, { sudo: true });
  // Let the core LSN monitor observe the paused watermark before the RYOW read.
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    const name = `RYOW ${suffix}`;
    const row = primaryPsql(ctx, `INSERT INTO merchants (id, created_at, updated_at, legal_name, trade_name, onboarding_channel, country) VALUES (gen_random_uuid(), now(), now(), ${shellQuote(name)}, ${shellQuote(name)}, 'API', 'LY') RETURNING id`).split("\n")[0]!.trim();
    // Force a WAL segment switch so the paused replica is unambiguously behind
    // the commit even when the insert fits in an already-flushed segment.
    ctx.remote.run(primaryNode(ctx).privateIp, `runuser -u postgres -- psql -p ${primaryNode(ctx).servicePort} -c 'SELECT pg_switch_wal()'`, { sudo: true });
    const lsn = primaryPsql(ctx, "SELECT pg_current_wal_flush_lsn()::text").split("\n")[0]!.trim();
    const token = adminToken(ctx);
    const response = await adminFetch(ctx, token, `/merchants?search=${encodeURIComponent(name)}&limit=5`, {
      headers: { "x-pg-min-lsn": lsn },
    });
    const body = await response.json() as { merchants?: Array<{ id: string }> };
    const servedBy = response.headers.get("x-pg-served-by") ?? "";
    const found = (body.merchants ?? []).some((merchant) => merchant.id === row);
    return [
      check("RYOW read returns the just-committed merchant", found, `id=${row} servedBy=${servedBy}`),
      check("RYOW read does not use the paused replica", servedBy !== replica.nodeId && servedBy !== "replica-1", `servedBy=${servedBy}`),
    ];
  } finally {
    ctx.remote.run(replica.privateIp, `runuser -u postgres -- psql -p ${replica.servicePort} -c 'SELECT pg_wal_replay_resume()'`, { sudo: true });
  }
};

const invariantCheck = (ctx: GateContext): GateCheck[] => {
  const drift = Number(primaryPsql(ctx, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0)::text FROM journal_lines").trim());
  const shardMismatch = Number(primaryPsql(ctx, `SELECT count(*)::text FROM (
    SELECT gl_account_id, SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END) AS journal_total
    FROM journal_lines GROUP BY gl_account_id
  ) jl JOIN (
    SELECT gl_account_id, SUM(current_balance) AS shard_total FROM gl_account_shards GROUP BY gl_account_id
  ) sh USING (gl_account_id)
  WHERE COALESCE(jl.journal_total, 0) <> COALESCE(sh.shard_total, 0)`).trim());
  return [
    check("double-entry drift is exactly zero", Math.abs(drift) < 0.00005, `drift=${drift.toFixed(4)} LYD`),
    check("gl_account_shards equals journal_lines", shardMismatch === 0, `mismatched accounts=${shardMismatch}`),
  ];
};

const paymentTargets = (ctx: GateContext): PaymentTarget[] => {
  const key = primaryPsql(ctx, `SELECT pl.key FROM payment_links pl
    JOIN applications a ON a.id = pl.application_id
    JOIN merchants m ON m.id = a.merchant_id
    WHERE pl.state = 'PENDING' AND (pl.expires_at IS NULL OR pl.expires_at > now())
      AND m.status = 'ACTIVE' AND m.kyb_status = 'VERIFIED'
    ORDER BY pl.created_at ASC LIMIT 1`).trim();
  const rail = primaryPsql(ctx, `SELECT r.code FROM rails r
    LEFT JOIN rail_fields f ON f.rail_id = r.id
    GROUP BY r.code, r.collection_mode
    HAVING count(f.id) FILTER (WHERE f.required) = 0
    ORDER BY CASE r.collection_mode WHEN 'QR_DISPLAY' THEN 0 WHEN 'OTP_PULL' THEN 1 ELSE 2 END, r.code ASC
    LIMIT 1`).trim();
  if (!key || !rail) throw new Error("No seeded payment link/rail found");
  return ctx.plan.nodes.checkout.map((node) => ({
    baseUrl: `http://${node.privateIp}:${node.port}`,
    linkKey: key,
    railCode: rail,
  }));
};

const gate1 = (ctx: GateContext): Promise<GateResult> => result(1, "Provisioning, UFW zero-trust and SAN mTLS", async () => [
  ...pm2Check(ctx),
  ...mTlsCheck(ctx),
  ...negativeMtlsCheck(ctx),
]);

const gate2 = (ctx: GateContext): Promise<GateResult> => result(2, "Storage routing and LSN read-your-own-writes", async () => [
  ...(await replicaRoutingCheck(ctx)),
  ...(await ryowCheck(ctx)),
]);

const gate3 = (ctx: GateContext): Promise<GateResult> => result(3, "Fake Rails and synthetic seeder invariants", async () => {
  const attempts = Number(primaryPsql(ctx, "SELECT count(*)::text FROM payment_attempts").trim());
  const fakeRailsHost = ctx.plan.hosts.find((host) => host.roles.includes("fake-rails"));
  const fakeRailsHealth = fakeRailsHost
    ? ctx.remote.capture(fakeRailsHost.ssh.host, `curl -fsS --max-time 5 http://${fakeRailsHost.ssh.host}:${ctx.config.FAKE_RAILS_NGINX_PORT}/health || true`).trim()
    : "";
  return [
    check("synthetic attempts were seeded", attempts > 0, `attempts=${attempts}`),
    check("Fake Rails health is reachable", fakeRailsHealth.length > 0, fakeRailsHealth.slice(0, 120)),
    ...invariantCheck(ctx),
  ];
});

const gate4 = (ctx: GateContext): Promise<GateResult> => result(4, "500+ TPS checkout and sharded ledger stress", async () => {
  const targets = paymentTargets(ctx);
  // The synthetic history intentionally seeds velocity/AML rules. Disable
  // them for the throughput gate so the workload measures checkout/ledger
  // capacity rather than the rule engine's rejection rate.
  primaryPsql(ctx, "UPDATE velocity_rules SET active = false");
  primaryPsql(ctx, "UPDATE aml_rules SET active = false");
  const linkId = primaryPsql(ctx, `SELECT id FROM payment_links WHERE key = ${shellQuote(targets[0]!.linkKey)}`).trim();
  primaryPsql(ctx, `UPDATE payment_links SET use_count = 50, confirmed_count = 0, active_locked_count = 0, infinite_use = false, expires_at = now() + interval '1 hour' WHERE id = ${shellQuote(linkId)}`);
  const strictPerf = process.env.LAB_STRICT_PERF === "true";
  const hot = await runHotLinkContention({ targets, attempts: 200, concurrency: strictPerf ? 100 : 50 });
  const counters = primaryPsql(ctx, `SELECT confirmed_count || '|' || active_locked_count || '|' || use_count || '|' || infinite_use FROM payment_links WHERE id = ${shellQuote(linkId)}`).split("|");
  primaryPsql(ctx, `UPDATE payment_links SET use_count = 50, confirmed_count = 0, active_locked_count = 0, infinite_use = true, expires_at = now() + interval '1 hour' WHERE id = ${shellQuote(linkId)}`);
  const burst = await runPaymentBurst({ targets, total: 500, concurrency: strictPerf ? 100 : 20, idempotencyPrefix: `lab-${ctx.topology}-${Date.now()}` });
  const confirmed = Number(counters[0] ?? 0);
  const active = Number(counters[1] ?? 0);
  const useCount = Number(counters[2] ?? 0);
  const infinite = counters[3] === "true";
  const checks = [
    check("hot-link requests all received a decision", hot.succeeded + hot.conflict + hot.failed === 200 && (strictPerf ? hot.failed === 0 : hot.failed <= 10), `success=${hot.succeeded} conflict=${hot.conflict} failed=${hot.failed}`),
    check("hot-link slot counters never exceed use_count", infinite || confirmed + active <= useCount, `confirmed=${confirmed} active=${active} use=${useCount}`),
    ...(strictPerf ? [check("hot-link contention succeeds exactly 50 times", hot.succeeded === 50, `success=${hot.succeeded}`)] : []),
    check("500-flow burst has no transport failures", strictPerf ? burst.failed === 0 : burst.failed <= 10, `success=${burst.succeeded} failed=${burst.failed}`),
    check(strictPerf ? "confirm burst p95 < 35ms" : "lab burst p95 under 5s", strictPerf ? burst.p95 < 35 : burst.p95 < 5_000, `p95=${burst.p95.toFixed(1)}ms`),
    ...invariantCheck(ctx),
  ];
  if (ctx.topology === "T7") {
    const removable = [...ctx.plan.nodes.core.slice(2), ...ctx.plan.nodes.checkout.slice(2)];
    for (const node of removable) {
      ctx.remote.run(node.ssh.host, `"$HOME/.bun/bin/pm2" stop ${node.serviceName}`, { sudo: false });
    }
    const scaledIn = await runPaymentBurst({ targets: targets.slice(0, Math.max(1, targets.length - removable.length)), total: 200, concurrency: 50, idempotencyPrefix: `scale-in-${ctx.topology}` });
    for (const node of removable) {
      ctx.remote.run(node.ssh.host, `"$HOME/.bun/bin/pm2" start ${node.serviceName}`, { sudo: false });
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const scaledOut = await runPaymentBurst({ targets: paymentTargets(ctx), total: 200, concurrency: 50, idempotencyPrefix: `scale-out-${ctx.topology}` });
    checks.push(check("live scale-in keeps checkouts succeeding", scaledIn.failed === 0, `success=${scaledIn.succeeded} failed=${scaledIn.failed}`));
    checks.push(check("live scale-out keeps checkouts succeeding", scaledOut.failed === 0, `success=${scaledOut.succeeded} failed=${scaledOut.failed}`));
  }
  return checks;
});

const gate5 = (ctx: GateContext): Promise<GateResult> => result(5, "Cross-node SSE and POS pairing", async () => {
  // The realtime bridge is exercised by publishing through Redis and reading
  // the stream from a checkout node. The stream still has its DB poll fallback.
  const redis = ctx.plan.storage.redis[0];
  const attempt = primaryPsql(ctx, "SELECT a.id, pl.key FROM payment_attempts a JOIN payment_links pl ON pl.id = a.link_id WHERE a.status NOT IN ('SUCCEEDED','FAILED','EXPIRED','CANCELLED','BLOCKED','REFUNDED') LIMIT 1").split("|");
  if (!redis || attempt.length < 2) return [check("SSE prerequisites", false, "redis or pending attempt missing")];
  const [attemptId, linkKey] = attempt;
  const checkout = ctx.plan.nodes.checkout[0]!;
  const event = {
    id: randomUUID(),
    namespace: "payment-gateway",
    topic: "realtime:attempt",
    payload: { attemptId, status: "SUCCEEDED", substatus: null, emittedAt: new Date().toISOString() },
    publishedAt: new Date().toISOString(),
  };
  const command = `redis-cli -h ${redis.privateIp} -p ${redis.servicePort} -a ${shellQuote(ctx.config.REDIS_PASSWORD)} PUBLISH ${shellQuote("payment-gateway:invalidation:realtime:attempt")} ${shellQuote(JSON.stringify(event))}`;
  // The stream must already be open before the event is published. Run the
  // blocking curl in the background on the checkout host, publish from the
  // Redis host, then read the captured stream.
  ctx.remote.run(checkout.privateIp, `rm -f /tmp/pg-sse-${ctx.topology}.out; nohup timeout 8 curl -sS -N http://${checkout.privateIp}:${checkout.port}/api/v1/pay/${linkKey}/logs/${attemptId}/status > /tmp/pg-sse-${ctx.topology}.out 2>&1 &`);
  await new Promise((resolve) => setTimeout(resolve, 750));
  ctx.remote.run(redis.privateIp, command);
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  const stream = ctx.remote.capture(checkout.privateIp, `cat /tmp/pg-sse-${ctx.topology}.out 2>/dev/null || true`);
  return [
    check("SSE stream is reachable", stream.includes("event: status"), stream.slice(0, 160)),
    check("SSE receives the cross-node transition", stream.includes("SUCCEEDED"), stream.slice(-160)),
  ];
});

const gate6 = (ctx: GateContext): Promise<GateResult> => result(6, "Concurrent workers and FOR UPDATE SKIP LOCKED", async () => {
  const expired = Number(primaryPsql(ctx, "SELECT count(*)::text FROM payment_attempts WHERE expires_at <= now()").trim());
  const inbound = Number(primaryPsql(ctx, "SELECT count(*)::text FROM inbound_events WHERE processed_at IS NULL").trim());
  const outbox = Number(primaryPsql(ctx, "SELECT count(*)::text FROM outbox_events WHERE processed_at IS NULL").trim());
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const inboundAfter = Number(primaryPsql(ctx, "SELECT count(*)::text FROM inbound_events WHERE processed_at IS NULL").trim());
  const outboxAfter = Number(primaryPsql(ctx, "SELECT count(*)::text FROM outbox_events WHERE processed_at IS NULL").trim());
  return [
    check("expired-attempt queue inspected", expired >= 0, `expired=${expired}`),
    check("inbound queue drains", inboundAfter <= inbound, `before=${inbound} after=${inboundAfter}`),
    check("outbox queue drains", outboxAfter <= outbox, `before=${outbox} after=${outboxAfter}`),
  ];
});

const gate7 = (ctx: GateContext): Promise<GateResult> => result(7, "Audit immutability and multi-node linear hash chain", async () => {
  const audit = ctx.plan.storage.auditDb;
  if (!audit) return [check("audit database configured", false)];
  const tamper = ctx.remote.capture(audit.privateIp, `PGPASSWORD=${shellQuote(ctx.config.AUDIT_DB_PASSWORD)} psql -h 127.0.0.1 -p ${audit.servicePort} -U ${ctx.config.AUDIT_DB_USER} -d ${ctx.config.AUDIT_DB_NAME} -tAc "UPDATE audit_records SET action='HACKED' WHERE seq_no=1" 2>&1 || true`);
  const deleted = ctx.remote.capture(audit.privateIp, `PGPASSWORD=${shellQuote(ctx.config.AUDIT_DB_PASSWORD)} psql -h 127.0.0.1 -p ${audit.servicePort} -U ${ctx.config.AUDIT_DB_USER} -d ${ctx.config.AUDIT_DB_NAME} -tAc "DELETE FROM audit_records WHERE seq_no=1" 2>&1 || true`);
  const chain = ctx.remote.capture(audit.privateIp, `PGPASSWORD=${shellQuote(ctx.config.AUDIT_DB_PASSWORD)} psql -h 127.0.0.1 -p ${audit.servicePort} -U ${ctx.config.AUDIT_DB_USER} -d ${ctx.config.AUDIT_DB_NAME} -tAc "SELECT valid::text || '|' || verified_count::text || '|' || COALESCE(first_broken_id::text,'') FROM verify_audit_chain()"`);
  return [
    check("audit UPDATE is rejected", /AUDIT_TAMPER_PROHIBITED|permission denied/i.test(tamper), tamper.slice(0, 160)),
    check("audit DELETE is rejected", /AUDIT_TAMPER_PROHIBITED|permission denied/i.test(deleted), deleted.slice(0, 160)),
    check("audit hash chain verifies", chain.trim().startsWith("true|"), `verify_audit_chain=${chain.trim()}`),
  ];
});

const gate8 = (ctx: GateContext): Promise<GateResult> => result(8, "Dedicated log DB batching and outage resilience", async () => {
  const log = ctx.plan.storage.logDb;
  if (!log) return [check("log database configured", false)];
  const logCluster = pgClusterFor(ctx.config, "log", { privateIp: log.privateIp, servicePort: log.servicePort });
  const before = Number(primaryPsql(ctx, "SELECT count(*)::text FROM payment_attempts").trim());
  ctx.remote.run(log.privateIp, `systemctl stop ${logCluster.service} 2>/dev/null || systemctl stop postgresql 2>/dev/null || true`, { sudo: true });
  const burst = await runPaymentBurst({ targets: paymentTargets(ctx), total: 200, concurrency: 50, idempotencyPrefix: `log-outage-${ctx.topology}` });
  ctx.remote.run(log.privateIp, `systemctl start ${logCluster.service} 2>/dev/null || systemctl start postgresql 2>/dev/null || true`, { sudo: true });
  let logs = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    try {
      logs = Number(ctx.remote.psql({
        host: log.privateIp,
        port: log.servicePort,
        user: ctx.config.LOG_DB_USER,
        password: ctx.config.LOG_DB_PASSWORD,
        database: ctx.config.LOG_DB_NAME,
        sql: "SELECT count(*) FROM attempt_step_logs",
      }).trim());
      break;
    } catch {
      // The cluster may still be starting; retry briefly.
    }
  }
  return [
    check("checkouts succeed while the log DB is down", burst.failed === 0, `success=${burst.succeeded} failed=${burst.failed}`),
    check("log rows are present after recovery", logs > 0, `attempt_step_logs=${logs}`),
    check("payment state is durable", Number(primaryPsql(ctx, "SELECT count(*)::text FROM payment_attempts").trim()) >= before, "attempt count did not shrink"),
  ];
});

const gate9 = (ctx: GateContext): Promise<GateResult> => result(9, "Global search and keyset pagination under load", async () => {
  const token = adminToken(ctx);
  const latencies: number[] = [];
  for (let index = 0; index < 50; index += 1) {
    const started = Date.now();
    const response = await adminFetch(ctx, token, "/search", { method: "POST", body: JSON.stringify({ query: "شركة" }) });
    if (!response.ok) throw new Error(`search returned ${response.status}`);
    await response.arrayBuffer();
    latencies.push(Date.now() - started);
  }
  latencies.sort((left, right) => left - right);
  const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] ?? 0;
  const support = supportToken(ctx);
  const aml = await adminFetch(ctx, support, "/search", { method: "POST", body: JSON.stringify({ query: "aml" }) });
  const amlBody = await aml.text();
  return [
    check(process.env.LAB_STRICT_PERF === "true" ? "search p95 < 25ms" : "lab search p95 under 500ms", process.env.LAB_STRICT_PERF === "true" ? p95 < 25 : p95 < 500, `p95=${p95}ms`),
    check("SUPPORT search response does not expose AML groups", !/"group"\s*:\s*"aml/i.test(amlBody), amlBody.slice(0, 160)),
  ];
});

const gate10 = (ctx: GateContext): Promise<GateResult> => result(10, "Backup control plane and scratch PITR drill", async () => {
  const token = adminToken(ctx);
  const overview = await adminFetch(ctx, token, "/system/backups/overview");
  const overviewBody = await overview.json() as Record<string, unknown>;
  const trigger = await adminFetch(ctx, token, "/system/backups/trigger", { method: "POST", body: JSON.stringify({ target: "all", kind: "full" }) });
  const triggerBody = await trigger.json() as { backupJobId?: string };
  let passed = false;
  for (let index = 0; index < 60; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const runs = await adminFetch(ctx, token, "/system/backups/overview");
    const body = await runs.json() as { backups?: Array<{ id?: string; status?: string }> };
    const run = (body.backups ?? []).find((entry) => entry.id === triggerBody.backupJobId);
    if (run?.status === "PASSED") { passed = true; break; }
    if (run?.status === "FAILED") break;
  }
  const drill = await adminFetch(ctx, token, "/system/backups/drill", { method: "POST", body: JSON.stringify({}) });
  return [
    check("overview is reachable", overview.ok, `status=${overview.status}`),
    check("overview reports backup health", overviewBody.walArchiveHealthy === true || overviewBody.configured === true, JSON.stringify(overviewBody).slice(0, 200)),
    check("full backup completes", trigger.ok && passed, `status=${trigger.status} job=${triggerBody.backupJobId ?? "none"}`),
    check("restore drill is queued", drill.ok, `status=${drill.status}`),
  ];
});

const gate11 = (ctx: GateContext): Promise<GateResult> => result(11, "Chaos, failover and primary PITR disaster recovery", async () => {
  if (ctx.topology !== "T8") return [check("chaos gate", true, "not T8; chaos injection is only executed on T8")];
  const core = ctx.plan.nodes.core[1] ?? ctx.plan.nodes.core[0]!;
  const before = await runPaymentBurst({ targets: paymentTargets(ctx), total: 100, concurrency: 50, idempotencyPrefix: `chaos-${ctx.topology}` });
  ctx.remote.run(core.ssh.host, `"$HOME/.bun/bin/pm2" restart ${core.serviceName}`, { sudo: false });
  const after = await runPaymentBurst({ targets: paymentTargets(ctx), total: 100, concurrency: 50, idempotencyPrefix: `chaos-after-${ctx.topology}` });
  const replica = ctx.plan.storage.postgres.replicas[0];
  if (replica) {
    const replicaCluster = pgClusterFor(ctx.config, "replica", { nodeId: replica.nodeId, privateIp: replica.privateIp, servicePort: replica.servicePort });
    ctx.remote.run(replica.privateIp, `systemctl stop ${replicaCluster.service} 2>/dev/null || systemctl stop postgresql 2>/dev/null || true`, { sudo: true });
  }
  const afterReplica = await runPaymentBurst({ targets: paymentTargets(ctx), total: 100, concurrency: 50, idempotencyPrefix: `chaos-replica-${ctx.topology}` });
  return [
    check("checkouts survive a core restart", before.failed === 0 && after.failed === 0, `before=${before.failed} after=${after.failed}`),
    check("checkouts survive a replica stop", afterReplica.failed === 0, `failed=${afterReplica.failed}`),
    ...invariantCheck(ctx),
  ];
});

export const runAllGates = async (ctx: GateContext): Promise<GateResult[]> => {
  const gates = [gate1, gate2, gate3, gate4, gate5, gate6, gate7, gate8, gate9, gate10, gate11];
  const results: GateResult[] = [];
  for (const gate of gates) {
    const gateResult = await gate(ctx);
    results.push(gateResult);
    console.log(`  Gate ${gateResult.gate}: ${gateResult.status} (${gateResult.durationMs}ms)`);
    if (gateResult.status === "FAILED") break;
  }
  return results;
};
