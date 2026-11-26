import { Vault } from "../../engine/crypto/Vault";
import { env } from "../env";

/**
 * Communication configuration (schema v46).
 *
 * Source of truth: the Platform Settings keys `communication.email`, `communication.sms`,
 * `communication.policy` and `auth.google`. Environment variables are the first-run bootstrap and a per-field
 * fallback for blank settings. An explicit `enabled: false` saved by an administrator always wins and is never
 * overridden by the environment.
 *
 * Secrets live in `platform_setting_secrets`, encrypted by the Vault. They are decrypted only here, never returned
 * by the settings API, exported or logged.
 */

export const COMMUNICATION_SETTING_KEYS = {
  email: "communication.email",
  sms: "communication.sms",
  policy: "communication.policy",
  google: "auth.google",
} as const;

export type CommunicationSettingKey = (typeof COMMUNICATION_SETTING_KEYS)[keyof typeof COMMUNICATION_SETTING_KEYS];

export type CommunicationSource = "ADMIN" | "ENV_BOOTSTRAP" | "ENV" | "MISSING";

export type SmtpSecurity = "TLS" | "STARTTLS" | "NONE";

export interface EmailConfiguration {
  enabled: boolean;
  provider: "SMTP";
  fromEmail: string;
  fromName: string;
  replyTo: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  smtpUsername: string;
  smtpPassword: string;
  timeoutMs: number;
  allowInsecure: boolean;
  source: CommunicationSource;
  configured: boolean;
  missingFields: string[];
}

export interface SmsConfiguration {
  enabled: boolean;
  provider: "WEBHOOK";
  webhookUrl: string;
  webhookSecret: string;
  senderId: string;
  timeoutMs: number;
  source: CommunicationSource;
  configured: boolean;
  missingFields: string[];
}

export interface GoogleConfiguration {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  hostedDomain: string;
  source: CommunicationSource;
  configured: boolean;
  missingFields: string[];
}

export type SmsMode = "OFF" | "AUTH_ONLY" | "CRITICAL_ONLY" | "ALL";

export interface CommunicationPolicy {
  smsMode: SmsMode;
  smsTemplateCodes: string[];
  staffSmsFallbackWhenEmailMissing: boolean;
  source: CommunicationSource;
}

export interface CommunicationConfiguration {
  email: EmailConfiguration;
  sms: SmsConfiguration;
  google: GoogleConfiguration;
  policy: CommunicationPolicy;
  loadedAt: number;
}

export interface CommunicationChannelStatusRow {
  channel: string;
  lastTestAt: Date | null;
  lastTestStatus: string | null;
  lastTestError: string | null;
  lastDeliveryAt: Date | null;
  lastDeliveryStatus: string | null;
  lastDeliveryError: string | null;
  consecutiveFailures: number;
  lastAlertAt: Date | null;
}

export interface CommunicationStatus {
  email: EmailStatus;
  sms: SmsStatus;
  google: GoogleStatus;
  maintenance: CommunicationMaintenance | null;
}

export interface CommunicationMaintenance {
  active: boolean;
  code: "EMAIL_NOT_CONFIGURED";
  message: string;
}

export interface EmailStatus {
  enabled: boolean;
  configured: boolean;
  source: CommunicationSource;
  missingFields: string[];
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastTestError: string | null;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: string | null;
  consecutiveFailures: number;
}

export interface SmsStatus {
  enabled: boolean;
  configured: boolean;
  source: CommunicationSource;
  missingFields: string[];
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: string | null;
  consecutiveFailures: number;
}

export interface GoogleStatus {
  enabled: boolean;
  configured: boolean;
  source: CommunicationSource;
  missingFields: string[];
}

interface SettingsRow {
  key: string;
  scope: string;
  version: number;
  valueJson: unknown;
  source?: string | null;
}

interface SecretRow {
  key: string;
  scope: string;
  version: number;
  field: string;
  ciphertext: string;
}

interface StatusRow {
  [key: string]: any;
}

