/**
 * Fixture loading, placeholder expansion and inventory seeding for the parity replay.
 *
 * Fixture file shape (a bare array of cases is also accepted):
 *
 * {
 *   "channel": "checkout",
 *   "cases": [
 *     { "name": "link view", "method": "GET", "path": "/api/v1/pay/LNKPARITY01",
 *       "headers": { "x-request-id": "parity-checkout-0001" },
 *       "normalize": { "unorderedPaths": ["/body/visible_rails"] } }
 *   ]
 * }
 *
 * `{{PARITY_MERCHANT_TOKEN}}` and `{{PARITY_ADMIN_TOKEN}}` are expanded in header values,
 * paths and JSON bodies so fixtures do not contain signed blobs.
 *
 * `--seed-from-inventory` builds a new fixture file from the committed route inventory. It is a
 * starting point, not a substitute for a hand-checked case: parameter names become placeholders
 * and some routes need a real seeded id or authority.
 */

import fs from "node:fs";
import path from "node:path";
import type { NormalizeOptions } from "./normalize";
import type { EdgeChannel } from "./edge-launcher";
import { EDGE_CHANNELS, isEdgeChannel } from "./edge-launcher";

export interface FixtureCase {
  name?: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Per-case normaliser overrides (see normalize.ts). */
  normalize?: NormalizeOptions;
  notes?: string;
}

export interface FixtureFile {
  channel: EdgeChannel;
  cases: FixtureCase[];
  /** File the fixture came from, for reports. */
  source?: string;
}

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

export const FIXTURES_ROOT = path.join(REPO_ROOT, "backend-rs", "tests", "parity-fixtures");

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;

const channelFromFilename = (file: string): EdgeChannel | undefined => {
  const base = path.basename(file, ".json").toLowerCase();
  for (const channel of ["checkout", "merchant", "admin"] as const) {
    if (base === channel || base.startsWith(`${channel}-`) || base.endsWith(`-${channel}`)) {
      return channel;
    }
  }
  return undefined;
};

const normalizeFixture = (value: unknown, source: string): FixtureFile => {
  const record = value as { channel?: unknown; cases?: unknown };
  const rawCases = Array.isArray(value) ? value : record.cases;
  if (!Array.isArray(rawCases)) {
    throw new Error(`${source}: expected a JSON list of cases or { channel, cases: [...] }`);
  }
  const channelValue = Array.isArray(value) ? undefined : record.channel;
  const channel =
    typeof channelValue === "string" && isEdgeChannel(channelValue)
      ? channelValue
      : channelFromFilename(source);
  if (!channel) {
    throw new Error(
      `${source}: missing "channel" (checkout|merchant|admin) and the filename does not name one`,
    );
  }
  const cases: FixtureCase[] = rawCases.map((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`${source}: case ${index} is not an object`);
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.method !== "string" || typeof candidate.path !== "string") {
      throw new Error(`${source}: case ${index} needs a string method and path`);
    }
    return {
      name: typeof candidate.name === "string" ? candidate.name : undefined,
      method: candidate.method.toUpperCase(),
      path: candidate.path,
      headers:
        candidate.headers !== undefined && candidate.headers !== null
          ? (candidate.headers as Record<string, string>)
          : undefined,
      body: candidate.body,
      normalize:
        candidate.normalize !== undefined && candidate.normalize !== null
          ? (candidate.normalize as NormalizeOptions)
          : undefined,
      notes: typeof candidate.notes === "string" ? candidate.notes : undefined,
    } satisfies FixtureCase;
  });
  return { channel, cases, source };
};

const listJsonFiles = (target: string): string[] => {
  const absolute = path.resolve(target);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [absolute];
  return fs
    .readdirSync(absolute)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => path.join(absolute, entry));
};

export interface LoadFixtureOptions {
  /** File or directory. Defaults to `<repo>/backend-rs/tests/parity-fixtures/reads`. */
  input?: string;
  /** Only these channels. */
  channels?: EdgeChannel[];
}

export const loadFixtures = (options: LoadFixtureOptions = {}): FixtureFile[] => {
  const input = path.resolve(options.input ?? path.join(FIXTURES_ROOT, "reads"));
  const files = listJsonFiles(input);
  const fixtures = files
    .map((file) => normalizeFixture(readJson<unknown>(file), file))
    .sort(
      (left, right) =>
        EDGE_CHANNELS.indexOf(left.channel) - EDGE_CHANNELS.indexOf(right.channel),
    );
  const filtered = options.channels
    ? fixtures.filter((fixture) => options.channels!.includes(fixture.channel))
    : fixtures;
  if (filtered.length === 0) {
    throw new Error(`no fixture files found in ${input}${options.channels ? ` for ${options.channels.join(",")}` : ""}`);
  }
  return filtered;
};

const expandString = (value: string, variables: Record<string, string>): string =>
  value.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, name: string) => {
    const replacement = variables[name];
    return replacement === undefined ? whole : replacement;
  });

export const expandCasePlaceholders = (
  fixtureCase: FixtureCase,
  variables: Record<string, string>,
): FixtureCase => {
  const headers: Record<string, string> | undefined = fixtureCase.headers
    ? Object.fromEntries(
        Object.entries(fixtureCase.headers).map(([key, value]) => [
          key,
          expandString(value, variables),
        ]),
      )
    : undefined;
  let body = fixtureCase.body;
  if (typeof body === "string") body = expandString(body, variables);
  return {
    ...fixtureCase,
    path: expandString(fixtureCase.path, variables),
    headers,
    body,
  };
};

