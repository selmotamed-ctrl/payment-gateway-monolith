import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface TestPki {
  dir: string;
  caCert: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
}

export const createTestPki = (): TestPki => {
  const dir = mkdtempSync(path.join(tmpdir(), "edge-mtls-"));
  const run = (args: string[]) => {
    execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  };
  run([
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
    "/CN=Edge Test Internal CA",
  ]);
  run([
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
  run([
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
  run([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "client.key",
    "-out",
    "client.csr",
    "-subj",
    "/CN=checkout-back",
  ]);
  run([
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
    serverCert: path.join(dir, "server.crt"),
    serverKey: path.join(dir, "server.key"),
    clientCert: path.join(dir, "client.crt"),
    clientKey: path.join(dir, "client.key"),
  };
};

export interface CoreRequestRecord {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  peerCn: string | undefined;
}

export interface TestCore {
  url: string;
  port: number;
  requests: CoreRequestRecord[];
  close: () => Promise<void>;
}

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

export const startTestCore = async (pki: TestPki): Promise<TestCore> => {
  const requests: CoreRequestRecord[] = [];
  const server = https.createServer(
    {
      cert: readFileSync(pki.serverCert),
      key: readFileSync(pki.serverKey),
      ca: readFileSync(pki.caCert),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
    async (request: IncomingMessage, response: ServerResponse) => {
      const body = await readBody(request);
      const socket = request.socket as import("node:tls").TLSSocket;
      let peerCn: string | undefined;
      try {
        const subject = socket.getPeerCertificate()?.subject?.CN;
        peerCn = Array.isArray(subject) ? subject[0] : subject;
      } catch {
        peerCn = undefined;
      }
      requests.push({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        body,
        peerCn,
      });
      const url = request.url ?? "/";
      if (url.endsWith("/status")) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.write("data: {\"status\":\"VERIFYING\"}\n\n");
        response.end();
        return;
      }
      if (url.includes("/inbound/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ received: body.byteLength }));
        return;
      }
      if (url.endsWith("/initiate") || url.endsWith("/confirm")) {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            attemptId: "att_test_1",
            reference: "REF-1",
            status: "AWAITING_CUSTOMER",
            clientAction: { type: "SHOW_OTP_FORM" },
            received: body.toString("utf8"),
          }),
        );
        return;
      }
      if (url.startsWith("/internal/checkout/return/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ reference: "REF-RETURN-1", status: "SUCCEEDED" }));
        return;
      }
      if (url.startsWith("/internal/checkout/pay/")) {
        const linkKey = url.split("/")[4] ?? "";
        if (linkKey === "LNKMISSING1") {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ code: "LINK_NOT_FOUND", message: "payment link not found" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            linkKey: url.split("/").pop(),
            amount: "100.0000",
            currency: "LYD",
            visible_rails: [],
          }),
        );
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "CORE_NOT_FOUND", message: "core resource missing" }));
    },
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `https://localhost:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};