export interface CommunicationSettingsDatabase {
  platformSetting: {
    findMany(args: Record<string, unknown>): Promise<SettingsRow[]>;
  };
  platformSettingSecret?: {
    findMany(args: Record<string, unknown>): Promise<SecretRow[]>;
  };
  communicationChannelStatus?: {
    findMany(args: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
    upsert(args: Record<string, unknown>): Promise<unknown>;
  };
}

const SETTINGS_CACHE_MS = 5_000;

let cache: { value: CommunicationConfiguration; expiresAt: number } | undefined;
const vault = new Vault();

export const invalidateCommunicationSettingsCache = (): void => {
  cache = undefined;
};

export const maskEmailAddress = (email: string): string => {
  const [local = "", domain = ""] = email.split("@");
  if (!domain) return email ? `${email.slice(0, 2)}***` : "";
  return `${local.slice(0, 2)}***@${domain}`;
};

export const maskPhoneNumber = (phone: string): string => {
  const clean = phone.replace(/[^\d+]/g, "");
  return clean.length >= 4 ? `*******${clean.slice(-4)}` : "*******";
};

export const hasRealEmail = (email: string | null | undefined): boolean => {
  const value = (email ?? "").trim().toLowerCase();
  if (!value.includes("@")) return false;
  if (value.includes("***")) return false;
  return !value.endsWith("@pending.payment-gateway.local") && !value.endsWith("@invited.payment-gateway.local");
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const text = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
};

const number = (fallback: number, ...values: unknown[]): number => {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
};

const bool = (fallback: boolean, ...values: unknown[]): boolean => {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lower = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(lower)) return true;
      if (["false", "0", "no", "off"].includes(lower)) return false;
    }
  }
  return fallback;
};

const field = (value: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  }
  return undefined;
};

const latestRows = (rows: SettingsRow[]): Map<string, SettingsRow> => {
  const latest = new Map<string, SettingsRow>();
  for (const row of rows) {
    const current = latest.get(row.key);
    if (!current || row.version > current.version) latest.set(row.key, row);
  }
  return latest;
};

const sourceOf = (row: SettingsRow | undefined, envHasAny: boolean): CommunicationSource => {
  if (!row) return envHasAny ? "ENV" : "MISSING";
  return String(row.source ?? "").toUpperCase() === "ENV_BOOTSTRAP" ? "ENV_BOOTSTRAP" : "ADMIN";
};

const envHasEmail = (): boolean =>
  Boolean(env.SMTP_HOST || env.SMTP_FROM_EMAIL || env.SMTP_USER || env.COMMUNICATION_EMAIL_ENABLED);
const envHasSms = (): boolean =>
  Boolean(env.SMS_WEBHOOK_URL || env.SMS_WEBHOOK_SECRET || env.COMMUNICATION_SMS_ENABLED);
const envHasGoogle = (): boolean =>
  Boolean(env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_SECRET || env.GOOGLE_REDIRECT_URI || env.GOOGLE_AUTH_ENABLED);

const explicitDisabled = (row: SettingsRow | undefined): boolean => {
  if (!row) return false;
  const value = asObject(row.valueJson);
  return value.enabled === false;
};

const mergedEmail = (row: SettingsRow | undefined, secret: string): EmailConfiguration => {
  const value = asObject(row?.valueJson);
  const adminDisabled = explicitDisabled(row);
  const host = text(field(value, "smtpHost", "host"), env.SMTP_HOST);
  const fromEmail = text(field(value, "fromEmail", "from"), env.SMTP_FROM_EMAIL);
  const securityValue = text(field(value, "smtpSecurity", "security"), env.SMTP_SECURITY).toUpperCase();
  const smtpSecurity: SmtpSecurity = securityValue === "TLS" || securityValue === "NONE" ? securityValue : "STARTTLS";
  const smtpUsername = text(field(value, "smtpUsername", "user", "username"), env.SMTP_USER);
  const smtpPassword = secret || text(env.SMTP_PASSWORD);
  const missing: string[] = [];
  if (!host) missing.push("smtpHost");
  if (!EMAIL_RE.test(fromEmail)) missing.push("fromEmail");
  if (smtpUsername && !smtpPassword) missing.push("smtpPassword");
  return {
    enabled: adminDisabled ? false : bool(env.COMMUNICATION_EMAIL_ENABLED, field(value, "enabled")),
    provider: "SMTP",
    fromEmail,
    fromName: text(field(value, "fromName"), env.SMTP_FROM_NAME),
    replyTo: text(field(value, "replyTo"), env.SMTP_REPLY_TO),
    smtpHost: host,
    smtpPort: number(env.SMTP_PORT, field(value, "smtpPort", "port"), env.SMTP_PORT),
    smtpSecurity,
    smtpUsername,
    smtpPassword,
    timeoutMs: number(env.SMTP_TIMEOUT_MS, field(value, "timeoutMs"), env.SMTP_TIMEOUT_MS),
    allowInsecure: bool(env.SMTP_ALLOW_INSECURE, field(value, "allowInsecure")),
    source: sourceOf(row, envHasEmail()),
    configured: !adminDisabled && missing.length === 0 && bool(env.COMMUNICATION_EMAIL_ENABLED, field(value, "enabled")),
    missingFields: missing,
  };
};

