import type { Request } from "express";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

/**
 * The `verify` hook installed on every body parser. It captures the exact wire
 * bytes (not the re-serialized JSON) before the parser consumes them, which is
 * what the signature emulators and the tester's wire inspector need.
 */
export const captureRawBody = (
  request: Request,
  _response: unknown,
  buffer: Buffer,
): void => {
  if (buffer.length > 0) {
    request.rawBody = Buffer.from(buffer);
  }
};

export const rawBodyText = (request: Request): string => {
  if (request.rawBody && request.rawBody.length > 0) {
    return request.rawBody.toString("utf8");
  }
  if (typeof request.body === "string") return request.body;
  if (Buffer.isBuffer(request.body)) return request.body.toString("utf8");
  if (request.body && typeof request.body === "object") return JSON.stringify(request.body);
  return "";
};

/**
 * Minimal RFC-7578 multipart parser. The emulated rails only receive a handful
 * of small text parts (credentials, amount, phone), so a dependency-free parser
 * is enough and keeps the service zero-install.
 */
export const parseMultipart = (
  body: Buffer,
  contentType: string,
): Record<string, string> => {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) return {};
  const text = body.toString("latin1");
  const parts = text.split(`--${boundary}`);
  const output: Record<string, string> = {};
  for (const part of parts) {
    if (part === "--\r\n" || part === "--" || part.trim() === "") continue;
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    const value = part.slice(headerEnd + 4).replace(/\r\n$/, "");
    const name = /name="([^"]+)"/i.exec(headers)?.[1];
    if (name) output[name] = value;
  }
  return output;
};
