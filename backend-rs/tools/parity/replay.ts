/**
 * Read-replay parity runner.
 *
 * For every fixture case the runner sends the same request to the TS edge and to the edge under
 * test (TS again for `--ts-vs-ts`, Rust with `EDGE_UNDER_TEST=rs`). Both edges point at the same
 * in-process fake core, which answers deterministically, records the upstream request and
 * includes deliberately volatile fields (random UUIDs, ISO timestamps, request ids, release
 * stamps) so the normaliser is exercised on every run.
 *
 * `--ts-vs-ts` is the harness self-check: the two sides run the same code, so any diff is a
 * harness bug (or a missing normalisation rule).
 *
 * Run:
 *   bun backend-rs/tools/parity/replay.ts --ts-vs-ts
 *   EDGE_UNDER_TEST=rs bun backend-rs/tools/parity/replay.ts
 *   bun backend-rs/tools/parity/replay.ts --seed-from-inventory
 *
 * The TS edges validate their environment at boot and require an https core URL plus mTLS
 * client material (see `edgeEnvironment`). The fake core terminates TLS and requires a client
 * certificate, so no production secret is involved. PKI is generated with `openssl` in
 * `PARITY_TMP_DIR` (default `/tmp/opencode`), or reused from `PARITY_PKI_DIR`.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  EDGE_CHANNELS,
  edgeCommand,
  freePort,
  isEdgeChannel,
  resolveImplementation,
  startEdge,
  type EdgeChannel,
  type EdgeImplementation,
  type RawHttpResponse,
} from "./edge-launcher";
import {
  diffResponses,
  formatDifferences,
  normalizeResponse,
  ruleTableLines,
  type DiffEntry,
  type NormalizeOptions,
  type NormalizedResponse,
} from "./normalize";
import {
  expandCasePlaceholders,
  loadFixtures,
  seedFixturesFromInventory,
  type FixtureCase,
  type FixtureFile,
} from "./fixtures";

export interface ParityPki {
  dir: string;
  caCert: string;
  caKey: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
}

const PKI_FILES = [
  "ca.crt",
  "ca.key",
  "server.crt",
  "server.key",
  "client.crt",
  "client.key",
] as const;

const tmpRoot = (): string => {
  const root = process.env.PARITY_TMP_DIR ?? "/tmp/opencode";
  fs.mkdirSync(root, { recursive: true });
  return root;
};

const runOpenSsl = (cwd: string, args: string[]): void => {
  try {
    execFileSync("openssl", args, { cwd, stdio: "ignore" });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      throw new Error(
        "PARITY_PKI_UNAVAILABLE: openssl is required to generate the fake-core mTLS material. " +
          "Install openssl or point PARITY_PKI_DIR at a directory containing " +
          PKI_FILES.join(", "),
      );
    }
    throw new Error(`openssl ${args[0]} failed: ${(error as Error).message}`);
  }
};

export const createParityPki = (): ParityPki => {
  const dir = fs.mkdtempSync(path.join(tmpRoot(), "pg-parity-pki-"));
  runOpenSsl(dir, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-days",
    "1",
    "-subj",
    "/CN=Parity Fake Core CA",
  ]);
  runOpenSsl(dir, [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  runOpenSsl(dir, [
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "server.crt",
    "-days",
    "1",
    "-copy_extensions",
    "copy",
  ]);
  runOpenSsl(dir, [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "client.key",
    "-out",
    "client.csr",
    "-subj",
    "/CN=parity-edge-client",
  ]);
  runOpenSsl(dir, [
    "x509",
    "-req",
    "-in",
    "client.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "client.crt",
    "-days",
    "1",
  ]);
  return {
    dir,
    caCert: path.join(dir, "ca.crt"),
    caKey: path.join(dir, "ca.key"),
    serverCert: path.join(dir, "server.crt"),
    serverKey: path.join(dir, "server.key"),
    clientCert: path.join(dir, "client.crt"),
    clientKey: path.join(dir, "client.key"),
  };
};

export const loadOrCreateParityPki = (): ParityPki => {
  const configured = process.env.PARITY_PKI_DIR;
  if (configured) {
    const dir = path.resolve(configured);
    for (const file of PKI_FILES) {
      if (!fs.existsSync(path.join(dir, file))) {
        throw new Error(`PARITY_PKI_DIR=${dir} is missing ${file}`);
      }
    }
    return {
      dir,
      caCert: path.join(dir, "ca.crt"),
      caKey: path.join(dir, "ca.key"),
      serverCert: path.join(dir, "server.crt"),
      serverKey: path.join(dir, "server.key"),
      clientCert: path.join(dir, "client.crt"),
      clientKey: path.join(dir, "client.key"),
    };
  }
  return createParityPki();
};

export interface FakeCoreRequest {
  method: string;
  /** Path plus query string exactly as the edge sent it. */
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface FakeCore {
  url: string;
  port: number;
  pki: ParityPki;
  requests: FakeCoreRequest[];
  reset: () => void;
  close: () => Promise<void>;
}

