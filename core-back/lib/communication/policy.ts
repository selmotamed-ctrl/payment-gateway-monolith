import {
  hasRealEmail,
  maskEmailAddress,
  maskPhoneNumber,
  type CommunicationConfiguration,
  type CommunicationPolicy,
} from "./settings";

/**
 * Which channels a message is queued on.
 *
 * E-mail is the default channel: every notification that needs an external channel and has an e-mail recipient gets
 * an EMAIL row. SMS is additive and only for the codes the policy marks as critical/auth (or every code when the
 * administrator selects `ALL`). SMS is never a silent replacement for e-mail, except for staff sign-in when e-mail is
 * not configured and the operator enabled the SMS fallback.
 */

export type NotificationChannel = "EMAIL" | "SMS" | "IN_APP";

export type AuthPurpose = "LOGIN_MFA" | "EMAIL_VERIFICATION" | "PASSWORD_RESET";

export interface OtpDelivery {
  channels: Array<"EMAIL" | "SMS">;
  email: string | null;
  phone: string | null;
  destinationMasked: { email?: string; phone?: string };
}

const AUTH_TEMPLATE_CODES = new Set<string>([
  "LOGIN_MFA",
  "EMAIL_VERIFICATION",
  "PASSWORD_RESET",
  "PASSWORD_CHANGED",
  "STAFF_INVITATION",
  "LOGIN_CODE",
  "VERIFY_EMAIL",
]);

const normalizeCode = (code: string): string => code.trim().toUpperCase();

export const isAuthTemplate = (code: string): boolean => AUTH_TEMPLATE_CODES.has(normalizeCode(code));

export const shouldSendSms = (
  policy: CommunicationPolicy,
  templateCode: string,
  smsConfigured: boolean,
): boolean => {
  if (!smsConfigured || policy.smsMode === "OFF") return false;
  const code = normalizeCode(templateCode);
  if (policy.smsMode === "ALL") return true;
  if (policy.smsTemplateCodes.map(normalizeCode).includes(code)) return true;
  if (policy.smsMode === "AUTH_ONLY") return isAuthTemplate(code);
  // CRITICAL_ONLY: the configured allow-list is the source of truth.
  return false;
};

export interface OtpRecipient {
  email?: string | null;
  phone?: string | null;
}

export interface OtpDeliveryOptions {
  /** ADMIN may fall back to SMS when e-mail is not configured; MERCHANT is blocked by maintenance instead. */
  channel: "ADMIN" | "MERCHANT";
  purpose: AuthPurpose;
}

export const resolveOtpDelivery = (
  config: CommunicationConfiguration,
  recipient: OtpRecipient,
  options: OtpDeliveryOptions,
): OtpDelivery => {
  const email = hasRealEmail(recipient.email) ? String(recipient.email).trim() : null;
  const phone = recipient.phone?.trim() ? recipient.phone.trim() : null;
  const channels: Array<"EMAIL" | "SMS"> = [];
  if (email && config.email.configured) {
    channels.push("EMAIL");
  }
  const smsAllowedForPurpose =
    options.purpose === "LOGIN_MFA"
      ? true
      : options.purpose === "PASSWORD_RESET" || options.purpose === "EMAIL_VERIFICATION";
  if (
    phone &&
    config.sms.configured &&
    smsAllowedForPurpose &&
    shouldSendSms(config.policy, options.purpose, config.sms.configured)
  ) {
    channels.push("SMS");
  }
  if (options.channel === "ADMIN" && channels.length === 0 && phone && config.sms.configured && config.policy.staffSmsFallbackWhenEmailMissing) {
    channels.push("SMS");
  }
  return {
    channels,
    email,
    phone,
    destinationMasked: {
      ...(email ? { email: maskEmailAddress(email) } : {}),
      ...(phone ? { phone: maskPhoneNumber(phone) } : {}),
    },
  };
};

/**
 * Channels for a non-OTP notification. `baseChannels` is what the producer already intends (for example IN_APP +
 * EMAIL). SMS is appended only when the policy allows this template and the recipient has a phone.
 */
export const notificationChannels = (
  config: CommunicationConfiguration,
  templateCode: string,
  baseChannels: readonly NotificationChannel[],
  recipient: OtpRecipient & { inApp?: boolean },
): NotificationChannel[] => {
  const channels = new Set<NotificationChannel>(baseChannels);
  if (config.email.configured && hasRealEmail(recipient.email)) {
    channels.add("EMAIL");
  }
  if (
    recipient.phone &&
    shouldSendSms(config.policy, templateCode, config.sms.configured)
  ) {
    channels.add("SMS");
  }
  if (recipient.inApp) channels.add("IN_APP");
  return [...channels];
};
