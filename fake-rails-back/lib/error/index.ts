import { z } from "zod";

export const apiErrorSymbol = Symbol("api-error");

export interface ErrorEnvelope {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly __symbol = apiErrorSymbol;
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const isApiError = (error: unknown): error is ApiError => {
  if (error instanceof ApiError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    "__symbol" in error &&
    (error as { __symbol?: unknown }).__symbol === apiErrorSymbol
  );
};

export const toErrorEnvelope = (error: unknown): ErrorEnvelope => {
  if (isApiError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  return { code: "SERVER_ERROR", message: "Internal server error" };
};

export const parseOrThrow = <T extends z.ZodType>(schema: T, data: unknown): z.output<T> => {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw new ApiError(
    400,
    "INVALID_BODY",
    "Invalid request data",
    result.error.issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message })),
  );
};
