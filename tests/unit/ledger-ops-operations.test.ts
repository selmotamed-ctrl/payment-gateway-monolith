import { describe, expect, test } from "vitest";
import { footerActionsFor, buildRetryGroupView, outcomeGroupOf } from "../../admin-front/src/pages/transactions/lifecycle";
import { flattenPayload, formatDuration, httpStatusTone, parseTextPayload, sectionsOfRequest } from "../../admin-front/src/pages/transactions/payloadRows";
import {
  availableActions,
  credentialStatusTone,
  defaultSettlementFor,
  draftsFromDetail,
  emptyCreateDraft,
  expiryState,
  highlightIdFromQuery,
  newEntry,
  toCreatePayload,
  toEntriesPayload,
  validateCreateDraft,
  validateEntries,
} from "../../admin-front/src/pages/credential-sets/model";
import {
  ageSecondsSince,
  attemptsLabel,
  backlogTone,
  canRequeueJob,
  canRetryNotification,
  formatAge,
  jobStateTone,
  normalizeTab,
  truncateError,
} from "../../admin-front/src/pages/system/jobs-outbox/model";
import {
  buildLatencySeries,
  buildSuccessRateSeries,
  buildVolumeSeries,
  formatMs,
  formatPercent,
  successRateOf,
  successRateTone,
  type HealthSample,
} from "../../admin-front/src/pages/gateways/healthModel";

describe("attempt lifecycle drawer", () => {
  const caps = { canInquire: true, canAdjust: true, canDispute: true };

  test("footer actions depend on status and authority", () => {
    expect(footerActionsFor({ status: "UNKNOWN", ...caps })).toEqual(["inquire"]);
    expect(footerActionsFor({ status: "VERIFYING", ...caps })).toEqual(["inquire"]);
    expect(footerActionsFor({ status: "SUCCEEDED", ...caps })).toEqual(["adjustment", "dispute"]);
    expect(footerActionsFor({ status: "FAILED", ...caps })).toEqual([]);
    expect(footerActionsFor({ status: "UNKNOWN", ...caps, canInquire: false })).toEqual([]);
    expect(footerActionsFor({ status: "SUCCEEDED", ...caps, canAdjust: false })).toEqual(["dispute"]);
  });

  test("an explicit inquiryEligible=false hides the inquiry action only", () => {
    expect(footerActionsFor({ status: "UNKNOWN", ...caps, inquiryEligible: false })).toEqual([]);
    expect(footerActionsFor({ status: "UNKNOWN", ...caps, inquiryEligible: null })).toEqual(["inquire"]);
  });

  test("outcome groups mirror the summary endpoint", () => {
    expect(outcomeGroupOf("SUCCEEDED")).toBe("settled");
    expect(outcomeGroupOf("AUTHORIZING")).toBe("inFlight");
    expect(outcomeGroupOf("EXPIRED")).toBe("failed");
    expect(outcomeGroupOf("REFUNDED")).toBe("other");
    expect(outcomeGroupOf(null)).toBe("other");
  });

  test("the retry group reads oldest first and detects recovery after a failure", () => {
    const view = buildRetryGroupView(
      [
        { id: "c", status: "SUCCEEDED", createdAt: "2026-01-01T10:05:00Z" },
        { id: "a", status: "FAILED", createdAt: "2026-01-01T10:00:00Z" },
        { id: "b", status: "FAILED", createdAt: "2026-01-01T10:02:00Z" },
      ],
      "c",
    );
    expect(view.attempts.map((attempt) => attempt.id)).toEqual(["a", "b", "c"]);
    expect(view).toMatchObject({ siblings: 2, anySucceeded: true, recoveredAfterFailure: true, currentIndex: 2 });
    const single = buildRetryGroupView([{ id: "x", status: "SUCCEEDED", createdAt: "2026-01-01T10:00:00Z" }], "x");
    expect(single).toMatchObject({ siblings: 0, recoveredAfterFailure: false });
  });
});

