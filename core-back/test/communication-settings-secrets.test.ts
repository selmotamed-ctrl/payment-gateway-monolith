import { describe, expect, test } from "bun:test";
import {
  extractSettingSecrets,
  listPlatformSettingsForApi,
  redactSettingSecretsForExport,
  SECRET_MASK,
} from "../lib/communication/settingsWrite";

describe("platform setting secrets", () => {
  test("extracts a new secret without leaving it in valueJson", () => {
    const extracted = extractSettingSecrets("communication.email", {
      enabled: true,
      smtpHost: "smtp.example.test",
      smtpPassword: "new-password",
    });
    expect(extracted.set).toEqual({ smtpPassword: "new-password" });
    expect(extracted.valueJson.smtpPassword).toBeUndefined();
    expect(extracted.valueJson.smtpHost).toBe("smtp.example.test");
  });

  test("a mask keeps the previous secret and an empty value clears it", () => {
    const kept = extractSettingSecrets("communication.sms", { webhookSecret: SECRET_MASK });
    expect(kept.set).toEqual({});
    expect(kept.clear).toEqual([]);
    const cleared = extractSettingSecrets("communication.sms", { webhookSecret: "" });
    expect(cleared.clear).toEqual(["webhookSecret"]);
  });

  test("the settings API returns a mask, never the stored ciphertext", async () => {
    const rows = await listPlatformSettingsForApi({
      platformSetting: {
        findMany: async () => [
          {
            id: "s1",
            key: "communication.email",
            scope: "PLATFORM",
            version: 2,
            valueJson: { enabled: true, smtpHost: "smtp.example.test", smtpPassword: "stored" },
          },
        ],
      },
      platformSettingSecret: {
        findMany: async () => [
          { key: "communication.email", scope: "PLATFORM", version: 2, field: "smtpPassword", ciphertext: "vault" },
        ],
      },
    } as never);
    expect(rows[0]?.valueJson).toMatchObject({
      smtpPassword: SECRET_MASK,
      smtpHost: "smtp.example.test",
    });
    expect(JSON.stringify(rows)).not.toContain("vault");
  });

  test("the settings export redacts known secret fields", () => {
    const exported = redactSettingSecretsForExport({
      key: "auth.google",
      scope: "PLATFORM",
      version: 1,
      valueJson: { enabled: true, clientId: "id", clientSecret: "should-not-leave" },
    });
    expect((exported.valueJson as Record<string, unknown>).clientSecret).toBe("<redacted>");
    expect(JSON.stringify(exported)).not.toContain("should-not-leave");
  });
});
