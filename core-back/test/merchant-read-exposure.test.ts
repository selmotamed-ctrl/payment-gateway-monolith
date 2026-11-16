import { describe, expect, test } from "bun:test";

/**
 * What the merchant read routes may return (2026-11-16 review).
 *
 * `GET /onboarding/join-request` returned the whole join request row, the reviewer's working record: the
 * decision notes ("…a confirmed watch list match" after a screening hit), the screening id, the duplicate
 * flags naming other merchants, the proposed risk tier, the four-eyes reasons, the review checklist, and each
 * KYB document's storage key, reviewer and review notes. `GET /onboarding/beneficial-owners` needed no
 * authority and returned the encrypted national id, its hash and the screening status. The POS reads needed
 * no authority, ignored the caller's application scope and returned each screen's token hash.
 *
 * The routes now SELECT an explicit list. These checks pin the lists (so a new internal column is not
 * exposed by default) and the guards.
 */
const source = (await Bun.file(new URL("../api/internal/merchant.ts", import.meta.url)).text()).split("\r\n").join("\n");

const block = (start: string, end = "\n} as const;"): string => {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  return source.slice(from, source.indexOf(end, from));
};
const routeBody = (signature: string): string => {
  const from = source.indexOf(signature);
  expect(from).toBeGreaterThan(-1);
  const next = source.indexOf("\nrouter.", from + signature.length);
  return source.slice(from, next === -1 ? undefined : next);
};
/** The top-level keys of an object literal `const X = { ... } as const;` (two-space indented). */
const keysOf = (literal: string): string[] =>
  [...literal.matchAll(/^ {2}([A-Za-z]+):/gm)].map((match) => match[1]!);

describe("the merchant's view of its join request", () => {
  const select = block("const MERCHANT_JOIN_REQUEST_SELECT = {");

  test("is an explicit allow-list", () => {
    expect(keysOf(select)).toEqual([
      "id", "createdAt", "updatedAt", "status", "onboardingChannel", "submittedAt", "decision",
      "decisionReasonCode", "infoRequestJson", "profileJson", "resubmissionOfId", "kybDocuments",
    ]);
  });

  test.each([
    "decisionNotes", "screeningId", "lastScreenedAt", "duplicateFlagsJson", "proposedRiskTier", "fourEyesRequired",
    "fourEyesReasons", "reviewChecklistJson", "assignedReviewerId", "slaDueAt", "approvalRequestId",
    // KYB document internals
    "storageKey", "storageObjectId", "sha256", "reviewNotes", "reviewedById", "duplicateJustification",
    "avEngine", "avSignature", "avLastError",
  ])("never selects %s", (field) => {
    expect(select).not.toMatch(new RegExp(`\\b${field}: true`));
  });

  test("the route selects through the allow-list and never includes whole relations", () => {
    const body = routeBody('router.get("/onboarding/join-request"');
    expect(body).toContain("select: MERCHANT_JOIN_REQUEST_SELECT");
    expect(body).not.toContain("include:");
  });
});

describe("the merchant's view of its beneficial owners", () => {
  const select = block("const MERCHANT_BENEFICIAL_OWNER_SELECT = {");

  test("needs an onboarding or merchant read authority", () => {
    const body = routeBody('router.get("/onboarding/beneficial-owners"');
    const guard = body.indexOf('assertMerchantAuthority(principalOf(request), ["onboarding:write", "merchant:read", "merchant:write"]);');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf("client.beneficialOwner.findMany("));
    expect(body).toContain("select: MERCHANT_BENEFICIAL_OWNER_SELECT");
  });

  test.each(["nationalIdCiphertext", "nationalIdHash", "screeningStatus"])("never selects %s", (field) => {
    expect(select).not.toContain(field);
  });
});

describe("POS terminals", () => {
  test("a screen's token hash never leaves core", () => {
    const select = block("const POS_SCREEN_SELECT = {");
    expect(keysOf(select)).toEqual(["id", "createdAt", "screenCode", "realtimeRoomId", "lastActiveAt"]);
    expect(source).not.toContain("include: { screens: true }");
  });

  test("the list needs a read authority and is narrowed to the caller's applications", () => {
    const body = routeBody('router.get("/pos/terminals",');
    expect(body).toContain("assertMerchantAuthority(principalOf(request), POS_READ_AUTHORITIES);");
    expect(body).toContain("withAppScope(request, { application: { merchantId }, ...built.where })");
    expect(source).toContain('const POS_READ_AUTHORITIES = ["pos:manage", "merchant:read", "merchant:write"];');
  });

  test("the detail needs a read authority and refuses a terminal of another application", () => {
    const body = routeBody('router.get("/pos/terminals/:id",');
    expect(body).toContain("assertMerchantAuthority(principalOf(request), POS_READ_AUTHORITIES);");
    expect(body).toContain("assertApplicationInScope(request, terminal.applicationId);");
  });

  test("creating, changing, pairing and streaming all check the application scope", () => {
    expect(routeBody('router.post("/pos/terminals",')).toContain("assertApplicationInScope(request, application.id);");
    expect(routeBody('router.patch("/pos/terminals/:id",')).toContain("await posTerminalInCallerScope(request, merchantId, id);");
    expect(routeBody('router.post("/pos/terminals/:id/screens",')).toContain("await posTerminalInCallerScope(request, merchantId, id);");
    expect(routeBody('router.get("/pos/screens/:screenCode/stream",')).toContain("assertApplicationInScope(request, screen.pos.applicationId);");
    const helper = block("const posTerminalInCallerScope = async (", "\n};");
    expect(helper).toContain("where: { id, application: { merchantId } }");
    expect(helper).toContain("assertApplicationInScope(request, terminal.applicationId);");
  });
});
