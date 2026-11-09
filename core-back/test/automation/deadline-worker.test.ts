/**
 * AUTO-04 / AUTO-22 deadline worker against live PostgreSQL: operator cases, AML cases, join requests, disputes,
 * cash-outs (Libyan business hours) and emergency ratification (decision D7), with exactly-once stages, the catch-up
 * window, isolation of the rules and the one-time emergency extension route.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { adminInternalRouter } from "../../api/internal/admin";
import { signSession } from "../../lib/auth";
import { MemoryAuthStateStore, setAuthStateStore } from "../../lib/auth/sharedState";
import { resetAuthThrottles } from "../../lib/auth/throttle";
import { isApiError, toErrorEnvelope } from "../../lib/error";
import { DeadlineWorker } from "../../engine/workers/DeadlineWorker";
import { cleanupAutomationCatalog, createAutomationCatalog, type AutomationCatalog } from "../helpers/automationCatalog";
import { createFakeRepositories } from "../helpers/fakeRepositories";
import { createPrisma, databaseIsReachable } from "../storage-engine/helpers/db";

const client = createPrisma({ max: 15 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const catalogs: AutomationCatalog[] = [];
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const HOUR = 3_600_000;
const MIN = 60_000;
const MS_DAY = 86_400_000;
const NOW = new Date();
const created = {
  users: [] as string[], cases: [] as string[], amlCases: [] as string[], joinRequests: [] as string[], disputes: [] as string[],
  cashouts: [] as string[], approvals: [] as string[], subjectIds: [] as string[],
};

// Staff recipients are resolved BY ROLE (the oldest active users first, at most 20). Users left active by an earlier or
// crashed run would crowd this run's users out, so they are disabled up front and again at the end.
const disableTestStaff = () => client.$executeRawUnsafe(`UPDATE users SET status = 'DISABLED' WHERE (email LIKE 'dl-%@gateway.test' OR email LIKE 'hk-%@gateway.test') AND status = 'ACTIVE'`);
if (databaseIsReachable) await disableTestStaff();

afterAll(async () => {
  if (databaseIsReachable) {
    const ids = [...created.cases, ...created.amlCases, ...created.joinRequests, ...created.disputes, ...created.cashouts, ...created.approvals, ...created.subjectIds];
    await client.$executeRawUnsafe(`DELETE FROM deadline_stages WHERE subject_id = ANY($1::text[])`, ids);
    await client.$executeRawUnsafe(`DELETE FROM notifications WHERE event_id LIKE 'notice:deadline:%' AND split_part(event_id, ':', 4) = ANY($1::text[])`, ids);
    await client.$executeRawUnsafe(`DELETE FROM notifications WHERE recipient_user_id = ANY($1::uuid[])`, created.users);
    await client.$executeRawUnsafe(`DELETE FROM operator_cases WHERE id = ANY($1::uuid[]) OR subject_key ~ ANY($2::text[])`, created.cases, ids.map((id) => `[:]${id}`));
    await client.$executeRawUnsafe(`DELETE FROM detail_change_logs WHERE approval_request_id = ANY($1::uuid[])`, created.approvals);
    await client.$executeRawUnsafe(`DELETE FROM disputes WHERE id = ANY($1::uuid[])`, created.disputes);
    await client.$executeRawUnsafe(`DELETE FROM cashout_requests WHERE id = ANY($1::uuid[])`, created.cashouts);
    await client.$executeRawUnsafe(`DELETE FROM aml_cases WHERE id = ANY($1::uuid[])`, created.amlCases);
    await client.$executeRawUnsafe(`DELETE FROM join_requests WHERE id = ANY($1::uuid[])`, created.joinRequests);
    // The audit trail is append-only and references approvals, so an approval cannot be deleted: close it instead, so
    // no suite ever sees a pending emergency approval left behind.
    await client.$executeRawUnsafe(`UPDATE approval_requests SET state = 'EXPIRED' WHERE id = ANY($1::uuid[]) AND state::text IN ('PENDING_REVIEW', 'DRAFT')`, created.approvals);
    await disableTestStaff();
    await cleanupAutomationCatalog(client, catalogs);
  }
  await client.$disconnect();
});

const worker = (clock: () => Date, overrides: Partial<ConstructorParameters<typeof DeadlineWorker>[0]> = {}) =>
  new DeadlineWorker({
    db: client as never,
    repositories: createFakeRepositories(),
    logger: quiet,
    healthRegistry: null,
    clock,
    loadHolidays: async () => new Set<string>(),
    ...overrides,
  });

const catalogOf = async (options: Parameters<typeof createAutomationCatalog>[1] = {}): Promise<AutomationCatalog> => {
  const catalog = await createAutomationCatalog(client, { label: "deadline", ...options });
  catalogs.push(catalog);
  return catalog;
};

const staff = async (role: string, authorities: string[] = []): Promise<string> => {
  const user = await client.user.create({
    data: {
      email: `dl-${role.toLowerCase()}-${randomUUID().slice(0, 8)}@gateway.test`,
      role: role as never,
      status: "ACTIVE",
      authoritiesMap: Object.fromEntries(authorities.map((authority) => [authority, true])),
      isMaker: false,
      isChecker: authorities.includes("approval:check"),
      mfaRequired: false,
    },
  });
  created.users.push(user.id);
  return user.id;
};

const approvalState = async (id: string) => client.approvalRequest.findUniqueOrThrow({ where: { id } });

const stages = async (subjectType: string, subjectId: string): Promise<string[]> =>
  (await client.$queryRawUnsafe<Array<{ stage: string }>>(`SELECT stage FROM deadline_stages WHERE subject_type = $1 AND subject_id = $2 ORDER BY stage`, subjectType, subjectId)).map((row) => row.stage);

const audits = async (action: string, entityId: string): Promise<number> =>
  Number((await client.$queryRawUnsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM audit_log WHERE action = $1 AND entity_id = $2`, action, entityId))[0]?.n ?? 0);

const notices = (prefix: string) =>
  client.notification.findMany({ where: { eventId: { startsWith: `notice:${prefix}` } }, orderBy: { eventId: "asc" } });

const operatorCase = async (input: { state?: string; priority?: string; slaMinutes: number; assignee?: string | null }) => {
  const row = await client.operatorCase.create({
    data: {
      kind: "MANUAL_REVIEW",
      priority: (input.priority ?? "P3") as never,
      state: (input.state ?? "OPEN") as never,
      slaDueAt: new Date(NOW.getTime() + input.slaMinutes * MIN),
      assigneeUserId: input.assignee ?? null,
    },
  });
  created.cases.push(row.id);
  return row.id;
};

describeDb("operator case deadlines", () => {
  test("a reminder before the SLA, exactly once, only for unresolved cases inside the lead time", async () => {
    const assignee = await staff("OPERATOR");
    const soon = await operatorCase({ slaMinutes: 30, assignee });
    const later = await operatorCase({ slaMinutes: 300, assignee });
    const resolved = await operatorCase({ slaMinutes: 20, state: "RESOLVED", assignee });
    await worker(() => NOW).runOnce();

    expect(await stages("OPERATOR_CASE", soon)).toEqual(["REMINDER"]);
    expect(await stages("OPERATOR_CASE", later)).toEqual([]);
    expect(await stages("OPERATOR_CASE", resolved)).toEqual([]);
    const sent = await notices(`deadline:operator-case:${soon}:REMINDER`);
    expect(sent.map((row) => row.channel).sort()).toEqual(["EMAIL", "IN_APP"]);
    expect(sent.every((row) => row.recipientUserId === assignee)).toBe(true);
    expect(await audits("DEADLINE_REMINDER_SENT", soon)).toBe(1);

    await worker(() => NOW).runOnce();
    await worker(() => NOW).runOnce(); // another instance, same minute
    expect((await notices(`deadline:operator-case:${soon}:REMINDER`)).length).toBe(2);
    expect(await audits("DEADLINE_REMINDER_SENT", soon)).toBe(1);
  });

  test("a breach raises the priority one level, annotates the case and tells the assignee; P1 stays P1; old breaches are ignored", async () => {
    const assignee = await staff("OPERATOR");
    const p3 = await operatorCase({ slaMinutes: -10, priority: "P3", assignee });
    const p2 = await operatorCase({ slaMinutes: -10, priority: "P2", assignee });
    const p1 = await operatorCase({ slaMinutes: -10, priority: "P1", assignee });
    const ancient = await operatorCase({ slaMinutes: -60 * 24 * 5, priority: "P3", assignee }); // 5 days ago: outside the 72 h catch-up window
    await worker(() => NOW).runOnce();

    const read = async (id: string) => client.operatorCase.findUniqueOrThrow({ where: { id } });
    expect((await read(p3)).priority).toBe("P2");
    expect((await read(p2)).priority).toBe("P1");
    expect((await read(p1)).priority).toBe("P1");
    expect((await read(p3)).resolutionNotes).toContain("[SLA BREACHED");
    expect((await read(p3)).resolutionNotes).toContain("priority P3 -> P2");
    expect(await audits("OPERATOR_CASE_SLA_BREACHED", p3)).toBe(1);
    expect((await notices(`deadline:operator-case:${p3}:BREACH`)).some((row) => row.recipientUserId === assignee)).toBe(true);
    // not escalated twice
    await worker(() => NOW).runOnce();
    expect((await read(p3)).priority).toBe("P2");
    // the old one was not touched and not claimed
    expect((await read(ancient)).priority).toBe("P3");
    expect(await stages("OPERATOR_CASE", ancient)).toEqual([]);
  });

  test("two nodes ticking at once escalate a case exactly once", async () => {
    const assignee = await staff("OPERATOR");
    const id = await operatorCase({ slaMinutes: -5, priority: "P3", assignee });
    await Promise.all([worker(() => NOW).runOnce(), worker(() => NOW).runOnce(), worker(() => NOW).runOnce()]);
    expect((await client.operatorCase.findUniqueOrThrow({ where: { id } })).priority).toBe("P2");
    expect(await audits("OPERATOR_CASE_SLA_BREACHED", id)).toBe(1);
  });
});

describeDb("AML case and join request deadlines", () => {
  test("an AML case reminder goes to the reviewer; a breach opens ONE keyed P1 case that carries nothing but the id", async () => {
    const catalog = await catalogOf();
    const reviewer = await staff("COMPLIANCE");
    const mk = async (status: string, slaMinutes: number) => {
      const row = await client.amlCase.create({
        data: {
          subjectType: "MERCHANT",
          subjectId: catalog.merchantId,
          triggerReason: "SECRET: structuring pattern against the merchant",
          severity: "HIGH",
          severityInputsJson: {},
          status: status as never,
          slaDueAt: new Date(NOW.getTime() + slaMinutes * MIN),
          assignedReviewerId: reviewer,
        },
      });
      created.amlCases.push(row.id);
      return row.id;
    };
    const dueSoon = await mk("IN_REVIEW", 20);
    const breached = await mk("OPEN", -15);
    const released = await mk("RELEASED", -15);
    await worker(() => NOW).runOnce();
    await worker(() => NOW).runOnce();

    expect(await stages("AML_CASE", dueSoon)).toEqual(["REMINDER"]);
    expect(await stages("AML_CASE", breached)).toEqual(["BREACH"]);
    expect(await stages("AML_CASE", released)).toEqual([]);
    const cases = await client.operatorCase.findMany({ where: { subjectKey: `aml.sla_breached:${breached}` } });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ priority: "P1", kind: "MANUAL_REVIEW", state: "OPEN" });
    // confidentiality: no subject, trigger or severity anywhere in the case, the notices or their payloads
    const text = JSON.stringify([cases, await notices(`deadline:aml-case:${breached}`), await notices(`deadline:aml-case:${dueSoon}`)]);
    expect(text).not.toMatch(/SECRET|structuring|HIGH|CRITICAL/);
    expect(text).toContain(breached);
  });

  test("a join request is reminded before its SLA runs out, and only then", async () => {
    const catalog = await catalogOf();
    const reviewer = await staff("COMPLIANCE");
    const mk = async (status: string, slaHours: number) => {
      const row = await client.joinRequest.create({
        data: {
          merchantId: catalog.merchantId,
          submittedByUserId: catalog.userId,
          status: status as never,
          onboardingChannel: "SELF_SERVICE" as never,
          slaDueAt: new Date(NOW.getTime() + slaHours * HOUR),
          assignedReviewerId: reviewer,
        },
      });
      created.joinRequests.push(row.id);
      return row.id;
    };
    const soon = await mk("IN_REVIEW", 20);
    const far = await mk("IN_REVIEW", 90);
    const draft = await mk("DRAFT", 10);
    await worker(() => NOW).runOnce();
    expect(await stages("JOIN_REQUEST", soon)).toEqual(["REMINDER"]);
    expect(await stages("JOIN_REQUEST", far)).toEqual([]);
    expect(await stages("JOIN_REQUEST", draft)).toEqual([]);
    expect((await notices(`deadline:join-request:${soon}:REMINDER`)).every((row) => row.recipientUserId === reviewer)).toBe(true);
  });
});

describeDb("dispute deadlines (decision D1)", () => {
  const dispute = async (catalog: AutomationCatalog, input: { status?: string; dueInHours: number | null; evidence?: unknown; updatedDaysAgo?: number }) => {
    const attempt = await catalog.newAttempt({ settlementTarget: "PLATFORM_CLEARING" });
    const row = await client.dispute.create({
      data: {
        attemptId: attempt.id,
        gatewayId: catalog.gatewayId,
        railId: catalog.railId,
        externalDisputeRef: `DSP-${randomUUID().slice(0, 8)}`,
        source: "MANUAL",
        amount: "25.0000",
        currency: "LYD",
        status: (input.status ?? "OPENED") as never,
        openedAt: new Date(NOW.getTime() - 5 * 86_400_000),
        evidenceDueAt: input.dueInHours === null ? null : new Date(NOW.getTime() + input.dueInHours * HOUR),
        ...(input.evidence !== undefined ? { evidenceJson: input.evidence as never } : {}),
      },
    });
    created.disputes.push(row.id);
    if (input.updatedDaysAgo !== undefined) {
      await client.$executeRawUnsafe(`UPDATE disputes SET updated_at = $2 WHERE id = $1::uuid`, row.id, new Date(NOW.getTime() - input.updatedDaysAgo * 86_400_000));
    }
    return { id: row.id, reference: row.externalDisputeRef };
  };

  test("reminders at T-72 h and T-24 h reach the merchant and the finance queue, once each", async () => {
    const catalog = await catalogOf();
    const finance = await staff("FINANCE");
    const in60 = await dispute(catalog, { dueInHours: 60 });
    const in20 = await dispute(catalog, { dueInHours: 20 });
    const in100 = await dispute(catalog, { dueInHours: 100 });
    await worker(() => NOW).runOnce();
    await worker(() => NOW).runOnce();
    expect(await stages("DISPUTE", in60.id)).toEqual(["T72H"]);
    expect(await stages("DISPUTE", in20.id)).toEqual(["T24H"]);
    expect(await stages("DISPUTE", in100.id)).toEqual([]);
    const merchantNotices = await client.notification.findMany({ where: { eventId: { startsWith: `notice:deadline:dispute:${in60.id}:T72H` }, recipientMerchantId: catalog.merchantId, templateCode: "DISPUTE_EVIDENCE_DUE" } });
    expect(merchantNotices.map((row) => row.channel).sort()).toEqual(["EMAIL", "IN_APP"]);
    expect(JSON.stringify(merchantNotices[0]!.payloadJson)).toContain(in60.reference);
    expect((await notices(`deadline:dispute:${in20.id}:T24H`)).some((row) => row.recipientUserId === finance)).toBe(true);
  });

  test("at the deadline without evidence the dispute is EXPIRED (lost by default), the merchant is told and finance gets ONE case; the money stays a human decision", async () => {
    const catalog = await catalogOf();
    const missed = await dispute(catalog, { dueInHours: -2 });
    const withEvidence = await dispute(catalog, { dueInHours: -2, evidence: { documents: ["receipt.pdf"] } });
    const submitted = await dispute(catalog, { status: "EVIDENCE_SUBMITTED", dueInHours: -2, evidence: { documents: ["receipt.pdf"] } });
    const old = await dispute(catalog, { dueInHours: -24 * 6 }); // beyond the catch-up window
    await worker(() => NOW).runOnce();
    await worker(() => NOW).runOnce();

    const read = async (id: string) => client.dispute.findUniqueOrThrow({ where: { id } });
    expect((await read(missed.id)).status).toBe("EXPIRED");
    expect((await read(missed.id)).outcomeAt).not.toBeNull();
    expect((await read(withEvidence.id)).status).toBe("OPENED"); // evidence exists: the provider decides
    expect((await read(submitted.id)).status).toBe("EVIDENCE_SUBMITTED");
    expect((await read(old.id)).status).toBe("OPENED");
    expect(await audits("DISPUTE_EXPIRED_LOST_BY_DEFAULT", missed.id)).toBe(1);
    // the merchant webhook source (AUTO-34): exactly one `dispute.closed`, written in the same transaction, for this merchant only
    const outbox = await client.$queryRawUnsafe<Array<{ merchant_id: string; payload_json: Record<string, unknown> }>>(
      `SELECT merchant_id::text AS merchant_id, payload_json FROM outbox_events WHERE topic = 'dispute.closed' AND aggregate_id = $1`,
      missed.id,
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.merchant_id).toBe(catalog.merchantId);
    expect(outbox[0]!.payload_json).toMatchObject({ disputeId: missed.id, outcome: "LOST", reason: "EVIDENCE_NOT_SUBMITTED" });
    const untouched = await client.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM outbox_events WHERE topic = 'dispute.closed' AND aggregate_id = ANY($1::text[])`, [withEvidence.id, submitted.id, old.id]);
    expect(untouched).toEqual([]);
    await client.$executeRawUnsafe(`DELETE FROM outbox_events WHERE topic = 'dispute.closed' AND aggregate_id = $1`, missed.id);
    const cases = await client.operatorCase.findMany({ where: { subjectKey: `dispute.expired:${missed.id}` } });
    expect(cases).toHaveLength(1);
    expect(cases[0]!.resolutionNotes).toContain("Approve its chargeback adjustment");
    const merchantNotice = await client.notification.findMany({ where: { templateCode: "DISPUTE_EXPIRED", recipientMerchantId: catalog.merchantId, eventId: { startsWith: `notice:deadline:dispute:${missed.id}` } } });
    expect(merchantNotice).toHaveLength(2);
    // no ledger movement: nothing is booked by this worker
    expect(Number((await client.$queryRawUnsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM journal_entries WHERE ref_type = 'DISPUTE_OUTCOME' AND ref_id LIKE $1`, `%${missed.id}%`))[0]!.n)).toBe(0);
  });

  test("evidence that has been with the provider for more than 30 days without a ruling opens one finance case", async () => {
    const catalog = await catalogOf();
    const overdue = await dispute(catalog, { status: "EVIDENCE_SUBMITTED", dueInHours: -500, evidence: { a: 1 }, updatedDaysAgo: 31 });
    const recent = await dispute(catalog, { status: "EVIDENCE_SUBMITTED", dueInHours: -500, evidence: { a: 1 }, updatedDaysAgo: 5 });
    await worker(() => NOW).runOnce();
    await worker(() => NOW).runOnce();
    expect(await client.operatorCase.count({ where: { subjectKey: `dispute.ruling_overdue:${overdue.id}` } })).toBe(1);
    expect(await client.operatorCase.count({ where: { subjectKey: `dispute.ruling_overdue:${recent.id}` } })).toBe(0);
  });
});

describeDb("cash-out SLA in Libyan business hours (decision D2)", () => {
  // 2030-06-06 is a Thursday; Tripoli is UTC+2, so 06:00Z is 08:00 local.
  const request = async (catalog: AutomationCatalog, createdAt: string, amount = "50.0000") => {
    const row = await client.cashoutRequest.create({
      data: { merchantId: catalog.merchantId, walletId: catalog.walletId, amount, destinationBankJson: {}, state: "PENDING", createdAt: new Date(createdAt) },
    });
    created.cashouts.push(row.id);
    return row.id;
  };
  const at = (iso: string) => () => new Date(iso);

  test("75 % reminds finance, 100 % opens a P2 case, 200 % a P1 case; the weekend does not count", async () => {
    const catalog = await catalogOf();
    const finance = await staff("FINANCE");
    const compliance = await staff("COMPLIANCE");
    const reminder = await request(catalog, "2030-06-06T06:00:00Z"); // Thu 08:00 local
    const breach = await request(catalog, "2030-06-06T06:00:00Z");
    const double = await request(catalog, "2030-06-02T06:00:00Z"); // Sun 08:00 local, a week earlier in business days

    // Sun 05:00 local: Thu 16 h + Sun 5 h = 21 h >= 18 h (75 % of 24)
    await worker(at("2030-06-09T03:00:00Z"), { rules: ["cashouts"] }).runOnce();
    expect((await stages("CASHOUT", reminder))).toContain("REMIND_75");
    expect((await stages("CASHOUT", reminder))).not.toContain("BREACH_100");
    expect((await notices(`deadline:cashout:${reminder}:REMIND_75`)).some((row) => row.recipientUserId === finance)).toBe(true);
    expect(await client.operatorCase.count({ where: { subjectKey: { startsWith: `cashout.sla:${reminder}` } } })).toBe(0);

    // Sun 08:00 local: Thu 16 h + Sun 8 h = 24 h = the SLA
    await worker(at("2030-06-09T06:00:00Z"), { rules: ["cashouts"] }).runOnce();
    expect(await stages("CASHOUT", breach)).toEqual(["BREACH_100", "REMIND_75"]); // the lower stage was claimed silently
    const p2 = await client.operatorCase.findMany({ where: { subjectKey: `cashout.sla:${breach}:1` } });
    expect(p2).toHaveLength(1);
    expect(p2[0]!.priority).toBe("P2");
    expect(await audits("CASHOUT_SLA_BREACHED", breach)).toBe(1);

    // the oldest one is already past 200 %: only the highest stage acts, compliance is told as well
    expect((await stages("CASHOUT", double)).sort()).toEqual(["BREACH_100", "BREACH_200", "REMIND_75"]);
    const p1 = await client.operatorCase.findMany({ where: { subjectKey: `cashout.sla:${double}:2` } });
    expect(p1).toHaveLength(1);
    expect(p1[0]!.priority).toBe("P1");
    expect(await client.operatorCase.count({ where: { subjectKey: `cashout.sla:${double}:1` } })).toBe(0);
    expect((await notices(`deadline:cashout:${double}:BREACH_200`)).some((row) => row.recipientUserId === compliance)).toBe(true);

    // nothing fires twice
    await worker(at("2030-06-09T07:00:00Z"), { rules: ["cashouts"] }).runOnce();
    expect(await audits("CASHOUT_SLA_BREACHED", breach)).toBe(1);
  });

  test("a holiday does not count, and a merchant that is not ACTIVE is in a documented hold and is not measured", async () => {
    const catalog = await catalogOf();
    const held = await catalogOf();
    await client.merchant.update({ where: { id: held.merchantId }, data: { status: "SUSPENDED" } });
    const onHoliday = await request(catalog, "2030-06-02T06:00:00Z"); // Sunday 08:00 local
    const suspended = await request(held, "2030-06-02T06:00:00Z");
    // Mon 2030-06-03 is a holiday: Sun 16 h + Tue 8 h... measured to Tue 08:00 local = 16 + 8 = 24 h without the holiday
    // but Monday removed: Sun 08:00 -> Mon 00:00 = 16 h, Tue 00:00 -> 08:00 = 8 h = 24 h exactly (Monday's 24 h are excluded)
    await worker(at("2030-06-04T06:00:00Z"), { rules: ["cashouts"], loadHolidays: async () => new Set(["2030-06-03"]) }).runOnce();
    expect(await stages("CASHOUT", onHoliday)).toContain("BREACH_100"); // exactly 24 business hours
    await worker(at("2030-06-12T06:00:00Z"), { rules: ["cashouts"] }).runOnce();
    expect(await stages("CASHOUT", suspended)).toEqual([]); // never measured
  });
});

describeDb("emergency ratification (decision D7)", () => {
  /** An emergency suspension: the merchant is SUSPENDED and its approval is PENDING_REVIEW, due `dueInHours` from `base`. */
  const emergency = async (dueAt: Date) => {
    const catalog = await catalogOf();
    await client.merchant.update({ where: { id: catalog.merchantId }, data: { status: "SUSPENDED", suspendedAt: dueAt, suspensionReasonCode: "FRAUD_SUSPECTED", suspensionNotes: "secret compliance note" } });
    const approval = await client.approvalRequest.create({
      data: {
        subjectType: "MERCHANT",
        subjectId: catalog.merchantId,
        payloadDiffJson: { kind: "SUSPEND_EMERGENCY", reasonCode: "FRAUD_SUSPECTED" },
        mode: "EMERGENCY_RATIFICATION",
        makerUserId: catalog.userId,
        state: "PENDING_REVIEW",
        ratifyDueAt: dueAt,
        expiresAt: new Date(dueAt.getTime() + 48 * HOUR),
      },
    });
    created.approvals.push(approval.id);
    await client.detailChangeLog.create({
      data: { actorId: catalog.userId, merchantId: catalog.merchantId, entityType: "MERCHANT", entityId: catalog.merchantId, fieldName: "/status", oldValue: "ACTIVE", newValue: "SUSPENDED", approvalRequestId: approval.id, source: "ADMIN", requestId: randomUUID() },
    });
    return { catalog, approvalId: approval.id, merchantId: catalog.merchantId };
  };
  const at = (date: Date) => () => date;

  test("reminders at 4 h and 1 h go to the ratifiers but never the actor; the suspension is untouched", async () => {
    const mlro = await staff("MLRO", ["approval:check"]);
    const due = new Date(NOW.getTime() + 3 * HOUR);
    const { approvalId, merchantId, catalog } = await emergency(due);
    await worker(at(NOW), { rules: ["emergency"] }).runOnce(); // 3 h before: the 4 h reminder
    expect(await stages("EMERGENCY_APPROVAL", approvalId)).toEqual(["REMIND_4H"]);
    const first = await notices(`deadline:emergency:${approvalId}:REMIND_4H`);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((row) => row.recipientUserId !== catalog.userId)).toBe(true);
    expect(first.some((row) => row.recipientUserId === mlro)).toBe(true);

    await worker(at(new Date(due.getTime() - 30 * MIN)), { rules: ["emergency"] }).runOnce(); // 30 min before: the 1 h reminder
    expect((await stages("EMERGENCY_APPROVAL", approvalId)).sort()).toEqual(["REMIND_1H", "REMIND_4H"]);
    await worker(at(new Date(due.getTime() - 20 * MIN)), { rules: ["emergency"] }).runOnce();
    expect(await notices(`deadline:emergency:${approvalId}:REMIND_1H`)).toHaveLength(first.length);
    expect((await client.merchant.findUniqueOrThrow({ where: { id: merchantId } })).status).toBe("SUSPENDED");
    expect((await approvalState(approvalId)).state).toBe("PENDING_REVIEW");
  });

  test("at the deadline the suspension STAYS in force, a P1 case opens once, and the escalation repeats every 4 h", async () => {
    await staff("MLRO", ["approval:check"]);
    const due = new Date(NOW.getTime() - 10 * MIN);
    const { approvalId, merchantId } = await emergency(due);
    await worker(at(NOW), { rules: ["emergency"] }).runOnce();
    await worker(at(NOW), { rules: ["emergency"] }).runOnce();
    expect((await client.merchant.findUniqueOrThrow({ where: { id: merchantId } })).status).toBe("SUSPENDED");
    expect((await approvalState(approvalId)).state).toBe("PENDING_REVIEW");
    const cases = await client.operatorCase.findMany({ where: { subjectKey: `emergency.unratified:${approvalId}` } });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ priority: "P1", state: "OPEN" });
    expect(await audits("EMERGENCY_ACTION_UNRATIFIED", approvalId)).toBe(1);

    await worker(at(new Date(due.getTime() + 5 * HOUR)), { rules: ["emergency"] }).runOnce(); // round 1
    await worker(at(new Date(due.getTime() + 5.5 * HOUR)), { rules: ["emergency"] }).runOnce(); // same round: nothing
    await worker(at(new Date(due.getTime() + 9 * HOUR)), { rules: ["emergency"] }).runOnce(); // round 2
    expect(await audits("EMERGENCY_ACTION_ESCALATED", approvalId)).toBe(2);
    expect((await stages("EMERGENCY_APPROVAL", approvalId)).sort()).toEqual(["ESCALATE_1", "ESCALATE_2", "OVERDUE"]);
    expect((await client.merchant.findUniqueOrThrow({ where: { id: merchantId } })).status).toBe("SUSPENDED");
  });

  test("48 hours after the deadline an unratified suspension is lifted: merchant restored, approval closed, merchant told only that it ended", async () => {
    await staff("MLRO", ["approval:check"]);
    const due = new Date(NOW.getTime() - 60 * HOUR);
    const { approvalId, merchantId } = await emergency(due);
    await worker(at(NOW), { rules: ["emergency"] }).runOnce(); // first look is past the grace: overdue + lift in one tick
    const merchant = await client.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    expect(merchant.status).toBe("ACTIVE"); // the status it had before the suspension
    expect(merchant.suspendedAt).toBeNull();
    expect(merchant.suspensionReasonCode).toBeNull();
    expect(merchant.suspensionNotes).toBeNull();
    const approval = await approvalState(approvalId);
    expect(approval.state).toBe("EXPIRED");
    expect(approval.rejectionReason).toBe("EMERGENCY_NOT_RATIFIED: lifted");
    expect(await audits("EMERGENCY_ACTION_LIFTED", merchantId)).toBe(1);
    expect(await client.operatorCase.count({ where: { subjectKey: `emergency.lifted:${approvalId}`, priority: "P1" } })).toBe(1);
    const told = await client.notification.findMany({ where: { templateCode: "MERCHANT_SUSPENSION_ENDED", recipientMerchantId: merchantId } });
    expect(told.map((row) => row.channel).sort()).toEqual(["EMAIL", "IN_APP"]);
    expect(JSON.stringify(told)).not.toMatch(/FRAUD|secret|compliance|ratif/i);
    const template = await client.notificationTemplate.findFirstOrThrow({ where: { code: "MERCHANT_SUSPENSION_ENDED", lang: "EN", channel: "EMAIL" } });
    expect(template.bodyTemplate).not.toMatch(/ratif|compliance|fraud|AML/i);
    // idempotent
    await worker(at(new Date(NOW.getTime() + HOUR)), { rules: ["emergency"] }).runOnce();
    expect(await audits("EMERGENCY_ACTION_LIFTED", merchantId)).toBe(1);
  });

  test("a ratified approval, or one whose merchant is no longer suspended, is never lifted", async () => {
    const due = new Date(NOW.getTime() - 60 * HOUR);
    const ratified = await emergency(due);
    await client.approvalRequest.update({ where: { id: ratified.approvalId }, data: { state: "EXECUTED", checkerUserId: await staff("COMPLIANCE", ["approval:check"]) } });
    const reinstated = await emergency(due);
    await client.merchant.update({ where: { id: reinstated.merchantId }, data: { status: "CLOSED" } });
    await worker(at(NOW), { rules: ["emergency"] }).runOnce();
    expect((await client.merchant.findUniqueOrThrow({ where: { id: ratified.merchantId } })).status).toBe("SUSPENDED");
    expect((await approvalState(ratified.approvalId)).state).toBe("EXECUTED");
    expect((await client.merchant.findUniqueOrThrow({ where: { id: reinstated.merchantId } })).status).toBe("CLOSED"); // untouched
    expect(await audits("EMERGENCY_ACTION_LIFTED", reinstated.merchantId)).toBe(1); // the audit says nothing was lifted
    const row = await client.$queryRawUnsafe<Array<{ after: string }>>(`SELECT after_json->>'status' AS after FROM audit_log WHERE action = 'EMERGENCY_ACTION_LIFTED' AND entity_id = $1`, reinstated.merchantId);
    expect(row[0]!.after).toBe("UNCHANGED");
  });

  test("a non-merchant emergency change with no registered reverter raises the case and is never silently closed before the grace ends", async () => {
    const due = new Date(NOW.getTime() - 30 * MIN);
    const catalog = await catalogOf();
    const approval = await client.approvalRequest.create({
      data: { subjectType: "VELOCITY_RULE", subjectId: randomUUID(), payloadDiffJson: [{ op: "replace", path: "/limit", value: 1 }], mode: "EMERGENCY_RATIFICATION", makerUserId: catalog.userId, state: "PENDING_REVIEW", ratifyDueAt: due, expiresAt: new Date(due.getTime() + 48 * HOUR) },
    });
    created.approvals.push(approval.id);
    await worker(at(NOW), { rules: ["emergency"] }).runOnce();
    const kase = await client.operatorCase.findFirstOrThrow({ where: { subjectKey: `emergency.unratified:${approval.id}` } });
    expect(kase.resolutionNotes).toContain("No automatic revert is registered for VELOCITY_RULE");
    expect((await approvalState(approval.id)).state).toBe("PENDING_REVIEW");
    // with a reverter the change IS reverted and the approval closed
    const reverted: string[] = [];
    const second = await client.approvalRequest.create({
      data: { subjectType: "VELOCITY_RULE", subjectId: randomUUID(), payloadDiffJson: [], mode: "EMERGENCY_RATIFICATION", makerUserId: catalog.userId, state: "PENDING_REVIEW", ratifyDueAt: due, expiresAt: new Date(due.getTime() + 48 * HOUR) },
    });
    created.approvals.push(second.id);
    await worker(at(NOW), { rules: ["emergency"], emergencyReverters: { VELOCITY_RULE: { revert: async (_tx, a) => { reverted.push(a.id); return true; } } } }).runOnce();
    expect(reverted).toContain(second.id);
    expect((await approvalState(second.id)).state).toBe("EXPIRED");
    expect(await audits("EMERGENCY_ACTION_REVERTED", (await client.approvalRequest.findUniqueOrThrow({ where: { id: second.id } })).subjectId)).toBe(1);
  });
});

