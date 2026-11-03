import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { CommandResult, RunOptions } from "../src/commandRunner";
import {
  AUDIT_CHAIN_QUERY,
  BALANCE_PARITY_QUERY,
  DOUBLE_ENTRY_QUERY,
  GENESIS_HASH,
  JOURNAL_LINE_COUNT_QUERY,
  REPLAYED_LSN_QUERY,
  RestoreDrillRunner,
  buildAuditCanonicalPayload,
  computeAuditRowHash,
  stableJson,
  verifyAuditChain,
  verifyDrillReportSignature,
  type AuditChainRow,
} from "../src/restoreDrillRunner";
import {
  ENCRYPTION_KEY_HEX,
  FakeEngine,
  MemoryDrillFileSystem,
  RecordingRunner,
  makeConfig,
} from "./helpers";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const SCRATCH = "/var/lib/pg-backup/scratch";
const AUDIT_SCRATCH = "/var/lib/pg-backup/scratch/audit";

const auditRows = (): AuditChainRow[] => {
  const first: AuditChainRow = {
    seqNo: "1",
    id: "0190a000-0000-7000-8000-000000000001",
    createdAt: "2026-11-03T10:00:00.000Z",
    actorId: "0190a000-0000-7000-8000-000000000011",
    action: "MERCHANT_APPROVED",
    entityType: "merchant",
    entityId: "merchant-1",
    beforeJson: { status: "PENDING", z: 1, a: 2 },
    afterJson: { status: "ACTIVE" },
    prevHash: GENESIS_HASH,
    rowHash: "",
  };
  first.rowHash = computeAuditRowHash(GENESIS_HASH, first);
  const second: AuditChainRow = {
    seqNo: "2",
    id: "0190a000-0000-7000-8000-000000000002",
    createdAt: "2026-11-03T10:01:00.000Z",
    actorId: "0190a000-0000-7000-8000-000000000012",
    action: "POLICY_UPDATED",
    entityType: "policy",
    entityId: "policy-1",
    beforeJson: { threshold: 10 },
    afterJson: { threshold: 20 },
    prevHash: first.rowHash,
    rowHash: "",
  };
  second.rowHash = computeAuditRowHash(first.rowHash, second);
  return [first, second];
};

interface DrillOutputs {
  doubleEntry: string;
  balanceParity: string;
  journalCount: string;
  audit: string;
  replayedLsn: string;
}

const defaultOutputs = (): DrillOutputs => ({
  doubleEntry: "0.0000",
  balanceParity: "0",
  journalCount: "3",
  audit: JSON.stringify(auditRows()),
  replayedLsn: "",
});