const headerRecord = (headers: Headers): Record<string, string> => {
  const output: Record<string, string> = {};
  for (const [name, value] of headers.entries()) output[name.toLowerCase()] = value;
  return output;
};

const jsonResponse = (
  requestId: string,
  body: unknown,
  status = 200,
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-pg-served-by": "core-ts",
      "x-pg-min-lsn": "0/16B6C50",
      "x-request-id": requestId,
    },
  });

const pageParams = (url: URL): { page: number; pageSize: number } => {
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "20", 10);
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 20,
  };
};

const merchantItem = (resource: string): Record<string, unknown> => ({
  id: randomUUID(),
  reference: `PARITY-${resource.toUpperCase()}-0001`,
  status: "SUCCEEDED",
  amount: "250.0000",
  currency: "LYD",
  createdAt: new Date().toISOString(),
});

/**
 * Deterministic fake core. Paths only; the body carries fresh UUIDs and timestamps on purpose.
 * Add a branch here when a new parity route needs a payload the edge forwards without rewriting.
 */
const fakeCoreResponse = (
  method: string,
  url: URL,
  request: FakeCoreRequest,
  requestId: string,
): Response => {
  const pathname = url.pathname;
  const now = new Date().toISOString();
  const volatile = {
    requestId,
    generatedAt: now,
    createdAt: now,
    release: "parity-fake-core",
    commit: "parity",
  };

  if (pathname === "/health") {
    return jsonResponse(requestId, {
      status: "ok",
      service: "fake-core",
      uptime: 0,
      serverTime: now,
    });
  }

  if (pathname.startsWith("/internal/checkout/pay/")) {
    const rest = pathname.slice("/internal/checkout/pay/".length).split("/");
    const linkKey = decodeURIComponent(rest[0] ?? "");
    if (rest[1] === "logs") {
      const attemptId = decodeURIComponent(rest[2] ?? "");
      if (rest[3] === "status") {
        return jsonResponse(requestId, {
          attemptId,
          status: "AWAITING_CUSTOMER",
          lastEvent: "OTP_REQUIRED",
          updatedAt: now,
          requestId,
        });
      }
      return jsonResponse(requestId, {
        attemptId,
        status: "AWAITING_CUSTOMER",
        timeline: [
          { event: "INITIATED", at: now },
          { event: "OTP_REQUIRED", at: now },
        ],
        requestId,
      });
    }
    if (rest[1] === "initiate") {
      return jsonResponse(
        requestId,
        {
          attemptId: randomUUID(),
          reference: "PARITY-REF-0001",
          status: "AWAITING_CUSTOMER",
          clientAction: { type: "SHOW_OTP_FORM" },
          createdAt: now,
          requestId,
        },
        201,
      );
    }
    if (rest[1] === "confirm" || rest[1] === "resend" || rest[1] === "cancel") {
      return jsonResponse(requestId, {
        attemptId: randomUUID(),
        reference: "PARITY-REF-0001",
        status: "SUCCEEDED",
        received: request.body.length,
        createdAt: now,
        requestId,
      });
    }
    return jsonResponse(requestId, {
      linkKey,
      status: "ACTIVE",
      amount: "100.0000",
      currency: "LYD",
      merchant: { id: randomUUID(), name: "Parity Demo Merchant" },
      visible_rails: [
        { code: "edfali", title: "Edfali", requiresOtp: true },
        { code: "sadad", title: "Sadad", requiresOtp: true },
      ],
      scopes: ["checkout:read", "checkout:pay"],
      ...volatile,
    });
  }

  if (pathname.startsWith("/internal/checkout/return/")) {
    return jsonResponse(requestId, {
      reference: "PARITY-RETURN-0001",
      status: "SUCCEEDED",
      attemptId: randomUUID(),
      createdAt: now,
      requestId,
    });
  }

  if (pathname.startsWith("/internal/checkout/academy/certificates/")) {
    return jsonResponse(requestId, {
      certificateId: "ABCDEF0123456789",
      status: "valid",
      holderName: "Parity Operator",
      trackId: "FOUNDATION",
      trackTitle: "Foundation",
      badgeCode: "FOUNDATION_CERTIFIED",
      earnedAt: now,
      expiresAt: "2099-01-01T00:00:00.000Z",
      contentVersion: "1.0.0",
      requestId,
    });
  }

  if (pathname.startsWith("/internal/checkout/inbound/")) {
    return jsonResponse(requestId, { received: request.body.length, createdAt: now, requestId });
  }

  if (pathname.startsWith("/internal/merchant/")) {
    const resource = pathname.slice("/internal/merchant/".length).split("/")[0] ?? "resource";
    const { page, pageSize } = pageParams(url);
    if (resource === "wallets") {
      return jsonResponse(requestId, {
        items: [
          {
            id: randomUUID(),
            currency: "LYD",
            liveBalance: "1500.0000",
            checkpointBalance: "1400.0000",
            createdAt: now,
          },
        ],
        page,
        pageSize,
        total: 1,
        ...volatile,
      });
    }
    return jsonResponse(requestId, {
      items: [merchantItem(resource)],
      page,
      pageSize,
      total: 1,
      ...volatile,
    });
  }

  if (pathname.startsWith("/internal/admin/")) {
    if (pathname === "/internal/admin/stats/overview") {
      return jsonResponse(requestId, {
        period: url.searchParams.get("period") ?? "24h",
        attemptsTotal: 42,
        attemptsCounted: 40,
        succeeded: 38,
        successRate: 95,
        grossVolume: "12345.6700",
        grossVolumeAttempts: 38,
        currency: "LYD",
        byCurrency: [
          { currency: "LYD", grossVolume: "12345.6700" },
          { currency: "USD", grossVolume: "0.0000" },
        ],
        openActionQueues: { approvals: 1, operatorCases: 2 },
        generatedAt: now,
        requestId,
      });
    }
    if (pathname === "/internal/admin/rails") {
      return jsonResponse(requestId, {
        items: [
          {
            id: randomUUID(),
            code: "edfali",
            name: "Edfali",
            status: "ACTIVE",
            createdAt: now,
          },
        ],
        total: 1,
        ...volatile,
      });
    }
    if (pathname === "/internal/admin/merchants") {
      const { page, pageSize } = pageParams(url);
      return jsonResponse(requestId, {
        items: [
          {
            id: randomUUID(),
            displayName: "Parity Demo Merchant",
            status: "ACTIVE",
            createdAt: now,
          },
        ],
        page,
        pageSize,
        total: 1,
        ...volatile,
      });
    }
    return jsonResponse(requestId, { ok: true, path: pathname, ...volatile });
  }

  void method;
  return jsonResponse(
    requestId,
    {
      code: "CORE_NOT_FOUND",
      message: `fake core has no route for ${pathname}`,
      requestId,
    },
    404,
  );
};

