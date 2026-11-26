import type { PrismaLike } from "../db/ports";
import type { CommunicationConfiguration } from "../../lib/communication/settings";
import { getCommunicationConfiguration, recordCommunicationTest } from "../../lib/communication/settings";
import { queueCommunicationNotice } from "../../lib/communication/notices";
import { ensureNoticeTemplates, bilingualNotice } from "../../lib/automationNotices";
import { env } from "../../lib/env";
import type { MonitorCheckResult, MonitorFinding, PlatformMonitorCheck } from "./PlatformMonitorWorker";

/**
 * Communication readiness check.
 *
 * Merchant registration/sign-in is in maintenance while e-mail is not configured. The check raises ONE keyed case
 * (`platform.communication:email`) and tells every active staff principal who can fix it: an in-app notification always,
 * an SMS when the SMS channel is configured, and the optional environment fallback recipients. The notification event
 * id contains the UTC date, so a re-tick or a restart cannot spam the same person.
 */

const alertTemplate = {
  code: "COMMUNICATION_ALERT",
  audience: "INTERNAL" as const,
  templates: [
    ...bilingualNotice({
      code: "COMMUNICATION_ALERT",
      audience: "INTERNAL",
      en: {
        subject: "Email delivery is not configured",
        body:
          "Merchant registration and sign-in are in maintenance because email delivery is not configured. Open Admin → Platform Settings → Communication and configure the SMTP mailbox.",
      },
      ar: {
        subject: "البريد الإلكتروني غير مُهيأ",
        body:
          "تسجيل التجار وتسجيل الدخول متوقفان لأن البريد الإلكتروني غير مُهيأ. افتح الإدارة ← إعدادات المنصة ← الاتصالات وهيئ خادم SMTP.",
      },
    }).templates,
    {
      channel: "SMS" as const,
      lang: "EN" as const,
      subject: null,
      body: "Payment Gateway: email delivery is not configured, so merchant registration/sign-in are in maintenance. Configure it in Platform Settings.",
    },
    {
      channel: "SMS" as const,
      lang: "AR" as const,
      subject: null,
      body: "بوابة الدفع: البريد الإلكتروني غير مُهيأ، لذا تسجيل التجار والدخول قيد الصيانة. هيّئه من إعدادات المنصة.",
    },
  ],
};

const asArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(String)
    : value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).filter(([, enabled]) => enabled === true).map(([key]) => key)
      : [];

const canConfigure = (user: { role: unknown; authoritiesMap: unknown }): boolean => {
  const role = String(user.role ?? "");
  const authorities = new Set(asArray(user.authoritiesMap));
  return role === "GATEWAY_ADMIN" || role === "SECURITY_ADMIN" || authorities.has("settings:write");
};

export const notifyCommunicationGap = async (
  db: PrismaLike,
  config: CommunicationConfiguration,
): Promise<void> => {
  if (config.email.configured) return;
  const day = new Date().toISOString().slice(0, 10);
  try {
    await ensureNoticeTemplates(db as never, [alertTemplate]);
    const staff = await db.user.findMany({
      where: { merchantId: null, status: "ACTIVE" },
      select: { id: true, email: true, phone: true, role: true, authoritiesMap: true },
    });
    const recipients = staff.filter(canConfigure);
    for (const user of recipients) {
      const channels: Array<"EMAIL" | "SMS" | "IN_APP"> = ["IN_APP"];
      if (config.sms.configured && user.phone) channels.push("SMS");
      if (config.email.configured && user.email) channels.push("EMAIL");
      await queueCommunicationNotice(db, {
        userId: String(user.id),
        templateCode: "COMMUNICATION_ALERT",
        eventKey: `communication-alert:${day}:${user.id}`,
        email: user.email,
        phone: user.phone,
        channels,
      });
    }
    if (env.PLATFORM_ALERT_SMS && config.sms.configured) {
      await queueCommunicationNotice(db, {
        templateCode: "COMMUNICATION_ALERT",
        eventKey: `communication-alert:${day}:env-sms`,
        phone: env.PLATFORM_ALERT_SMS,
        channels: ["SMS"],
      });
    }
    if (env.PLATFORM_ALERT_EMAIL && config.email.configured) {
      await queueCommunicationNotice(db, {
        templateCode: "COMMUNICATION_ALERT",
        eventKey: `communication-alert:${day}:env-email`,
        email: env.PLATFORM_ALERT_EMAIL,
        channels: ["EMAIL"],
      });
    }
  } catch {
    // Alerting is best effort; the operator case is the durable record.
  }
};

export const createCommunicationReadinessCheck = (): PlatformMonitorCheck => ({
  id: "communication",
  run: async ({ db }): Promise<MonitorCheckResult> => {
    const config = await getCommunicationConfiguration(db as never, { force: true });
    const findings: MonitorFinding[] = [];
    if (!config.email.configured) {
      findings.push({
        key: "email",
        title: "Email delivery is not configured",
        detail:
          "Merchant registration and sign-in are in maintenance. Configure communication.email in Platform Settings (SMTP host, From address and credentials) or provide SMTP_HOST/SMTP_FROM_EMAIL in the deployment environment.",
        priority: "P1",
      });
      await notifyCommunicationGap(db as PrismaLike, config);
    }
    if (config.sms.enabled && !config.sms.configured) {
      findings.push({
        key: "sms",
        title: "SMS channel is enabled but incomplete",
        detail: `Missing: ${config.sms.missingFields.join(", ") || "provider configuration"}.`,
        priority: "P2",
      });
    }
    if (config.google.enabled && !config.google.configured) {
      findings.push({
        key: "google",
        title: "Google sign-in is enabled but incomplete",
        detail: `Missing: ${config.google.missingFields.join(", ") || "OAuth client configuration"}.`,
        priority: "P2",
      });
    }
    const statuses = db.communicationChannelStatus
      ? await db.communicationChannelStatus.findMany({ where: { channel: { in: ["EMAIL", "SMS"] } } })
      : [];
    for (const status of statuses as Array<Record<string, unknown>>) {
      const failures = Number(status.consecutiveFailures ?? 0);
      const lastTest = String(status.lastTestStatus ?? "");
      if (failures >= 3) {
        findings.push({
          key: `delivery-${String(status.channel).toLowerCase()}`,
          title: `${String(status.channel)} delivery is failing`,
          detail: `${failures} consecutive delivery failures. Last error: ${String(status.lastDeliveryError ?? "unknown")}.`,
          priority: "P2",
        });
      } else if (lastTest === "FAILED") {
        findings.push({
          key: `test-${String(status.channel).toLowerCase()}`,
          title: `${String(status.channel)} test failed`,
          detail: String(status.lastTestError ?? "The test message could not be sent."),
          priority: "P3",
        });
      }
    }
    return { findings, complete: true };
  },
});

/** Used by the settings test buttons to keep the status table honest after an operator test. */
export const markCommunicationTest = recordCommunicationTest;
