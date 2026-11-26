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
/**
 * Origin the payer's BROWSER loads the emulator SDK from (widget script URLs + allowed origins).
 * Defaults to `FAKE_RAILS_PUBLIC_BASE_URL`. Set it separately when core reaches the emulator on a
 * private address (e.g. `http://127.0.0.1:4104`) but browsers only reach it through a forwarded
 * URL (GitHub Codespaces).
 */
const FAKE_RAILS_BROWSER_BASE_URL =
  process.env.FAKE_RAILS_BROWSER_BASE_URL?.trim() || FAKE_RAILS_PUBLIC_BASE_URL;
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
    const scriptUrl = `${FAKE_RAILS_BROWSER_BASE_URL.replace(/\/$/, "")}/sdk/${script}`;
    await client.widgetDefinition.update({
      where: { id: widget.id },
      data: {
        scriptUrls: json([scriptUrl]),
        scriptSriHashes: json([]),
        allowedOrigins: json([FAKE_RAILS_BROWSER_BASE_URL.replace(/\/$/, "")]),
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

/** Entry names the ApiConsumer looks up (apiKey / token / username+password / secret / OAuth client). */
const DEMO_CREDENTIAL_KEYS = ["apiKey", "token", "username", "password", "secret", "clientId", "clientSecret"] as const;

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

      // A freshly seeded platform set has no entries (real secrets are only written through the credential
      // API), so no emulated gateway could authenticate. The emulator does not check key values, so create
      // a demo manifest of well-known entry names, with secrets derived from the seeder token. Existing
      // entries are never replaced, and gateways that need real certificates (MUTUAL_TLS) stay unconfigured.
      if (entries.length === 0 && ["VERIFIED", "UNTESTED"].includes(String(set.status))) {
        for (const key of DEMO_CREDENTIAL_KEYS) {
          const value = await vault.encryptSecret(deriveFakeRailsSecret(code, `demo:${key}`), "credential-set");
          next.push({ key, type: "HEADER", value, isSecret: true, secretVersion: 1 });
        }
        // Signing / webhook secrets referenced by the gateway's crypto profiles (key = the profile's secretKeyRef).
        const refs = [...new Set(version.cryptoProfiles.map((profile) => profile.secretKeyRef).filter((ref): ref is string => Boolean(ref)))];
        for (const ref of refs) {
          const purpose = version.cryptoProfiles.some((profile) => profile.secretKeyRef === ref && profile.purpose === "INBOUND_VERIFY") ? "webhook" : "sign";
          const value = await vault.encryptSecret(deriveFakeRailsSecret(code, purpose), "credential-set");
          next.push({ key: ref, type: "HEADER", value, isSecret: true, secretVersion: 1 });
        }
        changed = true;
      }

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
  // The v38 migration stamps a fresh database LIVE unless the migration
  // session carries app.execution_plane=SANDBOX. The deploy sets that GUC on
  // the sandbox owner URL, but an existing sandbox database may still carry
  // the migration default. Stamp it only when the connected database name is
  // explicitly the configured SANDBOX_DB_NAME, so this can never flip Live.
  if (process.env.EXECUTION_PLANE === "SANDBOX" && process.env.SANDBOX_DB_NAME) {
    const [database] = await client.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    if (database?.name === process.env.SANDBOX_DB_NAME) {
      await client.systemExecutionPlane.upsert({
        where: { id: 1 },
        update: { plane: "SANDBOX", allowFakeRails: true },
        create: { id: 1, plane: "SANDBOX", allowFakeRails: true },
      });
    }
  }
  // v38: pointing seeded gateways at Fake Rails is a development activity.
  // The LIVE database fence refuses it unless the deployment explicitly
  // opted in (deploy sets this for a development/test server, never for
  // production).
  const allowFakeRailsOnLive =
    process.env.NODE_ENV !== "production"
    || String(process.env.PLANE_FENCE_ALLOW_FAKE_RAILS_ON_LIVE ?? "false").toLowerCase() === "true";
  if (allowFakeRailsOnLive) {
    await client.systemExecutionPlane.updateMany({
      where: { id: 1, plane: "LIVE" },
      data: { allowFakeRails: true },
    });
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
