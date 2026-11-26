import type { PrismaLike } from "../../engine/db/ports";
import { Vault } from "../../engine/crypto/Vault";
import { COMMUNICATION_SETTING_KEYS } from "./settings";

/**
 * Write-only secrets of Platform Settings.
 *
 * The API accepts the normal `valueJson` object. Known secret fields are extracted before the version is stored,
 * sealed with the Vault and written to `platform_setting_secrets`. The stored `valueJson` never carries a secret.
 * A read returns a mask (`••••`) and a `has<Field>` flag instead.
 */

const vault = new Vault();
export const SECRET_MASK = "••••";

export const SECRET_FIELDS: Record<string, readonly string[]> = {
  [COMMUNICATION_SETTING_KEYS.email]: ["smtpPassword"],
  [COMMUNICATION_SETTING_KEYS.sms]: ["webhookSecret"],
  [COMMUNICATION_SETTING_KEYS.google]: ["clientSecret"],
};

export interface ExtractedSecrets {
  valueJson: Record<string, unknown>;
  /** New values to encrypt; absent means "keep the previous version's secret". */
  set: Record<string, string>;
  /** Fields the administrator explicitly cleared. */
  clear: string[];
}

const isMask = (value: unknown): boolean =>
  value === SECRET_MASK || value === "__unchanged__" || value === "********" || value === "<redacted>";

export const extractSettingSecrets = (key: string, raw: unknown): ExtractedSecrets => {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const result: ExtractedSecrets = { valueJson: source, set: {}, clear: [] };
  for (const field of SECRET_FIELDS[key] ?? []) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const value = source[field];
    delete source[field];
    if (isMask(value)) continue;
    if (value === null || value === "") {
      result.clear.push(field);
      continue;
    }
    if (typeof value === "string" && value.trim() !== "") {
      result.set[field] = value.trim();
    }
  }
  return result;
};

export const listPlatformSettingsForApi = async (db: PrismaLike): Promise<Record<string, unknown>[]> => {
  const rows = await db.platformSetting.findMany({ orderBy: [{ key: "asc" }, { version: "desc" }] });
  const relevant = rows.filter((row: { key: string }) => SECRET_FIELDS[row.key]);
  const secrets = relevant.length > 0
    ? await db.platformSettingSecret.findMany({
        where: { key: { in: [...new Set(relevant.map((row: { key: string }) => row.key))] }, scope: "PLATFORM" },
        orderBy: [{ version: "desc" }],
      })
    : [];
  const byVersion = new Map<string, Set<string>>();
  for (const secret of secrets) {
    const mapKey = `${secret.key}:${secret.scope}:${secret.version}`;
    const fields = byVersion.get(mapKey) ?? new Set<string>();
    fields.add(secret.field);
    byVersion.set(mapKey, fields);
  }
  return rows.map((row: Record<string, unknown>) => {
    const fields = byVersion.get(`${String(row.key)}:${String(row.scope)}:${Number(row.version)}`);
    if (!fields || fields.size === 0) return row;
    const value = { ...(row.valueJson as Record<string, unknown>) };
    for (const field of fields) {
      value[field] = SECRET_MASK;
    }
    return { ...row, valueJson: value };
  });
};

export const persistSettingSecrets = async (
  tx: PrismaLike,
  input: {
    key: string;
    scope: string;
    version: number;
    previousVersion: number | null;
    extracted: ExtractedSecrets;
  },
): Promise<void> => {
  const { key, scope, version, previousVersion, extracted } = input;
  // A new version inherits the previous secret unless the administrator set or cleared it.
  if (previousVersion !== null) {
    const previous = await tx.platformSettingSecret.findMany({
      where: { key, scope, version: previousVersion },
    });
    for (const secret of previous) {
      if (extracted.clear.includes(secret.field)) continue;
      if (extracted.set[secret.field]) continue;
      await tx.platformSettingSecret.create({
        data: {
          key,
          scope,
          version,
          field: secret.field,
          ciphertext: secret.ciphertext,
        },
      });
    }
  }
  for (const [field, plaintext] of Object.entries(extracted.set)) {
    await tx.platformSettingSecret.create({
      data: {
        key,
        scope,
        version,
        field,
        ciphertext: await vault.encryptSecret(plaintext, "platform-setting-secret"),
      },
    });
  }
};

/** Export/backup helper: never include secret values, only their names. */
export const redactSettingSecretsForExport = (row: Record<string, unknown>): Record<string, unknown> => {
  const fields = SECRET_FIELDS[String(row.key)] ?? [];
  if (fields.length === 0) return row;
  const value = { ...(row.valueJson as Record<string, unknown>) };
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) value[field] = "<redacted>";
  }
  return { ...row, valueJson: value };
};
