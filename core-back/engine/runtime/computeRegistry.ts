import { randomUUID } from "node:crypto";
import type { PrismaLike } from "../db/ports";
import type { StepExecutionContext } from "../flow/StepExecutor";
import { CryptoEngine, canonicalize, type KeyEncoding } from "../crypto/CryptoEngine";
import { Vault } from "../crypto/Vault";
import { TransformPipeline } from "../transforms/TransformPipeline";
import { credentialValue, resolveCredentialValues } from "./credentials";

export interface ComputeRegistryOptions {
  db: PrismaLike;
  vault?: Vault;
  crypto?: CryptoEngine;
  pipeline?: TransformPipeline;
}

export type ComputeOperation = (
  input: unknown,
  context: StepExecutionContext,
) => Promise<unknown> | unknown;

/**
 * The declarative compute operations of the seeded blueprints.
 *
 * A `COMPUTE` step performs no HTTP call: it derives a payload from the
 * attempt, the state and the credentials. The operation name is carried by the
 * `method` column of the flow step (see `PrismaFlowProvider`).
 */
export const createComputeRegistry = (options: ComputeRegistryOptions): Record<string, ComputeOperation> => {
  const db = options.db;
  const vault = options.vault ?? new Vault();
  const crypto = options.crypto ?? new CryptoEngine();
  const pipeline = options.pipeline ?? new TransformPipeline();

  /**
   * Blueprint 2: the Moamalat Lightbox payload. The amount is scaled into
   * dirhams (`scale(1000) |> to_int`), the merchant reference is a ten digit
   * numeric value, the transaction timestamp uses `YYYYMMDDHHmm` in
   * `Africa/Tripoli` and the request is signed with the Hex decoded
   * `MOAMALAT_SECURE_HASH` profile.
   */
  const moamalatLightboxPayload: ComputeOperation = async (_input, context) => {
    const attempt = (context.attempt ?? {}) as Record<string, unknown>;
    const amount = String(attempt.totalChargedAmount ?? "0");
    const scaled = await pipeline.apply(amount, [
      { op: "scale", args: [1000] },
      { op: "to_int" },
      { op: "to_string" },
    ]);
    const AmountTrxn = String(scaled);
    const MerchantReference = merchantReference(attempt);
    const TrxDateTime = String(
      await pipeline.apply(new Date(), [
        { op: "format_date", args: ["YYYYMMDDHHmm", "Africa/Tripoli"] },
      ]),
    );
    const credentials = await resolveCredentialValues(
      db,
      vault,
      attempt.credentialSetId as string | undefined,
    );
    const fields: Record<string, unknown> = {
      Amount: AmountTrxn,
      DateTimeLocalTrxn: TrxDateTime,
      MerchantId: credentialValue(credentials, "MID"),
      MerchantReference,
      TerminalId: credentialValue(credentials, "TID"),
    };
    const SecureHash = await signMoamalat(context, fields, credentials);
    return {
      Amount: amount,
      AmountTrxn,
      Currency: String(attempt.currency ?? "LYD"),
      MerchantReference,
      TrxDateTime,
      SecureHash,
    };
  };

  /**
   * Blueprint 7: the dynamic NeomPay QR payload. It is bound to the attempt
   * reference and to the expiry of the session, so a static reusable QR can
   * never be produced.
   */
  const neompayQrPayload: ComputeOperation = async (_input, context) => {
    const attempt = (context.attempt ?? {}) as Record<string, unknown>;
    const reference = String(attempt.gatewayReference ?? attempt.reference ?? "");
    const expiresAt = attempt.expiresAt
      ? new Date(String(attempt.expiresAt))
      : new Date(Date.now() + 600_000);
    const requestId = randomUUID();
    const qr_payload = [
      "neompay://pay",
      `ref=${encodeURIComponent(reference)}`,
      `exp=${Math.floor(expiresAt.getTime() / 1000)}`,
      `nonce=${requestId}`,
    ].join("&");
    return {
      qr_payload,
      request_id: requestId,
      expires_at: expiresAt.toISOString(),
      reference,
    };
  };

  /**
   * The rails that have no public inquiry endpoint (Edfali, Sadad, MobiCash
   * and MyPay) are reconciled against the local settlement state instead of a
   * remote inquiry.
   */
  const localSettlementReconcile: ComputeOperation = async (_input, context) => {
    const attempt = (context.attempt ?? {}) as Record<string, unknown>;
    const attemptId = String(attempt.id ?? "");
    const row = attemptId
      ? await db.paymentAttempt.findUnique({ where: { id: attemptId } })
      : null;
    if (!row) {
      return { status: "UNKNOWN", settled_amount: undefined, provider_reference: null };
    }
    const settled = row.settledAmount === null || row.settledAmount === undefined
      ? undefined
      : String(row.settledAmount);
    return {
      status: row.status === "SUCCEEDED" ? "SUCCESS" : String(row.status ?? "UNKNOWN"),
      settled_amount: settled,
      provider_reference: row.providerReference ?? null,
      currency: row.currency,
      reference: row.gatewayReference ?? row.reference,
    };
  };

  const signMoamalat = async (
    context: StepExecutionContext,
    fields: Record<string, unknown>,
    credentials: Record<string, unknown>,
  ): Promise<string> => {
    const attempt = (context.attempt ?? {}) as Record<string, unknown>;
    const profile = await db.cryptoProfile.findFirst({
      where: {
        gatewayVersionId: attempt.gatewayVersionId as string | undefined,
        name: "MOAMALAT_SECURE_HASH",
      },
    });
    const secretRef = String(profile?.secretKeyRef ?? "CREDENTIAL.MerchantSecretKey");
    const secretName = secretRef.split(".").pop() ?? secretRef;
    const secret = credentialValue(credentials, secretName);
    if (!secret) {
      return "";
    }
    const keyEncoding = (profile?.secretKeyEncoding ?? "HEX") as KeyEncoding;
    const outputEncoding =
      (profile?.outputEncoding ?? "HEX_UPPER") as "HEX_LOWER" | "HEX_UPPER" | "BASE64";
    const canonical = canonicalize("SORTED_KEY_VALUE_AMP", { fields });
    return crypto.hmacSha256(secret, canonical, keyEncoding, outputEncoding);
  };

  return {
    MOAMALAT_LIGHTBOX_PAYLOAD: moamalatLightboxPayload,
    NEOMPAY_QR_PAYLOAD: neompayQrPayload,
    LOCAL_SETTLEMENT_RECONCILE: localSettlementReconcile,
  };
};

/**
 * The Moamalat merchant reference is a ten digit numeric value derived from
 * the attempt reference.
 */
const merchantReference = (attempt: Record<string, unknown>): string => {
  const source = String(attempt.gatewayReference ?? attempt.reference ?? "");
  const digits = source.replace(/\D/g, "");
  if (digits.length === 0) {
    return "0000000000";
  }
  return digits.slice(0, 10).padStart(10, "0");
};
