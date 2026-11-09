/**
 * AUTO-06 the clamd INSTREAM client against a fake clamd that speaks the real wire protocol (TCP and Unix socket),
 * and the fail-closed mapping of every non-verdict reply.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BuiltinKybScanner,
  ClamdScanner,
  KybScannerError,
  createKybScanner,
  parseClamdEndpoint,
  parseClamdReply,
} from "../../lib/kybScanner";

type Behaviour = (command: string, payload: Buffer, socket: Socket) => void;

const servers: Server[] = [];
const dirs: string[] = [];

/** A fake clamd: parses `zINSTREAM\0` + length-prefixed chunks + the zero chunk, or `zVERSION\0`, then calls `behave`. */
const fakeClamd = async (behave: Behaviour, listen: { port: 0 } | { path: string } = { port: 0 }): Promise<string> => {
  const server = createServer((socket) => {
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data as Buffer]);
      if (buffer.subarray(0, 10).toString() === "zVERSION\0") {
        behave("VERSION", Buffer.alloc(0), socket);
        buffer = Buffer.alloc(0);
        return;
      }
      if (buffer.subarray(0, 10).toString() !== "zINSTREAM\0") return;
      let offset = 10;
      const payload: Buffer[] = [];
      for (;;) {
        if (buffer.length < offset + 4) return;
        const length = buffer.readUInt32BE(offset);
        if (length === 0) break;
        if (buffer.length < offset + 4 + length) return;
        payload.push(buffer.subarray(offset + 4, offset + 4 + length));
        offset += 4 + length;
      }
      buffer = Buffer.alloc(0);
      behave("INSTREAM", Buffer.concat(payload), socket);
    });
    socket.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    if ("path" in listen) server.listen(listen.path, resolve);
    else server.listen(0, "127.0.0.1", resolve);
  });
  if ("path" in listen) return listen.path;
  return `127.0.0.1:${(server.address() as { port: number }).port}`;
};

afterAll(() => {
  for (const server of servers) server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const reply = (socket: Socket, text: string): void => {
  socket.end(`${text}\0`);
};

describe("clamd client", () => {
  test("streams the whole file in chunks and reports CLEAN with the engine version", async () => {
    let received: Buffer = Buffer.alloc(0);
    const address = await fakeClamd((command, payload, socket) => {
      if (command === "VERSION") return reply(socket, "ClamAV 1.4.1/27500/Mon Nov  3 08:25:08 2026");
      received = payload;
      reply(socket, "stream: OK");
    });
    const scanner = new ClamdScanner({ endpoint: parseClamdEndpoint(address), chunkSize: 1000 });
    const file = Buffer.alloc(10_500, 7);
    const verdict = await scanner.scan(file);
    expect(verdict).toEqual({ verdict: "CLEAN", engine: "clamd", signature: "ClamAV 1.4.1/27500/Mon Nov  3 08:25:08 2026" });
    expect(received.equals(file)).toBe(true);
  });

  test("an empty file is a valid (clean) scan", async () => {
    const address = await fakeClamd((command, payload, socket) => {
      if (command === "VERSION") return reply(socket, "ClamAV 1.4.1/1/x");
      expect(payload.length).toBe(0);
      reply(socket, "stream: OK");
    });
    expect((await new ClamdScanner({ endpoint: parseClamdEndpoint(address) }).scan(Buffer.alloc(0))).verdict).toBe("CLEAN");
  });

  test("FOUND is INFECTED with the detection name", async () => {
    const address = await fakeClamd((command, _payload, socket) =>
      command === "VERSION" ? reply(socket, "ClamAV 1.4.1/27500/x") : reply(socket, "stream: Win.Test.EICAR_HDB-1 FOUND"),
    );
    const verdict = await new ClamdScanner({ endpoint: parseClamdEndpoint(address) }).scan(Buffer.from("x"));
    expect(verdict).toMatchObject({ verdict: "INFECTED", threat: "Win.Test.EICAR_HDB-1", engine: "clamd" });
  });

  test("a verdict is still returned when the version query fails", async () => {
    const address = await fakeClamd((command, _payload, socket) => (command === "VERSION" ? socket.destroy() : reply(socket, "stream: OK")));
    const verdict = await new ClamdScanner({ endpoint: parseClamdEndpoint(address) }).scan(Buffer.from("x"));
    expect(verdict).toEqual({ verdict: "CLEAN", engine: "clamd" });
  });

  test("works over a Unix socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clamd-"));
    dirs.push(dir);
    const path = await fakeClamd((command, _payload, socket) => (command === "VERSION" ? reply(socket, "ClamAV 1.0/1/x") : reply(socket, "stream: OK")), { path: join(dir, "clamd.ctl") });
    expect((await new ClamdScanner({ endpoint: parseClamdEndpoint(path) }).scan(Buffer.from("hello"))).verdict).toBe("CLEAN");
  });

  test("fail closed: an ERROR reply, a size-limit reply, silence, a dropped connection and a refused connection all reject", async () => {
    const errorAddress = await fakeClamd((_c, _p, socket) => reply(socket, "stream: lstat() failed. ERROR"));
    await expect(new ClamdScanner({ endpoint: parseClamdEndpoint(errorAddress) }).scan(Buffer.from("x"))).rejects.toThrow(/could not scan/);

    const limitAddress = await fakeClamd((_c, _p, socket) => reply(socket, "INSTREAM size limit exceeded. ERROR"));
    const limitError = await new ClamdScanner({ endpoint: parseClamdEndpoint(limitAddress) }).scan(Buffer.from("x")).catch((e) => e);
    expect(limitError).toBeInstanceOf(KybScannerError);
    expect(limitError.retryable).toBe(false);

    const silentAddress = await fakeClamd(() => undefined);
    await expect(new ClamdScanner({ endpoint: parseClamdEndpoint(silentAddress), timeoutMs: 150 }).scan(Buffer.from("x"))).rejects.toThrow(/did not answer/);

    const droppedAddress = await fakeClamd((_c, _p, socket) => socket.destroy());
    await expect(new ClamdScanner({ endpoint: parseClamdEndpoint(droppedAddress) }).scan(Buffer.from("x"))).rejects.toThrow(/without a verdict|connection failed/);

    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(new ClamdScanner({ endpoint: { host: "127.0.0.1", port } }).scan(Buffer.from("x"))).rejects.toThrow(/connection failed/);
  });

  test("a runaway reply is cut off", async () => {
    const address = await fakeClamd((_c, _p, socket) => socket.end("x".repeat(20_000)));
    await expect(new ClamdScanner({ endpoint: parseClamdEndpoint(address), maxReplyBytes: 1024 }).scan(Buffer.from("x"))).rejects.toThrow(/larger than expected/);
  });
});

