import { createHash } from "node:crypto";
import type { PrismaLike } from "../db/ports";
import type {
  CallbackVerificationResult,
  CallbackVerifier,
} from "../flow/DynamicRailEngine";
import type { AdapterEvidence } from "../flow/NativeAdapterRegistry";
import { CryptoEngine, type HashOutputEncoding, type KeyEncoding } from "../crypto/CryptoEngine";
import { Vault } from "../crypto/Vault";
import { ApiError } from "../../lib/error";

export interface InboundCallbackRequest {
  rawBody: Buffer;
  headers: Record<string, string>;
  sourceIp: string;
}

interface CredentialEntry {
  key: string;
  type: string;
  value: string;
  isSecret: boolean;
  secretVersion?: number;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const readSelector = (payload: unknown, selector: string | null | undefined): string | null => {
  if (!selector) {
    return null;
  }
  let cursor: unknown = payload;
  for (const segment of selector.split(".")) {
    if (cursor && typeof cursor === "object" && segment in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return null;
    }
  }
  if (typeof cursor === "string") {
    return cursor.length > 0 ? cursor : null;
  }
  if (typeof cursor === "number" && Number.isFinite(cursor)) {
    return String(cursor);
  }
  return null;
};

const parsePayload = (rawBody: Buffer, format: string): unknown => {
  if (!rawBody.length) {
    return {};
  }
  const text = rawBody.toString("utf8");
  if (format === "FORM") {
    const params = new URLSearchParams(text);
    return Object.fromEntries(params.entries());
  }
  if (format === "XML") {
    return { raw: text };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

/**
 * Verifies inbound gateway callbacks before any trust decision is made.
 *
 * The verifier is deliberately conservative:
 *  - the source IP must be inside the channel's allowlist (when configured);
 *  - the callback timestamp must be inside `timestamp_tolerance_sec`;
 *  - the signature is verified in constant time against EVERY active
 *    `secret_version` of the channel's credential set, so a rotated secret
 *    never rejects an in-flight callback and an old secret never stays valid;
 *  - the attempt is correlated from the channel's `correlation_selector`.
 */
export class PrismaCallbackVerifier implements CallbackVerifier {
  private readonly client: PrismaLike;
  private readonly vault: Vault;
  private readonly crypto: CryptoEngine;

  constructor(client: PrismaLike, vault: Vault = new Vault(), crypto: CryptoEngine = new CryptoEngine()) {
    this.client = client;
    this.vault = vault;
    this.crypto = crypto;
  }

  async verify(channelToken: string, rawRequest: unknown): Promise<CallbackVerificationResult> {
    const request = rawRequest as InboundCallbackRequest;
    const channel = await this.client.confirmationChannel.findUnique({
      where: { pathToken: channelToken },
      include: { cryptoProfile: true, gatewayVersion: true },
    }) as Record<string, unknown> | null;
    if (!channel) {
      return { verified: false, reason: "INBOUND_CHANNEL_UNKNOWN" };
    }

    const sourceIp = request.sourceIp ?? "";
    if (!this.isIpAllowed(sourceIp, channel.ipAllowlist)) {
      return { verified: false, reason: "INBOUND_IP_NOT_ALLOWED" };
    }

    const payload = parsePayload(request.rawBody, String(channel.bodyFormat ?? "JSON"));
    const timestamp = this.readTimestamp(payload, request.headers, channel);
    if (timestamp !== null) {
      const tolerance = Number(channel.timestampToleranceSec ?? 300);
      const driftSeconds = Math.abs((Date.now() - timestamp) / 1000);
      if (driftSeconds > tolerance) {
        return { verified: false, reason: "INBOUND_TIMESTAMP_OUTSIDE_WINDOW" };
      }
    }

    const correlation = readSelector(payload, channel.correlationSelector as string | null);
    if (!correlation) {
      return { verified: false, reason: "INBOUND_CORRELATION_MISSING" };
    }
    const attempt = await this.client.paymentAttempt.findFirst({
      where: {
        OR: [
          { reference: correlation },
          { providerReference: correlation },
          { networkReference: correlation },
          { gatewayReference: correlation },
        ],
      },
    });
    if (!attempt) {
      return { verified: false, reason: "INBOUND_ATTEMPT_UNKNOWN" };
    }

    const verifyMethod = String(channel.verifyMethod ?? "NONE_PLUS_INQUIRY");
    if (verifyMethod === "IP_ONLY") {
      return {
        verified: true,
        attemptId: attempt.id,
        mustInquire: true,
        reason: "IP_ONLY_REQUIRES_INQUIRY",
      };
    }
    if (verifyMethod === "NONE_PLUS_INQUIRY") {
      return {
        verified: true,
        attemptId: attempt.id,
        mustInquire: true,
        reason: "UNSIGNED_REQUIRES_INQUIRY",
      };
    }

    const signature = this.readSignature(request.headers, channel.signatureHeader as string | null);
    if (!signature) {
      return { verified: false, reason: "INBOUND_SIGNATURE_MISSING" };
    }

    const profile = channel.cryptoProfile as Record<string, unknown> | null;
    const secrets = await this.resolveSecrets(attempt.credentialSetId);
    if (secrets.length === 0) {
      return { verified: false, reason: "INBOUND_CREDENTIAL_MISSING" };
    }

    const verified = secrets.some((secret) =>
      this.verifyWithSecret({
        secret,
        profile,
        verifyMethod,
        payload,
        rawBody: request.rawBody,
        timestamp,
        signature,
      }),
    );
    if (!verified) {
      return { verified: false, reason: "INBOUND_SIGNATURE_INVALID" };
    }

    // The derived facts are authoritative: the raw payload may only fill the
    // gaps, it may never overwrite the mapped status, amount or currency.
    const evidence: AdapterEvidence = {
      ...asRecord(payload),
      status: this.deriveStatus(payload, channel),
      reference: correlation,
      amount: this.deriveAmount(payload),
      currency: this.deriveCurrency(payload),
      environment: attempt.env,
    };

    return {
      verified: true,
      attemptId: attempt.id,
      evidence,
      mustInquire: Boolean(channel.mustInquire),
    };
  }

  private verifyWithSecret(input: {
    secret: CredentialEntry;
    profile: Record<string, unknown> | null;
    verifyMethod: string;
    payload: unknown;
    rawBody: Buffer;
    timestamp: number | null;
    signature: string;
  }): boolean {
    const { profile, verifyMethod, payload, rawBody, timestamp, signature, secret } = input;
    const algorithm = String(profile?.algorithm ?? "HMAC_SHA256");
    const keyEncoding = String(profile?.secretKeyEncoding ?? "UTF8") as KeyEncoding;
    const outputEncoding = String(profile?.outputEncoding ?? "HEX_LOWER") as HashOutputEncoding;
    const canonicalization = String(profile?.canonicalizationMode ?? "RAW_BODY");

    try {
      if (algorithm === "RSA_SHA256") {
        const canonical = this.canonicalString(canonicalization, payload, rawBody, timestamp);
        return this.crypto.rsaSha256Verify(
          secret.value,
          canonical,
          signature,
          outputEncoding === "BASE64" ? "BASE64" : "HEX_LOWER",
        );
      }
      const canonical = this.canonicalString(canonicalization, payload, rawBody, timestamp);
      const expected = algorithm === "HMAC_SHA512"
        ? this.crypto.hmacSha512(secret.value, canonical, keyEncoding, outputEncoding)
        : algorithm === "SHA256"
          ? this.crypto.sha256(canonical, outputEncoding)
          : this.crypto.hmacSha256(secret.value, canonical, keyEncoding, outputEncoding);
      return this.crypto.constantTimeEqual(expected, signature);
    } catch {
      return false;
    }
  }

  private canonicalString(
    mode: string,
    payload: unknown,
    rawBody: Buffer,
    timestamp: number | null,
  ): string {
    const fields = asRecord(payload);
    switch (mode) {
      case "TIMESTAMP_DOT_RAW_BODY":
        return `${timestamp ?? ""}.${rawBody.toString("utf8")}`;
      case "SORTED_VALUES_HASH": {
        const values = Object.values(fields)
          .filter((value) => typeof value !== "object" || value === null)
          .map((value) => String(value))
          .sort();
        return values.join("");
      }
      case "SORTED_KEY_VALUE_AMP": {
        const pairs = Object.keys(fields)
          .filter((key) => key !== "hashed" && key !== "hash" && key !== "signature")
          .sort()
          .map((key) => `${key}=${String(fields[key])}`);
        return pairs.join("&");
      }
      case "JSON_CANONICAL":
        return JSON.stringify(fields, Object.keys(fields).sort());
      case "TEMPLATE_STRING":
        return rawBody.toString("utf8");
      case "RAW_BODY":
      default:
        return rawBody.toString("utf8");
    }
  }

  private async resolveSecrets(credentialSetId: string): Promise<CredentialEntry[]> {
    const credentialSet = await this.client.credentialSet.findUnique({
      where: { id: credentialSetId },
    });
    if (!credentialSet) {
      return [];
    }
    const entries = Array.isArray(credentialSet.entriesCiphertext)
      ? credentialSet.entriesCiphertext as CredentialEntry[]
      : [];
    const resolved: CredentialEntry[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry.value !== "string") {
        continue;
      }
      let value = entry.value;
      if (entry.isSecret) {
        try {
          value = await this.vault.decryptSecret(entry.value);
        } catch {
          continue;
        }
      }
      resolved.push({ ...entry, value });
    }
    return resolved;
  }

  private readSignature(
    headers: Record<string, string>,
    signatureHeader: string | null,
  ): string | null {
    const candidates = signatureHeader
      ? [signatureHeader.toLowerCase()]
      : ["x-signature", "x-gateway-signature", "x-hub-signature-256", "signature"];
    for (const name of candidates) {
      const value = headers[name] ?? headers[name.toUpperCase()];
      if (typeof value === "string" && value.length > 0) {
        return value.trim();
      }
    }
    return null;
  }

  private readTimestamp(
    payload: unknown,
    headers: Record<string, string>,
    channel: Record<string, unknown>,
  ): number | null {
    const fromPayload = readSelector(payload, channel.timestampSelector as string | null);
    const headerValue = headers["x-timestamp"] ?? headers["x-gateway-timestamp"];
    const raw = fromPayload ?? headerValue ?? null;
    if (raw === null) {
      return null;
    }
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(String(raw));
    return Number.isFinite(parsed) ? parsed : null;
  }

  private isIpAllowed(sourceIp: string, allowlist: unknown): boolean {
    const list = Array.isArray(allowlist) ? allowlist.map((entry) => String(entry)) : [];
    if (list.length === 0) {
      return true;
    }
    return list.some((entry) => {
      if (entry === sourceIp) {
        return true;
      }
      if (!entry.includes("/")) {
        return false;
      }
      const segments = entry.split("/");
      const network = segments[0];
      const bits = Number(segments[1] ?? "0");
      if (!network || !Number.isFinite(bits)) {
        return false;
      }
      return ipInCidr(sourceIp, network, bits);
    });
  }

  private deriveStatus(payload: unknown, channel: Record<string, unknown>): string {
    const eventMap = asRecord(channel.eventMap);
    const fields = asRecord(payload);
    const rawStatus = fields.status ?? fields.result ?? fields.ActionCode ?? fields.action;
    if (rawStatus === undefined || rawStatus === null) {
      return "SUCCESS";
    }
    const key = String(rawStatus);
    const mapped = eventMap[key] ?? eventMap[key.toUpperCase()];
    if (typeof mapped === "string") {
      return mapped;
    }
    return key;
  }

  private deriveAmount(payload: unknown): string | undefined {
    const fields = asRecord(payload);
    const value = fields.amount ?? fields.settled_amount ?? fields.total_charged_amount;
    if (value === undefined || value === null) {
      return undefined;
    }
    return String(value);
  }

  private deriveCurrency(payload: unknown): string | undefined {
    const fields = asRecord(payload);
    const value = fields.currency ?? fields.Currency;
    return value === undefined || value === null ? undefined : String(value);
  }
}

const ipToLong = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }
    value = value * 256 + octet;
  }
  return value >>> 0;
};

const ipInCidr = (ip: string, network: string, bits: number): boolean => {
  const ipLong = ipToLong(ip);
  const networkLong = ipToLong(network);
  if (ipLong === null || networkLong === null) {
    return false;
  }
  if (bits <= 0) {
    return true;
  }
  if (bits > 32) {
    return false;
  }
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (ipLong & mask) === (networkLong & mask);
};

export const sha256Hex = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

export const callbackVerificationError = (reason: string): ApiError =>
  new ApiError(401, reason, "The inbound callback could not be verified");