export const startFakeCore = async (options: { pki?: ParityPki } = {}): Promise<FakeCore> => {
  const pki = options.pki ?? loadOrCreateParityPki();
  const requests: FakeCoreRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: {
      key: fs.readFileSync(pki.serverKey),
      cert: fs.readFileSync(pki.serverCert),
      ca: fs.readFileSync(pki.caCert),
      requestCert: true,
      rejectUnauthorized: true,
    },
    async fetch(request) {
      const url = new URL(request.url);
      const requestId = request.headers.get("x-request-id") ?? randomUUID();
      const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
      const record: FakeCoreRequest = {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: headerRecord(request.headers),
        body,
      };
      requests.push(record);
      try {
        return fakeCoreResponse(request.method, url, record, requestId);
      } catch (error) {
        return jsonResponse(
          requestId,
          {
            code: "FAKE_CORE_FAILURE",
            message: (error as Error).message,
            requestId,
          },
          500,
        );
      }
    },
  });
  const port = server.port;
  if (port === undefined) {
    throw new Error("fake core did not report a listening port");
  }
  return {
    url: `https://127.0.0.1:${port}`,
    port,
    pki,
    requests,
    reset: () => {
      requests.length = 0;
    },
    close: async () => {
      server.stop(true);
    },
  };
};

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const signature = "A".repeat(43);

