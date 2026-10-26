import type { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LogType = "info" | "warn" | "error";

interface LogEntry {
    content: string;
    type: LogType;
    at: number; // ms since request start
}

export interface RequestLogger {
    log: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    end: () => void;
}

// ---------------------------------------------------------------------------
// Terminal styling (no deps — plain ANSI codes, auto-disabled if not a TTY)
// ---------------------------------------------------------------------------

const isTTY = Boolean(process.stdout.isTTY);

const c = isTTY
    ? {
          reset: "\x1b[0m",
          dim: "\x1b[2m",
          bold: "\x1b[1m",
          red: "\x1b[31m",
          green: "\x1b[32m",
          yellow: "\x1b[33m",
          blue: "\x1b[34m",
          cyan: "\x1b[36m",
          gray: "\x1b[90m",
          white: "\x1b[37m",
      }
    : {
          reset: "",
          dim: "",
          bold: "",
          red: "",
          green: "",
          yellow: "",
          blue: "",
          cyan: "",
          gray: "",
          white: "",
      };

const methodColor = (method: string) => {
    switch (method) {
        case "GET":
            return c.green;
        case "POST":
            return c.yellow;
        case "PUT":
        case "PATCH":
            return c.blue;
        case "DELETE":
            return c.red;
        default:
            return c.white;
    }
};

const statusColor = (status: number) => {
    if (status >= 500) return c.red;
    if (status >= 400) return c.yellow;
    if (status >= 300) return c.cyan;
    if (status >= 200) return c.green;
    return c.white;
};

const levelStyle: Record<LogType, { color: string; icon: string }> = {
    info: { color: c.gray, icon: "ℹ" },
    warn: { color: c.yellow, icon: "⚠" },
    error: { color: c.red, icon: "✖" },
};

const formatDuration = (ms: number) =>
    ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;

const shortId = () => Math.random().toString(36).slice(2, 8);

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

const createRequestLogger = (request: Request, response: Response): RequestLogger => {
    const startedAt = new Date();
    const startNs = process.hrtime.bigint();
    const id = shortId();

    const entries: LogEntry[] = [];

    const record = (type: LogType) => (msg: string) => {
        entries.push({
            content: msg,
            type,
            at: Number(process.hrtime.bigint() - startNs) / 1_000_000,
        });
    };

    const log = record("info");
    const warn = record("warn");
    const error = record("error");

    const end = () => {
        const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
        const { method, path: requestPath, ip } = request;
        const { statusCode } = response;
        const contentLength = response.getHeader("content-length");

        const hasErrors = entries.some((e) => e.type === "error");
        const hasWarnings = entries.some((e) => e.type === "warn");

        // Header line: timestamp, method, path, status, duration
        const header =
            `${c.dim}${startedAt.toISOString()} #${id}${c.reset} ` +
            `${methodColor(method)}${c.bold}${method.padEnd(6)}${c.reset}` +
            `${c.white}${requestPath}${c.reset} ` +
            `${statusColor(statusCode)}${c.bold}${statusCode}${c.reset} ` +
            `${c.dim}${formatDuration(durationMs)}${c.reset}` +
            (contentLength ? `${c.dim} ${contentLength}b${c.reset}` : "") +
            (ip ? `${c.dim} ← ${ip}${c.reset}` : "");

        const body = entries.map((e) => {
            const { color, icon } = levelStyle[e.type];
            return `  ${color}${icon} ${c.dim}+${e.at.toFixed(1)}ms${c.reset} ${color}${e.content}${c.reset}`;
        });

        const output = [header, ...body].join("\n");

        // Route to the console channel matching the worst thing that happened
        if (hasErrors || statusCode >= 500) {
            console.error(output);
        } else if (hasWarnings || statusCode >= 400) {
            console.warn(output);
        } else {
            console.log(output);
        }
    };

    return { log, warn, error, end };
};

export default createRequestLogger;

// ---------------------------------------------------------------------------
// Optional: ready-to-use Express middleware
// ---------------------------------------------------------------------------

declare global {
    namespace Express {
        interface Request {
            logger: RequestLogger;
        }
    }
}

export const requestLoggerMiddleware = (req: Request, res: Response, next: NextFunction) => {
    req.logger = createRequestLogger(req, res);
    res.on("finish", () => req.logger.end());
    next();
};

/**
 * Usage:
 *
 *   app.use(requestLoggerMiddleware);
 *
 *   app.get("/users/:id", (req, res) => {
 *       req.logger.log(`looking up user ${req.params.id}`);
 *       if (!found) req.logger.warn("user not found, returning 404");
 *       res.status(404).json({ error: "not found" });
 *   });
 */