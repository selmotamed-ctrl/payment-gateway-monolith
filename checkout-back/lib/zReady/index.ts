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

export const zLinkKey = z
  .string()
  .min(6, "link key is too short")
  .max(64, "link key is too long")
  .regex(/^[A-Za-z0-9_-]+$/, "invalid link key");

export const zAttemptId = z
  .string()
  .min(6, "attempt id is too short")
  .max(64, "attempt id is too long")
  .regex(/^[A-Za-z0-9_-]+$/, "invalid attempt id");

export const zAttemptToken = z
  .string()
  .min(8, "attempt token is too short")
  .max(256, "attempt token is too long")
  .regex(/^[A-Za-z0-9_-]+$/, "invalid attempt token");

export const zRailCode = z
  .string()
  .min(1, "rail code is required")
  .max(64, "rail code is too long")
  .regex(/^[A-Za-z0-9_-]+$/, "invalid rail code");

export const zOtp = z.string().regex(/^\d{4,8}$/, { error: "invalid otp" });

export const zIdempotencyKey = z
  .string()
  .min(8, "idempotency key is too short")
  .max(128, "idempotency key is too long")
  .regex(/^[A-Za-z0-9_.:-]+$/, "invalid idempotency key");

export const zFormData = z.record(
  z.string().max(128),
  z.union([z.string().max(512), z.number(), z.boolean(), z.null()]),
);

export const zEvidence = z.record(z.string().max(64), z.unknown());

export const zClientEvent = z.enum([
  "COMPLETE_CALLBACK",
  "ERROR_CALLBACK",
  "CANCEL_CALLBACK",
  "WIDGET_READY",
  "WIDGET_CLOSED",
]);

const FORBIDDEN_MONETARY_NAMES = new Set([
  "amount",
  "amountminor",
  "amountmajor",
  "amountlyd",
  "amountminorunits",
  "currency",
  "currencycode",
  "total",
  "totalamount",
  "fee",
  "fees",
  "commission",
  "commissionamount",
  "exchangerate",
  "price",
  "netamount",
  "grossamount",
  "debitamount",
  "creditamount",
]);

const normalizeFieldName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

export const isForbiddenMonetaryField = (name: string): boolean =>
  FORBIDDEN_MONETARY_NAMES.has(normalizeFieldName(name));

export const findForbiddenMonetaryField = (
  payload: unknown,
  path = "",
  depth = 0,
  budget = { nodes: 0 },
): string | null => {
  if (depth > 8 || budget.nodes > 2000) return null;
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const found = findForbiddenMonetaryField(entry, path, depth + 1, budget);
      if (found) return found;
    }
    return null;
  }
  if (payload && typeof payload === "object") {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      budget.nodes += 1;
      if (isForbiddenMonetaryField(key)) return path ? `${path}.${key}` : key;
      const found = findForbiddenMonetaryField(value, path ? `${path}.${key}` : key, depth + 1, budget);
      if (found) return found;
    }
  }
  return null;
};

export const assertNoMonetaryFields = (payload: unknown): void => {
  const forbidden = findForbiddenMonetaryField(payload);
  if (forbidden) {
    throw new ApiError(
      400,
      "AMOUNT_NOT_ACCEPTED",
      "Checkout requests must never carry amount or currency; the core resolves them from the payment link",
      { field: forbidden },
    );
  }
};