/** Synthetic tokens: the edge only reads the claims, core verifies the signature in production. */
export const syntheticSessionToken = (
  audience: "payment-gateway-merchant" | "payment-gateway-admin",
): string => {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64url({ alg: "HS256", typ: "JWT" }),
    base64url({
      typ: "session",
      iss: "payment-gateway-core",
      aud: audience,
      sub: "00000000-0000-4000-8000-0000000000aa",
      role: "COMPLIANCE",
      authorities: ["*"],
      iat: now,
      exp: now + 3600,
    }),
    signature,
  ].join(".");
};

export const parityPlaceholders = (): Record<string, string> => ({
  PARITY_MERCHANT_TOKEN:
    process.env.PARITY_MERCHANT_TOKEN ?? syntheticSessionToken("payment-gateway-merchant"),
  PARITY_ADMIN_TOKEN:
    process.env.PARITY_ADMIN_TOKEN ?? syntheticSessionToken("payment-gateway-admin"),
});

/**
 * Minimal environment the TS edges accept at boot.
 *
 * - `CORE_BACK_URL` must be an absolute https URL and mTLS paths must exist (`lib/env`).
 * - `SANDBOX_CORE_BACK_URL` is deliberately absent: these fixtures are Live-plane reads.
 * - admin-back listens on `ADMIN_BIND_HOST`; the launcher sets it to loopback.
 * - `ADMIN_LAN_CIDRS` keeps the synthetic admin caller inside the LAN guard. Do not send
 *   `x-real-ip` from a public address in an admin fixture: the guard trusts it on loopback.
 */
export const edgeEnvironment = (
  channel: EdgeChannel,
  coreUrl: string,
  pki: ParityPki,
): Record<string, string> => ({
  CORE_BACK_URL: coreUrl,
  MTLS_CLIENT_CERT_PATH: pki.clientCert,
  MTLS_CLIENT_KEY_PATH: pki.clientKey,
  MTLS_CA_CERT_PATH: pki.caCert,
  CORE_REQUEST_TIMEOUT_MS: "5000",
  CORE_TOTAL_DEADLINE_MS: "10000",
  TRUSTED_PROXY_CIDRS: "127.0.0.0/8,::1/128",
  APP_RELEASE: "parity",
  APP_COMMIT: "parity",
  ...(channel === "admin"
    ? { ADMIN_LAN_CIDRS: "127.0.0.1/32,::1/128" }
    : {}),
});

export interface CaseResult {
  name: string;
  method: string;
  path: string;
  leftStatus: number;
  rightStatus: number;
  upstreamLeft: number;
  upstreamRight: number;
  responseDiffs: DiffEntry[];
  upstreamDiffs: DiffEntry[];
  passed: boolean;
}

export interface ChannelResult {
  channel: EdgeChannel;
  cases: CaseResult[];
  left: EdgeImplementation;
  right: EdgeImplementation;
  passed: number;
  failed: number;
}

export interface ReplayReport {
  pair: [EdgeImplementation, EdgeImplementation];
  fixtureSource: string;
  fakeCore: { url: string; pkiDir: string };
  channels: ChannelResult[];
  summary: {
    cases: number;
    passed: number;
    failed: number;
    responseDiffs: number;
    upstreamDiffs: number;
  };
}

const parseJsonBody = (body: string): unknown => {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};

const UPSTREAM_HEADER_ALLOWLIST = [
  "accept",
  "authorization",
  "content-type",
  "x-client-user-agent",
  "x-edge-service",
  "x-pg-min-lsn",
  "x-real-client-ip",
  "x-request-id",
];

const normalizedUpstream = (
  request: FakeCoreRequest,
  options: NormalizeOptions,
): NormalizedResponse =>
  normalizeResponse(
    {
      status: 0,
      headers: Object.fromEntries(
        UPSTREAM_HEADER_ALLOWLIST.filter((name) => request.headers[name] !== undefined).map(
          (name) => [name, request.headers[name]!],
        ),
      ),
      body: JSON.stringify({
        method: request.method,
        path: request.path,
        body: parseJsonBody(request.body),
      }),
    },
    { ...options, headerAllowlist: UPSTREAM_HEADER_ALLOWLIST, dropKeys: [] },
  );

