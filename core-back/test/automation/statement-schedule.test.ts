/**
 * AUTO-07 / AUTO-12 and the cron helper: scheduled statements that did not arrive become one keyed case per slot (and
 * resolve themselves), slot counters that drifted from the live attempts are reported (and repaired only on request).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createFakeRepositories } from "../helpers/fakeRepositories";
import { ConsistencyAuditWorker } from "../../engine/workers/ConsistencyAuditWorker";
import { StatementScheduleWorker, statementMissingSubjectKey } from "../../engine/workers/StatementScheduleWorker";
import { lastScheduledAtOrBefore, parseCron } from "../../lib/cron";
import { cleanupAutomationCatalog, createAutomationCatalog, type AutomationCatalog } from "../helpers/automationCatalog";
import { createPrisma, databaseIsReachable } from "../storage-engine/helpers/db";

const client = createPrisma({ max: 10 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const catalogs: AutomationCatalog[] = [];
const sourceIds: string[] = [];
const iso = (date: Date): string => date.toISOString();

afterAll(async () => {
  for (const id of sourceIds) {
    await client.$executeRawUnsafe(`DELETE FROM operator_cases WHERE subject_key LIKE $1`, `statement.%:${id}%`);
    await client.$executeRawUnsafe(`DELETE FROM reconciliation_runs WHERE statement_source_id = $1::uuid`, id);
    await client.$executeRawUnsafe(`DELETE FROM statement_sources WHERE id = $1::uuid`, id);
  }
  for (const catalog of catalogs) {
    await client.$executeRawUnsafe(`DELETE FROM operator_cases WHERE subject_key = $1`, `link.slot_drift:${catalog.linkId}`);
  }
  await cleanupAutomationCatalog(client, catalogs);
  await client.$disconnect();
});

describe("cron (Africa/Tripoli)", () => {
  test("syntax: lists, ranges, steps, weekdays; invalid expressions throw", () => {
    const cron = parseCron("*/15 6-8 1,15 * 1-5");
    expect([...cron.minutes]).toEqual([0, 15, 30, 45]);
    expect([...cron.hours]).toEqual([6, 7, 8]);
    expect([...cron.daysOfMonth]).toEqual([1, 15]);
    expect([...parseCron("0 0 * * 7").daysOfWeek]).toEqual([0]); // 7 = Sunday
    for (const bad of ["", "* * * *", "61 * * * *", "* 24 * * *", "a b c d e", "*/0 * * * *", "5-1 * * * *"]) expect(() => parseCron(bad), bad).toThrow();
  });

  test("a daily 06:00 schedule is 04:00 UTC; the latest slot at or before an instant", () => {
    const cron = parseCron("0 6 * * *");
    expect(iso(lastScheduledAtOrBefore(cron, new Date("2026-11-09T10:00:00.000Z"))!)).toBe("2026-11-09T04:00:00.000Z");
    expect(iso(lastScheduledAtOrBefore(cron, new Date("2026-11-09T04:00:00.000Z"))!)).toBe("2026-11-09T04:00:00.000Z"); // exactly at the slot
    expect(iso(lastScheduledAtOrBefore(cron, new Date("2026-11-09T03:59:59.000Z"))!)).toBe("2026-11-08T04:00:00.000Z");
    // local time decides the date: 22:30 UTC on the 9th is already the 10th in Tripoli, but before 06:00 local
    expect(iso(lastScheduledAtOrBefore(cron, new Date("2026-11-09T22:30:00.000Z"))!)).toBe("2026-11-09T04:00:00.000Z");
  });

  test("weekday and day-of-month rules, including the OR of both when both are restricted", () => {
    const mondays = parseCron("0 9 * * 1");
    expect(iso(lastScheduledAtOrBefore(mondays, new Date("2026-11-11T12:00:00.000Z"))!)).toBe("2026-11-09T07:00:00.000Z"); // Monday 9 Nov 09:00 local
    const first = parseCron("30 1 1 * *");
    expect(iso(lastScheduledAtOrBefore(first, new Date("2026-11-20T12:00:00.000Z"))!)).toBe("2026-10-31T23:30:00.000Z"); // 1 Nov 01:30 local
    const either = parseCron("0 0 13 * 5"); // the 13th OR a Friday
    expect(iso(lastScheduledAtOrBefore(either, new Date("2026-11-14T12:00:00.000Z"))!)).toBe("2026-11-12T22:00:00.000Z"); // Fri 13 Nov 00:00 local
    expect(iso(lastScheduledAtOrBefore(either, new Date("2026-11-10T12:00:00.000Z"))!)).toBe("2026-11-05T22:00:00.000Z"); // Fri 6 Nov 00:00 local
  });

  test("a schedule with no occurrence in the look-back window yields null", () => {
    expect(lastScheduledAtOrBefore(parseCron("0 0 31 2 *"), new Date("2026-11-09T10:00:00.000Z"))).toBeNull();
  });
});

