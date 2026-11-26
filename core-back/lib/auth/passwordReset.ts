import type { PrismaLike } from "../../engine/db/ports";
import { ApiError } from "../error";
import { hashPassword, hashMfaCode } from "./index";
import { issueMfaChallenge, verifyMfaChallenge, type MfaPurpose } from "./mfaChallenges";
import { getCommunicationConfiguration, hasRealEmail } from "../communication/settings";
import { resolveOtpDelivery } from "../communication/policy";
import { ensureCommunicationTemplates } from "../communication/templates";
import { queueCommunicationNotice } from "../communication/notices";
import { findAuthUserByEmail, type AuthChannel } from "./emailVerification";

/**
 * Password reset by six-digit OTP.
 *
 * The request endpoint is deliberately enumeration-safe: it always answers 202. Only an active account with a real
 * e-mail receives a code. A successful reset sets `sessions_invalid_before`, so every session issued before the
 * change is refused by `authDoubleCheck` even without knowing its jti.
 */

export const requestPasswordReset = async (
  db: PrismaLike,
  input: { email: string; channel: AuthChannel; ip: string | null },
): Promise<{ requested: true }> => {
  const user = await findAuthUserByEmail(db, input.email, input.channel);
  if (!user || user.status !== "ACTIVE" || !hasRealEmail(user.email)) {
    return { requested: true };
  }
  await ensureCommunicationTemplates(db);
  const config = await getCommunicationConfiguration(db as never);
  if (!config.email.configured && input.channel === "MERCHANT") {
    // The merchant channel is in maintenance; do not queue a code that cannot arrive.
    return { requested: true };
  }
  const delivery = resolveOtpDelivery(
    config,
    { email: user.email, phone: user.phone },
    { channel: input.channel, purpose: "PASSWORD_RESET" },
  );
  if (delivery.channels.length === 0) return { requested: true };
  await issueMfaChallenge(db as never, {
    userId: user.id,
    channel: input.channel,
    purpose: "PASSWORD_RESET",
    email: delivery.email,
    phone: delivery.phone,
    phoneLast4: delivery.phone?.slice(-4),
    deliveries: delivery.channels.map((channel) => ({
      channel,
      address: channel === "EMAIL" ? delivery.email! : delivery.phone!,
      masked: channel === "EMAIL" ? delivery.destinationMasked.email! : delivery.destinationMasked.phone!,
    })),
    ip: input.ip,
  });
  return { requested: true };
};

export const resetPasswordWithCode = async (
  db: PrismaLike,
  input: { email: string; code: string; newPassword: string; channel: AuthChannel },
): Promise<{ userId: string }> => {
  const user = await findAuthUserByEmail(db, input.email, input.channel);
  if (!user || user.status !== "ACTIVE") {
    throw new ApiError(401, "PASSWORD_RESET_INVALID", "The password reset code is invalid or expired");
  }
  const challenge = await db.mfaChallenge.findFirst({
    where: { userId: user.id, purpose: "PASSWORD_RESET", channel: input.channel, consumedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!challenge) {
    throw new ApiError(401, "PASSWORD_RESET_INVALID", "The password reset code is invalid or expired");
  }
  await verifyMfaChallenge(db as never, {
    challengeId: String(challenge.id),
    code: input.code,
    channel: input.channel,
    purpose: "PASSWORD_RESET" as MfaPurpose,
  });
  await ensureCommunicationTemplates(db);
  const passwordHash = await hashPassword(input.newPassword);
  const now = new Date();
  await db.user.update({
    where: { id: user.id },
    data: { passwordHash, sessionsInvalidBefore: now },
  });
  // Tell the owner on every configured channel. A failure here must not undo the reset.
  try {
    const config = await getCommunicationConfiguration(db as never, { force: true });
    const delivery = resolveOtpDelivery(
      config,
      { email: user.email, phone: user.phone },
      { channel: input.channel, purpose: "PASSWORD_RESET" },
    );
    await queueCommunicationNotice(db, {
      userId: user.id,
      merchantId: user.merchantId,
      templateCode: "PASSWORD_CHANGED",
      eventKey: `password-changed:${user.id}:${now.getTime()}`,
      email: user.email,
      phone: user.phone,
      channels: delivery.channels,
      payload: { changedAt: now.toISOString(), platformName: "Payment Gateway" },
    });
  } catch {
    // The notification outbox is best effort; the password change itself is committed.
  }
  return { userId: user.id };
};

export const __testHashCode = hashMfaCode;
