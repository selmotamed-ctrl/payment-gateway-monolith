import { Vault } from "../../engine/crypto/Vault";
import type { PrismaLike } from "../../engine/db/ports";
import { env } from "../env";
import { COMMUNICATION_SETTING_KEYS } from "./settings";

/**
 * First-run bootstrap of the communication settings from the deployment environment.
 *
 * Rules:
 *  - no setting row                 -> create version 1 with `source = ENV_BOOTSTRAP`;
 *  - an `ENV_BOOTSTRAP` row exists  -> update it when the environment changed;
 *  - an `ADMIN` row exists          -> never overwrite it (the administrator's value wins, including `enabled: false`);
 *  - an explicitly empty value in an ADMIN row still falls back to the environment at runtime, so "empty" is filled
 *    without creating a new version on every boot.
 *
 * The operation is idempotent and safe to run from every core node: it takes a transaction-scoped advisory lock.
 */

const LOCK_NAME = "pgw:communication-settings-bootstrap:v1";
const vault = new Vault();

interface Candidate {
  key: string;
  value: Record<string, unknown>;
  secrets: Record<string, string>;
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const emailCandidate = (): Candidate | null => {
  const hasAny = Boolean(
    nonEmpty(env.SMTP_HOST) ||
      nonEmpty(env.SMTP_FROM_EMAIL) ||
      nonEmpty(env.SMTP_USER) ||
      env.COMMUNICATION_EMAIL_ENABLED,
  );
  if (!hasAny) return null;
  const value: Record<string, unknown> = {
    enabled: env.COMMUNICATION_EMAIL_ENABLED,
    provider: "SMTP",
    fromEmail: nonEmpty(env.SMTP_FROM_EMAIL) ?? "",
    fromName: nonEmpty(env.SMTP_FROM_NAME) ?? "Payment Gateway",
    replyTo: nonEmpty(env.SMTP_REPLY_TO) ?? "",
    smtpHost: nonEmpty(env.SMTP_HOST) ?? "",
    smtpPort: env.SMTP_PORT,
    smtpSecurity: env.SMTP_SECURITY,
    smtpUsername: nonEmpty(env.SMTP_USER) ?? "",
    timeoutMs: env.SMTP_TIMEOUT_MS,
    allowInsecure: env.SMTP_ALLOW_INSECURE,
  };
  return {
    key: COMMUNICATION_SETTING_KEYS.email,
    value,
    secrets: nonEmpty(env.SMTP_PASSWORD) ? { smtpPassword: env.SMTP_PASSWORD! } : {},
  };
};

const smsCandidate = (): Candidate | null => {
  const hasAny = Boolean(
    nonEmpty(env.SMS_WEBHOOK_URL) || nonEmpty(env.SMS_WEBHOOK_SECRET) || env.COMMUNICATION_SMS_ENABLED,
  );
  if (!hasAny) return null;
  return {
    key: COMMUNICATION_SETTING_KEYS.sms,
    value: {
      enabled: env.COMMUNICATION_SMS_ENABLED,
      provider: "WEBHOOK",
      webhookUrl: nonEmpty(env.SMS_WEBHOOK_URL) ?? "",
      senderId: nonEmpty(env.SMS_SENDER_ID) ?? "",
      timeoutMs: env.SMS_TIMEOUT_MS,
    },
    secrets: nonEmpty(env.SMS_WEBHOOK_SECRET) ? { webhookSecret: env.SMS_WEBHOOK_SECRET! } : {},
  };
};

const googleCandidate = (): Candidate | null => {
  const hasAny = Boolean(
    nonEmpty(env.GOOGLE_CLIENT_ID) ||
      nonEmpty(env.GOOGLE_CLIENT_SECRET) ||
      nonEmpty(env.GOOGLE_REDIRECT_URI) ||
      env.GOOGLE_AUTH_ENABLED,
  );
  if (!hasAny) return null;
  return {
    key: COMMUNICATION_SETTING_KEYS.google,
    value: {
      enabled: env.GOOGLE_AUTH_ENABLED,
      clientId: nonEmpty(env.GOOGLE_CLIENT_ID) ?? "",
      redirectUri: nonEmpty(env.GOOGLE_REDIRECT_URI) ?? "",
      hostedDomain: nonEmpty(env.GOOGLE_HOSTED_DOMAIN) ?? "",
    },
    secrets: nonEmpty(env.GOOGLE_CLIENT_SECRET) ? { clientSecret: env.GOOGLE_CLIENT_SECRET! } : {},
  };
};

const candidates = (): Candidate[] =>
  [emailCandidate(), smsCandidate(), googleCandidate()].filter((candidate): candidate is Candidate => candidate !== null);

const stable = (value: unknown): string => JSON.stringify(value);

export interface BootstrapResult {
  created: string[];
  updated: string[];
  skipped: string[];
}

export const bootstrapCommunicationSettingsFromEnv = async (
  db: PrismaLike,
  options: { now?: Date } = {},
): Promise<BootstrapResult> => {
  const result: BootstrapResult = { created: [], updated: [], skipped: [] };
  if (!env.COMMUNICATION_BOOTSTRAP_ENABLED) return result;
  const configured = candidates();
  if (configured.length === 0) return result;
  const now = options.now ?? new Date();

  await db.$transaction(async (tx: PrismaLike) => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", LOCK_NAME);
    for (const candidate of configured) {
      const latest = await tx.platformSetting.findFirst({
        where: { key: candidate.key, scope: "PLATFORM" },
        orderBy: { version: "desc" },
      });
      const source = String(latest?.source ?? "").toUpperCase();
      if (latest && source !== "ENV_BOOTSTRAP") {
        result.skipped.push(candidate.key);
        continue;
      }
      const changed = !latest || stable(latest.valueJson) !== stable(candidate.value);
      if (!changed) {
        result.skipped.push(candidate.key);
        continue;
      }
      const version = (latest?.version ?? 0) + 1;
      await tx.platformSetting.create({
        data: {
          key: candidate.key,
          scope: "PLATFORM",
          version,
          valueJson: candidate.value,
          source: "ENV_BOOTSTRAP",
          effectiveFrom: now,
        },
      });
      await tx.platformSettingSecret?.deleteMany?.({
        where: { key: candidate.key, scope: "PLATFORM", version },
      });
      for (const [field, plaintext] of Object.entries(candidate.secrets)) {
        await tx.platformSettingSecret?.create?.({
          data: {
            key: candidate.key,
            scope: "PLATFORM",
            version,
            field,
            ciphertext: await vault.encryptSecret(plaintext, "platform-setting-secret"),
          },
        });
      }
      if (latest) result.updated.push(candidate.key);
      else result.created.push(candidate.key);
    }
  });
  return result;
};
