import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AttemptGuardPipeline } from "../../engine/guards/AttemptGuardPipeline";
import { CachedScreeningProvider, InternalWatchlistProvider } from "../../engine/guards/ScreeningProvider";
import {
  assertApplicationActive,
  assertCommerceActive,
  assertPosTerminalActive,
  assertWalletActive,
} from "../../lib/commerceStatus";
import { approvalDomain, approvalSubjectTypeVariants, normalizeApprovalSubjectType } from "../../lib/approvalQueue";
import { createGuardFixture, type GuardFixture } from "../helpers/guardsFake";

const NOW = new Date("2026-03-01T12:00:00.000Z");

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const pipelineFor = (fixture: GuardFixture, status: { applicationStatus: string | null; walletStatus: string | null }) => {
  (fixture.repositories.payments as { findLinkCommerceStatus?: unknown }).findLinkCommerceStatus = async () => status;
  return new AttemptGuardPipeline({
    db: fixture.db,
    repositories: fixture.repositories,
    screening: new CachedScreeningProvider(new InternalWatchlistProvider()),
    clock: () => NOW,
  });
};

const guardRequest = (env: "LIVE" | "SANDBOX") => ({
  linkKey: "link-key-1",
  railCode: "edfali",
  applicationId: "application-1",
  merchantId: "merchant-1",
  env,
  channel: "WEB" as const,
  mode: "OTP_PULL",
  idempotencyKey: "idem-0001",
});

describe("commerce status gates (a freeze that does not freeze is a bug)", () => {
  test("LIVE traffic needs an ACTIVE application and an ACTIVE wallet", () => {
    expect(codeOf(() => assertApplicationActive("ACTIVE"))).toBeUndefined();
    for (const status of ["SUSPENDED", "PENDING", "DRAFT", "CLOSED", null]) {
      expect(codeOf(() => assertApplicationActive(status))).toBe("APPLICATION_NOT_ACTIVE");
    }
    expect(codeOf(() => assertWalletActive("ACTIVE"))).toBeUndefined();
    for (const status of ["FROZEN", "PENDING", "CLOSED", null]) {
      expect(codeOf(() => assertWalletActive(status))).toBe("WALLET_NOT_ACTIVE");
    }
    for (const status of ["INACTIVE", "BLOCKED", null]) {
      expect(codeOf(() => assertPosTerminalActive(status))).toBe("POS_TERMINAL_NOT_ACTIVE");
    }
    expect(codeOf(() => assertPosTerminalActive("ACTIVE"))).toBeUndefined();
  });

  test("the application check wins over the wallet check", () => {
    expect(codeOf(() => assertCommerceActive({ applicationStatus: "SUSPENDED", walletStatus: "FROZEN" }))).toBe("APPLICATION_NOT_ACTIVE");
    expect(codeOf(() => assertCommerceActive({ applicationStatus: "ACTIVE", walletStatus: "FROZEN" }))).toBe("WALLET_NOT_ACTIVE");
  });

  test("SANDBOX traffic of a not yet approved merchant (PENDING rows) still runs, a suspension/freeze never does", () => {
    expect(codeOf(() => assertCommerceActive({ applicationStatus: "PENDING", walletStatus: "PENDING", env: "SANDBOX" }))).toBeUndefined();
    expect(codeOf(() => assertCommerceActive({ applicationStatus: "SUSPENDED", walletStatus: "ACTIVE", env: "SANDBOX" }))).toBe("APPLICATION_NOT_ACTIVE");
    expect(codeOf(() => assertCommerceActive({ applicationStatus: "ACTIVE", walletStatus: "FROZEN", env: "SANDBOX" }))).toBe("WALLET_NOT_ACTIVE");
    expect(codeOf(() => assertCommerceActive({ applicationStatus: "CLOSED", walletStatus: "ACTIVE", env: "SANDBOX" }))).toBe("APPLICATION_NOT_ACTIVE");
  });
});

