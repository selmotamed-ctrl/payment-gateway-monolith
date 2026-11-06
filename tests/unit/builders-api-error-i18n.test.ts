import { describe, expect, test } from "vitest";
import { detailList, readApiErrorInfo } from "@/components/builders/model/apiError";
import { buildersCatalogue } from "@/constants/i18n/builders";
import { appCatalogue } from "@/constants/i18nCatalogue";
import {
  AML_PARAM_ERROR_MESSAGES,
  COST_ERROR_MESSAGES,
  LOGO_ERROR_MESSAGES,
  MISMATCH_ERROR_MESSAGE,
  PARSER_ERROR_MESSAGES,
  SCOPE_ERROR_MESSAGES,
  SETTING_ERROR_MESSAGES,
  WINDOW_ERROR_MESSAGES,
} from "@/components/builders/messages";
import { AML_PARAM_FIELDS } from "@/components/builders/model/amlRules";
import { knownSettingKeys, resolveSettingNamespace } from "@/components/builders/model/settingsSchemas";

describe("readApiErrorInfo", () => {
  test("reads the template placeholder error of the API (422 with details)", () => {
    const error = {
      response: {
        status: 422,
        data: { code: "TEMPLATE_UNKNOWN_PLACEHOLDERS", message: "unknown", details: { unknown: ["x"], allowed: ["a", "b"] } },
      },
    };
    const info = readApiErrorInfo(error);
    expect(info.status).toBe(422);
    expect(info.code).toBe("TEMPLATE_UNKNOWN_PLACEHOLDERS");
    expect(detailList(info.details, "unknown")).toEqual(["x"]);
    expect(detailList(info.details, "allowed")).toEqual(["a", "b"]);
  });

  test("reads an envelope wrapped in `error` and tolerates garbage", () => {
    expect(readApiErrorInfo({ response: { status: 409, data: { error: { code: "TEMPLATE_UNCHANGED", message: "same" } } } }).code).toBe("TEMPLATE_UNCHANGED");
    expect(readApiErrorInfo(null)).toEqual({ status: 0, code: "", message: "", details: null });
    expect(readApiErrorInfo({ response: { status: 500, data: "boom" } }).code).toBe("");
    expect(detailList(null, "unknown")).toEqual([]);
  });
});

describe("builders catalogue", () => {
  const has = (key: string) => key in buildersCatalogue || key in appCatalogue;
  const messageMaps: Record<string, string>[] = [
    COST_ERROR_MESSAGES,
    SCOPE_ERROR_MESSAGES,
    WINDOW_ERROR_MESSAGES,
    PARSER_ERROR_MESSAGES,
    AML_PARAM_ERROR_MESSAGES,
    SETTING_ERROR_MESSAGES,
    LOGO_ERROR_MESSAGES,
  ];

  test("every validation message has an English and an Arabic entry", () => {
    const messages = [MISMATCH_ERROR_MESSAGE, ...messageMaps.flatMap((map) => Object.values(map))];
    for (const message of messages) expect(has(message), message).toBe(true);
  });

  test("every setting namespace and AML parameter label is translated", () => {
    const labels: string[] = [];
    for (const key of knownSettingKeys()) {
      const def = resolveSettingNamespace(key)!;
      labels.push(def.title, def.description);
      for (const field of def.fields) labels.push(field.label, ...(field.hint ? [field.hint] : []));
    }
    for (const fields of Object.values(AML_PARAM_FIELDS)) for (const field of fields) labels.push(field.label, ...(field.hint ? [field.hint] : []));
    for (const label of labels) expect(has(label), label).toBe(true);
  });

  test("entries have a distinct Arabic text for non-technical strings", () => {
    for (const [key, [english, arabic]] of Object.entries(buildersCatalogue)) {
      expect(english, key).toBe(key);
      expect(arabic.trim().length, key).toBeGreaterThan(0);
      if (/[A-Za-z]{4,}/.test(english) && !["Subject", "Public", "Internal", "Merchant", "Standard", "Mode", "Number", "Group", "List"].includes(key) && english.includes(" ")) {
        expect(arabic, key).not.toBe(english);
      }
    }
  });
});