const normalizedResponse = (
  response: RawHttpResponse,
  options: NormalizeOptions,
): NormalizedResponse =>
  normalizeResponse(
    {
      status: response.status,
      headers: response.headers,
      body: response.bodyText,
    },
    options,
  );

const runChannelSide = async (
  fixture: FixtureFile,
  implementation: EdgeImplementation,
  core: FakeCore,
  pki: ParityPki,
  cases: FixtureCase[],
  healthTimeoutMs?: number,
): Promise<{ responses: RawHttpResponse[]; upstream: FakeCoreRequest[] }> => {
  const edge = await startEdge({
    channel: fixture.channel,
    implementation,
    env: edgeEnvironment(fixture.channel, core.url, pki),
    ...(healthTimeoutMs !== undefined ? { healthTimeoutMs } : {}),
  });
  try {
    const start = core.requests.length;
    const responses: RawHttpResponse[] = [];
    for (const fixtureCase of cases) {
      const headers = { ...(fixtureCase.headers ?? {}) };
      let body: string | undefined;
      if (fixtureCase.body !== undefined) {
        body = typeof fixtureCase.body === "string" ? fixtureCase.body : JSON.stringify(fixtureCase.body);
        headers["content-type"] ??= "application/json";
      }
      responses.push(
        await edge.request(fixtureCase.path, {
          method: fixtureCase.method,
          headers,
          body,
        }),
      );
    }
    return { responses, upstream: core.requests.slice(start) };
  } finally {
    await edge.stop();
  }
};

export interface RunReplayOptions {
  fixtures?: string;
  channels?: EdgeChannel[];
  pair?: [EdgeImplementation, EdgeImplementation];
  healthTimeoutMs?: number;
}

export const runReplay = async (options: RunReplayOptions = {}): Promise<ReplayReport> => {
  const pair: [EdgeImplementation, EdgeImplementation] = options.pair ?? [
    "ts",
    resolveImplementation(process.env.EDGE_UNDER_TEST ?? "rs"),
  ];
  const fixtures = loadFixtures({ input: options.fixtures, channels: options.channels });
  const pki = loadOrCreateParityPki();
  let core: FakeCore;
  try {
    core = await startFakeCore({ pki });
  } catch (error) {
    if (!process.env.PARITY_KEEP_PKI) fs.rmSync(pki.dir, { recursive: true, force: true });
    throw error;
  }
  const variables = parityPlaceholders();
  const channelResults: ChannelResult[] = [];
  try {
    for (const fixture of fixtures) {
      const cases = fixture.cases.map((entry) => expandCasePlaceholders(entry, variables));
      const left = await runChannelSide(
        fixture,
        pair[0],
        core,
        pki,
        cases,
        options.healthTimeoutMs,
      );
      const right = await runChannelSide(
        fixture,
        pair[1],
        core,
        pki,
        cases,
        options.healthTimeoutMs,
      );

      const upstreamFor = (records: FakeCoreRequest[], fixtureCase: FixtureCase, index: number) => {
        const pinned = fixtureCase.headers?.["x-request-id"];
        if (pinned) {
          const match = records.find((record) => record.headers["x-request-id"] === pinned);
          if (match) return match;
        }
        return records[index];
      };

      const results: CaseResult[] = [];
      cases.forEach((fixtureCase, index) => {
        const normaliseOptions: NormalizeOptions = { ...(fixtureCase.normalize ?? {}) };
        const leftResponse = left.responses[index]!;
        const rightResponse = right.responses[index]!;
        const responseDiffs = diffResponses(
          normalizedResponse(leftResponse, normaliseOptions),
          normalizedResponse(rightResponse, normaliseOptions),
        ).differences;

        const leftUpstream = upstreamFor(left.upstream, fixtureCase, index);
        const rightUpstream = upstreamFor(right.upstream, fixtureCase, index);
        let upstreamDiffs: DiffEntry[] = [];
        if (leftUpstream && rightUpstream) {
          upstreamDiffs = diffResponses(
            normalizedUpstream(leftUpstream, normaliseOptions),
            normalizedUpstream(rightUpstream, normaliseOptions),
          ).differences;
        } else if (leftUpstream || rightUpstream) {
          upstreamDiffs = [
            {
              path: "/upstream",
              kind: leftUpstream ? "missing-right" : "missing-left",
              left: leftUpstream?.path,
              right: rightUpstream?.path,
            },
          ];
        }

        results.push({
          name: fixtureCase.name ?? `${fixtureCase.method} ${fixtureCase.path}`,
          method: fixtureCase.method,
          path: fixtureCase.path,
          leftStatus: leftResponse.status,
          rightStatus: rightResponse.status,
          upstreamLeft: leftUpstream ? 1 : 0,
          upstreamRight: rightUpstream ? 1 : 0,
          responseDiffs,
          upstreamDiffs,
          passed: responseDiffs.length === 0 && upstreamDiffs.length === 0,
        });
      });

      // A count mismatch between the two upstream logs means a case made a different number of
      // core calls (for example a local validation short-circuit). Report it even when the
      // index-wise comparison above happened to line up.
      if (left.upstream.length !== right.upstream.length) {
        const representative = results[results.length - 1];
        if (representative) {
          representative.upstreamDiffs.push({
            path: "/upstream/count",
            kind: "value",
            left: left.upstream.length,
            right: right.upstream.length,
          });
          representative.passed = false;
        }
      }

      channelResults.push({
        channel: fixture.channel,
        cases: results,
        left: pair[0],
        right: pair[1],
        passed: results.filter((entry) => entry.passed).length,
        failed: results.filter((entry) => !entry.passed).length,
      });
    }
  } finally {
    await core.close();
    if (!process.env.PARITY_KEEP_PKI) {
      fs.rmSync(pki.dir, { recursive: true, force: true });
    }
  }

  const cases = channelResults.flatMap((entry) => entry.cases);
  return {
    pair,
    fixtureSource: options.fixtures ?? "backend-rs/tests/parity-fixtures/reads",
    fakeCore: { url: core.url, pkiDir: pki.dir },
    channels: channelResults,
    summary: {
      cases: cases.length,
      passed: cases.filter((entry) => entry.passed).length,
      failed: cases.filter((entry) => !entry.passed).length,
      responseDiffs: cases.reduce((total, entry) => total + entry.responseDiffs.length, 0),
      upstreamDiffs: cases.reduce((total, entry) => total + entry.upstreamDiffs.length, 0),
    },
  };
};