const drillRunnerFor = (
  outputs: DrillOutputs,
  startFails = false,
): RecordingRunner =>
  new RecordingRunner((command: string, args: string[], _options?: RunOptions): CommandResult => {
    const binary = basename(command);
    if (binary === "pg_ctl") {
      if (startFails && args.includes("start")) {
        return { code: 1, stdout: "", stderr: "could not start scratch postgres" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (binary === "initdb") return { code: 0, stdout: "", stderr: "" };
    if (binary === "psql") {
      const query = args.at(-1) ?? "";
      if (query === DOUBLE_ENTRY_QUERY) return { code: 0, stdout: `${outputs.doubleEntry}\n`, stderr: "" };
      if (query === BALANCE_PARITY_QUERY) return { code: 0, stdout: `${outputs.balanceParity}\n`, stderr: "" };
      if (query === JOURNAL_LINE_COUNT_QUERY) return { code: 0, stdout: `${outputs.journalCount}\n`, stderr: "" };
      if (query === AUDIT_CHAIN_QUERY) return { code: 0, stdout: `${outputs.audit}\n`, stderr: "" };
      if (query === REPLAYED_LSN_QUERY) return { code: 0, stdout: `${outputs.replayedLsn}\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected query ${query}` };
    }
    return { code: 0, stdout: "", stderr: "" };
  });

const makeHarness = (
  outputs: DrillOutputs = defaultOutputs(),
  options: {
    startFails?: boolean;
    recovered?: { replayedLsn?: string; recoveryConf?: string; initializedEmptyDir?: boolean };
    initialFiles?: Record<string, string>;
    producesDataDir?: boolean;
    engineThrows?: boolean;
  } = {},
) => {
  const config = makeConfig();
  const runner = drillRunnerFor(outputs, options.startFails);
  const fileSystem = new MemoryDrillFileSystem(
    options.initialFiles ?? {
      [join(SCRATCH, "PG_VERSION")]: "18",
      [join(AUDIT_SCRATCH, "PG_VERSION")]: "18",
    },
  );
  const engine = new FakeEngine(
    async () => ({ storageTargets: ["primary-s3"] }),
    async (recoverRequest) => {
      if (options.engineThrows) throw new Error("restore failed: bucket unavailable");
      if (options.producesDataDir !== false) {
        await fileSystem.writeFile(join(recoverRequest.targetDir, "PG_VERSION"), "18");
      }
      return options.recovered ?? {
        replayedLsn: "0/16B6C50",
        recoveryConf:
          "restore_command = 'wal-g wal-fetch %f %p'\n" +
          `recovery_target_time = '${recoverRequest.targetTime.toISOString()}'\n`,
      };
    },
  );
  const drill = new RestoreDrillRunner({
    config,
    engine,
    runner,
    fileSystem,
    clock: () => NOW,
    idFactory: () => "drill-fixed-id",
  });
  return { config, runner, fileSystem, engine, drill };
};

describe("audit hash chain", () => {
  test("stableJson sorts nested object keys but preserves array order", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(stableJson([{ z: 1, a: 2 }, 3])).toBe('[{"a":2,"z":1},3]');
    expect(stableJson(null)).toBe("null");
  });

  test("computes the documented canonical SHA-256 payload", () => {
    const row = auditRows()[0]!;
    const canonical = buildAuditCanonicalPayload(GENESIS_HASH, row);
    expect(canonical).toBe(
      [
        GENESIS_HASH,
        row.id,
        "2026-11-03T10:00:00.000Z",
        row.actorId,
        row.action,
        row.entityType,
        row.entityId,
        stableJson(row.beforeJson),
        stableJson(row.afterJson),
      ].join("|"),
    );
    expect(computeAuditRowHash(GENESIS_HASH, row)).toBe(
      createHash("sha256").update(canonical, "utf8").digest("hex"),
    );
  });

  test("detects valid chains, mutated payloads and broken previous links", () => {
    const rows = auditRows();
    expect(verifyAuditChain(rows)).toMatchObject({ valid: true, brokenLinks: 0, verifiedCount: 2 });

    const payloadTampered = auditRows();
    (payloadTampered[0] as AuditChainRow).afterJson = { status: "TAMPERED" };
    expect(verifyAuditChain(payloadTampered).brokenLinks).toBe(1);

    const linkTampered = auditRows();
    (linkTampered[1] as AuditChainRow).prevHash = "f".repeat(64);
    expect(verifyAuditChain(linkTampered)).toMatchObject({ valid: false, brokenLinks: 1 });
  });
});

describe("restore drill runner", () => {
  test("runs a passing full drill and signs the report", async () => {
    const { config, runner, fileSystem, engine, drill } = makeHarness();
    const report = await drill.run();

    expect(report.id).toBe("drill-fixed-id");
    expect(report.status).toBe("PASSED");
    expect(report.startedAt).toBe(NOW.toISOString());
    expect(report.targetTime).toBe("2026-11-03T11:55:00.000Z");
    expect(report.replayedLsn).toBe("0/16B6C50");
    expect(report.doubleEntryDrift).toBe("0.0000");
    expect(report.balanceMismatches).toBe(0);
    expect(report.auditBrokenLinks).toBe(0);
    expect(report.journalLineCount).toBe(3);
    expect(report.checks).toEqual({
      doubleEntry: { ok: true, detail: "SUM(DEBIT) - SUM(CREDIT) = 0.0000" },
      balanceParity: { ok: true, detail: "0 sharded-balance mismatch(es)" },
      auditChain: { ok: true, detail: "verified 2 audit rows" },
    });
    expect(report.errorMessage).toBeUndefined();
    expect(verifyDrillReportSignature(report, ENCRYPTION_KEY_HEX)).toBe(true);

    expect(engine.recovered).toHaveLength(2);
    expect(engine.recovered[0]).toMatchObject({
      target: "postgres_core",
      targetDir: SCRATCH,
      port: config.BACKUP_SCRATCH_PORT,
    });
    expect(engine.recovered[1]).toMatchObject({
      target: "audit_db",
      targetDir: AUDIT_SCRATCH,
      port: config.BACKUP_SCRATCH_AUDIT_PORT,
    });
    expect(engine.recovered[0]?.targetTime.toISOString()).toBe("2026-11-03T11:55:00.000Z");
    expect(engine.recovered[1]?.targetTime.toISOString()).toBe("2026-11-03T11:55:00.000Z");
    expect(
      fileSystem.writeHistory.find((entry) => entry.path === join(SCRATCH, "postgresql.auto.conf"))?.data,
    ).toContain("recovery_target_time = '2026-11-03T11:55:00.000Z'");
    expect(
      fileSystem.writeHistory.find((entry) => entry.path === join(AUDIT_SCRATCH, "postgresql.auto.conf"))?.data,
    ).toContain("recovery_target_time = '2026-11-03T11:55:00.000Z'");
    expect(fileSystem.writeHistory.some((entry) => entry.path === join(SCRATCH, "recovery.signal"))).toBe(true);
    expect(fileSystem.writeHistory.some((entry) => entry.path === join(AUDIT_SCRATCH, "recovery.signal"))).toBe(true);
    expect(fileSystem.removed).toContain(SCRATCH);
    expect(fileSystem.removed).toContain(AUDIT_SCRATCH);
    expect(await fileSystem.exists(SCRATCH)).toBe(false);
    expect(await fileSystem.exists(AUDIT_SCRATCH)).toBe(false);
    const psqlCalls = runner.calls.filter((call) => basename(call.command) === "psql");
    expect(psqlCalls).toHaveLength(4);
    const auditCall = psqlCalls.find((call) => call.args.at(-1) === AUDIT_CHAIN_QUERY);
    expect(auditCall?.args).toContain(config.PG_AUDIT_DB_NAME);
    expect(auditCall?.args).toContain(String(config.BACKUP_SCRATCH_AUDIT_PORT));
    const coreCall = psqlCalls.find((call) => call.args.at(-1) === DOUBLE_ENTRY_QUERY);
    expect(coreCall?.args).toContain(config.PG_PRIMARY_DB_NAME);
    expect(coreCall?.args).toContain(String(config.BACKUP_SCRATCH_PORT));

    const tampered = { ...report, journalLineCount: report.journalLineCount + 1 };
    expect(verifyDrillReportSignature(tampered, ENCRYPTION_KEY_HEX)).toBe(false);
  });

  test("refuses to initdb over a restore that produced no PostgreSQL data directory", async () => {
    const { runner, fileSystem, drill } = makeHarness(defaultOutputs(), {
      initialFiles: {},
      producesDataDir: false,
    });
    const report = await drill.run();
    expect(report.status).toBe("FAILED");
    expect(report.errorMessage).toContain("refusing to initdb");
    expect(runner.calls.some((call) => basename(call.command) === "initdb")).toBe(false);
    expect(runner.calls.some((call) => basename(call.command) === "psql")).toBe(false);
    expect(await fileSystem.exists(SCRATCH)).toBe(false);
    expect(await fileSystem.exists(AUDIT_SCRATCH)).toBe(false);
  });

  test("runs initdb only when the engine explicitly reports an initialized empty dir", async () => {
    const { runner, fileSystem, drill } = makeHarness(defaultOutputs(), {
      initialFiles: {},
      producesDataDir: false,
      recovered: { initializedEmptyDir: true, replayedLsn: "0/16B6C50" },
    });
    const report = await drill.run();
    expect(report.status).toBe("PASSED");
    expect(runner.calls.filter((call) => basename(call.command) === "initdb")).toHaveLength(2);
    expect(await fileSystem.exists(SCRATCH)).toBe(false);
    expect(await fileSystem.exists(AUDIT_SCRATCH)).toBe(false);
  });

  const failingCases: Array<{
    name: string;
    mutate: (outputs: DrillOutputs) => void;
    check: "doubleEntry" | "balanceParity" | "auditChain";
  }> = [
    {
      name: "double-entry drift",
      mutate: (outputs) => {
        outputs.doubleEntry = "0.0100";
      },
      check: "doubleEntry",
    },
    {
      name: "balance mismatch",
      mutate: (outputs) => {
        outputs.balanceParity = "2";
      },
      check: "balanceParity",
    },
    {
      name: "audit chain tamper",
      mutate: (outputs) => {
        const rows = auditRows();
        rows[0]!.afterJson = { status: "TAMPERED" };
        outputs.audit = JSON.stringify(rows);
      },
      check: "auditChain",
    },
  ];

  for (const failingCase of failingCases) {
    test(`fails independently on ${failingCase.name} and still cleans the scratch instance`, async () => {
      const outputs = defaultOutputs();
      failingCase.mutate(outputs);
      const { fileSystem, drill } = makeHarness(outputs);
      const report = await drill.run();

      expect(report.status).toBe("FAILED");
      expect(report.checks[failingCase.check].ok).toBe(false);
      for (const key of ["doubleEntry", "balanceParity", "auditChain"] as const) {
        if (key !== failingCase.check) expect(report.checks[key].ok).toBe(true);
      }
      if (failingCase.check === "doubleEntry") expect(report.doubleEntryDrift).toBe("0.0100");
      if (failingCase.check === "balanceParity") expect(report.balanceMismatches).toBe(2);
      if (failingCase.check === "auditChain") expect(report.auditBrokenLinks).toBe(1);
      expect(await fileSystem.exists(SCRATCH)).toBe(false);
      expect(await fileSystem.exists(AUDIT_SCRATCH)).toBe(false);
    });
  }

  test("reports a failed recover and cleans up", async () => {
    const { runner, fileSystem, drill } = makeHarness(defaultOutputs(), { engineThrows: true });
    const report = await drill.run();
    expect(report.status).toBe("FAILED");
    expect(report.errorMessage).toContain("restore failed");
    expect(report.checks.doubleEntry).toEqual({ ok: false, detail: "not executed" });
    expect(runner.calls.some((call) => basename(call.command) === "psql")).toBe(false);
    expect(await fileSystem.exists(SCRATCH)).toBe(false);
    expect(await fileSystem.exists(AUDIT_SCRATCH)).toBe(false);
  });

  test("reports a failed pg_ctl start and still destroys the scratch directory", async () => {
    const { fileSystem, drill } = makeHarness(defaultOutputs(), { startFails: true });
    const report = await drill.run();
    expect(report.status).toBe("FAILED");
    expect(report.errorMessage).toContain("pg_ctl start failed");
    expect(report.checks.auditChain).toEqual({ ok: false, detail: "not executed" });
    expect(await fileSystem.exists(SCRATCH)).toBe(false);
    expect(await fileSystem.exists(AUDIT_SCRATCH)).toBe(false);
  });

  test("surfaces audit query failures without aborting the other checks", async () => {
    const outputs = defaultOutputs();
    const { runner, drill } = makeHarness(outputs);
    const drillFileSystem = new MemoryDrillFileSystem();
    const failingRunner = new RecordingRunner((command, args, options) => {
      const query = args.at(-1);
      if (basename(command) === "psql" && query === AUDIT_CHAIN_QUERY) {
        return { code: 1, stdout: "", stderr: "relation audit_records does not exist" };
      }
      return runner.run(command, args, options);
    });
    const harness = new RestoreDrillRunner({
      config: makeConfig(),
      engine: new FakeEngine(
        async () => ({ storageTargets: ["primary-s3"] }),
        async (recoverRequest) => {
          await drillFileSystem.writeFile(join(recoverRequest.targetDir, "PG_VERSION"), "18");
          return { replayedLsn: "0/16B6C50" };
        },
      ),
      runner: failingRunner,
      fileSystem: drillFileSystem,
      clock: () => NOW,
    });
    const report = await harness.run();
    expect(report.status).toBe("FAILED");
    expect(report.checks.doubleEntry.ok).toBe(true);
    expect(report.checks.balanceParity.ok).toBe(true);
    expect(report.checks.auditChain.ok).toBe(false);
    expect(report.checks.auditChain.detail).toContain("audit chain query failed");
    expect(drill).toBeDefined();
  });
});
