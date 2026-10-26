import { z } from "zod";

export const apiErrorSymbol = Symbol("api-error");

export interface ErrorEnvelope {
  code: string;
  message: string;
  reference?: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly __symbol = apiErrorSymbol;
  readonly [apiErrorSymbol] = true;
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  reference?: string;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  get error(): string {
    return this.message;
  }

  get data(): unknown {
    return this.details;
  }

  toJSON(): ErrorEnvelope {
    return toErrorEnvelope(this, this.reference);
  }
}

export const isApiError = (error: unknown): error is ApiError => {
  if (error instanceof ApiError) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "__symbol" in error &&
    (error as { __symbol?: unknown }).__symbol === apiErrorSymbol
  );
};

export const errorCodePrefixer = (prefix: string) => {
  const normalizedPrefix = prefix.toUpperCase().replaceAll(" ", "_");

  return (code: string) => {
    const normalizedCode = code.toUpperCase().replaceAll(" ", "_");
    return `${normalizedPrefix}${normalizedCode}`;
  };
};

export const toErrorEnvelope = (error: unknown, reference?: string): ErrorEnvelope => {
  if (isApiError(error)) {
    const envelope: ErrorEnvelope = {
      code: error.code,
      message: error.message,
    };
    const errorReference = error.reference ?? reference;
    if (errorReference) {
      envelope.reference = errorReference;
    }
    if (error.details !== undefined) {
      envelope.details = error.details;
    }
    return envelope;
  }

  return {
    code: "SERVER_ERROR",
    message: "Internal server error",
    ...(reference ? { reference } : {}),
  };
};

export const parseOrThrow = <T extends z.ZodType>(
  schema: T,
  data: unknown,
): z.output<T> => {
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  const details = result.error.issues.map((issue) => ({
    path: issue.path,
    code: issue.code,
    message: issue.message,
  }));

  throw new ApiError(400, "INVALID_BODY", "Invalid request data", details);
};