const printReport = (report: ReplayReport, verbose: boolean): void => {
  console.log(`Parity replay — ${report.pair[0]} vs ${report.pair[1]}`);
  console.log(`Fixtures: ${report.fixtureSource}`);
  console.log(`Fake core: ${report.fakeCore.url} (mTLS)`);
  for (const channel of report.channels) {
    const command = edgeCommand(channel.channel, channel.right);
    console.log(
      `\n${channel.channel}: ${channel.cases.length} cases (${channel.left} vs ${channel.right}) — ` +
        `${channel.passed} passed, ${channel.failed} failed`,
    );
    if (verbose) {
      console.log(`  right command: ${command.command.join(" ")}${command.cargoFallback ? " (cargo run fallback)" : ""}`);
    }
    for (const entry of channel.cases) {
      const mark = entry.passed ? "PASS" : "FAIL";
      console.log(
        `  [${mark}] ${entry.name} (${entry.method} ${entry.path}) ` +
          `status ${entry.leftStatus}/${entry.rightStatus} ` +
          `upstream ${entry.upstreamLeft}/${entry.upstreamRight}`,
      );
      if (!entry.passed) {
        for (const line of formatDifferences(entry.responseDiffs, verbose ? 40 : 12)) {
          console.log(`         response ${line}`);
        }
        for (const line of formatDifferences(entry.upstreamDiffs, verbose ? 40 : 12)) {
          console.log(`         upstream ${line}`);
        }
      }
    }
  }
  const { summary } = report;
  const verdict = summary.failed === 0 ? "PASS" : "DIFFS";
  console.log(
    `\nRESULT: ${verdict} — ${summary.passed}/${summary.cases} cases, ` +
      `${summary.responseDiffs} response diff(s), ${summary.upstreamDiffs} upstream diff(s)`,
  );
};

interface CliOptions {
  pair?: [EdgeImplementation, EdgeImplementation];
  fixtures?: string;
  channels?: EdgeChannel[];
  json?: string | true;
  verbose: boolean;
  seed?: string | true;
  perChannel?: number;
  printRules?: boolean;
  help?: boolean;
}

