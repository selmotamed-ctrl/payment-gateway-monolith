import { randomBytes } from "node:crypto";
import { Vault } from "../../engine/crypto/Vault";
import type { PrismaLike } from "../../engine/db/ports";
import { getCommunicationConfiguration, hasRealEmail, maskEmailAddress, maskPhoneNumber } from "./settings";
import { resolveOtpDelivery } from "./policy";

const vault = new Vault();

export interface QueueNoticeInput {
  userId?: string | null;
  merchantId?: string | null;
  templateCode: string;
  lang?: "EN" | "AR";
  payload?: Record<string, unknown>;
  /** A unique key per logical event; the channel is appended. */
  eventKey: string;
  email?: string | null;
  phone?: string | null;
  channels: Array<"EMAIL" | "SMS" | "IN_APP">;
}

/**
 * Queues a rendered notification on the outbox with the REAL destination sealed. Masked addresses are for logs only.
 * Any missing or unusable address is skipped (an IN_APP row never needs one).
 */
export const queueCommunicationNotice = async (db: PrismaLike, input: QueueNoticeInput): Promise<number> => {
  const rows: Array<Record<string, unknown>> = [];
  for (const channel of input.channels) {
    let address = "";
    let masked = "in-app";
    if (channel === "EMAIL") {
      if (!hasRealEmail(input.email)) continue;
      address = String(input.email);
      masked = maskEmailAddress(address);
    } else if (channel === "SMS") {
      if (!input.phone) continue;
      address = input.phone;
      masked = maskPhoneNumber(address);
    }
    rows.push({
      eventId: `notice:${input.eventKey}:${channel}`.slice(0, 191),
      recipientUserId: input.userId ?? null,
      recipientMerchantId: input.merchantId ?? null,
      templateCode: input.templateCode,
      channel,
      lang: input.lang ?? "EN",
      payloadJson: { ...(input.payload ?? {}), noticeNonce: randomBytes(6).toString("hex") },
      addressCiphertext: address ? await vault.encryptSecret(address, "notification-address") : "",
      addressMasked: masked,
      status: "QUEUED",
      attempts: 0,
    });
  }
  if (rows.length === 0) return 0;
  const created = await db.notification.createMany({ data: rows, skipDuplicates: true });
  return Number(created?.count ?? 0);
};

export const securityNoticeChannels = async (
  db: PrismaLike,
  templateCode: string,
  recipient: { email?: string | null; phone?: string | null },
): Promise<Array<"EMAIL" | "SMS">> => {
  const config = await getCommunicationConfiguration(db as never);
  const delivery = resolveOtpDelivery(config, recipient, { channel: "ADMIN", purpose: "PASSWORD_RESET" });
  return delivery.channels.filter((channel): channel is "EMAIL" | "SMS" => channel !== undefined);
};