describe("payload rows (no raw JSON in the UI)", () => {
  test("nested objects become dotted rows and redacted values are flagged", () => {
    const { rows, truncated } = flattenPayload({ customer: { phone: "[REDACTED]", name: "Ali" }, items: [{ sku: "A1" }], empty: {} });
    expect(truncated).toBe(0);
    expect(rows.map((row) => row.path)).toEqual(["customer.phone", "customer.name", "items[0].sku", "empty"]);
    expect(rows[0]).toMatchObject({ label: "phone", parent: "customer", redacted: true, value: "" });
    expect(rows[1]).toMatchObject({ value: "Ali", redacted: false });
    expect(rows[3]?.value).toBe("{}");
  });

  test("the row cap is enforced and counted", () => {
    const big = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`k${index}`, index]));
    const result = flattenPayload(big, { maxRows: 4 });
    expect(result.rows).toHaveLength(4);
    expect(result.truncated).toBe(6);
  });

  test("a request is split into summary, headers, query and body sections", () => {
    const sections = sectionsOfRequest({ method: "POST", url: "/pay", headers: { Authorization: "[REDACTED]" }, query: { a: "1" }, body: { amount: "5.0000" } });
    expect(sections.map((section) => section.id)).toEqual(["summary", "headers", "query", "body"]);
    expect(sections[1]?.rows[0]).toMatchObject({ label: "Authorization", redacted: true });
  });

  test("response text becomes rows for JSON and form bodies, plain text otherwise", () => {
    const json = parseTextPayload('{"status":"OK","data":{"id":"7"}}');
    expect(json.kind).toBe("fields");
    if (json.kind === "fields") expect(json.rows.map((row) => row.path)).toEqual(["status", "data.id"]);
    const form = parseTextPayload("a=1&b=2");
    expect(form.kind).toBe("fields");
    const text = parseTextPayload("upstream timeout");
    expect(text).toMatchObject({ kind: "text", text: "upstream timeout", truncated: false });
    const cut = parseTextPayload('{"status":"O');
    expect(cut.kind).toBe("text");
    expect(parseTextPayload("").kind).toBe("fields");
  });

  test("http status tone and duration formatting", () => {
    expect(httpStatusTone(200)).toBe("success");
    expect(httpStatusTone(302)).toBe("warning");
    expect(httpStatusTone(429)).toBe("warning");
    expect(httpStatusTone(500)).toBe("danger");
    expect(httpStatusTone(null)).toBe("neutral");
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(1500)).toBe("1.50 s");
    expect(formatDuration(25_000)).toBe("25.0 s");
    expect(formatDuration(undefined)).toBe("—");
  });
});

