import z from "zod";
import { ApiError } from "../error";

export const zUuid = z.uuid({ error: "invalid uuid" });

export const zEmail = z.email({ error: "invalid email address" });

export const zIdentifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "invalid identifier");

export const zAmount = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, { error: "amount must be a decimal string with up to 4 decimals" });

export const zCurrency = z.string().regex(/^[A-Z]{3}$/, { error: "currency must be an ISO 4217 code" });

export const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: "month must be formatted as YYYY-MM" });

export const zOtp = z.string().regex(/^\d{4,8}$/, { error: "invalid otp" });

export const zMfaCode = z.string().regex(/^\d{6}$/, { error: "invalid mfa code" });

export const zPassword = z
  .string()
  .min(12)
  .max(128)
  .regex(/[a-z]/, "password must contain a lowercase letter")
  .regex(/[A-Z]/, "password must contain an uppercase letter")
  .regex(/\d/, "password must contain a digit");

export const zJsonObject = z.record(z.string().max(64), z.unknown());

export const zConfigDocument = z.record(z.string().max(64), z.unknown());

export const zReason = z.string().min(3).max(500);

export const zBaseVersion = z.number().int().min(1);

export const zJsonPatch = z.array(
  z
    .object({
      op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
      path: z.string().min(1).max(512),
      value: z.unknown().optional(),
      from: z.string().min(1).max(512).optional(),
    })
    .strict(),
);

export const zAdminRole = z.enum([
  "GATEWAY_ADMIN",
  "SECURITY_ADMIN",
  "FINANCE",
  "OPERATOR",
  "COMPLIANCE",
  "MLRO",
  "SUPPORT",
]);

export const zPaginationQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).optional(),
    pageSize: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

export const zDateRangeQuery = z
  .object({
    from: z.string().max(64).optional(),
    to: z.string().max(64).optional(),
    currency: zCurrency.optional(),
  })
  .strict();

export const zGatewayCode = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "invalid gateway code");

export const zVersionNumber = z.coerce.number().int().min(1).max(100000);

export const detectUploadMime = (buffer: Buffer): string | null => {
  const csv = buffer.subarray(0, 4096).toString("utf8");
  if (buffer.byteLength >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return "text/csv";
  if (buffer.byteLength >= 2 && buffer[0] === 0xef && buffer[1] === 0xbb) return "text/csv";
  if (buffer.byteLength >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return "application/vnd.ms-excel";
  }
  const trimmed = csv.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "application/json";
  if (trimmed.includes(",") || trimmed.includes(";")) return "text/csv";
  return null;
};

export const assertAllowedUpload = (
  buffer: Buffer,
  declaredMime: string | undefined,
  allowedMimes: string[],
  maxBytes: number,
): string => {
  if (buffer.byteLength === 0) {
    throw new ApiError(400, "UPLOAD_EMPTY", "The uploaded statement is empty");
  }
  if (buffer.byteLength > maxBytes) {
    throw new ApiError(413, "UPLOAD_TOO_LARGE", "The uploaded statement exceeds the size limit", {
      maxBytes,
      receivedBytes: buffer.byteLength,
    });
  }
  const normalized = (declaredMime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!allowedMimes.includes(normalized)) {
    throw new ApiError(415, "UNSUPPORTED_UPLOAD_TYPE", "The uploaded statement type is not accepted", {
      allowed: allowedMimes,
      received: normalized,
    });
  }
  const detected = detectUploadMime(buffer);
  if (!detected) {
    throw new ApiError(415, "UPLOAD_SIGNATURE_MISMATCH", "The uploaded statement is not a CSV, XLSX or JSON file");
  }
  if (detected !== normalized) {
    throw new ApiError(415, "UPLOAD_SIGNATURE_MISMATCH", "The uploaded statement content does not match its declared type", {
      declared: normalized,
      detected,
    });
  }
  return detected;
};