const HELP = `Usage: bun backend-rs/tools/parity/replay.ts [options]

Options:
  --ts-vs-ts                 Self-check: both sides are the TS edge (must be zero diffs).
  --rs-vs-rs                 Both sides are the Rust edge.
  --edge-pair=ts-rs          Explicit left-right pair (default: ts vs EDGE_UNDER_TEST or rs).
  --fixtures <path>          Fixture file or directory (default tests/parity-fixtures/reads).
  --channel <list>           Filter channels: checkout,merchant,admin.
  --json[=<path>]            Emit the JSON report (stdout when no path).
  --verbose                  Show edge commands and more diff lines.
  --seed-from-inventory[=<dir>]  Write generated fixtures from the route inventory and exit.
  --per-channel <n>          Cases per channel when seeding (default 4).
  --print-rules              Print the normalisation rule table and exit.
  --help                     This text.

Environment:
  EDGE_UNDER_TEST=ts|rs      Right-hand edge when --edge-pair is not given.
  PARITY_PKI_DIR             Reuse mTLS material instead of generating it with openssl.
  PARITY_MERCHANT_TOKEN      Override the synthetic merchant session token.
  PARITY_ADMIN_TOKEN         Override the synthetic admin session token.
`;

const parsePair = (value: string): [EdgeImplementation, EdgeImplementation] => {
  const parts = value.split("-");
  if (parts.length !== 2) throw new Error(`--edge-pair expects ts-rs, rs-ts, ts-ts or rs-rs, got "${value}"`);
  const left = resolveImplementation(parts[0]);
  const right = resolveImplementation(parts[1]);
  return [left, right];
};

const parseChannels = (value: string): EdgeChannel[] => {
  const channels = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const channel of channels) {
    if (!isEdgeChannel(channel)) {
      throw new Error(`unknown channel "${channel}" (expected ${EDGE_CHANNELS.join(",")})`);
    }
  }
  return channels as EdgeChannel[];
};

export const parseCli = (argv: string[]): CliOptions => {
  const options: CliOptions = { verbose: false };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    const [flag, inline] = raw.startsWith("--") ? raw.split("=", 2) : [raw, undefined];
    const next = (): string => {
      if (inline !== undefined) return inline;
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      index += 1;
      return value;
    };
    switch (flag) {
      case "--ts-vs-ts":
        options.pair = ["ts", "ts"];
        break;
      case "--rs-vs-rs":
        options.pair = ["rs", "rs"];
        break;
      case "--edge-pair":
        options.pair = parsePair(next());
        break;
      case "--fixtures":
        options.fixtures = next();
        break;
      case "--channel":
        options.channels = parseChannels(next());
        break;
      case "--json":
        options.json = inline !== undefined ? inline : true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--seed-from-inventory":
        options.seed = inline !== undefined ? inline : true;
        break;
      case "--per-channel":
        options.perChannel = Number.parseInt(next(), 10);
        break;
      case "--print-rules":
        options.printRules = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option ${raw}`);
    }
  }
  return options;
};

const main = async (): Promise<number> => {
  let options: CliOptions;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    console.error(HELP);
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.printRules) {
    console.log("id\tscope\tmatch\taction");
    for (const line of ruleTableLines()) console.log(line);
    return 0;
  }
  if (options.seed) {
    const written = seedFixturesFromInventory({
      outDir: typeof options.seed === "string" ? options.seed : undefined,
      perChannel: options.perChannel,
    });
    if (written.length === 0) {
      console.error("no parameterless GET routes found in the edge inventory");
      return 1;
    }
    for (const entry of written) {
      console.log(`${entry.channel}: wrote ${entry.cases} case(s) to ${entry.file}`);
    }
    return 0;
  }

  try {
    const report = await runReplay({
      fixtures: options.fixtures,
      channels: options.channels,
      pair: options.pair,
    });
    if (options.json === true) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report, options.verbose);
      if (typeof options.json === "string") {
        fs.mkdirSync(path.dirname(path.resolve(options.json)), { recursive: true });
        fs.writeFileSync(path.resolve(options.json), `${JSON.stringify(report, null, 2)}\n`, "utf8");
        console.log(`JSON report: ${path.resolve(options.json)}`);
      }
    }
    return report.summary.failed === 0 ? 0 : 1;
  } catch (error) {
    console.error(`PARITY_HARNESS_FAILED: ${(error as Error).message}`);
    if (options.verbose) console.error((error as Error).stack);
    return 2;
  }
};

if (import.meta.main) {
  process.exitCode = await main();
}
