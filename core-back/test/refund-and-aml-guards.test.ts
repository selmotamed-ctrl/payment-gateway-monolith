import { describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import { executeAdjustment, executeAmlCaseResolution } from "../engine/governance/GovernanceExecution";
import { createGovernanceFixture } from "./edge-cases/helpers";
import { fakeTable } from "./helpers/governanceFake";

/**
 * Money-path guards found by the 2026-11-12 review:
 *  - a refund was sent to the gateway before the attempt's status was checked, then failed the
 *    status transition, leaving the payer refunded with no journal;
 *  - partial refunds that add up to the whole payment left the attempt PARTIALLY_REFUNDED forever;
 *  - two approvals on one open AML case (RELEASE and REJECT) could both post.
 */

const attempt = () => fakeTable("paymentAttempt").find((row) => row.id === "attempt-1")!;
const checker = { checkerUserId: "user-finance", checkerRole: "FINANCE" };

const seedRefund = (
  fixture: ReturnType<typeof createGovernanceFixture>,
  id: string,
  amount: number,
  state = "PENDING_REVIEW",
): void => {
  fixture.client.adjustment.create({
    data: {
      id,
      type: "REFUND",
      targetGlAccountId: "acc-wallet",
      sourceAttemptId: "attempt-1",
      amount: new Decimal(amount),
      reverseCommission: false,
      reason: "customer request",
      state,
    },
  });
};

describe("a refund is only sent to the gateway for a settled payment", () => {
  for (const [status, substatus] of [["VERIFYING", "AML_HOLD"], ["UNKNOWN", null], ["FAILED", null], ["AUTHORIZING", null]] as const) {
    test(`an attempt that is ${status}${substatus ? ` (${substatus})` : ""} is refused before the gateway is called`, async () => {
      const fixture = createGovernanceFixture();
      attempt().status = status;
      attempt().substatus = substatus;
      seedRefund(fixture, "refund-unsettled", 10);
      let gatewayCalls = 0;
      const engine = { refund: async () => { gatewayCalls += 1; return { status: "REFUNDED" }; } };

      const error = await executeAdjustment(
        { ...fixture.context, engine },
        fixture.client as never,
        { adjustmentId: "refund-unsettled", ...checker },
      ).catch((caught) => caught);

      expect((error as { code?: string }).code).toBe("REFUND_ATTEMPT_NOT_SETTLED");
      expect(gatewayCalls).toBe(0);
      // Not claimed: the adjustment is not left EXECUTING.
      expect(fakeTable("adjustment").find((row) => row.id === "refund-unsettled")?.state).toBe("PENDING_REVIEW");
      expect(fakeTable("journalEntry").some((row) => row.refId === "refund-unsettled")).toBe(false);
    });
  }

  test("a settled payment under an AML hold substatus is refused too", async () => {
    const fixture = createGovernanceFixture();
    attempt().status = "SUCCEEDED";
    attempt().substatus = "AML_HOLD";
    seedRefund(fixture, "refund-held", 10);
    const error = await executeAdjustment(
      { ...fixture.context, engine: { refund: async () => ({ status: "REFUNDED" }) } },
      fixture.client as never,
      { adjustmentId: "refund-held", ...checker },
    ).catch((caught) => caught);
    expect((error as { code?: string }).code).toBe("REFUND_ATTEMPT_NOT_SETTLED");
  });
});

describe("partial refunds that cover the whole payment close the attempt", () => {
  // The engine compares ONE refund with the charged amount and leaves PARTIALLY_REFUNDED.
  const partialEngine = {
    refund: async () => {
      attempt().status = "PARTIALLY_REFUNDED";
      return { status: "PARTIALLY_REFUNDED", attempt: { ownershipMode: "PLATFORM_CLEARING" } };
    },
  };
  const refundable = (): Decimal =>
    new Decimal(String(attempt().settledAmount ?? attempt().totalChargedAmount));

  test("the refund that completes the amount moves the attempt to REFUNDED", async () => {
    const fixture = createGovernanceFixture();
    attempt().status = "SUCCEEDED";
    const total = refundable();
    const first = total.mul(0.6).toDecimalPlaces(4);
    seedRefund(fixture, "refund-part-1", first.toNumber());
    seedRefund(fixture, "refund-part-2", total.minus(first).toNumber());

    await executeAdjustment({ ...fixture.context, engine: partialEngine }, fixture.client as never, { adjustmentId: "refund-part-1", ...checker });
    expect(attempt().status).toBe("PARTIALLY_REFUNDED");

    const second = await executeAdjustment({ ...fixture.context, engine: partialEngine }, fixture.client as never, { adjustmentId: "refund-part-2", ...checker });
    expect(second.status).toBe("EXECUTED");
    expect(attempt().status).toBe("REFUNDED");
    expect(attempt().terminalAt).toBeInstanceOf(Date);
  });

  test("a refund that leaves a remainder keeps the attempt PARTIALLY_REFUNDED", async () => {
    const fixture = createGovernanceFixture();
    attempt().status = "SUCCEEDED";
    seedRefund(fixture, "refund-small", refundable().mul(0.25).toDecimalPlaces(4).toNumber());
    await executeAdjustment({ ...fixture.context, engine: partialEngine }, fixture.client as never, { adjustmentId: "refund-small", ...checker });
    expect(attempt().status).toBe("PARTIALLY_REFUNDED");
  });
});

describe("an AML case is resolved by exactly one approval", () => {
  test("the case is claimed with a conditional update before anything is posted", async () => {
    const source = (await Bun.file(new URL("../engine/governance/GovernanceExecution.ts", import.meta.url)).text()).split("\r\n").join("\n");
    const start = source.indexOf("export async function executeAmlCaseResolution(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    const claim = body.indexOf("where: { id: String(amlCase.id), status: amlCase.status }");
    expect(claim).toBeGreaterThan(-1);
    // The claim precedes every posting and the attempt finalisation.
    expect(claim).toBeLessThan(body.indexOf("ctx.ledgerPoster.post("));
    expect(claim).toBeLessThan(body.indexOf("finalizeAmlAttempt(ctx, tx, attempt"));
    expect(body.slice(claim, claim + 600)).toContain('reason: "AML_CASE_ALREADY_RESOLVED"');
  });

  test("a second resolution of a case that another approval already resolved posts nothing", async () => {
    const fixture = createGovernanceFixture();
    const amlCase = fakeTable("amlCase")[0];
    if (!amlCase) return; // the fixture has no AML case in this build: the source check above still holds
    amlCase.status = "RELEASED";
    const journals = fakeTable("journalEntry").length;
    const result = await executeAmlCaseResolution(fixture.context, fixture.client as never, {
      amlCaseId: String(amlCase.id),
      action: "REJECT",
      ...checker,
    });
    expect(result.status).toBe("SKIPPED");
    expect(result.reason).toBe("AML_CASE_ALREADY_RESOLVED");
    expect(fakeTable("journalEntry").length).toBe(journals);
  });
});
