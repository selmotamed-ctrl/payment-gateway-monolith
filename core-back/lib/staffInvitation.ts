import { createHash, randomBytes } from "node:crypto";
import { Vault } from "../engine/crypto/Vault";

/**
 * Staff invitations.
 *
 * The person who proposes a staff user (the maker) must never know the new user's credentials: the
 * invitation token is mailed to the invitee and nowhere else, and the invitee chooses their own
 * password and their own MFA phone when accepting it. Activation stays a maker-checker approval, but it
 * is refused until the invitee has completed this step, so a maker can neither sign in as the new user
 * nor receive its MFA codes. Before 2026-11-08 the maker chose the password and the phone at creation.
 */
export const STAFF_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const STAFF_INVITATION_TEMPLATE = "STAFF_INVITATION";

const vault = new Vault();

export const hashInvitationToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const maskEmail = (email: string): string => {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
};

interface Delegates {
  user: { update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown> };
  notification: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
  notificationTemplate?: { createMany(args: { data: Record<string, unknown>[]; skipDuplicates: boolean }): Promise<unknown> };
}

export const ensureStaffInvitationTemplates = async (db: Delegates): Promise<void> => {
  if (!db.notificationTemplate) return;
  await db.notificationTemplate.createMany({
    data: [
      {
        code: STAFF_INVITATION_TEMPLATE,
        channel: "EMAIL",
        lang: "EN",
        subjectTemplate: "You have been invited to the back office",
        bodyTemplate:
          "You were invited to the payment gateway back office. Open the back office, choose \"Accept invitation\" and enter this invitation code: {{token}}. You will choose your own password and the phone number that receives your sign-in codes. The code works once and expires in 7 days. If you did not expect this, ignore this message.",
      },
      {
        code: STAFF_INVITATION_TEMPLATE,
        channel: "EMAIL",
        lang: "AR",
        subjectTemplate: "تمت دعوتك إلى لوحة الإدارة",
        bodyTemplate:
          "تمت دعوتك إلى لوحة إدارة بوابة الدفع. افتح لوحة الإدارة واختر \"قبول الدعوة\" ثم أدخل رمز الدعوة التالي: {{token}}. ستختار كلمة المرور الخاصة بك ورقم الهاتف الذي يستقبل رموز الدخول. يعمل الرمز مرة واحدة وتنتهي صلاحيته بعد 7 أيام. إذا لم تتوقع هذه الدعوة فتجاهل هذه الرسالة.",
        confidentialityClass: "INTERNAL",
      },
    ].map((template) => ({ confidentialityClass: "INTERNAL", version: 1, active: true, ...template })),
    skipDuplicates: true,
  });
};

/**
 * Issues (or re-issues) the invitation of a staff user: stores the token HASH and the expiry on the user,
 * clears any credential a maker set earlier, and queues the email. The token itself is returned to nobody:
 * it only exists sealed in the notification payload until the worker opens it at send time.
 */
export const issueStaffInvitation = async (
  db: Delegates,
  input: { userId: string; email: string; now?: Date },
): Promise<{ expiresAt: Date }> => {
  const now = input.now ?? new Date();
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(now.getTime() + STAFF_INVITATION_TTL_MS);
  await ensureStaffInvitationTemplates(db);
  await db.user.update({
    where: { id: input.userId },
    data: {
      invitationTokenHash: hashInvitationToken(token),
      invitationExpiresAt: expiresAt,
      // The invitee sets both; whatever a maker (or an earlier invitation) left is discarded.
      passwordHash: null,
      phone: null,
    },
  });
  await db.notification.create({
    data: {
      eventId: `staff-invitation:${input.userId}:${randomBytes(8).toString("hex")}`,
      recipientUserId: input.userId,
      templateCode: STAFF_INVITATION_TEMPLATE,
      channel: "EMAIL",
      lang: "EN",
      // Never the plaintext token or address: the worker opens them at send time.
      payloadJson: { tokenCiphertext: await vault.encryptSecret(token, "staff-invitation") },
      addressCiphertext: await vault.encryptSecret(input.email, "notification-address"),
      addressMasked: maskEmail(input.email),
      status: "QUEUED",
      attempts: 0,
    },
  });
  return { expiresAt };
};

export const openInvitationToken = (ciphertext: string): Promise<string> => vault.decryptSecret(ciphertext);