const mergedSms = (row: SettingsRow | undefined, secret: string): SmsConfiguration => {
  const value = asObject(row?.valueJson);
  const adminDisabled = explicitDisabled(row);
  const webhookUrl = text(field(value, "webhookUrl", "url"), env.SMS_WEBHOOK_URL);
  const webhookSecret = secret || text(env.SMS_WEBHOOK_SECRET);
  const missing: string[] = [];
  if (!webhookUrl) missing.push("webhookUrl");
  if (!webhookSecret) missing.push("webhookSecret");
  return {
    enabled: adminDisabled ? false : bool(env.COMMUNICATION_SMS_ENABLED, field(value, "enabled")),
    provider: "WEBHOOK",
    webhookUrl,
    webhookSecret,
    senderId: text(field(value, "senderId"), env.SMS_SENDER_ID),
    timeoutMs: number(env.SMS_TIMEOUT_MS, field(value, "timeoutMs"), env.SMS_TIMEOUT_MS),
    source: sourceOf(row, envHasSms()),
    configured: !adminDisabled && missing.length === 0 && bool(env.COMMUNICATION_SMS_ENABLED, field(value, "enabled")),
    missingFields: missing,
  };
};

const mergedGoogle = (row: SettingsRow | undefined, secret: string): GoogleConfiguration => {
  const value = asObject(row?.valueJson);
  const adminDisabled = explicitDisabled(row);
  const clientId = text(field(value, "clientId"), env.GOOGLE_CLIENT_ID);
  const clientSecret = secret || text(env.GOOGLE_CLIENT_SECRET);
  const redirectUri = text(field(value, "redirectUri"), env.GOOGLE_REDIRECT_URI);
  const missing: string[] = [];
  if (!clientId) missing.push("clientId");
  if (!clientSecret) missing.push("clientSecret");
  if (!redirectUri) missing.push("redirectUri");
  return {
    enabled: adminDisabled ? false : bool(env.GOOGLE_AUTH_ENABLED, field(value, "enabled")),
    clientId,
    clientSecret,
    redirectUri,
    hostedDomain: text(field(value, "hostedDomain"), env.GOOGLE_HOSTED_DOMAIN),
    source: sourceOf(row, envHasGoogle()),
    configured: !adminDisabled && missing.length === 0 && bool(env.GOOGLE_AUTH_ENABLED, field(value, "enabled")),
    missingFields: missing,
  };
};

const DEFAULT_SMS_TEMPLATES = [
  "LOGIN_MFA",
  "EMAIL_VERIFICATION",
  "PASSWORD_RESET",
  "PASSWORD_CHANGED",
  "STAFF_INVITATION",
  "SECURITY_ALERT",
] as const;

const mergedPolicy = (row: SettingsRow | undefined): CommunicationPolicy => {
  const value = asObject(row?.valueJson);
  const mode = text(field(value, "smsMode")).toUpperCase();
  const allowed: SmsMode[] = ["OFF", "AUTH_ONLY", "CRITICAL_ONLY", "ALL"];
  const codes = field(value, "smsTemplateCodes");
  return {
    smsMode: (allowed as string[]).includes(mode) ? (mode as SmsMode) : "CRITICAL_ONLY",
    smsTemplateCodes: Array.isArray(codes)
      ? codes.map(String).map((entry) => entry.trim().toUpperCase()).filter(Boolean)
      : [...DEFAULT_SMS_TEMPLATES],
    staffSmsFallbackWhenEmailMissing: bool(true, field(value, "staffSmsFallbackWhenEmailMissing")),
    source: sourceOf(row, false),
  };
};

