import { randomBytes } from "node:crypto";
import { Vault } from "../../engine/crypto/Vault";
import { ApiError } from "../error";
import { constantTimeEqual, generateMfaCode, hashMfaCode } from "./index";

/**
 * Server-side, single-use authentication challenges.
 *
 * A challenge is only ever issued after the password step succeeded. The
 * client holds the opaque row id; the code is stored as an HMAC. Every wrong
 * guess is counted in the database (so the limit holds across processes), the
 * challenge dies after `MFA_MAX_ATTEMPTS` wrong codes, on first success, or at
 * expiry, and a locked user is refused new challenges for a cool-down.
 *
 * `purpose` separates sign-in, e-mail verification and password reset. The same
 * six-digit UX is used on every purpose, but a password-reset code can never be
 * replayed as a sign-in code.
 */

export const MFA_MAX_ATTEMPTS = 5;
export const MFA_TTL_MS = 5 * 60_000;
export const MFA_LOCK_COOLDOWN_MS = 15 * 60_000;
export const MFA_ISSUE_WINDOW_MS = 15 * 60_000;
export const MFA_MAX_ISSUES_PER_WINDOW = 5;

export type MfaChannel = "ADMIN" | "MERCHANT";
export type MfaPurpose = "LOGIN_MFA" | "EMAIL_VERIFICATION" | "PASSWORD_RESET";

type Row = Record<string, any>;

interface Delegate {
  create(args: { data: Row }): Promise<Row>;
  findUnique(args: { where: Row }): Promise<Row | null>;
  findMany(args: { where: Row }): Promise<Row[]>;
  updateMany(args: { where: Row; data: Row }): Promise<{ count: number }>;
}

/** The slice of the Prisma client (or a transaction) the challenge store needs. */
export interface MfaStore {
  mfaChallenge: Delegate;
  notification: {
    create(args: { data: Row }): Promise<Row>;
    updateMany?(args: { where: Row; data: Row }): Promise<{ count: number }>;
  };
}

