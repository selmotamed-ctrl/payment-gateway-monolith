import { connect, type Socket } from "node:net";
import { containsActiveContent } from "./kybScan";

/**
 * The malware-scanner port of the KYB scan worker (AUTO-06, decision D5).
 *
 * `scan` resolves to a verdict only when the engine examined the bytes. Anything else - a refused connection, a
 * timeout, a protocol error, an engine ERROR reply, a size-limit refusal - REJECTS, and the worker keeps the document
 * `PENDING` (fail closed): a scanner problem is never read as "clean".
 */
export interface KybScanVerdict {
  verdict: "CLEAN" | "INFECTED";
  /** Engine name, for example `clamd` or `builtin`. */
  engine: string;
  /** Engine and signature-set version when the engine reports one (`ClamAV 1.4.1/27500/...`). */
  signature?: string;
  /** The detection name for an infected file (`Eicar-Signature`). */
  threat?: string;
}

export interface KybScanner {
  readonly engine: string;
  scan(bytes: Buffer): Promise<KybScanVerdict>;
}

export class KybScannerError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
    this.name = "KybScannerError";
  }
}

export type ClamdEndpoint = { socketPath: string } | { host: string; port: number };

export interface ClamdScannerOptions {
  endpoint: ClamdEndpoint;
  /** Whole-exchange limit per scan. Default 30 s. */
  timeoutMs?: number;
  /** INSTREAM chunk size. Default 64 KiB. */
  chunkSize?: number;
  /** Largest reply read from the engine; a reply is one short line. Default 4 KiB. */
  maxReplyBytes?: number;
}

/** `/run/clamav/clamd.ctl` (a path) or `host:port`. */
export const parseClamdEndpoint = (value: string): ClamdEndpoint => {
  const text = value.trim();
  if (!text) throw new Error("KYB_CLAMD_ADDRESS is empty");
  if (text.startsWith("/") || text.startsWith("unix:")) {
    return { socketPath: text.startsWith("unix:") ? text.slice("unix:".length) : text };
  }
  const separator = text.lastIndexOf(":");
  const port = Number(text.slice(separator + 1));
  if (separator <= 0 || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`KYB_CLAMD_ADDRESS must be a socket path or host:port, got "${value}"`);
  }
  return { host: text.slice(0, separator).replace(/^\[|\]$/g, ""), port };
};

/**
 * ClamAV `clamd` over the null-terminated `zINSTREAM` command: `zINSTREAM\0`, then `<uint32 BE length><bytes>` chunks,
 * then a zero-length chunk; the reply is `stream: OK\0`, `stream: <Name> FOUND\0` or `... ERROR\0`. The signature
 * version comes from `zVERSION\0` on a second short connection (clamd closes a connection after INSTREAM).
 */
export class ClamdScanner implements KybScanner {
  readonly engine = "clamd";
  private readonly endpoint: ClamdEndpoint;
  private readonly timeoutMs: number;
  private readonly chunkSize: number;
  private readonly maxReplyBytes: number;

  constructor(options: ClamdScannerOptions) {
    this.endpoint = options.endpoint;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.chunkSize = Math.max(1, options.chunkSize ?? 64 * 1024);
    this.maxReplyBytes = options.maxReplyBytes ?? 4096;
  }

  async scan(bytes: Buffer): Promise<KybScanVerdict> {
    const reply = await this.exchange((socket) => {
      socket.write("zINSTREAM\0");
      for (let offset = 0; offset < bytes.length; offset += this.chunkSize) {
        const chunk = bytes.subarray(offset, offset + this.chunkSize);
        const header = Buffer.alloc(4);
        header.writeUInt32BE(chunk.length, 0);
        socket.write(header);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
    const verdict = parseClamdReply(reply);
    const signature = await this.version().catch(() => undefined);
    return { ...verdict, engine: this.engine, ...(signature ? { signature } : {}) };
  }

  /** `ClamAV 1.4.1/27500/Mon Nov  3 08:25:08 2026`; undefined when the engine does not answer. */
  async version(): Promise<string> {
    const reply = await this.exchange((socket) => {
      socket.write("zVERSION\0");
    });
    return reply.replace(/\0/g, "").trim().slice(0, 200);
  }

  private exchange(send: (socket: Socket) => void): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = "socketPath" in this.endpoint ? connect({ path: this.endpoint.socketPath }) : connect({ host: this.endpoint.host, port: this.endpoint.port });
      const received: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error: Error | null, value?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value ?? "");
      };
      const timer = setTimeout(() => finish(new KybScannerError(`clamd did not answer within ${this.timeoutMs} ms`)), this.timeoutMs);
      socket.on("connect", () => {
        try {
          send(socket);
        } catch (error) {
          finish(new KybScannerError(`clamd write failed: ${(error as Error).message}`));
        }
      });
      socket.on("data", (data: Buffer) => {
        received.push(data);
        size += data.length;
        if (size > this.maxReplyBytes) {
          finish(new KybScannerError("clamd reply is larger than expected"));
        }
      });
      socket.on("error", (error) => finish(new KybScannerError(`clamd connection failed: ${error.message}`)));
      socket.on("end", () => finish(null, Buffer.concat(received).toString("utf8")));
      socket.on("close", () => finish(null, Buffer.concat(received).toString("utf8")));
    });
  }
}

/** Maps a clamd reply line to a verdict, and every non-verdict reply to a thrown error. */
export const parseClamdReply = (reply: string): Pick<KybScanVerdict, "verdict" | "threat"> => {
  const line = reply.replace(/\0/g, "").trim();
  if (!line) throw new KybScannerError("clamd closed the connection without a verdict");
  if (/\bOK$/.test(line)) return { verdict: "CLEAN" };
  const found = /^[^:]*:\s*(.+?)\s+FOUND$/.exec(line);
  if (found) return { verdict: "INFECTED", threat: found[1]!.slice(0, 200) };
  // "INSTREAM size limit exceeded. ERROR" and every other ERROR: the file was not examined.
  throw new KybScannerError(`clamd could not scan the file: ${line.slice(0, 200)}`, !/size limit/i.test(line));
};

/**
 * The built-in content gate (`KYB_SCANNER_MODE=eicar`, development and tests): it is NOT a malware engine, it only
 * applies the same content sniffing the upload path applies, so a worker running against it moves documents out of
 * PENDING the same way the upload does.
 */
export class BuiltinKybScanner implements KybScanner {
  readonly engine = "builtin";
  async scan(bytes: Buffer): Promise<KybScanVerdict> {
    if (bytes.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE") || containsActiveContent(bytes)) {
      return { verdict: "INFECTED", engine: this.engine, threat: "BuiltinContentGate" };
    }
    return { verdict: "CLEAN", engine: this.engine };
  }
}

/** The scanner a deployment configured, or null when none is (every document then stays PENDING). */
export const createKybScanner = (config: { mode?: string; clamdAddress?: string; timeoutMs?: number }): KybScanner | null => {
  if (config.mode === "clamd") {
    if (!config.clamdAddress) throw new Error("KYB_SCANNER_MODE=clamd requires KYB_CLAMD_ADDRESS");
    return new ClamdScanner({ endpoint: parseClamdEndpoint(config.clamdAddress), timeoutMs: config.timeoutMs });
  }
  if (config.mode === "eicar") return new BuiltinKybScanner();
  return null;
};
