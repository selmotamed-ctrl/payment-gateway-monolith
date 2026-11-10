import { describe, expect, test } from "bun:test";
import { REPORT_ENGINE_BODY_PATH } from "../index";

describe("report-engine body parser path", () => {
  test("covers the staff and merchant report-engine prefixes", () => {
    expect(REPORT_ENGINE_BODY_PATH.test("/internal/admin/report-engine/specs/verify")).toBe(true);
    expect(REPORT_ENGINE_BODY_PATH.test("/internal/merchant/report-engine/studio/verify")).toBe(true);
    expect(REPORT_ENGINE_BODY_PATH.test("/internal/merchant/report-engine")).toBe(true);
    expect(REPORT_ENGINE_BODY_PATH.test("/internal/admin/report-engine")).toBe(true);
  });

  test("does not widen unrelated routes", () => {
    expect(REPORT_ENGINE_BODY_PATH.test("/internal/admin/merchants")).toBe(false);
    expect(REPORT_ENGINE_BODY_PATH.test("/internal/merchant/links")).toBe(false);
  });
});
