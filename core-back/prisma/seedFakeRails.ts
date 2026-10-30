import "dotenv/config";
import { createHmac } from "node:crypto";
import { Prisma } from "../generated/prisma/client";
import { client, ensureSchemaVersion } from "./client";
import { Vault } from "../engine/crypto/Vault";

/**
 * Points every seeded gateway at the standalone Fake Payment Rails emulator.
 *
 * This is the bridge that makes the whole platform work out of the box with
 * the emulator:
 *
 *  - each `gateway_environments` row gets the Fake Rails base URL and an
 *    `allowed_hosts` entry (which the scoped SSRF allowlist also requires);
 *  - the widget definitions of Moamalat / MPGS load the emulator's SDK;
 *  - the inbound-verify crypto secrets are derived from the shared seeder
 *    token, so signatures produced by Fake Rails verify with real crypto and
 *    zero bypassed checks;
 *  - `server.environment_mode` is set to `TEST_SANDBOX` for the synthetic
 *    seeder's safety gate.
 */

const json = (value: unknown): Prisma.InputJsonValue => value as unknown as Prisma.InputJsonValue;

const FAKE_RAILS_PUBLIC_BASE_URL =
  process.env.FAKE_RAILS_PUBLIC_BASE_URL ?? "http://127.0.0.1:8444";
