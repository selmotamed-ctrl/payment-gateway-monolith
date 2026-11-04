import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDeployConfig } from "../lib/configSchema";
import { planHosts } from "../lib/hostPlanner";
import { pgClusterFor, postgresConfigPath, postgresDataDir } from "../provisioners/postgres18Provisioner";
import { auditDatabaseDdl } from "../provisioners/auditAndLogDbProvisioner";
import { generateJsonSchema, parseArgs, SCHEMA_PATH } from "../test-matrix/cli";
import { gateStatusOf, sqlLiteral, topologyPassed } from "../test-matrix/gates";
import { offeredRequests, PRESETS, INTENSITY_PRESETS, resolveIntensity, selectedGates } from "../test-matrix/intensity";
import { configHash, findLiteralSecrets, LabConfigError, loadLabConfig, parseLabConfig, resolveSudoPassword, type LabConfig, type LabConfigInput } from "../test-matrix/labConfig";
import { generateLabSecrets, redact, type LabSecrets } from "../test-matrix/labSecrets";
import { renderCertificationReport } from "../test-matrix/report";
import { runSustainedLoad, summarize } from "../test-matrix/stressWorkload";
import { renderEnvFile, renderTopologyEnv } from "../test-matrix/topologies";
import { deriveTopologies, selectTopologies, type DerivedTopology } from "../test-matrix/topologyDerivation";
import type { GateResult, MatrixRunMeta, TopologyRunResult } from "../test-matrix/types";

const MATRIX_DIR = join(import.meta.dirname, "..", "test-matrix");
const EXAMPLE = join(MATRIX_DIR, "machines.example.json");
const TWO_HOST = join(MATRIX_DIR, "machines.two-host-lab.example.json");

const SECRETS: LabSecrets = {
  ...generateLabSecrets(),
  kmsMasterKeyHex: "a".repeat(64),
  backupEncryptionKeyHex: "b".repeat(64),
  pgDbPassword: "unit-test-pg-password",
};

const minimal = (patch: Partial<LabConfigInput> = {}): LabConfigInput => ({
  version: 1,
  lab: { name: "unit" },
  ssh: { user: "lab", keyPath: "~/.ssh/id_lab" },
  machines: [{ id: "solo", address: "10.0.0.10", roles: ["controller", "app", "db", "cache", "logs", "backup", "object-store"] }],
  services: { objectStore: { machine: "solo" } },
  ...patch,
});

const problemsOf = (raw: unknown): string[] => {
  try {
    parseLabConfig(raw, "unit");
    return [];
  } catch (error) {
    if (error instanceof LabConfigError) return error.problems;
    throw error;
  }
};

const renderAndLoad = (config: LabConfig, topology: DerivedTopology, sudoPassword = "") => {
  const env = renderTopologyEnv({ config, topology, secrets: SECRETS, intensity: resolveIntensity(config.intensity), sudoPassword });
  const loaded = loadDeployConfig(renderEnvFile(env));
  if (!loaded.ok || !loaded.config) throw new Error(`${topology.id}: ${loaded.problems.join("; ")}`);
  return { env, config: loaded.config, plan: planHosts(loaded.config) };
};

