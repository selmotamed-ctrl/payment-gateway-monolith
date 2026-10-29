import z from "zod";
import { ApiError } from "../error";

export const passportRegex = /^[A-Z0-9a-z]{8}$/;
export const nationalIdRegex = /^[12][0-9]{11}$/;
export const phoneRegex = /^(?:(?:(?:00|\+)?218)|0)?([9][1-5][0-9]{7})$/;

export const zPhone = z
  .string()
  .regex(phoneRegex, { error: "Phone Invalid" })
  .transform((value) => {
    const match = value.match(phoneRegex)!;
    return match[1]!;
  });

export const zNationalId = z.string().regex(nationalIdRegex, { error: "invalid national id" });

export const zPassportNumber = z.string().regex(passportRegex, { error: "invalid passport number" });

export const zEmail = z.email({ error: "invalid email address" });

export const zUuid = z.uuid({ error: "invalid uuid" });

export const zIdentifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "invalid identifier");

export const zLinkKey = z
  .string()
  .min(6)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "invalid link key");

export const zAmount = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, { error: "amount must be a decimal string with up to 4 decimals" });

export const zCurrency = z.string().regex(/^[A-Z]{3}$/, { error: "currency must be an ISO 4217 code" });

export const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: "month must be formatted as YYYY-MM" });

export const zOtp = z.string().regex(/^\d{4,8}$/, { error: "invalid otp" });

export const zMfaCode = z.string().regex(/^\d{6}$/, { error: "invalid mfa code" });

export const zIdempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, "invalid idempotency key");

export const zCidrList = z.array(z.string().min(3).max(64)).max(64);

export const zPassword = z
  .string()
  .min(10)
  .max(128)
  .regex(/[a-z]/, "password must contain a lowercase letter")
  .regex(/[A-Z]/, "password must contain an uppercase letter")
  .regex(/\d/, "password must contain a digit");

export const zOptionalText = (max: number) => z.string().max(max).optional();

export const zJsonObject = z.record(z.string().max(64), z.unknown());

const MAGIC_BYTES: { mime: string; signature: number[] }[] = [
  { mime: "image/png", signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", signature: [0xff, 0xd8, 0xff] },
  { mime: "application/pdf", signature: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

export const detectUploadMime = (buffer: Buffer): string | null => {
  for (const candidate of MAGIC_BYTES) {
    if (buffer.byteLength < candidate.signature.length) continue;
    const matches = candidate.signature.every((byte, index) => buffer[index] === byte);
    if (matches) return candidate.mime;
  }
  return null;
};

export const assertAllowedUpload = (
  buffer: Buffer,
  declaredMime: string | undefined,
  allowedMimes: string[],
  maxBytes: number,
): string => {
  if (buffer.byteLength === 0) {
    throw new ApiError(400, "UPLOAD_EMPTY", "The uploaded document is empty");
  }
  if (buffer.byteLength > maxBytes) {
    throw new ApiError(413, "UPLOAD_TOO_LARGE", "The uploaded document exceeds the size limit", {
      maxBytes,
      receivedBytes: buffer.byteLength,
    });
  }
  const normalized = (declaredMime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!allowedMimes.includes(normalized)) {
    throw new ApiError(415, "UNSUPPORTED_UPLOAD_TYPE", "The uploaded document type is not accepted", {
      allowed: allowedMimes,
      received: normalized,
    });
  }
  const detected = detectUploadMime(buffer);
  if (!detected) {
    throw new ApiError(415, "UPLOAD_SIGNATURE_MISMATCH", "The uploaded document is not a valid PNG, JPEG or PDF file");
  }
  if (detected !== normalized) {
    throw new ApiError(415, "UPLOAD_SIGNATURE_MISMATCH", "The uploaded document content does not match its declared type", {
      declared: normalized,
      detected,
    });
  }
  return detected;
};

export const zListQuery = z
  .object({
    search: z.string().max(200).optional(),
    page: z.coerce.number().int().min(1).max(10000).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
    sortKey: z.string().max(64).optional(),
    sortDirection: z.enum(["asc", "desc"]).optional(),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    dateFrom: z.string().max(40).optional(),
    dateTo: z.string().max(40).optional(),
  })
  .passthrough();