describe("the attempt-creation guard is the central choke point", () => {
  test("a suspended application creates no attempt and reserves no slot", async () => {
    const fixture = createGuardFixture();
    const pipeline = pipelineFor(fixture, { applicationStatus: "SUSPENDED", walletStatus: "ACTIVE" });
    await expect(pipeline.guard(guardRequest("LIVE"))).rejects.toMatchObject({ code: "APPLICATION_NOT_ACTIVE", statusCode: 409 });
    expect(fixture.state.attempts).toHaveLength(0);
    expect(fixture.state.slotDeltas).toHaveLength(0);
  });

  test("a frozen wallet creates no attempt and reserves no slot", async () => {
    const fixture = createGuardFixture();
    const pipeline = pipelineFor(fixture, { applicationStatus: "ACTIVE", walletStatus: "FROZEN" });
    await expect(pipeline.guard(guardRequest("LIVE"))).rejects.toMatchObject({ code: "WALLET_NOT_ACTIVE", statusCode: 409 });
    expect(fixture.state.attempts).toHaveLength(0);
    expect(fixture.state.slotDeltas).toHaveLength(0);
  });

  test("a LIVE request on a PENDING application is refused, the sandbox one is allowed", async () => {
    const live = createGuardFixture();
    await expect(
      pipelineFor(live, { applicationStatus: "PENDING", walletStatus: "PENDING" }).guard(guardRequest("LIVE")),
    ).rejects.toMatchObject({ code: "APPLICATION_NOT_ACTIVE" });
    const sandbox = createGuardFixture();
    const decision = await pipelineFor(sandbox, { applicationStatus: "PENDING", walletStatus: "PENDING" }).guard(guardRequest("SANDBOX"));
    expect(decision.outcome).not.toBe("BLOCK");
    expect(decision.attemptId).toBeTruthy();
  });

  test("control: an active application and wallet pass", async () => {
    const fixture = createGuardFixture();
    const decision = await pipelineFor(fixture, { applicationStatus: "ACTIVE", walletStatus: "ACTIVE" }).guard(guardRequest("SANDBOX"));
    expect(decision.attemptId).toBeTruthy();
  });
});

describe("governance subject types", () => {
  test("WALLET, APPLICATION and POS_TERMINAL are MERCHANT-domain subjects", () => {
    for (const type of ["WALLET", "APPLICATION", "POS_TERMINAL"]) {
      expect(approvalDomain(type)).toBe("MERCHANT");
    }
    expect(normalizeApprovalSubjectType("PosTerminal")).toBe("POS_TERMINAL");
    expect(normalizeApprovalSubjectType("pos-terminal")).toBe("POS_TERMINAL");
    expect(approvalSubjectTypeVariants("PosTerminal")).toEqual(expect.arrayContaining(["POS_TERMINAL", "PosTerminal"]));
  });
});

describe("every payment intake path is wired to the status gates", () => {
  const checkout = readFileSync("api/internal/checkout.ts", "utf8");
  const merchant = readFileSync("api/internal/merchant.ts", "utf8");
  const guard = readFileSync("engine/guards/AttemptGuardPipeline.ts", "utf8");

  test("checkout initiate and confirm, the guard, link creation and the POS screen paths call the gates", () => {
    // checkout: ensureLinkUsable (initiate) and the confirm step
    expect(checkout.slice(checkout.indexOf("const ensureLinkUsable"), checkout.indexOf("const NON_CANCELLABLE_STATUSES"))).toContain("assertCommerceActive");
    const confirm = checkout.slice(checkout.indexOf('"/pay/:linkKey/logs/:attemptId/confirm"'), checkout.indexOf('"/pay/:linkKey/logs/:attemptId/resend"'));
    expect(confirm).toContain("assertCommerceActive");
    // the single attempt-creation choke point
    expect(guard).toContain("assertCommerceActive");
    // merchant/API link creation
    const createLink = merchant.slice(merchant.indexOf("const createLink = async"), merchant.indexOf('router.get("/links"'));
    expect(createLink).toContain("assertCommerceActive");
    // POS: stream authentication and screen issuing
    const stream = merchant.slice(merchant.indexOf('"/pos/screens/:screenCode/stream"'), merchant.indexOf('router.get("/stats/overview"'));
    expect(stream).toContain("assertPosTerminalActive");
    const screens = merchant.slice(merchant.indexOf('"/pos/terminals/:id/screens"'), merchant.indexOf('"/pos/screens/:screenCode/stream"'));
    expect(screens).toContain("assertPosTerminalActive");
  });

  test("payment attempts are only created through the guard (no other intake writes an attempt)", () => {
    for (const file of ["api/internal/checkout.ts", "api/internal/merchant.ts", "api/internal/admin.ts"]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/paymentAttempt\.create\(/);
    }
  });
});
