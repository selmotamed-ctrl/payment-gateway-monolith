import type { PrismaLike } from "../../engine/db/ports";

export interface KybDuplicateLookup {
  sha256: string;
  merchantId: string;
}

export const findDuplicateKybMerchant = async (
  tx: PrismaLike,
  input: KybDuplicateLookup,
): Promise<string | null> => {
  if (!input.sha256 || !input.merchantId) {
    return null;
  }
  const rows = (await tx.$queryRawUnsafe(
    "SELECT merchant_id FROM kyb_documents WHERE sha256 = ? AND merchant_id <> ? LIMIT 1",
    input.sha256,
    input.merchantId,
  )) as Array<Record<string, unknown>>;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return row ? String(row.merchant_id ?? row.merchantId ?? "") || null : null;
};

export const resolveKybDuplicateOfMerchant = async (
  tx: PrismaLike,
  input: KybDuplicateLookup & { duplicateOfMerchantId?: string | null },
): Promise<string | null> => {
  if (input.duplicateOfMerchantId !== undefined) {
    return input.duplicateOfMerchantId;
  }
  return findDuplicateKybMerchant(tx, input);
};

export const isKybDuplicate = (duplicateOfMerchantId: string | null | undefined): boolean =>
  Boolean(duplicateOfMerchantId);
