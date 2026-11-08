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
  SCRATCH_SAFETY_CONF,
  parseControlData,
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
const DEDICATED = { PG_AUDIT_DATA_DIR: "/var/lib/postgresql/18/audit" };

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
  /** Successive answers to `SELECT pg_is_in_recovery()`; the last one repeats. */
  recoveryStates?: string[];
  auditDatabasePresent?: boolean;
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
      if (query === "SELECT pg_is_in_recovery();") {
        const states = outputs.recoveryStates ?? ["f"];
        const answer = states.length > 1 ? states.shift()! : states[0]!;
        return { code: 0, stdout: `${answer}\n`, stderr: "" };
      }
      if (query.startsWith("SELECT 1 FROM pg_database")) {
        return { code: 0, stdout: outputs.auditDatabasePresent === false ? "\n" : "1\n", stderr: "" };
      }
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
    dedicatedAudit?: boolean;
    sleeps?: number[];
  } = {},
) => {
  const config = makeConfig(options.dedicatedAudit ? DEDICATED : {});
  const runner = drillRunnerFor(outputs, options.startFails);
  const fileSystem = new MemoryDrillFileSystem(
    options.initialFiles ?? {
      [join(SCRATCH, "PG_VERSION")]: "18",
      ...(options.dedicatedAudit ? { [join(AUDIT_SCRATCH, "PG_VERSION")]: "18" } : {}),
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
    sleep: async (ms) => {
      options.sleeps?.push(ms);
    },
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
  test("runs a passing full drill (dedicated audit cluster) and signs the report", async () => {
    const { config, runner, fileSystem, engine, drill } = makeHarness(defaultOutputs(), { dedicatedAudit: true });
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
    // 4 invariant queries + one pg_is_in_recovery wait per cluster
    expect(psqlCalls.filter((call) => call.args.at(-1) !== "SELECT pg_is_in_recovery();")).toHaveLength(4);
    expect(psqlCalls.filter((call) => call.args.at(-1) === "SELECT pg_is_in_recovery();")).toHaveLength(2);
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
      dedicatedAudit: true,
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

/** Rows hashed exactly the way the audit trigger does: over `before_json::text` (JSONB text form). */
const triggerRows = (): AuditChainRow[] => {
  const make = (seq: number, prev: string, before: string, after: string): AuditChainRow => {
    const row: AuditChainRow = {
      seqNo: String(seq),
      id: `0190a000-0000-7000-8000-00000000010${seq}`,
      createdAt: "2026-11-03T10:00:00.123Z",
      actorId: "0190a000-0000-7000-8000-000000000011",
      action: "ACTION",
      entityType: "thing",
      entityId: `thing-${seq}`,
      // Parsed form: stableJson of this can NEVER equal the JSONB text form below.
      beforeJson: JSON.parse(before),
      afterJson: JSON.parse(after),
      beforeJsonText: before,
      afterJsonText: after,
      prevHash: prev,
      rowHash: "",
    };
    row.rowHash = createHash("sha256")
      .update([prev, row.id, row.createdAt, row.actorId, row.action, row.entityType, row.entityId, before, after].join("|"), "utf8")
      .digest("hex");
    return row;
  };
  const first = make(1, GENESIS_HASH, '{"status": "PENDING", "zz": 1, "a": [1, 2]}', '{"status": "ACTIVE"}');
  const second = make(2, first.rowHash, '{"b": 1}', '{"b": 2, "a": null}');
  return [first, second];
};

describe("audit hash chain against PostgreSQL JSONB text (RC-11)", () => {
  test("verifies rows hashed by the trigger over before_json::text / after_json::text", () => {
    const rows = triggerRows();
    // The stableJson form is genuinely different, which is why the old drill failed 100% on real data.
    expect(computeAuditRowHash(GENESIS_HASH, rows[0]!)).not.toBe(rows[0]!.rowHash);
    expect(verifyAuditChain(rows)).toMatchObject({ valid: true, brokenLinks: 0, verifiedCount: 2 });
  });

  test("still detects a tampered row in trigger-format data", () => {
    const rows = triggerRows();
    rows[0]!.afterJsonText = '{"status": "TAMPERED"}';
    expect(verifyAuditChain(rows)).toMatchObject({ valid: false, brokenLinks: 1, firstBrokenSeqNo: "1" });
  });

  test("detects a deleted row through the gap in seq_no, even when the surviving hashes line up", () => {
    const rows = auditRows();
    // Build a three-row chain, then delete the middle row and re-link: hashes are internally consistent.
    const third: AuditChainRow = { ...rows[1]!, seqNo: "3", id: "0190a000-0000-7000-8000-000000000003", prevHash: rows[0]!.rowHash, rowHash: "" };
    third.rowHash = computeAuditRowHash(third.prevHash, third);
    const result = verifyAuditChain([rows[0]!, third]);
    expect(result.valid).toBe(false);
    expect(result.brokenLinks).toBe(1);
    expect(result.firstBrokenSeqNo).toBe("3");
  });
});

describe("restore drill: shared vs dedicated audit database", () => {
  test("shared cluster (default): recovers ONE scratch cluster and checks the audit chain against it", async () => {
    const { config, runner, fileSystem, engine, drill } = makeHarness();
    const report = await drill.run();
    expect(report.status).toBe("PASSED");
    expect(engine.recovered).toHaveLength(1);
    expect(engine.recovered[0]?.target).toBe("postgres_core");
    const starts = runner.calls.filter((call) => basename(call.command) === "pg_ctl" && call.args.includes("start"));
    expect(starts).toHaveLength(1);
    const auditCall = runner.calls.find((call) => call.args.at(-1) === AUDIT_CHAIN_QUERY);
    expect(auditCall?.args).toContain(config.PG_AUDIT_DB_NAME);
    expect(auditCall?.args).toContain(String(config.BACKUP_SCRATCH_PORT));
    expect(auditCall?.args).not.toContain(String(config.BACKUP_SCRATCH_AUDIT_PORT));
    expect(await fileSystem.exists(AUDIT_SCRATCH)).toBe(false);
    expect(engine.logicalRestores).toHaveLength(0);
  });

  test("shared cluster: restores the logical audit dump when the audit database is not in the physical restore", async () => {
    const { config, engine, drill } = makeHarness({ ...defaultOutputs(), auditDatabasePresent: false });
    const report = await drill.run();
    expect(engine.logicalRestores).toEqual([
      { database: config.PG_AUDIT_DB_NAME, host: "127.0.0.1", port: config.BACKUP_SCRATCH_PORT, user: config.PG_PRIMARY_USER },
    ]);
    expect(report.checks.auditChain.detail).toContain("restored logical dump");
  });

  test("dedicated cluster: the audit queries connect as the AUDIT role (the core role does not exist in that cluster)", async () => {
    const config = makeConfig({ ...DEDICATED, PG_AUDIT_USER: "gw_audit_writer", PG_PRIMARY_USER: "gw_app" });
    const runner = drillRunnerFor(defaultOutputs());
    const fileSystem = new MemoryDrillFileSystem({ [join(SCRATCH, "PG_VERSION")]: "18", [join(AUDIT_SCRATCH, "PG_VERSION")]: "18" });
    const drill = new RestoreDrillRunner({
      config,
      engine: new FakeEngine(undefined, async (request) => {
        await fileSystem.writeFile(join(request.targetDir, "PG_VERSION"), "18");
        return { replayedLsn: "0/1", recoveryConf: "recovery_target_time = 'x'\n" };
      }),
      runner,
      fileSystem,
      clock: () => NOW,
      sleep: async () => undefined,
    });
    const report = await drill.run();
    expect(report.errorMessage).toBeUndefined();
    expect(report.status).toBe("PASSED");
    const userOf = (query: string): string | undefined => {
      const call = runner.calls.find((entry) => entry.args.at(-1) === query);
      return call?.args[call.args.indexOf("-U") + 1];
    };
    expect(userOf(AUDIT_CHAIN_QUERY)).toBe("gw_audit_writer");
    expect(userOf(DOUBLE_ENTRY_QUERY)).toBe("gw_app");
    expect(userOf(BALANCE_PARITY_QUERY)).toBe("gw_app");
  });

  test("shared cluster: the audit queries ALSO run as the audit role (the core application role has no grant on the audit database)", async () => {
    const config = makeConfig({ PG_AUDIT_USER: "gw_audit_writer", PG_PRIMARY_USER: "gw_app" });
    const runner = drillRunnerFor(defaultOutputs());
    const fileSystem = new MemoryDrillFileSystem();
    const drill = new RestoreDrillRunner({
      config,
      engine: new FakeEngine(undefined, async (request) => {
        await fileSystem.writeFile(join(request.targetDir, "PG_VERSION"), "18");
        return { replayedLsn: "0/1", recoveryConf: "recovery_target_time = 'x'\n" };
      }),
      runner,
      fileSystem,
      clock: () => NOW,
      sleep: async () => undefined,
    });
    expect((await drill.run()).errorMessage).toBeUndefined();
    const userOf = (query: string): string | undefined => {
      const call = runner.calls.find((entry) => entry.args.at(-1) === query);
      return call?.args[call.args.indexOf("-U") + 1];
    };
    expect(userOf(AUDIT_CHAIN_QUERY)).toBe("gw_audit_writer");
    expect(userOf(DOUBLE_ENTRY_QUERY)).toBe("gw_app");
  });

  test("dedicated cluster still recovers and starts both scratch clusters", async () => {
    const { engine, runner, drill } = makeHarness(defaultOutputs(), { dedicatedAudit: true });
    await drill.run();
    expect(engine.recovered.map((request) => request.target)).toEqual(["postgres_core", "audit_db"]);
    expect(runner.calls.filter((call) => basename(call.command) === "pg_ctl" && call.args.includes("start"))).toHaveLength(2);
  });
});

describe("restore drill: scratch safety and recovery", () => {
  test("neutralizes archiving in every scratch cluster so a promoted drill can never write into the real archive", async () => {
    const { fileSystem, drill } = makeHarness(defaultOutputs(), {
      initialFiles: { [join(SCRATCH, "PG_VERSION")]: "18", [join(SCRATCH, "postgresql.auto.conf")]: "archive_command = 'curl https://backup/v1/wal/%f'\n" },
    });
    await drill.run();
    const written = fileSystem.writeHistory.filter((entry) => entry.path === join(SCRATCH, "postgresql.auto.conf")).at(-1)!.data;
    expect(written).toContain(SCRATCH_SAFETY_CONF);
    expect(written.indexOf("archive_command = 'curl")).toBeLessThan(written.lastIndexOf("archive_command = ''"));
    expect(SCRATCH_SAFETY_CONF).toContain("archive_mode = off");
    expect(SCRATCH_SAFETY_CONF).toContain("primary_slot_name = ''");
  });

  test("builds postgresql.conf / pg_hba.conf for a restore that only contains PGDATA, sized from pg_controldata", async () => {
    const control = [
      "max_connections setting:              500",
      "max_worker_processes setting:         16",
      "max_wal_senders setting:              10",
      "max_prepared_xacts setting:           0",
      "max_locks_per_xact setting:           128",
      "track_commit_timestamp setting:       on",
    ].join("\n");
    expect(parseControlData(control)).toBe(
      "max_connections = 500\nmax_worker_processes = 16\nmax_wal_senders = 10\nmax_prepared_transactions = 0\nmax_locks_per_transaction = 128\ntrack_commit_timestamp = on\n",
    );
    const base = drillRunnerFor(defaultOutputs());
    const runner = new RecordingRunner((command, args, options) =>
      basename(command) === "pg_controldata" ? { code: 0, stdout: control, stderr: "" } : base.run(command, args, options) as never,
    );
    const fileSystem = new MemoryDrillFileSystem({ [join(SCRATCH, "PG_VERSION")]: "18" });
    const drill = new RestoreDrillRunner({
      config: makeConfig(),
      engine: new FakeEngine(undefined, async (request) => {
        await fileSystem.writeFile(join(request.targetDir, "PG_VERSION"), "18");
        return { recoveryConf: "recovery_target_time = 'x'\n" };
      }),
      runner,
      fileSystem,
      clock: () => NOW,
      sleep: async () => undefined,
    });
    await drill.run();
    const conf = fileSystem.writeHistory.find((entry) => entry.path === join(SCRATCH, "postgresql.conf"))?.data ?? "";
    expect(conf).toContain("max_connections = 500");
    expect(conf).toContain("max_locks_per_transaction = 128");
    expect(fileSystem.writeHistory.some((entry) => entry.path === join(SCRATCH, "pg_hba.conf") && entry.data.includes("127.0.0.1/32 trust"))).toBe(true);
  });

  test("waits for WAL replay to finish and promote before running any invariant query", async () => {
    const sleeps: number[] = [];
    const { runner, drill } = makeHarness({ ...defaultOutputs(), recoveryStates: ["t", "t", "t", "f"] }, { sleeps });
    const report = await drill.run();
    expect(report.status).toBe("PASSED");
    expect(sleeps).toEqual([250, 250, 250]);
    const queries = runner.calls.filter((call) => basename(call.command) === "psql").map((call) => call.args.at(-1));
    const lastWait = queries.lastIndexOf("SELECT pg_is_in_recovery();");
    expect(queries.indexOf(DOUBLE_ENTRY_QUERY)).toBeGreaterThan(lastWait);
  });

  test("fails with a clear error when recovery never finishes", async () => {
    const sleeps: number[] = [];
    const { drill } = makeHarness({ ...defaultOutputs(), recoveryStates: ["t"] }, { sleeps });
    const report = await drill.run();
    expect(report.status).toBe("FAILED");
    expect(report.errorMessage).toContain("recovery did not finish");
    expect(report.checks.doubleEntry).toEqual({ ok: false, detail: "not executed" });
  });

  test("latest: asks the engine to replay ALL WAL (no target) and still runs every check", async () => {
    const { engine, drill } = makeHarness();
    const report = await drill.run({ latest: true });
    expect(report.status).toBe("PASSED");
    expect(engine.recovered[0]).toMatchObject({ target: "postgres_core", latest: true });
    expect(report.targetTime).toBe(NOW.toISOString()); // the moment the rehearsal started
    const plain = makeHarness();
    await plain.drill.run();
    expect(plain.engine.recovered[0]?.latest).toBeUndefined();
  });

  test("recovers to an explicit targetTime when one is given", async () => {
    const { engine, drill } = makeHarness();
    const target = new Date("2026-11-03T11:30:00.000Z");
    const report = await drill.run({ targetTime: target });
    expect(report.targetTime).toBe(target.toISOString());
    expect(engine.recovered[0]?.targetTime.toISOString()).toBe(target.toISOString());
  });
});
