import { describe, expect, test } from "bun:test";

/**
 * A merchant user can be restricted to some applications (`app_scope_ids`), and every dispute route narrows
 * the dispute by that scope. The dispute attachment routes arrived from another branch (2026-11-16 merge)
 * with the merchant check only on three of the four: a restricted user could list, download and delete the
 * evidence files of a dispute in an application they cannot see. These checks pin the rule on each route.
 */
const source = (await Bun.file(new URL("../api/internal/merchant.ts", import.meta.url)).text()).split("\r\n").join("\n");

const routeBody = (signature: string): string => {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf("\nrouter.", start + signature.length);
  return source.slice(start, next === -1 ? undefined : next);
};

describe("dispute attachment routes honour the caller's application scope", () => {
  test("the shared lookup narrows the dispute by merchant and by application scope, and answers 404", () => {
    const start = source.indexOf("const disputeInCallerScope = async (");
    expect(start).toBeGreaterThan(-1);
    const helper = source.slice(start, source.indexOf("\n};", start));
    expect(helper).toContain("const scope = appScopeOf(request);");
    expect(helper).toContain("attempt: { merchantId, ...(scope ? { applicationId: { in: [...scope] } } : {}) }");
    expect(helper).toContain('throw new ApiError(404, "DISPUTE_NOT_FOUND"');
  });

  test.each([
    ['router.get("/disputes/:id/attachments",', "client.disputeAttachment.findMany("],
    ['router.get("/disputes/:id/attachments/:attachmentId/content",', "client.disputeAttachment.findFirst("],
    ['router.delete("/disputes/:id/attachments/:attachmentId",', "client.disputeAttachment.findFirst("],
  ])("%s checks the dispute before it reads an attachment", (signature, firstRead) => {
    const body = routeBody(signature);
    const check = body.indexOf("await disputeInCallerScope(request, merchantId, id);");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(body.indexOf(firstRead));
    // Never the merchant-only lookup these routes arrived with.
    expect(body).not.toContain("where: { id, attempt: { merchantId } }");
  });

  test("the upload route narrows the dispute by application scope before it stores anything", () => {
    const body = routeBody('router.post("/disputes/:id/attachments",');
    const check = body.indexOf("applicationId: { in: [...appScopeOf(request)!] }");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(body.indexOf("UPLOAD_REQUIRED"));
  });
});
