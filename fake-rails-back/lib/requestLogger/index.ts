import type { NextFunction, Request, Response } from "express";

const isTTY = Boolean(process.stdout.isTTY);
const color = (code: string, value: string) => (isTTY ? `\x1b[${code}m${value}\x1b[0m` : value);

export interface RequestLogger {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

declare global {
  namespace Express {
    interface Request {
      logger: RequestLogger;
      requestId: string;
    }
  }
}

export const requestLoggerMiddleware = (request: Request, response: Response, next: NextFunction) => {
  const startedAt = Date.now();
  const entries: Array<{ level: "info" | "warn" | "error"; message: string; at: number }> = [];
  const record = (level: "info" | "warn" | "error") => (message: string) =>
    entries.push({ level, message, at: Date.now() - startedAt });

  request.logger = { log: record("info"), warn: record("warn"), error: record("error") };
  request.requestId = request.header("x-request-id") ?? crypto.randomUUID();
  response.setHeader("x-request-id", request.requestId);

  response.on("finish", () => {
    const duration = Date.now() - startedAt;
    const status = response.statusCode;
    const paint = status >= 500 ? "31" : status >= 400 ? "33" : "32";
    const header = `${color("90", request.requestId.slice(0, 8))} ${color("36", request.method.padEnd(6))} ${request.path} ${color(paint, String(status))} ${color("90", `${duration}ms`)}`;
    const lines = entries.map((entry) => `  ${color(entry.level === "error" ? "31" : entry.level === "warn" ? "33" : "90", `+${entry.at}ms ${entry.message}`)}`);
    const output = [header, ...lines].join("\n");
    if (status >= 500) console.error(output);
    else if (status >= 400) console.warn(output);
    else console.log(output);
  });

  next();
};