describe("credential set vault model", () => {
  const entry = (key: string, value: string, overrides: Record<string, unknown> = {}) => newEntry({ key, value, ...overrides });

  test("every value must be typed again and keys are unique per type", () => {
    const first = entry("apiKey", "s3cret");
    const dupe = entry("APIKEY", "x");
    const sameKeyOtherType = entry("apiKey", "y", { type: "QUERY" });
    const empty = entry("token", "");
    const noKey = entry("  ", "z");
    const result = validateEntries([first, dupe, sameKeyOtherType, empty, noKey]);
    expect(result.ok).toBe(false);
    expect(result.errors[first.uid]).toBeUndefined();
    expect(result.errors[dupe.uid]).toBe("KEY_DUPLICATE");
    expect(result.errors[sameKeyOtherType.uid]).toBeUndefined();
    expect(result.errors[empty.uid]).toBe("VALUE_REQUIRED");
    expect(result.errors[noKey.uid]).toBe("KEY_REQUIRED");
  });

  test("an empty list and an oversized list are rejected", () => {
    expect(validateEntries([])).toMatchObject({ ok: false, empty: true });
    const many = Array.from({ length: 41 }, (_, index) => entry(`k${index}`, "v"));
    expect(validateEntries(many)).toMatchObject({ ok: false, tooMany: true });
    expect(validateEntries([entry("k", "v")]).ok).toBe(true);
  });

  test("a rotation draft keeps keys, types and secret flags but never a value", () => {
    const drafts = draftsFromDetail([
      { key: "apiKey", type: "HEADER", isSecret: true },
      { key: "region", type: "WEIRD", isSecret: false },
    ]);
    expect(drafts.map((draft) => [draft.key, draft.type, draft.isSecret, draft.value])).toEqual([
      ["apiKey", "HEADER", true, ""],
      ["region", "HEADER", false, ""],
    ]);
    expect(draftsFromDetail(null)).toEqual([]);
  });

  test("the create payload omits optional fields instead of sending them empty", () => {
    const draft = { ...emptyCreateDraft(), gatewayCode: " almadar ", externalMerchantId: "  " };
    const payload = toCreatePayload(draft, [entry(" apiKey ", "v")]);
    expect(payload).toEqual({
      gatewayCode: "almadar",
      env: "SANDBOX",
      ownerType: "PLATFORM",
      settlementTarget: "PLATFORM_CLEARING",
      entries: [{ key: "apiKey", type: "HEADER", value: "v", isSecret: true }],
    });
    const merchant = toCreatePayload({ ...draft, ownerType: "MERCHANT", ownerMerchantId: " m-1 ", externalMerchantId: "EXT-9" }, [entry("k", "v")]);
    expect(merchant).toMatchObject({ ownerMerchantId: "m-1", externalMerchantId: "EXT-9" });
    expect(toEntriesPayload([entry("k", "v", { isSecret: false })])[0]).toEqual({ key: "k", type: "HEADER", value: "v", isSecret: false });
  });

  test("create draft validation", () => {
    expect(validateCreateDraft(emptyCreateDraft())).toEqual(["GATEWAY_REQUIRED"]);
    expect(validateCreateDraft({ ...emptyCreateDraft(), gatewayCode: "g", ownerType: "MERCHANT" })).toEqual(["OWNER_MERCHANT_REQUIRED"]);
    expect(validateCreateDraft({ ...emptyCreateDraft(), gatewayCode: "g", externalMerchantId: "x" })).toEqual(["EXTERNAL_ID_LENGTH"]);
    expect(validateCreateDraft({ ...emptyCreateDraft(), gatewayCode: "g" })).toEqual([]);
    expect(defaultSettlementFor("MERCHANT")).toBe("MERCHANT_DIRECT");
    expect(defaultSettlementFor("PLATFORM")).toBe("PLATFORM_CLEARING");
  });

  test("a revoked set is terminal and read-only users get no actions", () => {
    expect(availableActions("VERIFIED", true)).toEqual(["verify", "rotate", "revoke"]);
    expect(availableActions("REVOKED", true)).toEqual([]);
    expect(availableActions("UNTESTED", false)).toEqual([]);
  });

  test("expiry warns inside 14 days and flags the past", () => {
    const now = Date.parse("2026-06-01T00:00:00Z");
    expect(expiryState(null, now)).toBe("none");
    expect(expiryState("garbage", now)).toBe("none");
    expect(expiryState("2026-05-31T00:00:00Z", now)).toBe("expired");
    expect(expiryState("2026-06-10T00:00:00Z", now)).toBe("soon");
    expect(expiryState("2026-09-01T00:00:00Z", now)).toBe("ok");
  });

  test("status tones and the highlight query", () => {
    expect(credentialStatusTone("VERIFIED")).toBe("success");
    expect(credentialStatusTone("FAILING")).toBe("danger");
    expect(credentialStatusTone("UNTESTED")).toBe("warning");
    expect(credentialStatusTone("REVOKED")).toBe("neutral");
    expect(highlightIdFromQuery("abc")).toBe("abc");
    expect(highlightIdFromQuery(["abc", "def"])).toBe("abc");
    expect(highlightIdFromQuery("  ")).toBeNull();
    expect(highlightIdFromQuery(undefined)).toBeNull();
  });
});