const FAKE_RAILS_SEEDER_TOKEN = process.env.FAKE_RAILS_SEEDER_TOKEN ?? "";
const FAKE_RAILS_ALLOWED_HOSTS = (process.env.FAKE_RAILS_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const baseHost = (() => {
  try {
    return new URL(FAKE_RAILS_PUBLIC_BASE_URL).hostname;
  } catch {
    return "127.0.0.1";
  }
})();

const allowedHosts = [...new Set([
  baseHost,
  ...FAKE_RAILS_ALLOWED_HOSTS,
  "127.0.0.1",
  "localhost",
])];

export const deriveFakeRailsSecret = (gatewayCode: string, purpose: string): string =>
  createHmac("sha256", FAKE_RAILS_SEEDER_TOKEN)
    .update(`fake-rails:${gatewayCode}:${purpose}`)
    .digest("hex");

const gatewayBaseUrl = (gatewayCode: string): string =>
  `${FAKE_RAILS_PUBLIC_BASE_URL.replace(/\/$/, "")}/rails/${gatewayCode}`;

const SDK_BY_GATEWAY: Record<string, string> = {
  moamalat: "moamalat-lightbox.js",
  mpgs: "mpgs-session.js",
};

const updateEnvironments = async (): Promise<number> => {
  const versions = await client.gatewayVersion.findMany({
    include: { gateway: true, environments: true },
  });
  let updated = 0;
  for (const version of versions) {
    const code = version.gateway.code;
    const baseUrl = gatewayBaseUrl(code);
    for (const environment of version.environments) {
      const existing = (environment.baseUrls ?? {}) as Record<string, string>;
      const keys = Object.keys(existing).length > 0 ? Object.keys(existing) : ["api"];
      const baseUrls = Object.fromEntries(keys.map((key) => [key, baseUrl]));
      await client.gatewayEnvironment.update({
        where: { id: environment.id },
        data: {
          baseUrls: json(baseUrls),
          allowedHosts: json([...new Set([...allowedHosts, ...((environment.allowedHosts as string[]) ?? [])])]),
          enabled: true,
        },
      });
      updated += 1;
    }
  }
  return updated;
};

const updateWidgets = async (): Promise<number> => {
  const widgetDefinitions = await client.widgetDefinition.findMany({
    include: { route: { include: { gateway: true } } },
  });
  let updated = 0;
  for (const widget of widgetDefinitions) {
    const code = widget.route.gateway.code;
    const script = SDK_BY_GATEWAY[code];
    if (!script) continue;
    const scriptUrl = `${FAKE_RAILS_PUBLIC_BASE_URL.replace(/\/$/, "")}/sdk/${script}`;
    await client.widgetDefinition.update({
      where: { id: widget.id },
      data: {
        scriptUrls: json([scriptUrl]),
        scriptSriHashes: json([]),
        allowedOrigins: json([FAKE_RAILS_PUBLIC_BASE_URL.replace(/\/$/, "")]),
      },
    });
    updated += 1;
  }
  return updated;
};

const updateWebhookChannels = async (): Promise<number> => {
  const channels = await client.confirmationChannel.findMany({
    include: { gatewayVersion: { include: { gateway: true } } },
  });
  let updated = 0;
  const claimed = new Set<string>();
  for (const channel of channels) {
    if (channel.type !== "WEBHOOK") continue;
    const code = channel.gatewayVersion.gateway.code;
    const token = `${code}-webhook`;
    if (claimed.has(token)) continue;
    try {
      await client.confirmationChannel.update({
        where: { id: channel.id },
        data: { pathToken: token },
      });
      claimed.add(token);
      updated += 1;
    } catch {
      // Another version already owns the token; the existing channel is used.
    }
  }
  return updated;
};

const updateCredentialSecrets = async (): Promise<number> => {
  if (!FAKE_RAILS_SEEDER_TOKEN) return 0;
  const vault = new Vault();
  const versions = await client.gatewayVersion.findMany({
    include: { gateway: true, cryptoProfiles: true },
  });
  let updated = 0;
  for (const version of versions) {
    const code = version.gateway.code;
    const credentialSets = await client.credentialSet.findMany({
      where: { gatewayId: version.gatewayId, ownerType: "PLATFORM" },
    });
    for (const set of credentialSets) {
      const entries = Array.isArray(set.entriesCiphertext)
        ? (set.entriesCiphertext as Array<{ key: string; type: string; value: string; isSecret: boolean; secretVersion?: number }>)
        : [];
      let changed = false;
      const next = [];
      for (const entry of entries) {
        const profiles = version.cryptoProfiles.filter((profile) => profile.secretKeyRef === entry.key);
        if (profiles.length === 0) {
          next.push(entry);
          continue;
        }
        const purpose = profiles.some((profile) => profile.purpose === "INBOUND_VERIFY") ? "webhook" : "sign";
        const secret = deriveFakeRailsSecret(code, purpose);
        const encrypted = await vault.encryptSecret(secret, "credential-set");
        next.push({ ...entry, value: encrypted, isSecret: true, secretVersion: (entry.secretVersion ?? 1) + 1 });
        changed = true;
      }
      if (changed) {
        await client.credentialSet.update({
          where: { id: set.id },
          data: { entriesCiphertext: json(next), status: "VERIFIED", lastVerifiedAt: new Date() },
        });
        updated += 1;
      }
    }
  }
  return updated;
};

const ensureEnvironmentSetting = async (): Promise<void> => {
  await client.platformSetting.upsert({
    where: { key_scope_version: { key: "server.environment_mode", scope: "PLATFORM", version: 1 } },
    update: { valueJson: json({ mode: "TEST_SANDBOX" }), effectiveFrom: new Date() },
    create: {
      key: "server.environment_mode",
      scope: "PLATFORM",
      version: 1,
      valueJson: json({ mode: "TEST_SANDBOX" }),
      effectiveFrom: new Date(),
    },
  });
};

export const seedFakeRails = async (): Promise<void> => {
  await ensureSchemaVersion();
  if (!FAKE_RAILS_SEEDER_TOKEN) {
    throw new Error("FAKE_RAILS_SEEDER_TOKEN is required to seed the Fake Rails blueprints");
  }
  const environments = await updateEnvironments();
  const widgets = await updateWidgets();
  const channels = await updateWebhookChannels();
  const credentials = await updateCredentialSecrets();
  await ensureEnvironmentSetting();
  console.log(
    `Fake Rails blueprints seeded: ${environments} environment(s), ${widgets} widget(s), ${channels} webhook channel(s), ${credentials} credential set(s).`,
  );
  console.log(`Base URL: ${FAKE_RAILS_PUBLIC_BASE_URL}`);
  console.log(`Allowed hosts: ${allowedHosts.join(", ")}`);
};

if (import.meta.main) {
  seedFakeRails()
    .then(async () => {
      await client.$disconnect();
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      console.error(error);
      await client.$disconnect();
      process.exit(1);
    });
}
