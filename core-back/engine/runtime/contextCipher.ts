import type { ContextCipher } from "../flow/DynamicRailEngine";
import { Vault } from "../crypto/Vault";

/**
 * The context of an attempt carries the state of the flow between the phases
 * (the `process_id` of an OTP confirmation, the `transfer_uuid` of an instant
 * payment, the `order_id` of a hosted session). It is persisted encrypted, so
 * that a gateway reference is never written to the database in clear text.
 */
export class VaultContextCipher implements ContextCipher {
  private readonly vault: Vault;
  private readonly keyId: string;

  constructor(vault: Vault = new Vault(), keyId = "attempt-context") {
    this.vault = vault;
    this.keyId = keyId;
  }

  async encrypt(value: unknown): Promise<string> {
    return this.vault.encryptSecret(JSON.stringify(value ?? {}), this.keyId);
  }

  async decrypt(payload: string): Promise<unknown> {
    const plaintext = await this.vault.decryptSecret(payload);
    try {
      return JSON.parse(plaintext) as unknown;
    } catch {
      return {};
    }
  }
}