export interface InventoryRoute {
  method: string;
  fullPath: string;
  service?: string;
  file?: string;
  line?: number;
}

const CHANNEL_FOR_SERVICE: Record<string, EdgeChannel> = {
  "checkout-back": "checkout",
  "merchant-back": "merchant",
  "admin-back": "admin",
};

const authHeaderFor = (channel: EdgeChannel): Record<string, string> => {
  if (channel === "merchant") return { authorization: "Bearer {{PARITY_MERCHANT_TOKEN}}" };
  if (channel === "admin") return { authorization: "Bearer {{PARITY_ADMIN_TOKEN}}" };
  return {};
};

export interface SeedFromInventoryOptions {
  inventoryDir?: string;
  outDir?: string;
  perChannel?: number;
  /** Only consider routes without path parameters. Default false: parameters get safe sample values. */
  parameterlessOnly?: boolean;
}

export interface SeededFixture {
  channel: EdgeChannel;
  file: string;
  cases: number;
}

/** Sample values used to make parameterised inventory routes replayable. */
export const INVENTORY_PARAM_VALUES: Record<string, string> = {
  linkKey: "LNKPARITY01",
  attemptToken: "RETPARITYTOKEN01",
  attemptId: "ATT-PARITY-0001",
  publicId: "ABCDEF0123456789",
  trackId: "FOUNDATION",
  identifier: "ABCDEF0123456789",
  key: "LNKPARITY01",
  id: "00000000-0000-4000-8000-000000000001",
  merchantId: "00000000-0000-4000-8000-000000000002",
  applicationId: "00000000-0000-4000-8000-000000000003",
  walletId: "00000000-0000-4000-8000-000000000004",
  caseId: "00000000-0000-4000-8000-000000000005",
  examId: "FOUNDATION",
  railId: "00000000-0000-4000-8000-000000000006",
};

const concretePath = (routePath: string): string =>
  routePath.replace(/:([A-Za-z0-9_]+)/g, (_whole, name: string) => INVENTORY_PARAM_VALUES[name] ?? "parity");

/**
 * Writes `generated/<channel>.json` fixture files from the committed edge inventory. The output
 * is intentionally outside `reads/`, so the curated smoke set is never replaced by generated
 * routes. Every generated case is a GET with a fixed request id; parameterless routes are chosen
 * first, then parameterised routes with `INVENTORY_PARAM_VALUES` samples.
 */
export const seedFixturesFromInventory = (
  options: SeedFromInventoryOptions = {},
): SeededFixture[] => {
  const inventoryDir =
    options.inventoryDir ??
    path.join(REPO_ROOT, "backend-rs", "tests", "golden-vectors", "route-inventory");
  const outDir = path.resolve(options.outDir ?? path.join(FIXTURES_ROOT, "generated"));
  const perChannel = options.perChannel ?? 4;
  const parameterlessOnly = options.parameterlessOnly === true;
  const inventory = readJson<InventoryRoute[]>(path.join(inventoryDir, "edge-routes.json"));
  const selected = new Map<EdgeChannel, Array<{ route: InventoryRoute; path: string }>>();
  const ordered = [...inventory].sort((left, right) => {
    const leftParams = left.fullPath.includes(":") ? 1 : 0;
    const rightParams = right.fullPath.includes(":") ? 1 : 0;
    return leftParams - rightParams || left.fullPath.localeCompare(right.fullPath);
  });
  for (const route of ordered) {
    if (route.method !== "GET") continue;
    const channel = route.service ? CHANNEL_FOR_SERVICE[route.service] : undefined;
    if (!channel) continue;
    if (route.fullPath === "/health") continue;
    if (parameterlessOnly && route.fullPath.includes(":")) continue;
    const bucket = selected.get(channel) ?? [];
    if (bucket.length >= perChannel) continue;
    const samplePath = concretePath(route.fullPath);
    if (bucket.some((entry) => entry.path === samplePath)) continue;
    bucket.push({ route, path: samplePath });
    selected.set(channel, bucket);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const written: SeededFixture[] = [];
  for (const channel of ["checkout", "merchant", "admin"] as const) {
    const routes = selected.get(channel) ?? [];
    if (routes.length === 0) continue;
    const cases: FixtureCase[] = routes.map(({ route, path: samplePath }, index) => ({
      name: `inventory ${route.method} ${route.fullPath}`,
      method: "GET",
      path: samplePath,
      headers: {
        accept: "application/json",
        "user-agent": "parity-harness/1",
        "x-request-id": `parity-${channel}-inv-${String(index + 1).padStart(4, "0")}`,
        ...authHeaderFor(channel),
      },
      notes: `seeded from ${route.service ?? "inventory"}${route.file ? ` ${route.file}:${route.line ?? "?"}` : ""}${
        samplePath !== route.fullPath ? `; sample parameters ${samplePath}` : ""
      }`,
    }));
    const file = path.join(outDir, `${channel}.json`);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ channel, cases }, null, 2)}\n`,
      "utf8",
    );
    written.push({ channel, file, cases: cases.length });
  }
  return written;
};