describeDb("statement schedule (live PostgreSQL)", () => {
  const NOW = new Date("2026-11-09T10:00:00.000Z"); // 12:00 Monday in Tripoli
  const source = async (cron: string | null, createdAt: Date) => {
    const catalog = await createAutomationCatalog(client, { label: "stmt" });
    catalogs.push(catalog);
    const row = await client.statementSource.create({ data: { gatewayId: catalog.gatewayId, type: "UPLOAD" as never, scheduleCron: cron, parserConfig: {}, createdAt } });
    sourceIds.push(row.id);
    return row.id;
  };
  const run = async (sourceId: string, at: Date) =>
    client.reconciliationRun.create({
      data: { statementSourceId: sourceId, windowStart: new Date(at.getTime() - 86_400_000), windowEnd: at, fileHash: createHash("sha256").update(randomUUID()).digest("hex"), statsJson: {}, createdAt: at },
    });
  const worker = (now: Date, ids: string[], extra: Partial<ConstructorParameters<typeof StatementScheduleWorker>[0]> = {}) =>
    new StatementScheduleWorker({ db: client as never, repositories: createFakeRepositories(), logger: quiet, healthRegistry: null, clock: () => now, sourceIds: ids, graceMinutes: 120, lookbackSlots: 3, ...extra } as never);
  const cases = (id: string) => client.operatorCase.findMany({ where: { subjectKey: { startsWith: `statement.` , contains: id } }, orderBy: { subjectKey: "asc" } });

  test("a daily source with no upload produces ONE case per missed day (inside the look-back), none before the grace, none for slots before the source existed", async () => {
    const id = await source("0 6 * * *", new Date("2026-11-01T00:00:00.000Z"));
    // before the grace of today's 06:00 slot (04:00Z + 2 h = 06:00Z): 05:00Z -> today's slot is not due yet
    await worker(new Date("2026-11-09T05:00:00.000Z"), [id], { lookbackSlots: 2 }).runOnce();
    expect((await cases(id)).map((row) => row.subjectKey)).toEqual([
      statementMissingSubjectKey(id, new Date("2026-11-07T04:00:00.000Z")),
      statementMissingSubjectKey(id, new Date("2026-11-08T04:00:00.000Z")),
    ]);
    await worker(NOW, [id]).runOnce();
    await worker(NOW, [id]).runOnce();
    const open = await cases(id);
    expect(open.map((row) => row.subjectKey)).toEqual([
      statementMissingSubjectKey(id, new Date("2026-11-07T04:00:00.000Z")),
      statementMissingSubjectKey(id, new Date("2026-11-08T04:00:00.000Z")),
      statementMissingSubjectKey(id, new Date("2026-11-09T04:00:00.000Z")),
    ]);
    expect(open.every((row) => row.priority === "P2" && row.kind === "UNMATCHED_STATEMENT" && row.state === "OPEN")).toBe(true);
    expect(open[2]!.resolutionNotes).toContain(id);
    const audits = await client.$queryRawUnsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'STATEMENT_MISSING' AND entity_id = $1`, id);
    expect(Number(audits[0]!.n)).toBe(3);
  });

  test("an upload after a slot clears that slot's case; the other missed days stay open", async () => {
    const id = await source("0 6 * * *", new Date("2026-11-01T00:00:00.000Z"));
    await worker(NOW, [id]).runOnce();
    expect(await cases(id)).toHaveLength(3);
    await run(id, new Date("2026-11-09T07:30:00.000Z")); // today's statement
    await worker(NOW, [id]).runOnce();
    const states = Object.fromEntries((await cases(id)).map((row) => [row.subjectKey!.split(":").slice(2).join(":"), row.state]));
    expect(states).toEqual({ "2026-11-07T04:00:00.000Z": "OPEN", "2026-11-08T04:00:00.000Z": "OPEN", "2026-11-09T04:00:00.000Z": "RESOLVED" });
    const resolved = (await cases(id)).find((row) => row.state === "RESOLVED")!;
    expect(resolved.resolutionNotes).toMatch(/AUTO-RESOLVED.*statement arrived/);
  });

  test("a statement counts for its own slot, not for the previous ones (one upload does not hide yesterday's miss)", async () => {
    const id = await source("0 6 * * *", new Date("2026-11-01T00:00:00.000Z"));
    await run(id, new Date("2026-11-08T07:00:00.000Z")); // yesterday's arrived, today's did not
    await worker(NOW, [id]).runOnce();
    const open = (await cases(id)).filter((row) => row.state === "OPEN").map((row) => row.subjectKey);
    expect(open).toEqual([statementMissingSubjectKey(id, new Date("2026-11-07T04:00:00.000Z")), statementMissingSubjectKey(id, new Date("2026-11-09T04:00:00.000Z"))]);
  });

  test("a source created after a slot never owes it; no cron and an invalid cron raise nothing missing; the invalid one is reported once", async () => {
    const fresh = await source("0 6 * * *", new Date("2026-11-09T08:00:00.000Z")); // created after today's 06:00 slot
    const none = await source(null, new Date("2026-11-01T00:00:00.000Z"));
    const broken = await source("not a cron", new Date("2026-11-01T00:00:00.000Z"));
    await worker(NOW, [fresh, none, broken]).runOnce();
    await worker(NOW, [fresh, none, broken]).runOnce();
    expect(await cases(fresh)).toEqual([]);
    expect(await cases(none)).toEqual([]);
    const invalid = await cases(broken);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.subjectKey).toBe(`statement.schedule_invalid:${broken}`);
    expect(invalid[0]!.priority).toBe("P3");
  });
});

describeDb("slot counter audit (live PostgreSQL)", () => {
  const NOW = new Date();
  const link = async () => {
    const catalog = await createAutomationCatalog(client, { label: "slots" });
    catalogs.push(catalog);
    // finite-use link, settled long ago
    await client.$executeRawUnsafe(`UPDATE payment_links SET infinite_use = false, use_count = 5, updated_at = $2 WHERE id = $1::uuid`, catalog.linkId, new Date(NOW.getTime() - 3_600_000));
    return catalog;
  };
  const setActive = (id: string, n: number, updatedAt = new Date(NOW.getTime() - 3_600_000)) =>
    client.$executeRawUnsafe(`UPDATE payment_links SET active_locked_count = $2, updated_at = $3 WHERE id = $1::uuid`, id, n, updatedAt);
  const worker = (ids: string[], extra: Partial<ConstructorParameters<typeof ConsistencyAuditWorker>[0]> = {}) =>
    new ConsistencyAuditWorker({ db: client as never, repositories: createFakeRepositories(), logger: quiet, healthRegistry: null, clock: () => NOW, linkIds: ids, ...extra } as never);
  const caseOf = (id: string) => client.operatorCase.findMany({ where: { subjectKey: `link.slot_drift:${id}` } });
  const active = async (id: string) => Number((await client.$queryRawUnsafe<Array<{ n: number }>>(`SELECT active_locked_count AS n FROM payment_links WHERE id = $1::uuid`, id))[0]!.n);

  test("a counter that matches the live attempts raises nothing; a drifted one opens ONE P3 case with both numbers and is NOT repaired by default", async () => {
    const ok = await link();
    await ok.newAttempt({ status: "AWAITING_CUSTOMER" });
    await client.$executeRawUnsafe(`UPDATE payment_attempts SET link_id = $1::uuid WHERE id IN (SELECT id FROM payment_attempts WHERE merchant_id = $2::uuid)`, ok.linkId, ok.merchantId);
    await setActive(ok.linkId, 1);
    const drifted = await link();
    await setActive(drifted.linkId, 3);
    await worker([ok.linkId, drifted.linkId]).runOnce();
    await worker([ok.linkId, drifted.linkId]).runOnce();
    expect(await caseOf(ok.linkId)).toEqual([]);
    const found = await caseOf(drifted.linkId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ priority: "P3", kind: "MISMATCH" });
    expect(found[0]!.resolutionNotes).toMatch(/records 3 locked slot\(s\) but has 0 live attempt\(s\)/);
    expect(await active(drifted.linkId)).toBe(3); // untouched
  });

  test("terminal attempts do not hold a slot; infinite-use links and recently changed links are skipped", async () => {
    const done = await link();
    await done.newAttempt({ status: "FAILED" });
    await client.$executeRawUnsafe(`UPDATE payment_attempts SET link_id = $1::uuid WHERE merchant_id = $2::uuid`, done.linkId, done.merchantId);
    await setActive(done.linkId, 1); // claims a slot that no live attempt holds
    const infinite = await link();
    await client.$executeRawUnsafe(`UPDATE payment_links SET infinite_use = true WHERE id = $1::uuid`, infinite.linkId);
    await setActive(infinite.linkId, 9);
    const busy = await link();
    await setActive(busy.linkId, 2, new Date(NOW.getTime() - 60_000)); // changed a minute ago: may be an in-flight reservation
    await worker([done.linkId, infinite.linkId, busy.linkId]).runOnce();
    expect((await caseOf(done.linkId)).length).toBe(1);
    expect(await caseOf(infinite.linkId)).toEqual([]);
    expect(await caseOf(busy.linkId)).toEqual([]);
  });

  test("with repair on the counter is corrected under the lock and audited; a healed or in-flight link is left alone", async () => {
    const drifted = await link();
    await drifted.newAttempt({ status: "VERIFYING" });
    await client.$executeRawUnsafe(`UPDATE payment_attempts SET link_id = $1::uuid WHERE merchant_id = $2::uuid`, drifted.linkId, drifted.merchantId);
    await setActive(drifted.linkId, 4);
    await worker([drifted.linkId], { repair: true }).runOnce();
    expect(await active(drifted.linkId)).toBe(1);
    const audits = await client.$queryRawUnsafe<Array<{ before_json: any; after_json: any }>>(`SELECT before_json, after_json FROM audit_log WHERE action = 'PAYMENT_LINK_SLOTS_REPAIRED' AND entity_id = $1`, drifted.linkId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.before_json.activeLockedCount).toBe(4);
    expect(audits[0]!.after_json.activeLockedCount).toBe(1);
    expect(await caseOf(drifted.linkId)).toEqual([]); // repaired, not reported
    await worker([drifted.linkId], { repair: true }).runOnce();
    const again = await client.$queryRawUnsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'PAYMENT_LINK_SLOTS_REPAIRED' AND entity_id = $1`, drifted.linkId);
    expect(Number(again[0]!.n)).toBe(1);
  });
});
