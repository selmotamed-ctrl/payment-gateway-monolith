import type { PrismaLike } from "../db/ports";
import { Vault } from "../crypto/Vault";

interface CredentialEntryRow {
  key: string;
  type: string;
  value: string;
  isSecret: boolean;
}

/**
 * Resolves the entries of a credential set into a plain map.
 *
 * The outbound consumer applies the authentication headers itself, but the
 * declarative steps also need the raw identifiers of the merchant (the Moamalat
 * `MID` and `TID`, the T-LYNC `store_id` and `store_token`, the Moamalat
 * signing key). Those are read through the vault so that a secret never
 * leaves the encrypted credential set.
 */
export const resolveCredentialValues = async (
  db: PrismaLike,
  vault: Vault,
  credentialSetId: string | null | undefined,
): Promise<Record<string, unknown>> => {
  if (!credentialSetId) {
    return {};
  }
  const credentialSet = await db.credentialSet.findUnique({
    where: { id: credentialSetId },
  });
  if (!credentialSet) {
    return {};
  }
  const entries = Array.isArray(credentialSet.entriesCiphertext)
    ? credentialSet.entriesCiphertext as CredentialEntryRow[]
    : [];
  const values: Record<string, unknown> = {};
  for (const entry of entries) {
    if (!entry || typeof entry.key !== "string" || typeof entry.value !== "string") {
      continue;
    }
    let value: string = entry.value;
    if (entry.isSecret) {
      try {
        value = await vault.decryptSecret(entry.value);
      } catch {
        continue;
      }
    }
    values[entry.key] = value;
    values[entry.key.toLowerCase()] = value;
  }
  return values;
};

/**
 * Reads a credential value by name. The lookup is case insensitive so that
 * `MID`, `Mid` and `mid` all resolve.
 */
export const credentialValue = (
  credentials: Record<string, unknown> | undefined,
  name: string,
): string => {
  if (!credentials) {
    return "";
  }
  const direct = credentials[name];
  if (typeof direct === "string") {
    return direct;
  }
  const lowered = credentials[name.toLowerCase()];
  return typeof lowered === "string" ? lowered : "";
};
