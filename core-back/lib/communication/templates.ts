import type { PrismaLike } from "../../engine/db/ports";

/**
 * Authentication templates are code-owned because they must exist before the first sign-in, even on a database that
 * was seeded before the communication engine existed. They are inserted idempotently with `skipDuplicates`, so an
 * administrator's newer template version is never overwritten.
 *
 * `confidentiality_class = INTERNAL` keeps one-time codes and invitation tokens out of every log line.
 */

interface AuthTemplate {
  code: string;
  channel: "EMAIL" | "SMS";
  subject: string | null;
  en: string;
  ar: string;
}

const AUTH_TEMPLATES: AuthTemplate[] = [
  {
    code: "LOGIN_MFA",
    channel: "EMAIL",
    subject: "Your sign-in code",
    en: "Your sign-in code is {{code}}. It expires in {{ttlMinutes}} minutes. Never share this code with anyone.",
    ar: "رمز الدخول الخاص بك هو {{code}}. تنتهي صلاحيته خلال {{ttlMinutes}} دقيقة. لا تشارك هذا الرمز مع أي شخص.",
  },
  {
    code: "LOGIN_MFA",
    channel: "SMS",
    subject: null,
    en: "Your sign-in code is {{code}}. It expires in {{ttlMinutes}} minutes. Never share it.",
    ar: "رمز الدخول {{code}}. تنتهي صلاحيته خلال {{ttlMinutes}} دقيقة. لا تشاركه مع أحد.",
  },
  {
    code: "EMAIL_VERIFICATION",
    channel: "EMAIL",
    subject: "Verify your email address",
    en: "Welcome to {{platformName}}. Your verification code is {{code}}. It expires in {{ttlMinutes}} minutes.",
    ar: "مرحباً بك في {{platformName}}. رمز التحقق الخاص بك هو {{code}}. تنتهي صلاحيته خلال {{ttlMinutes}} دقيقة.",
  },
  {
    code: "EMAIL_VERIFICATION",
    channel: "SMS",
    subject: null,
    en: "{{platformName}} verification code: {{code}}. Expires in {{ttlMinutes}} minutes.",
    ar: "رمز التحقق من {{platformName}}: {{code}}. تنتهي صلاحيته خلال {{ttlMinutes}} دقيقة.",
  },
  {
    code: "PASSWORD_RESET",
    channel: "EMAIL",
    subject: "Reset your password",
    en: "Use code {{code}} to reset your password. It expires in {{ttlMinutes}} minutes. If you did not ask for this, ignore this message.",
    ar: "استخدم الرمز {{code}} لإعادة تعيين كلمة المرور. تنتهي صلاحيته خلال {{ttlMinutes}} دقيقة. إذا لم تطلب ذلك تجاهل هذه الرسالة.",
  },
  {
    code: "PASSWORD_RESET",
    channel: "SMS",
    subject: null,
    en: "{{platformName}} password reset code: {{code}}. Expires in {{ttlMinutes}} minutes.",
    ar: "رمز إعادة تعيين كلمة المرور من {{platformName}}: {{code}}. تنتهي صلاحيته خلال {{ttlMinutes}} دقيقة.",
  },
  {
    code: "PASSWORD_CHANGED",
    channel: "EMAIL",
    subject: "Your password was changed",
    en: "Your password was changed at {{changedAt}}. If this was not you, contact the platform administrator immediately.",
    ar: "تم تغيير كلمة المرور الخاصة بك في {{changedAt}}. إذا لم تقم بذلك فاتصل بمسؤول المنصة فوراً.",
  },
  {
    code: "PASSWORD_CHANGED",
    channel: "SMS",
    subject: null,
    en: "{{platformName}}: your password was changed at {{changedAt}}. If this was not you, contact support immediately.",
    ar: "{{platformName}}: تم تغيير كلمة المرور في {{changedAt}}. إذا لم تقم بذلك فاتصل بالدعم فوراً.",
  },
];

export const COMMUNICATION_AUTH_TEMPLATE_CODES = ["LOGIN_MFA", "EMAIL_VERIFICATION", "PASSWORD_RESET", "PASSWORD_CHANGED"] as const;

export const ensureCommunicationTemplates = async (db: PrismaLike): Promise<void> => {
  const delegate = db.notificationTemplate;
  if (!delegate?.createMany) return;
  await delegate.createMany({
    data: AUTH_TEMPLATES.flatMap((template) => [
      {
        code: template.code,
        channel: template.channel,
        lang: "EN",
        subjectTemplate: template.subject,
        bodyTemplate: template.en,
        confidentialityClass: "INTERNAL",
        version: 1,
        active: true,
      },
      {
        code: template.code,
        channel: template.channel,
        lang: "AR",
        subjectTemplate: template.subject,
        bodyTemplate: template.ar,
        confidentialityClass: "INTERNAL",
        version: 1,
        active: true,
      },
    ]),
    skipDuplicates: true,
  });
};
