import { Vault } from "../../../engine/crypto/Vault";
import { metaOf, type SeederContext } from "../context";

/**
 * Encrypts every sensitive column the generators left as a pending secret
 * (attempt contexts, national ids, regulatory report payloads, notification
 * addresses) with the REAL Vault, so any code that decrypts them (the engine's
 * `VaultContextCipher`, the notification resolver, the KYB screens) works on
 * synthetic rows exactly as on live rows. The previous generators wrote plain
 * base64, which the Vault rejects.
 */
export const encryptPendingSecrets = async (ctx: SeederContext, vault = new Vault(), concurrency = 64): Promise<number> => {
  const pending = metaOf(ctx).pendingSecrets;
  for (let offset = 0; offset < pending.length; offset += concurrency) {
    await Promise.all(
      pending.slice(offset, offset + concurrency).map(async (secret) => {
        secret.row[secret.field] = await vault.encryptSecret(secret.plaintext, secret.keyId);
      }),
    );
  }
  const count = pending.length;
  pending.length = 0;
  return count;
};