describe("jobs and outbox monitor model", () => {
  test("ages are compact and tolerate bad input", () => {
    expect(formatAge(45)).toBe("45s");
    expect(formatAge(125)).toBe("2m");
    expect(formatAge(2 * 3600 + 5 * 60)).toBe("2h 05m");
    expect(formatAge(3 * 86_400 + 4 * 3600)).toBe("3d 4h");
    expect(formatAge(null)).toBe("—");
    expect(formatAge(-1)).toBe("—");
    expect(ageSecondsSince("2026-01-01T00:01:00Z", Date.parse("2026-01-01T00:03:00Z"))).toBe(120);
    expect(ageSecondsSince("nope")).toBeNull();
  });

  test("a backlog is calm, then watched, then urgent", () => {
    expect(backlogTone(0, 9999)).toBe("success");
    expect(backlogTone(3, null)).toBe("warning");
    expect(backlogTone(3, 30)).toBe("info");
    expect(backlogTone(3, 120)).toBe("warning");
    expect(backlogTone(3, 16 * 60)).toBe("danger");
  });

  test("only failed rows can be acted on, and only with write authority", () => {
    expect(canRequeueJob("FAILED", true)).toBe(true);
    expect(canRequeueJob("FAILED", false)).toBe(false);
    expect(canRequeueJob("QUEUED", true)).toBe(false);
    expect(canRetryNotification("FAILED", true)).toBe(true);
    expect(canRetryNotification("SENT", true)).toBe(false);
    expect(jobStateTone("FAILED")).toBe("danger");
    expect(jobStateTone("SUCCEEDED")).toBe("success");
    expect(jobStateTone("???")).toBe("neutral");
    expect(attemptsLabel(2, 5)).toBe("2 / 5");
  });

  test("tab and error text normalisation", () => {
    expect(normalizeTab("jobs")).toBe("jobs");
    expect(normalizeTab("bogus")).toBe("outbox");
    expect(normalizeTab(undefined)).toBe("outbox");
    expect(truncateError("a\n  b   c")).toBe("a b c");
    expect(truncateError("x".repeat(200)).length).toBe(140);
    expect(truncateError(null)).toBe("");
  });
});

describe("gateway health model", () => {
  const sample = (overrides: Partial<HealthSample> = {}): HealthSample => ({
    windowStart: "2026-01-01T00:00:00.000Z",
    successes: 8,
    definitiveFailures: 1,
    ambiguousUnknowns: 1,
    rateLimits429: 0,
    p50Ms: 100,
    p95Ms: 300,
    p99Ms: null,
    successRate: null,
    ...overrides,
  });

  test("success rate counts failures and unknowns, and is null without traffic", () => {
    expect(successRateOf(sample())).toBe(0.8);
    expect(successRateOf(sample({ successes: 0, definitiveFailures: 0, ambiguousUnknowns: 0 }))).toBeNull();
  });

  test("series keep gaps as null so the line breaks", () => {
    const series = buildSuccessRateSeries([sample(), sample({ successes: 0, definitiveFailures: 0, ambiguousUnknowns: 0 }), sample({ successRate: 0.5 })]);
    expect(series.map((point) => point[1])).toEqual([80, null, 50]);
    expect(buildLatencySeries([sample()], "p99Ms")[0]?.[1]).toBeNull();
    expect(buildLatencySeries([sample()], "p95Ms")[0]?.[1]).toBe(300);
  });

  test("the volume axis is dense and sums per day across currencies", () => {
    const series = buildVolumeSeries([
      { day: "2026-01-01", currency: "LYD", attemptCount: 3, successCount: 2, volumeAmount: "10.5000" },
      { day: "2026-01-03", currency: "LYD", attemptCount: 1, successCount: 1, volumeAmount: "4.0000" },
      { day: "2026-01-03", currency: "USD", attemptCount: 2, successCount: 1, volumeAmount: "2.0000" },
    ]);
    expect(series.days).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    expect(series.currencies).toEqual(["LYD", "USD"]);
    expect(series.amountByCurrency.LYD).toEqual([10.5, 0, 4]);
    expect(series.amountByCurrency.USD).toEqual([0, 0, 2]);
    expect(series.attempts).toEqual([3, 0, 3]);
    expect(series.totalAttempts).toBe(6);
    expect(series.totalSuccesses).toBe(4);
    expect(buildVolumeSeries([]).days).toEqual([]);
  });

  test("tones and formatting", () => {
    expect(successRateTone(0.995)).toBe("success");
    expect(successRateTone(0.96)).toBe("warning");
    expect(successRateTone(0.5)).toBe("danger");
    expect(successRateTone(null)).toBe("neutral");
    expect(formatPercent(0.5)).toBe("50%");
    expect(formatPercent(null)).toBe("—");
    expect(formatMs(123.4)).toBe("123 ms");
    expect(formatMs(undefined)).toBe("—");
  });
});
