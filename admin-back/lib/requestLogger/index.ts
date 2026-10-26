import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

type LogType = "info" | "warn" | "error";

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|passphrase|secret|token|otp|pin|cvv|cvc|pan|card[_-]?number|authorization|api[_-]?key|private[_-]?key|credential|cookie|session|signature|nonce|client[_-]?secret|encryption[_-]?key|mtls|key)/i;

const MAX_STRING_LENGTH = 256;

export const redactSecrets = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]` : value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(entry, depth + 1);
    }
    return output;
  }
  return value;
};

export const redactHeaders = (headers: Record<string, string | string[] | undefined>): Record<string, string> => {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const flat = Array.isArray(value) ? value.join(", ") : (value ?? "");
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : flat;
  }
  return output;
};

export const newRequestId = (): string => randomUUID();

export const resolveRequestId = (req: Request): string => {
  const incoming = req.headers["x-request-id"];
  const value = typeof incoming === "string" ? incoming.trim() : "";
  if (value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value)) return value;
  return newRequestId();
};

const isTTY = Boolean(process.stdout.isTTY);

const palette = {
  reset: isTTY ? "\x1b[0m" : "",
  dim: isTTY ? "\x1b[2m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  red: isTTY ? "\x1b[31m" : "",
  green: isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  blue: isTTY ? "\x1b[34m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
  gray: isTTY ? "\x1b[90m" : "",
  white: isTTY ? "\x1b[37m" : "",
};

const methodColor = (method: string) => {
  switch (method) {
    case "GET":
      return palette.green;
    case "POST":
      return palette.yellow;
    case "PUT":
    case "PATCH":
      return palette.blue;
    case "DELETE":
      return palette.red;
    default:
      return palette.white;
  }
};

const statusColor = (status: number) => {
  if (status >= 500) return palette.red;
  if (status >= 400) return palette.yellow;
  if (status >= 300) return palette.cyan;
  if (status >= 200) return palette.green;
  return palette.white;
};

const levelStyle: Record<LogType, { color: string; icon: string }> = {
  info: { color: palette.gray, icon: "i" },
  warn: { color: palette.yellow, icon: "!" },
  error: { color: palette.red, icon: "x" },
};

const formatDuration = (ms: number) => (ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`);

export interface RequestLogger {
  requestId: string;
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  detail: (payload: unknown) => void;
  end: () => void;
}

const createRequestLogger = (request: Request, response: Response): RequestLogger => {
  const startedAt = new Date();
  const startNs = process.hrtime.bigint();
  const requestId = resolveRequestId(request);
  const entries: { content: string; type: LogType; at: number }[] = [];

  const record = (type: LogType) => (content: string) => {
    entries.push({
      content,
      type,
      at: Number(process.hrtime.bigint() - startNs) / 1_000_000,
    });
  };

  const logger: RequestLogger = {
    requestId,
    log: record("info"),
    warn: record("warn"),
    error: record("error"),
    detail: (payload: unknown) => {
      entries.push({
        content: JSON.stringify(redactSecrets(payload)),
        type: "info",
        at: Number(process.hrtime.bigint() - startNs) / 1_000_000,
      });
    },
    end: () => {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      const statusCode = response.statusCode;
      const header =
        `${palette.dim}${startedAt.toISOString()} ${requestId}${palette.reset} ` +
        `${methodColor(request.method)}${palette.bold}${request.method.padEnd(6)}${palette.reset}` +
        `${palette.white}${request.originalUrl}${palette.reset} ` +
        `${statusColor(statusCode)}${palette.bold}${statusCode}${palette.reset} ` +
        `${palette.dim}${formatDuration(durationMs)}${palette.reset}`;
      const body = entries.map((entry) => {
        const style = levelStyle[entry.type];
        return `  ${style.color}${style.icon} ${palette.dim}+${entry.at.toFixed(1)}ms${palette.reset} ${style.color}${entry.content}${palette.reset}`;
      });
      const output = [header, ...body].join("\n");
      const hasError = entries.some((entry) => entry.type === "error");
      const hasWarn = entries.some((entry) => entry.type === "warn");
      if (hasError || statusCode >= 500) console.error(output);
      else if (hasWarn || statusCode >= 400) console.warn(output);
      else console.log(output);
    },
  };

  return logger;
};

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
