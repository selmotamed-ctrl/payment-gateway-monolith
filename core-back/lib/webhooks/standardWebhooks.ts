import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The Standard Webhooks signature scheme (https://www.standardwebhooks.com/), AUTO-34.
 *
 *   webhook-id         stable per event (the same on every retry and for every endpoint)
 *   webhook-timestamp  Unix seconds, set per ATTEMPT
 *   webhook-signature  space-separated `v1,<base64 HMAC-SHA256>` over `<id>.<timestamp>.<body>`; one entry per active
 *                      secret, so a merchant can rotate the secret with an overlap window and verify with either.
 *
 * The signing key is the base64-decoded part of the `whsec_...` secret.
 */
export const WEBHOOK_SECRET_PREFIX = "whsec_";
export const WEBHOOK_SIGNATURE_VERSION = "v1";

export const generateWebhookSecret = (): string => `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64")}`;

const keyOf = (secret: string): Buffer => {
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX)) throw new Error("a webhook secret starts with whsec_");
  const key = Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), "base64");
  if (key.length < 16) throw new Error("a webhook secret must carry at least 16 key bytes");
  return key;
};

/** `v1,<base64>` for one secret. */
export const signWebhookWithSecret = (input: { id: string; timestampSeconds: number; body: string; secret: string }): string =>
  `${WEBHOOK_SIGNATURE_VERSION},${createHmac("sha256", keyOf(input.secret)).update(`${input.id}.${input.timestampSeconds}.${input.body}`, "utf8").digest("base64")}`;

/** The three headers of one attempt, signed with every active secret. */
export const buildWebhookHeaders = (input: { id: string; timestampSeconds: number; body: string; secrets: readonly string[] }): Record<string, string> => {
  if (input.secrets.length === 0) throw new Error("at least one signing secret is required");
  return {
    "webhook-id": input.id,
    "webhook-timestamp": String(input.timestampSeconds),
    "webhook-signature": input.secrets.map((secret) => signWebhookWithSecret({ ...input, secret })).join(" "),
  };
};

/**
 * Verifies a received webhook: a valid timestamp inside the tolerance (replay protection) and a signature that matches
 * with any of the secrets. This is what a merchant's receiver does; the guide's generated code does the same.
 */
export const verifyWebhook = (input: {
  headers: Record<string, string | undefined>;
  body: string;
  secrets: readonly string[];
  toleranceSeconds?: number;
  now?: Date;
}): boolean => {
  const id = input.headers["webhook-id"];
  const timestamp = input.headers["webhook-timestamp"];
  const signatures = input.headers["webhook-signature"];
  if (!id || !timestamp || !signatures || !/^\d{1,12}$/.test(timestamp)) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > (input.toleranceSeconds ?? 300)) return false;
  const provided = signatures.split(" ").filter((entry) => entry.startsWith(`${WEBHOOK_SIGNATURE_VERSION},`)).map((entry) => entry.slice(WEBHOOK_SIGNATURE_VERSION.length + 1));
  for (const secret of input.secrets) {
    const expected = Buffer.from(signWebhookWithSecret({ id, timestampSeconds: Number(timestamp), body: input.body, secret }).slice(WEBHOOK_SIGNATURE_VERSION.length + 1));
    for (const candidate of provided) {
      const buffer = Buffer.from(candidate);
      if (buffer.length === expected.length && timingSafeEqual(buffer, expected)) return true;
    }
  }
  return false;
};
