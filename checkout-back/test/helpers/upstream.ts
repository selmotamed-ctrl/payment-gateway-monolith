import fs from "node:fs";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { TestPki } from "./core";

export interface UpstreamRequestRecord {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type UpstreamHandler = (
  request: UpstreamRequestRecord,
  response: ServerResponse,
) => void | Promise<void>;

export interface TestUpstream {
  url: string;
  port: number;
  requests: UpstreamRequestRecord[];
  setHandler: (handler: UpstreamHandler) => void;
  close: () => Promise<void>;
}

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

const jsonHandler: UpstreamHandler = (_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
};

export const startUpstream = async (
  pki: TestPki,
  initialHandler: UpstreamHandler = jsonHandler,
): Promise<TestUpstream> => {
  const requests: UpstreamRequestRecord[] = [];
  let handler = initialHandler;
  const sockets = new Set<Socket>();
  const server = https.createServer(
    {
      cert: fs.readFileSync(pki.serverCert),
      key: fs.readFileSync(pki.serverKey),
      ca: fs.readFileSync(pki.caCert),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
    async (request, response) => {
      const body = await readBody(request);
      const record: UpstreamRequestRecord = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        body,
      };
      requests.push(record);
      try {
        await handler(record, response);
      } catch {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
        }
        response.end(JSON.stringify({ code: "TEST_UPSTREAM_FAILURE" }));
      }
    },
  );
  server.on("secureConnection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `https://localhost:${port}`,
    port,
    requests,
    setHandler: (next) => {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
};

export const respondJson = (
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void => {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
};