describe("reply and endpoint parsing", () => {
  test("verdict lines", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ verdict: "CLEAN" });
    expect(parseClamdReply("stream: Eicar-Signature FOUND\0")).toEqual({ verdict: "INFECTED", threat: "Eicar-Signature" });
    expect(() => parseClamdReply("")).toThrow(KybScannerError);
    expect(() => parseClamdReply("UNKNOWN COMMAND")).toThrow(KybScannerError);
    // the word OK inside a detection name must not read as clean
    expect(parseClamdReply("stream: Trojan.OK.Dropper FOUND")).toMatchObject({ verdict: "INFECTED" });
  });

  test("endpoints", () => {
    expect(parseClamdEndpoint("/run/clamav/clamd.ctl")).toEqual({ socketPath: "/run/clamav/clamd.ctl" });
    expect(parseClamdEndpoint("unix:/run/clamd.sock")).toEqual({ socketPath: "/run/clamd.sock" });
    expect(parseClamdEndpoint("scan.internal:3310")).toEqual({ host: "scan.internal", port: 3310 });
    expect(parseClamdEndpoint("[::1]:3310")).toEqual({ host: "::1", port: 3310 });
    for (const bad of ["", "scan.internal", "scan.internal:0", "scan.internal:99999", ":3310"]) {
      expect(() => parseClamdEndpoint(bad)).toThrow();
    }
  });

  test("the factory: clamd needs an address, eicar is the built-in gate, anything else is no scanner", async () => {
    expect(createKybScanner({ mode: "clamd", clamdAddress: "127.0.0.1:3310" })?.engine).toBe("clamd");
    expect(() => createKybScanner({ mode: "clamd" })).toThrow(/KYB_CLAMD_ADDRESS/);
    expect(createKybScanner({ mode: "eicar" })).toBeInstanceOf(BuiltinKybScanner);
    expect(createKybScanner({ mode: "disabled" })).toBeNull();
    expect(createKybScanner({})).toBeNull();
    const builtin = new BuiltinKybScanner();
    expect((await builtin.scan(Buffer.from("%PDF-1.4 plain"))).verdict).toBe("CLEAN");
    expect((await builtin.scan(Buffer.from("X5O!P%@AP EICAR-STANDARD-ANTIVIRUS-TEST-FILE"))).verdict).toBe("INFECTED");
    expect((await builtin.scan(Buffer.from("<script>alert(1)</script>"))).verdict).toBe("INFECTED");
  });
});