describeDb("extending an emergency suspension once", () => {
  const serve = async () => {
    const app = express();
    app.use(express.json());
    app.use("/internal/admin", adminInternalRouter);
    app.use((error: unknown, _request: express.Request, response: express.Response, _next: unknown) => {
      response.status(isApiError(error) ? error.statusCode : 500).json(toErrorEnvelope(error));
    });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return {
      close: () => server.close(),
      post: async (path: string, token: string, body: unknown) => {
        const response = await fetch(`${base}/internal/admin${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
        return { status: response.status, body: (await response.json()) as Record<string, any> };
      },
    };
  };
  const officer = async (role: "COMPLIANCE" | "MLRO" | "FINANCE") => {
    const authorities = ["approval:check", "approval:read", "approval:write"];
    const user = await client.user.create({
      data: { email: `dl-officer-${randomUUID().slice(0, 8)}@gateway.test`, role, status: "ACTIVE", authoritiesMap: Object.fromEntries(authorities.map((a) => [a, true])), isMaker: false, isChecker: true, mfaRequired: false },
    });
    created.users.push(user.id);
    return { id: user.id, token: signSession({ sub: user.id, role, merchantId: null, authorities, appScopeIds: [], mfa: true }, "admin") };
  };

  test("one independent compliance officer may extend once; the actor, a finance user and a second extension are refused; stages run again against the new deadline", async () => {
    setAuthStateStore(new MemoryAuthStateStore());
    await resetAuthThrottles();
    const catalog = await catalogOf();
    const due = new Date(NOW.getTime() - 30 * MIN);
    await client.merchant.update({ where: { id: catalog.merchantId }, data: { status: "SUSPENDED", suspendedAt: due } });
    const maker = await officer("COMPLIANCE"); // also the actor who suspended
    const approval = await client.approvalRequest.create({
      data: { subjectType: "MERCHANT", subjectId: catalog.merchantId, payloadDiffJson: { kind: "SUSPEND_EMERGENCY" }, mode: "EMERGENCY_RATIFICATION", makerUserId: maker.id, state: "PENDING_REVIEW", ratifyDueAt: due, expiresAt: new Date(due.getTime() + 48 * HOUR) },
    });
    created.approvals.push(approval.id);
    await worker(() => NOW, { rules: ["emergency"] }).runOnce();
    expect(await stages("EMERGENCY_APPROVAL", approval.id)).toEqual(["OVERDUE"]);

    const api = await serve();
    try {
      const reason = "Second officer needs time to review the evidence";
      const own = await api.post(`/approvals/${approval.id}/extend-emergency`, maker.token, { days: 2, reason }); // the actor cannot extend their own
      expect([own.status, own.body.code]).toEqual([409, "APPROVAL_MAKER_EQUALS_CHECKER"]);
      const finance = await officer("FINANCE");
      expect((await api.post(`/approvals/${approval.id}/extend-emergency`, finance.token, { days: 2, reason })).body.code).toBe("MERCHANT_CHECKER_DOMAIN_FORBIDDEN");
      const second = await officer("MLRO");
      expect((await api.post(`/approvals/${approval.id}/extend-emergency`, second.token, { days: 8, reason })).status).toBe(400);
      expect((await api.post(`/approvals/${approval.id}/extend-emergency`, second.token, { days: 2, reason: "short" })).status).toBe(400);

      const ok = await api.post(`/approvals/${approval.id}/extend-emergency`, second.token, { days: 3, reason });
      expect(ok.status).toBe(200);
      const extended = await approvalState(approval.id);
      expect(extended.ratifyDueAt!.getTime()).toBeGreaterThan(NOW.getTime() + 2.9 * MS_DAY);
      expect(extended.expiresAt!.getTime() - extended.ratifyDueAt!.getTime()).toBe(48 * HOUR);
      expect((extended.payloadDiffJson as any).extension).toMatchObject({ byUserId: second.id, days: 3, reason });
      expect(await audits("EMERGENCY_ACTION_EXTENDED", catalog.merchantId)).toBe(1);
      expect(await stages("EMERGENCY_APPROVAL", approval.id)).toEqual([]); // cleared: they run again against the new deadline
      const again = await api.post(`/approvals/${approval.id}/extend-emergency`, (await officer("COMPLIANCE")).token, { days: 1, reason });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("EMERGENCY_ALREADY_EXTENDED");

      // the worker now sees a deadline three days away: nothing fires
      await worker(() => NOW, { rules: ["emergency"] }).runOnce();
      expect(await stages("EMERGENCY_APPROVAL", approval.id)).toEqual([]);
      expect((await client.merchant.findUniqueOrThrow({ where: { id: catalog.merchantId } })).status).toBe("SUSPENDED");
    } finally {
      api.close();
    }
  });
});

describeDb("isolation of the rules", () => {
  test("a failing rule is reported at the end of the tick and never stops the others", async () => {
    const assignee = await staff("OPERATOR");
    const id = await operatorCase({ slaMinutes: -5, priority: "P3", assignee });
    const w = worker(() => NOW, {
      rules: ["amlCases", "operatorCases"],
      audit: async (_tx, input) => {
        if (input.entityType === "AML_CASE") throw new Error("audit store unavailable");
        await (await import("../../engine/ledger/ledgerAlerts")).writeSystemAudit(client as never, input);
      },
    });
    const catalog = await catalogOf();
    const reviewer = await staff("COMPLIANCE");
    const aml = await client.amlCase.create({ data: { subjectType: "MERCHANT", subjectId: catalog.merchantId, triggerReason: "x", severity: "LOW", severityInputsJson: {}, status: "OPEN", slaDueAt: new Date(NOW.getTime() - 5 * MIN), assignedReviewerId: reviewer } });
    created.amlCases.push(aml.id);
    await expect(w.runOnce()).rejects.toThrow(/deadline rules failed \(amlCases: audit store unavailable\)/);
    expect(w.lastSummary?.failed).toEqual(["amlCases"]);
    expect((await client.operatorCase.findUniqueOrThrow({ where: { id } })).priority).toBe("P2"); // the other rule ran
    expect(await stages("AML_CASE", aml.id)).toEqual([]); // the failed rule rolled its claim back: it retries next tick
  });
});
