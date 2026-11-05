import { randomBytes } from "node:crypto";
import { Vault } from "../../engine/crypto/Vault";
import { ApiError } from "../error";
import { constantTimeEqual, generateMfaCode, hashMfaCode } from "./index";

/**
 * Server-side, single-use MFA challenges.
 *
 * A challenge is only ever issued after the password step succeeded. The
 * client holds the opaque row id; the code is stored as an HMAC. Every wrong
 * guess is counted in the database (so the limit holds across processes), the
 * challenge dies after `MFA_MAX_ATTEMPTS` wrong codes, on first success, or at
 * expiry, and a locked user is refused new challenges for a cool-down.
 */
export const MFA_MAX_ATTEMPTS = 5;
export const MFA_TTL_MS = 5 * 60_000;
export const MFA_LOCK_COOLDOWN_MS = 15 * 60_000;
export const MFA_ISSUE_WINDOW_MS = 15 * 60_000;
export const MFA_MAX_ISSUES_PER_WINDOW = 5;

export type MfaChannel = "ADMIN" | "MERCHANT";

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
  notification: { create(args: { data: Row }): Promise<Row> };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const vault = new Vault();

/** The SMS payload carries the code encrypted; the notification worker opens it at send time. */
export const sealMfaCode = (code: string): Promise<string> => vault.encryptSecret(code, "mfa-sms");
export const openMfaCode = (ciphertext: string): Promise<string> => vault.decryptSecret(ciphertext);

export const issueMfaChallenge = async (
  db: MfaStore,
  input: {
    userId: string;
    channel: MfaChannel;
    phoneLast4: string;
    ip: string | null;
    templateCode?: string;
    now?: Date;
  },
): Promise<{ challengeId: string }> => {
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
  // A new challenge supersedes every open one of the same user.
  await db.mfaChallenge.updateMany({
    where: { userId: input.userId, consumedAt: null },
    data: { consumedAt: now },
  });
  const code = generateMfaCode();
  const row = await db.mfaChallenge.create({
    data: {
      userId: input.userId,
      channel: input.channel,
      codeHash: hashMfaCode(input.userId, code),
      attempts: 0,
      maxAttempts: MFA_MAX_ATTEMPTS,
      expiresAt: new Date(now.getTime() + MFA_TTL_MS),
      ip: input.ip,
    },
  });
  await db.notification.create({
    data: {
      eventId: randomBytes(16).toString("hex"),
      recipientUserId: input.userId,
      templateCode: input.templateCode ?? "LOGIN_MFA",
      channel: "SMS",
      lang: "EN",
      // Never the plaintext code: the worker decrypts `codeCiphertext` for delivery only.
      payloadJson: { codeCiphertext: await sealMfaCode(code) },
      addressCiphertext: "",
      status: "QUEUED",
      addressMasked: input.phoneLast4,
    },
  });
  return { challengeId: String(row.id) };
};

/** Consumes the challenge when the code is right. Returns the user the password step belongs to. */
export const verifyMfaChallenge = async (
  db: Pick<MfaStore, "mfaChallenge">,
  input: { challengeId: string; code: string; channel: MfaChannel; now?: Date },
): Promise<{ userId: string }> => {
  const now = input.now ?? new Date();
  const invalid = () => new ApiError(401, "MFA_CHALLENGE_INVALID", "The MFA challenge is invalid or expired");
  if (!UUID.test(input.challengeId)) throw invalid();
  const row = await db.mfaChallenge.findUnique({ where: { id: input.challengeId } });
  if (!row || row.channel !== input.channel || row.consumedAt || new Date(row.expiresAt).getTime() <= now.getTime()) {
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
