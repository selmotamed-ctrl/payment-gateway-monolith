import type { NextFunction, Request, Response } from "express";
import z from "zod";

export const apiErrorSymbol = Symbol("api-error");

export interface ApiErrorEnvelope {
  code: string;
  message: string;
  reference?: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly __symbol = apiErrorSymbol;
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly reference?: string;

  constructor(status: number, code: string, message: string, details?: unknown, reference?: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = status;
    this.code = code;
    this.details = details;
    this.reference = reference;
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  toEnvelope(): ApiErrorEnvelope {
    const envelope: ApiErrorEnvelope = { code: this.code, message: this.message };
    if (this.reference !== undefined) envelope.reference = this.reference;
    if (this.details !== undefined) envelope.details = this.details;
    return envelope;
  }
}

export const isApiError = (error: unknown): error is ApiError => {
  if (error instanceof ApiError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { __symbol?: unknown }).__symbol === apiErrorSymbol
  );
};

export const parseOrThrow = <T extends z.ZodType>(schema: T, data: unknown): z.infer<T> => {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw new ApiError(400, "VALIDATION_FAILED", "Request payload failed validation", result.error.issues);
};

export const errorCodePrefixer = (prefix: string) => {
  const normalized = prefix.toUpperCase().replaceAll(" ", "_");
  return (code: string) => `${normalized}${code.toUpperCase().replaceAll(" ", "_")}`;
};

export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({
    code: "NOT_FOUND",
    message: `No route matches ${req.method} ${req.path}`,
  } satisfies ApiErrorEnvelope);
};

export const apiErrorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const parserStatus = (error as { status?: unknown; type?: unknown } | null)?.status;
  if (
    typeof parserStatus === "number" &&
    parserStatus >= 400 &&
    parserStatus < 500 &&
    typeof (error as { type?: unknown }).type === "string"
  ) {
    // body-parser failures (payload too large, malformed json, bad encoding): a client error.
    const tooLarge = parserStatus === 413;
    res.status(parserStatus).json({
      code: tooLarge ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST",
      message: tooLarge ? "The request body exceeds the size limit" : "The request body could not be parsed",
    } satisfies ApiErrorEnvelope);
    return;
  }
  if (!isApiError(error)) {
    console.error("Unhandled edge error", error instanceof Error ? error.message : String(error));
    res.status(500).json({
      code: "SERVER_ERROR",
      message: "Unexpected server error",
    } satisfies ApiErrorEnvelope);
    return;
  }
  res.status(error.statusCode).json(error.toEnvelope());
};