describe("lab config validation", () => {
  test("committed example configs validate", () => {
    expect(loadLabConfig(EXAMPLE).machines).toHaveLength(3);
    expect(loadLabConfig(TWO_HOST).machines).toHaveLength(2);
  });

  test("machines.schema.json is in sync with the Zod schema", () => {
    expect(readFileSync(SCHEMA_PATH, "utf8")).toBe(generateJsonSchema());
  });

  test("literal secrets are rejected with a fix hint", () => {
    const raw = minimal({ ssh: { user: "lab", keyPath: "~/.ssh/k", sudo: { mode: "password", password: "1234" } as never } });
    const problems = problemsOf(raw);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ssh.sudo.password");
    expect(problems[0]).toContain("passwordEnv");
    expect(findLiteralSecrets({ services: { objectStore: { secretKey: "x" } } })[0]).toContain("services.objectStore.secretKey");
    expect(findLiteralSecrets({ ssh: { sudo: { passwordEnv: "LAB_SUDO_PASS" } } })).toEqual([]);
  });

  test("errors carry the JSON path and are aggregated", () => {
    const problems = problemsOf({
      ...minimal(),
      machines: [
        { id: "a", address: "lab-a.lan", roles: ["controller", "app"] },
        { id: "b", address: "10.0.0.2", roles: ["controller", "app", "bogus"] },
      ],
      services: { objectStore: { machine: "ghost" } },
      typo: true,
    });
    const text = problems.join("\n");
    expect(text).toContain("typo");
    expect(text).toContain("machines[1].roles[2]");
    expect(text).toContain("machines[0].address: must be an IPv4 address");
    const semantic = problemsOf({
      ...minimal(),
      machines: [
        { id: "a", address: "10.0.0.1", roles: ["controller", "app"] },
        { id: "a", address: "10.0.0.2", privateIp: "10.0.0.1", roles: ["controller", "app"] },
      ],
      services: { objectStore: { machine: "ghost" } },
    }).join("\n");
    expect(semantic).toContain("machines[1].privateIp: privateIp 10.0.0.1 is already used by machine 'a'");
    expect(semantic).toContain("machines[1].id: duplicate machine id 'a'");
    expect(semantic).toContain("at most one machine may have role 'controller'");
    expect(semantic).toContain("needs role 'db'");
    expect(semantic).toContain("services.objectStore.machine: unknown machine 'ghost'");
  });

  test("an existing object store needs credential env references", () => {
    const problems = problemsOf(minimal({ services: { objectStore: { machine: "solo", provision: false } } }));
    expect(problems.join()).toContain("accessKeyEnv and secretKeyEnv are required");
  });

  test("sudo password is resolved only from the named env var", () => {
    const config = parseLabConfig(minimal({ ssh: { user: "lab", keyPath: "~/.ssh/k", sudo: { mode: "password", passwordEnv: "LAB_SUDO_PASS" } } }));
    expect(() => resolveSudoPassword(config, {})).toThrow("LAB_SUDO_PASS");
    expect(resolveSudoPassword(config, { LAB_SUDO_PASS: "from-env" })).toBe("from-env");
    expect(resolveSudoPassword(parseLabConfig(minimal()), {})).toBe("");
  });

  test("config hash ignores formatting/key order and tracks content", () => {
    const left = parseLabConfig(minimal());
    const reordered = parseLabConfig(JSON.parse(JSON.stringify({ services: minimal().services, machines: minimal().machines, ssh: minimal().ssh, lab: minimal().lab, version: 1 })));
    expect(configHash(left)).toBe(configHash(reordered));
    const changed = parseLabConfig(minimal({ lab: { name: "other" } }));
    expect(configHash(changed)).not.toBe(configHash(left));
  });

  test("no hard-coded lab password remains in the harness", () => {
    for (const file of readdirSync(MATRIX_DIR).filter((name) => /\.(ts|json)$/.test(name))) {
      const text = readFileSync(join(MATRIX_DIR, file), "utf8");
      expect({ file, hit: /["'`]1234["'`]|sshpass|StrictHostKeyChecking=no|minioadmin1234|pg_\w+_pass_1234/.test(text) }).toEqual({ file, hit: false });
    }
  });
});

describe("intensity resolution", () => {
  test("every preset resolves and validates", () => {
    for (const preset of INTENSITY_PRESETS) {
      const resolved = resolveIntensity({ preset });
      expect(resolved.preset).toBe(preset);
      expect(resolved.overridden).toEqual([]);
      expect(resolved.slo.minTps).toBe(PRESETS[preset].slo.minTps);
    }
  });

  test("overrides deep-merge and are recorded", () => {
    const resolved = resolveIntensity({ preset: "standard", overrides: { targetTps: 400, slo: { minTps: 350 }, hotLink: { attempts: 500 } } });
    expect(resolved.targetTps).toBe(400);
    expect(resolved.slo.minTps).toBe(350);
    expect(resolved.slo.maxP95Ms).toBe(PRESETS.standard.slo.maxP95Ms);
    expect(resolved.hotLink).toEqual({ ...PRESETS.standard.hotLink, attempts: 500 });
    expect(resolved.overridden).toEqual(["hotLink.attempts", "slo.minTps", "targetTps"]);
  });

  test("a CLI preset replaces the config preset but keeps overrides", () => {
    const resolved = resolveIntensity({ preset: "standard", overrides: { durationSec: 5 } }, "soak");
    expect(resolved.preset).toBe("soak");
    expect(resolved.durationSec).toBe(5);
    expect(resolved.targetTps).toBe(PRESETS.soak.targetTps);
  });

  test("invalid knobs are rejected", () => {
    expect(() => resolveIntensity({ overrides: { targetTps: -1 } })).toThrow();
    expect(() => resolveIntensity({ overrides: { bogus: 1 } as never })).toThrow();
    expect(() => resolveIntensity({ overrides: { chaos: { faults: [{ type: "primary-pitr", everySec: 60 }] } } })).toThrow("allowDestructive");
    expect(() => resolveIntensity({ overrides: { hotLink: { attempts: 10, useCount: 20 } } })).toThrow("useCount");
  });

  test("gate selection and offered volume", () => {
    expect(selectedGates(resolveIntensity({ preset: "smoke" }))).toEqual(["provisioning", "storage-routing", "seeder-invariants", "checkout-stress", "audit-chain"]);
    expect(selectedGates(resolveIntensity({ preset: "standard" }))).toHaveLength(12);
    expect(offeredRequests({ targetTps: 100, rampUpSec: 10, durationSec: 60 })).toBe(6_500);
  });

  test("the certification preset carries the archived strict targets", () => {
    const strict = resolveIntensity({ preset: "certification" });
    expect(strict.slo.minTps).toBe(500);
    expect(strict.slo.maxP95Ms).toBe(35);
    expect(strict.slo.searchP95Ms).toBe(25);
  });
});

describe("topology derivation", () => {
  test("one machine yields only single-host and explains the rest", () => {
    const result = deriveTopologies(parseLabConfig(minimal()));
    expect(result.topologies.map((topology) => topology.id)).toEqual(["single-host@solo"]);
    expect(result.skipped.map((entry) => entry.family).sort()).toEqual(["chaos", "dmz", "mesh", "replicated", "scale", "split"]);
    renderAndLoad(parseLabConfig(minimal()), result.topologies[0]!);
  });

  test("the two-host example reproduces the archived T1-T8 matrix as aliases", () => {
    const config = loadLabConfig(TWO_HOST);
    const { topologies } = selectTopologies(config);
    expect(topologies.map((topology) => topology.aliases[0])).toEqual(["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]);
    const byAlias = (alias: string) => topologies.find((topology) => topology.aliases.includes(alias))!;
    expect(byAlias("T1").machinesUsed).toEqual(["host-a"]);
    expect(byAlias("T2").pgPrimary.machineId).toBe("host-b");
    expect(byAlias("T2").nodes.core.every((node) => node.machineId === "host-a")).toBe(true);
    expect(byAlias("T3").pgPrimary.machineId).toBe("host-a");
    expect(byAlias("T4").pgPrimary.machineId).toBe("host-b");
    expect(byAlias("T4").pgReplicas.map((node) => node.machineId)).toEqual(["host-b", "host-a"]);
    expect(byAlias("T6").nodes.core).toHaveLength(4);
    expect(byAlias("T7").deployMode).toBe("rolling_update");
    expect(byAlias("T7").features.scalableNodeIds.length).toBeGreaterThan(0);
    expect(byAlias("T8").features.chaos).toBe(true);
  });

  test("the DMZ edge hosts no storage and the backup host stays private", () => {
    const t5 = selectTopologies(loadLabConfig(TWO_HOST), ["T5"]).topologies[0]!;
    expect(t5.features.dmzMachines).toEqual(["host-b"]);
    const storage = [t5.pgPrimary, ...t5.pgReplicas, ...t5.redis, t5.auditDb, t5.logDb, t5.backup];
    expect(storage.some((ref) => ref.machineId === "host-b")).toBe(false);
    expect([...t5.nodes.checkout, ...t5.nodes.merchant].every((ref) => ref.machineId === "host-b")).toBe(true);
  });

  test("WAL-G always runs on the primary's machine", () => {
    for (const path of [EXAMPLE, TWO_HOST]) {
      for (const topology of deriveTopologies(loadLabConfig(path)).topologies) {
        if (topology.backupMode === "wal-g") expect(topology.backup.machineId).toBe(topology.pgPrimary.machineId);
      }
    }
  });

  test("every derived topology renders a deploy config the real engine accepts", () => {
    for (const path of [EXAMPLE, TWO_HOST]) {
      const config = loadLabConfig(path);
      for (const topology of deriveTopologies(config).topologies) {
        const { env, plan } = renderAndLoad(config, topology, "sudo-from-env");
        expect(plan.nodes.core).toHaveLength(topology.nodes.core.length);
        expect(plan.nodes.checkout).toHaveLength(topology.nodes.checkout.length);
        expect(plan.storage.postgres.replicas).toHaveLength(topology.pgReplicas.length);
        for (const [key, value] of Object.entries(env)) {
          if (key.endsWith("_SSH_USER")) expect(value).toBe(config.ssh.user);
          if (key.endsWith("_SUDO_PASSWORD")) expect(value).toBe("sudo-from-env");
        }
        expect(env.LAN_ALLOWED_CIDRS).not.toContain("10.0.0.0/8");
        expect(env.PG_DB_PASSWORD).toBe(SECRETS.pgDbPassword);
        expect(env.SYNTHETIC_SEED_PROFILE).toBe(resolveIntensity(config.intensity).data.seedProfile);
      }
    }
  });

  test("maxPerFamily, include/exclude and alias selection", () => {
    const config = loadLabConfig(EXAMPLE);
    const all = deriveTopologies(config).topologies;
    expect(all.filter((topology) => topology.family === "split")).toHaveLength(2);
    expect(selectTopologies(config, ["mesh", "dmz@lab-b"]).topologies.map((topology) => topology.id)).toEqual(["mesh", "dmz@lab-b"]);
    expect(() => selectTopologies(config, ["T1"])).toThrow("Unknown topology selection: T1");
    const twoHost = loadLabConfig(TWO_HOST);
    expect(selectTopologies(twoHost, ["t5", "T6"]).topologies.map((topology) => topology.id)).toEqual(["dmz@host-b", "mesh"]);
    const excluded = parseLabConfig({ ...JSON.parse(readFileSync(TWO_HOST, "utf8")), topologies: { include: [], exclude: ["T8", "scale"] } });
    expect(selectTopologies(excluded).topologies.map((topology) => topology.id)).not.toContain("chaos");
    expect(selectTopologies(excluded).topologies.map((topology) => topology.id)).not.toContain("scale");
  });

  test("capacity clamps instances per machine and ports never collide", () => {
    const raw = JSON.parse(readFileSync(EXAMPLE, "utf8"));
    raw.machines.forEach((machine: { capacity?: unknown }) => { machine.capacity = { maxNodesPerTier: 1 }; });
    const config = parseLabConfig(raw);
    for (const topology of deriveTopologies(config).topologies) {
      const perMachine = new Map<string, number>();
      for (const node of topology.nodes.core) perMachine.set(node.machineId, (perMachine.get(node.machineId) ?? 0) + 1);
      expect(Math.max(...perMachine.values())).toBe(1);
      const endpoints = [...Object.values(topology.nodes).flat(), topology.fakeRails, topology.backup, topology.pgPrimary, ...topology.pgReplicas, topology.auditDb, topology.logDb, ...topology.redis]
        .map((ref) => `${ref.machineId}:${ref.port}`);
      expect(new Set(endpoints).size).toBe(endpoints.length);
      renderAndLoad(config, topology);
    }
  });

  test("co-located tiers get per-node env files, release suffixes and a least_conn upstream", () => {
    const config = loadLabConfig(TWO_HOST);
    const t1 = selectTopologies(config, ["T1"]).topologies[0]!;
    const { plan } = renderAndLoad(config, t1);
    const host = plan.hosts.find((candidate) => candidate.services.filter((service) => service.role === "core").length === 2)!;
    const core = host.services.filter((service) => service.role === "core");
    expect(core.map((service) => service.name)).toEqual(["pg-core-back-core-1", "pg-core-back-core-2"]);
    expect(core.map((service) => service.envFileName)).toEqual([".env.core-1", ".env.core-2"]);
    const checkout = host.nginx.find((site) => site.site === "checkout-public")!;
    expect(checkout.upstreamServers).toEqual(["10.209.250.48:4103", "10.209.250.48:4113"]);
  });
});

describe("gate verdicts", () => {
  test("SKIP never counts as a pass", () => {
    expect(gateStatusOf([])).toBe("SKIPPED");
    expect(gateStatusOf([{ name: "a", status: "SKIP", detail: "" }])).toBe("SKIPPED");
    expect(gateStatusOf([{ name: "a", status: "SKIP", detail: "" }, { name: "b", status: "PASS", detail: "" }])).toBe("PASSED");
    expect(gateStatusOf([{ name: "a", status: "PASS", detail: "" }, { name: "b", status: "FAIL", detail: "" }])).toBe("FAILED");
    const gate = (status: GateResult["status"]): GateResult => ({ gate: 1, id: "provisioning", name: "x", status, checks: [], durationMs: 0 });
    expect(topologyPassed(true, [gate("PASSED"), gate("SKIPPED")])).toBe(true);
    expect(topologyPassed(true, [gate("SKIPPED")])).toBe(false);
    expect(topologyPassed(true, [gate("PASSED"), gate("NOT_RUN")])).toBe(false);
    expect(topologyPassed(false, [gate("PASSED")])).toBe(false);
  });

  test("SQL literals are SQL-escaped, not shell-escaped", () => {
    expect(sqlLiteral("o'brien")).toBe("'o''brien'");
  });
});

describe("report, redaction and CLI", () => {
  test("report records config hash, intensity and explicit gate tallies", () => {
    const config = loadLabConfig(TWO_HOST);
    const topology = selectTopologies(config, ["T1"]).topologies[0]!;
    const intensity = resolveIntensity(config.intensity);
    const meta: MatrixRunMeta = {
      runId: "run-1", labName: config.lab.name, configPath: TWO_HOST, configHash: configHash(config), intensityHash: "abc",
      intensity, gitCommit: "deadbee", machines: [], skippedFamilies: [], startedAt: "s", finishedAt: "f",
    };
    const result: TopologyRunResult = {
      topology, configPath: "p", attempt: 2, attemptsAllowed: 2, deploy: { ok: true, durationMs: 1000, output: "" }, passed: false, startedAt: "s", finishedAt: "f",
      gates: [
        { gate: 1, id: "provisioning", name: "p", status: "PASSED", checks: [{ name: "c", status: "PASS", detail: "" }], durationMs: 1 },
        { gate: 2, id: "storage-routing", name: "s", status: "FAILED", checks: [{ name: "c", status: "FAIL", detail: "admin merchants returned 403" }], durationMs: 1 },
        { gate: 3, id: "seeder-invariants", name: "x", status: "NOT_RUN", checks: [], durationMs: 0 },
      ],
    };
    const markdown = renderCertificationReport(meta, [result]);
    expect(markdown).toContain(configHash(config));
    expect(markdown).toContain("Intensity: `standard` + overrides (chaos.enabled)");
    expect(markdown).toContain("| single-host@host-a | T1 | single-host | OK (1s) | 2/2 | 1 | 1 | 0 | 1 | NOT CERTIFIED |");
  });

  test("redaction covers every secret-looking key and known values", () => {
    const text = "KMS_MASTER_KEY=abc\nFAKE_RAILS_JWT_SECRET=def\nBACKUP_PRIMARY_S3_SECRET_KEY=ghi\nPG_SSH_KEY_PATH=~/.ssh/k\nlog: connecting with s3cr3t-value";
    const out = redact(text, ["s3cr3t-value"]);
    expect(out).toContain("KMS_MASTER_KEY=***");
    expect(out).toContain("FAKE_RAILS_JWT_SECRET=***");
    expect(out).toContain("BACKUP_PRIMARY_S3_SECRET_KEY=***");
    expect(out).toContain("PG_SSH_KEY_PATH=~/.ssh/k");
    expect(out).not.toContain("s3cr3t-value");
  });

  test("CLI arguments are validated", () => {
    const options = parseArgs(["run", "--config=x.json", "--topologies=T1, mesh", "--intensity=smoke", "--attempts=3"], {});
    expect(options.topologies).toEqual(["T1", "mesh"]);
    expect(options.intensity).toBe("smoke");
    expect(options.attempts).toBe(3);
    expect(() => parseArgs(["run", "--intensity=extreme"], {})).toThrow("Unknown intensity");
    expect(() => parseArgs(["run", "--bogus"], {})).toThrow("Unknown option");
    expect(() => parseArgs(["deploy"], {})).toThrow("Usage");
  });
});

describe("stress workload", () => {
  test("summary separates success, exhaustion and failures", () => {
    const summary = summarize(5, [1, 2, 3, 4, 5], [201, 201, 409, 409, 500], ["boom"]);
    expect(summary.succeeded).toBe(2);
    expect(summary.conflict).toBe(2);
    expect(summary.failed).toBe(2);
    expect(summary.p50).toBe(3);
  });

  test("sustained load measures achieved TPS, errors and per-node distribution", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        calls += 1;
        return new URL(request.url).pathname.includes("/bad/") ? new Response("no", { status: 500 }) : new Response("{}", { status: 201 });
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const result = await runSustainedLoad({
        targets: () => [
          { baseUrl: base, linkKey: "good", railCode: "R", nodeId: "chk-1" },
          { baseUrl: base, linkKey: "bad", railCode: "R", nodeId: "chk-2" },
        ],
        targetTps: 40,
        rampUpSec: 0,
        durationSec: 1,
        concurrency: 10,
        timeoutMs: 2_000,
        idempotencyPrefix: "unit",
      });
      expect(calls).toBe(result.total);
      expect(result.offered).toBeGreaterThanOrEqual(35);
      expect(result.perNode["chk-1"]!.succeeded).toBeGreaterThan(0);
      expect(result.perNode["chk-2"]!.succeeded).toBe(0);
      expect(result.errorRate).toBeGreaterThan(0.4);
      expect(result.errorRate).toBeLessThan(0.6);
      expect(result.achievedTps).toBeGreaterThan(10);
      expect(result.achievedTps).toBeLessThanOrEqual(25);
    } finally {
      server.stop(true);
    }
  });
});

describe("multi-cluster PostgreSQL", () => {
  test("co-located roles get independent clusters and ports", () => {
    const config = { PG_VERSION: "18" };
    expect(pgClusterFor(config, "primary", { privateIp: "10.0.0.1", servicePort: 5432 }).name).toBe("main");
    expect(pgClusterFor(config, "replica", { nodeId: "pg-rep-1", privateIp: "10.0.0.1", servicePort: 5433 })).toMatchObject({
      name: "replica_pg_rep_1",
      port: 5433,
      dataDir: "/var/lib/postgresql/18/replica_pg_rep_1",
      service: "postgresql@18-replica_pg_rep_1",
    });
    expect(pgClusterFor(config, "audit", { privateIp: "10.0.0.1", servicePort: 5434 }).name).toBe("audit");
    expect(pgClusterFor(config, "log", { privateIp: "10.0.0.1", servicePort: 5435 }).name).toBe("log");
    expect(postgresDataDir(config, "audit")).toBe("/var/lib/postgresql/18/audit");
    expect(postgresConfigPath(config, "audit")).toBe("/etc/postgresql/18/audit/conf.d/zz-pg-switch.conf");
  });

  test("audit DDL installs the serialized trigger and pgcrypto", () => {
    const ddl = auditDatabaseDdl({ AUDIT_DB_USER: "pg_audit_writer" });
    expect(ddl).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    expect(ddl).toContain("compute_audit_chain_hash_trg");
    expect(ddl).toContain("pg_advisory_xact_lock(994001)");
    expect(ddl).toContain("trg_audit_chain_compute");
  });
});