const decryptSecrets = async (
  db: CommunicationSettingsDatabase,
  rows: Map<string, SettingsRow>,
): Promise<Map<string, Map<string, string>>> => {
  const result = new Map<string, Map<string, string>>();
  if (!db.platformSettingSecret) return result;
  const latest = [...rows.values()];
  if (latest.length === 0) return result;
  let secrets: SecretRow[] = [];
  try {
    secrets = await db.platformSettingSecret.findMany({
      where: { key: { in: latest.map((row) => row.key) }, scope: "PLATFORM" },
      orderBy: [{ version: "desc" }],
    });
  } catch {
    return result;
  }
  for (const secret of secrets) {
    const setting = rows.get(secret.key);
    if (!setting || setting.version !== secret.version) continue;
    let plaintext: string;
    try {
      plaintext = await vault.decryptSecret(secret.ciphertext);
    } catch {
      continue;
    }
    const fields = result.get(secret.key) ?? new Map<string, string>();
    if (!fields.has(secret.field)) fields.set(secret.field, plaintext);
    result.set(secret.key, fields);
  }
  return result;
};

export const buildCommunicationConfiguration = (
  settings: SettingsRow[],
  secrets: Map<string, Map<string, string>>,
): CommunicationConfiguration => {
  const rows = latestRows(settings);
  const emailSecret = secrets.get(COMMUNICATION_SETTING_KEYS.email)?.get("smtpPassword") ?? "";
  const smsSecret = secrets.get(COMMUNICATION_SETTING_KEYS.sms)?.get("webhookSecret") ?? "";
  const googleSecret = secrets.get(COMMUNICATION_SETTING_KEYS.google)?.get("clientSecret") ?? "";
  return {
    email: mergedEmail(rows.get(COMMUNICATION_SETTING_KEYS.email), emailSecret),
    sms: mergedSms(rows.get(COMMUNICATION_SETTING_KEYS.sms), smsSecret),
    google: mergedGoogle(rows.get(COMMUNICATION_SETTING_KEYS.google), googleSecret),
    policy: mergedPolicy(rows.get(COMMUNICATION_SETTING_KEYS.policy)),
    loadedAt: Date.now(),
  };
};

export const getCommunicationConfiguration = async (
  db: CommunicationSettingsDatabase,
  options: { force?: boolean } = {},
): Promise<CommunicationConfiguration> => {
  const now = Date.now();
  if (!options.force && cache && cache.expiresAt > now) return cache.value;
  const settings = await db.platformSetting.findMany({
    where: { key: { in: Object.values(COMMUNICATION_SETTING_KEYS) }, scope: "PLATFORM" },
    orderBy: [{ key: "asc" }, { version: "desc" }],
  });
  const secrets = await decryptSecrets(db, latestRows(settings));
  const value = buildCommunicationConfiguration(settings, secrets);
  cache = { value, expiresAt: now + SETTINGS_CACHE_MS };
  return value;
};

const iso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const statusFor = (row: StatusRow | undefined): StatusRow => row ?? { channel: "" };

