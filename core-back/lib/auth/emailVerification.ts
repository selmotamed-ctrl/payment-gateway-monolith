import type { PrismaLike } from "../../engine/db/ports";
import { ApiError } from "../error";
import { issueMfaChallenge, verifyMfaChallenge, MFA_TTL_MS } from "./mfaChallenges";
import { getCommunicationConfiguration, hasRealEmail } from "../communication/settings";
import { resolveOtpDelivery } from "../communication/policy";
import { ensureCommunicationTemplates } from "../communication/templates";

export type AuthChannel = "ADMIN" | "MERCHANT";

export interface AuthUserRecord {
  id: string;
  email: string;
  phone: string | null;
  status: string;
  role: string;
  merchantId: string | null;
}

const MERCHANT_ROLES = ["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"] as const;

const userFilterFor = (channel: AuthChannel): Record<string, unknown> =>
  channel === "MERCHANT"
    ? { merchantId: { not: null }, role: { in: [...MERCHANT_ROLES] } }
    : { merchantId: null, role: { notIn: [...MERCHANT_ROLES] } };

export const findAuthUserByEmail = async (
  db: PrismaLike,
  email: string,
  channel: AuthChannel,
): Promise<AuthUserRecord | null> => {
  const normalized = email.trim().toLowerCase();
  if (!hasRealEmail(normalized)) return null;
  return db.user.findFirst({
    where: { email: normalized, ...userFilterFor(channel) },
    select: { id: true, email: true, phone: true, status: true, role: true, merchantId: true },
  });
};

/**
 * True when this user still has to prove ownership of the mailbox.
 *
 * Legacy accounts without an EMAIL identity row are grandfathered (the migration backfills active users, but a
 * phone-only account must not be locked out by a row that never existed).
 */
export const isEmailVerificationRequired = async (db: PrismaLike, user: AuthUserRecord): Promise<boolean> => {
  if (!hasRealEmail(user.email)) return false;
  const identity = await db.userIdentity.findFirst({
    where: { userId: user.id, kind: "EMAIL", identifierNormalized: user.email.trim().toLowerCase() },
    select: { id: true, verifiedAt: true },
  });
  if (!identity) {
    const anyIdentity = await db.userIdentity.findFirst({
      where: { userId: user.id, kind: "EMAIL" },
      select: { id: true },
    });
    return Boolean(anyIdentity);
  }
  return !identity.verifiedAt;
};

export const markEmailVerified = async (db: PrismaLike, userId: string, email: string): Promise<void> => {
  const identifier = email.trim().toLowerCase();
  const existing = await db.userIdentity.findFirst({
    where: { userId, kind: "EMAIL", identifierNormalized: identifier },
    select: { id: true },
  });
  if (existing) {
    await db.userIdentity.update({ where: { id: existing.id }, data: { verifiedAt: new Date() } });
    return;
  }
  await db.userIdentity.create({
    data: {
      userId,
      kind: "EMAIL",
      identifierNormalized: identifier,
      verifiedAt: new Date(),
      isPrimary: true,
    },
  });
};

export const issueEmailVerification = async (
  db: PrismaLike,
  input: { user: AuthUserRecord; channel: AuthChannel; ip: string | null },
): Promise<{ challengeId: string; channels: Array<"EMAIL" | "SMS">; destinationMasked: Record<string, string> }> => {
  await ensureCommunicationTemplates(db);
  const config = await getCommunicationConfiguration(db as never);
  const delivery = resolveOtpDelivery(
    config,
    { email: input.user.email, phone: input.user.phone },
    { channel: input.channel, purpose: "EMAIL_VERIFICATION" },
  );
  if (delivery.channels.length === 0) {
    throw new ApiError(
      503,
      input.channel === "MERCHANT" ? "AUTH_MAINTENANCE_EMAIL_NOT_CONFIGURED" : "NO_DELIVERY_CHANNEL",
      input.channel === "MERCHANT"
        ? "Merchant registration is unavailable until email delivery is configured in Platform Settings"
        : "No configured channel can deliver a verification code",
    );
  }
  return issueMfaChallenge(db as never, {
    userId: input.user.id,
    channel: input.channel,
    purpose: "EMAIL_VERIFICATION",
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
};

export const verifyEmailAddress = async (
  db: PrismaLike,
  input: { email: string; code: string; channel: AuthChannel },
): Promise<AuthUserRecord> => {
  const user = await findAuthUserByEmail(db, input.email, input.channel);
  if (!user) {
    throw new ApiError(401, "EMAIL_VERIFICATION_INVALID", "The verification code is invalid or expired");
  }
  await verifyMfaChallenge(db as never, {
    challengeId: await latestChallengeId(db, user.id, "EMAIL_VERIFICATION", input.channel),
    code: input.code,
    channel: input.channel,
    purpose: "EMAIL_VERIFICATION",
  });
  await markEmailVerified(db, user.id, user.email);
  return user;
};

const latestChallengeId = async (
  db: PrismaLike,
  userId: string,
  purpose: string,
  channel: AuthChannel,
): Promise<string> => {
  const row = await db.mfaChallenge.findFirst({
    where: { userId, purpose, channel, consumedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!row) throw new ApiError(401, "MFA_CHALLENGE_INVALID", "The verification challenge is invalid or expired");
  return String(row.id);
};

export const emailVerificationTtlMinutes = MFA_TTL_MS / 60_000;
