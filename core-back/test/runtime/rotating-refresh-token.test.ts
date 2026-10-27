import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { loadConsumerConfig } from "../../engine/runtime/platform";
import { Vault } from "../../engine/crypto/Vault";
import { invalidationBus } from "../../lib/invalidationBus";
import type { PrismaLike } from "../../engine/db/ports";

const buildClient = (options: { rotateTo?: string } = {}) => {
  const store = new Map<string, Record<string, unknown>>();
  store.set("credential-set-1", {
    id: "credential-set-1",
    gatewayId: "gateway-1",
    env: "SANDBOX",
    entriesCiphertext: [
      { key: "refresh_token", type: "BODY", value: "old-refresh-token", isSecret: false, secretVersion: 1 },
    ],
  });
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    credentialSet: {
      findUnique: async ({ where }: { where: { id: string } }) => store.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.get(where.id);
        if (!row) {
          throw new Error("credential set not found");
        }
        Object.assign(row, data);
        updates.push(data);
        return row;
      },
    },
    gatewayVersion: {
      findFirst: async () => ({
        id: "version-1",
        gatewayId: "gateway-1",
        state: "LIVE",
        auth: [{ env: "SANDBOX", method: "REFRESH_TOKEN", authApply: "BODY", refreshConfigJson: {} }],
        environments: [{ env: "SANDBOX", baseUrls: { api: "https://gateway.example" }, allowedHosts: ["gateway.example"] }],
        setting: { timeoutMs: 15000 },
      }),
    },
    $transaction: async (callback: (tx: never) => Promise<unknown>) => callback(client as never),
    _options: options,
  };
  return { client: client as unknown as PrismaLike, store, updates };
};

describe("rotating refresh token persistence", () => {
  test("encrypts and persists a rotated token, then invalidates the consumer cache", async () => {
    const { client, store } = buildClient();
    const vault = new Vault();
    const published: string[] = [];
    const unsubscribe = invalidationBus.subscribe("credential:*", (event) => {
      published.push((event.payload as { credentialSetId: string }).credentialSetId);
    });
    try {
      const config = await loadConsumerConfig(client, vault, {
        gatewayId: "gateway-1",
        env: "SANDBOX",
        credentialSetId: "credential-set-1",
      });
      expect(typeof config.rotatingRefreshTokenPersistence).toBe("function");

      await config.rotatingRefreshTokenPersistence!({
        newRefreshToken: "rotated-token-value",
        gatewayId: "gateway-1",
        env: "SANDBOX",
        credentialSetId: "credential-set-1",
        selector: "refresh_token",
      });

      const row = store.get("credential-set-1") as { entriesCiphertext: Array<Record<string, unknown>> };
      const entry = row.entriesCiphertext.find((candidate) => candidate.key === "refresh_token");
      expect(entry).toBeDefined();
      // The stored value must be ciphertext, never the plaintext token.
      expect(entry?.value).not.toBe("rotated-token-value");
      expect(entry?.isSecret).toBe(true);
      expect(Number(entry?.secretVersion)).toBeGreaterThan(1);
      expect(await vault.decryptSecret(String(entry?.value))).toBe("rotated-token-value");
      expect(published).toContain("credential-set-1");
    } finally {
      unsubscribe();
    }
  });

  test("the persisted ciphertext is not the plaintext", async () => {
    const { client, store } = buildClient();
    const vault = new Vault();
    const token = `token-${randomBytes(8).toString("hex")}`;
    const config = await loadConsumerConfig(client, vault, {
      gatewayId: "gateway-1",
      env: "SANDBOX",
      credentialSetId: "credential-set-1",
    });
    await config.rotatingRefreshTokenPersistence!({
      newRefreshToken: token,
      gatewayId: "gateway-1",
      env: "SANDBOX",
      credentialSetId: "credential-set-1",
      selector: "refresh_token",
    });
    const serialised = JSON.stringify(store.get("credential-set-1"));
    expect(serialised).not.toContain(token);
  });
});
