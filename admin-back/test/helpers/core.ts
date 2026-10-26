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

export const createTestPki = (commonName: string): TestPki => {
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
    `/CN=${commonName}`,
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
      requests.push({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        body,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization ?? null,
          bodyLength: body.byteLength,
          body: body.toString("utf8").slice(0, 512),
        }),
      );
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