export interface MfaDelivery {
  channel: "EMAIL" | "SMS";
  /** The real destination; sealed before it is stored. */
  address: string;
  /** The masked form shown to the user and written to the log. */
  masked: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const vault = new Vault();

/** The code is stored encrypted; the notification worker opens it at send time. */
export const sealMfaCode = (code: string): Promise<string> => vault.encryptSecret(code, "mfa-sms");
export const openMfaCode = (ciphertext: string): Promise<string> => vault.decryptSecret(ciphertext);
/** The delivery address is encrypted at rest; the transport opens it at send time. */
export const sealMfaAddress = (address: string): Promise<string> => vault.encryptSecret(address, "mfa-address");

const templateForPurpose = (purpose: MfaPurpose): string => purpose;

const canBeVerifiedByPhone = (purpose: MfaPurpose): boolean =>
  purpose === "LOGIN_MFA" || purpose === "PASSWORD_RESET" || purpose === "EMAIL_VERIFICATION";

export const issueMfaChallenge = async (
  db: MfaStore,
  input: {
    userId: string;
    channel: MfaChannel;
    /** Full destination phone. Required unless a `deliveries` list is supplied. */
    phone?: string | null;
    phoneLast4?: string;
    /** Full destination e-mail. Supplied by the communication policy. */
    email?: string | null;
    emailMasked?: string | null;
    /** The exact channels the policy selected. */
    deliveries?: MfaDelivery[];
    purpose?: MfaPurpose;
    ip: string | null;
    templateCode?: string;
    now?: Date;
  },
): Promise<{ challengeId: string; channels: Array<"EMAIL" | "SMS">; destinationMasked: Record<string, string> }> => {
  const purpose = input.purpose ?? "LOGIN_MFA";
  const deliveries: MfaDelivery[] = input.deliveries
    ? input.deliveries
    : input.phone && canBeVerifiedByPhone(purpose)
      ? [
          {
            channel: "SMS",
            address: input.phone,
            masked: input.phoneLast4 ? `*******${input.phoneLast4}` : `*******${input.phone.slice(-4)}`,
          },
        ]
      : [];
  if (deliveries.length === 0) {
    // Fail explicitly instead of queueing a code that can never be delivered.
    throw new ApiError(
      503,
      "NO_DELIVERY_CHANNEL",
      "No configured channel can deliver a verification code to this account. Contact an administrator",
    );
  }
  const now = input.now ?? new Date();
  const recent = await db.mfaChallenge.findMany({
    where: { userId: input.userId, createdAt: { gte: new Date(now.getTime() - MFA_ISSUE_WINDOW_MS) } },
  });
  const lockCutoff = now.getTime() - MFA_LOCK_COOLDOWN_MS;
  if (recent.some((row) => row.lockedAt && new Date(row.lockedAt).getTime() > lockCutoff)) {
    throw new ApiError(429, "MFA_LOCKED", "Too many failed codes. Try again later");
  }
  if (recent.length >= MFA_MAX_ISSUES_PER_WINDOW) {
    throw new ApiError(429, "MFA_RATE_LIMITED", "Too many verification codes were requested. Try again later");
  }
  // A new challenge supersedes every open one of the same user, and any queued
  // code for a superseded challenge must not be delivered after the new code.
  await db.mfaChallenge.updateMany({
    where: { userId: input.userId, consumedAt: null, purpose },
    data: { consumedAt: now },
  });
  const templateCode = input.templateCode ?? templateForPurpose(purpose);
  if (db.notification.updateMany) {
    await db.notification.updateMany({
      where: { recipientUserId: input.userId, templateCode, status: "QUEUED" },
      data: { status: "SUPPRESSED" },
    });
  }
  const code = generateMfaCode();
  const destinationMasked: Record<string, string> = {};
  for (const delivery of deliveries) {
    destinationMasked[delivery.channel === "EMAIL" ? "email" : "phone"] = delivery.masked;
  }
  const row = await db.mfaChallenge.create({
    data: {
      userId: input.userId,
      channel: input.channel,
      purpose,
      codeHash: hashMfaCode(input.userId, code),
      attempts: 0,
      maxAttempts: MFA_MAX_ATTEMPTS,
      expiresAt: new Date(now.getTime() + MFA_TTL_MS),
      ip: input.ip,
      deliveryChannels: deliveries.map((delivery) => delivery.channel),
      destinationMasked,
    },
  });
  const sealedCode = await sealMfaCode(code);
  for (const delivery of deliveries) {
    await db.notification.create({
      data: {
        eventId: `auth:${purpose}:${String(row.id)}:${delivery.channel}`,
        recipientUserId: input.userId,
        templateCode,
        channel: delivery.channel,
        lang: "EN",
        // Never the plaintext code or address: the worker decrypts them at send time.
        payloadJson: { codeCiphertext: sealedCode, ttlMinutes: MFA_TTL_MS / 60_000, platformName: "Payment Gateway" },
        addressCiphertext: await sealMfaAddress(delivery.address),
        status: "QUEUED",
        addressMasked: delivery.masked,
      },
    });
  }
  return {
    challengeId: String(row.id),
    channels: deliveries.map((delivery) => delivery.channel),
    destinationMasked,
  };
};

/** Consumes the challenge when the code is right. Returns the user the password step belongs to. */
export const verifyMfaChallenge = async (
  db: Pick<MfaStore, "mfaChallenge">,
  input: { challengeId: string; code: string; channel: MfaChannel; purpose?: MfaPurpose; now?: Date },
): Promise<{ userId: string }> => {
  const purpose = input.purpose ?? "LOGIN_MFA";
  const now = input.now ?? new Date();
  const invalid = () => new ApiError(401, "MFA_CHALLENGE_INVALID", "The verification challenge is invalid or expired");
  if (!UUID.test(input.challengeId)) throw invalid();
  const row = await db.mfaChallenge.findUnique({ where: { id: input.challengeId } });
  if (
    !row ||
    row.channel !== input.channel ||
    String(row.purpose ?? "LOGIN_MFA") !== purpose ||
    row.consumedAt ||
    new Date(row.expiresAt).getTime() <= now.getTime()
  ) {
    throw invalid();
  }
  const userId = String(row.userId);
  const attemptsBefore = Number(row.attempts);
  const recent = await db.mfaChallenge.findMany({
    where: { userId, createdAt: { gte: new Date(now.getTime() - MFA_LOCK_COOLDOWN_MS) } },
  });
  if (row.lockedAt || row.attempts >= row.maxAttempts || recent.some((entry) => entry.lockedAt)) {
    throw new ApiError(429, "MFA_LOCKED", "Too many failed codes. Try again later");
  }
  // Count the guess first (compare-and-swap on the counter) so concurrent
  // guesses cannot share one attempt.
  const counted = await db.mfaChallenge.updateMany({
    where: { id: row.id, consumedAt: null, lockedAt: null, attempts: attemptsBefore },
    data: { attempts: attemptsBefore + 1 },
  });
  if (counted.count !== 1) throw invalid();
  if (!constantTimeEqual(hashMfaCode(userId, input.code), String(row.codeHash))) {
    if (attemptsBefore + 1 >= Number(row.maxAttempts)) {
      await db.mfaChallenge.updateMany({ where: { id: row.id, lockedAt: null }, data: { lockedAt: now } });
      throw new ApiError(429, "MFA_LOCKED", "Too many failed codes. Try again later");
    }
    throw new ApiError(401, "MFA_CODE_INVALID", "The supplied MFA code is not valid");
  }
  const consumed = await db.mfaChallenge.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (consumed.count !== 1) throw invalid();
  return { userId };
};