export const communicationStatus = async (
  db: CommunicationSettingsDatabase,
  options: { force?: boolean } = {},
): Promise<CommunicationStatus> => {
  const config = await getCommunicationConfiguration(db, options);
  let statuses: StatusRow[] = [];
  try {
    statuses = db.communicationChannelStatus
      ? await db.communicationChannelStatus.findMany({ where: { channel: { in: ["EMAIL", "SMS"] } } })
      : [];
  } catch {
    statuses = [];
  }
  const byChannel = new Map(statuses.map((row) => [row.channel, row]));
  const emailRow = statusFor(byChannel.get("EMAIL"));
  const smsRow = statusFor(byChannel.get("SMS"));
  return {
    email: {
      enabled: config.email.enabled,
      configured: config.email.configured,
      source: config.email.source,
      missingFields: config.email.missingFields,
      lastTestAt: iso(emailRow.lastTestAt),
      lastTestStatus: emailRow.lastTestStatus ?? null,
      lastTestError: emailRow.lastTestError ?? null,
      lastDeliveryAt: iso(emailRow.lastDeliveryAt),
      lastDeliveryStatus: emailRow.lastDeliveryStatus ?? null,
      consecutiveFailures: Number(emailRow.consecutiveFailures ?? 0),
    },
    sms: {
      enabled: config.sms.enabled,
      configured: config.sms.configured,
      source: config.sms.source,
      missingFields: config.sms.missingFields,
      lastTestAt: iso(smsRow.lastTestAt),
      lastTestStatus: smsRow.lastTestStatus ?? null,
      lastDeliveryAt: iso(smsRow.lastDeliveryAt),
      lastDeliveryStatus: smsRow.lastDeliveryStatus ?? null,
      consecutiveFailures: Number(smsRow.consecutiveFailures ?? 0),
    },
    google: {
      enabled: config.google.enabled,
      configured: config.google.configured,
      source: config.google.source,
      missingFields: config.google.missingFields,
    },
    maintenance: config.email.configured
      ? null
      : {
          active: true,
          code: "EMAIL_NOT_CONFIGURED",
          message:
            "Merchant registration and sign-in are unavailable until email delivery is configured in Platform Settings.",
        },
  };
};

/** The public (unauthenticated) view: booleans only, never provider details. */
export const publicCommunicationStatus = (status: CommunicationStatus): {
  emailConfigured: boolean;
  smsConfigured: boolean;
  googleEnabled: boolean;
  registrationEnabled: boolean;
  passwordResetEnabled: boolean;
  maintenance: CommunicationMaintenance | null;
} => ({
  emailConfigured: status.email.configured,
  smsConfigured: status.sms.configured,
  googleEnabled: status.google.configured,
  registrationEnabled: status.email.configured,
  passwordResetEnabled: status.email.configured,
  maintenance: status.maintenance,
});

export const recordCommunicationDelivery = async (
  db: { communicationChannelStatus?: { upsert(args: Record<string, unknown>): Promise<unknown> } },
  channel: "EMAIL" | "SMS",
  outcome: { status: "SENT" | "DELIVERED" | "FAILED"; error?: string | null; at?: Date },
): Promise<void> => {
  if (!db.communicationChannelStatus) return;
  const now = outcome.at ?? new Date();
  const failed = outcome.status === "FAILED";
  try {
    await db.communicationChannelStatus.upsert({
      where: { channel },
      create: {
        channel,
        lastDeliveryAt: now,
        lastDeliveryStatus: outcome.status,
        lastDeliveryError: failed ? outcome.error ?? "Delivery failed" : null,
        consecutiveFailures: failed ? 1 : 0,
      },
      update: {
        lastDeliveryAt: now,
        lastDeliveryStatus: outcome.status,
        lastDeliveryError: failed ? outcome.error ?? "Delivery failed" : null,
        ...(failed ? { consecutiveFailures: { increment: 1 } } : { consecutiveFailures: 0 }),
      },
    });
  } catch {
    // Status telemetry must never fail a delivery or a worker tick.
  }
};

export const recordCommunicationTest = async (
  db: { communicationChannelStatus?: { upsert(args: Record<string, unknown>): Promise<unknown> } },
  channel: "EMAIL" | "SMS",
  outcome: { status: "PASSED" | "FAILED"; error?: string | null; at?: Date },
): Promise<void> => {
  if (!db.communicationChannelStatus) return;
  const now = outcome.at ?? new Date();
  try {
    await db.communicationChannelStatus.upsert({
      where: { channel },
      create: {
        channel,
        lastTestAt: now,
        lastTestStatus: outcome.status,
        lastTestError: outcome.status === "FAILED" ? outcome.error ?? "Test failed" : null,
      },
      update: {
        lastTestAt: now,
        lastTestStatus: outcome.status,
        lastTestError: outcome.status === "FAILED" ? outcome.error ?? "Test failed" : null,
      },
    });
  } catch {
    // Telemetry only.
  }
};

export const __resetCommunicationSettingsForTests = (): void => {
  cache = undefined;
};
