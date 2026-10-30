import { z } from "zod";

/** Libyan mobile numbers accepted by the emulated OTP rails. */
export const libyanPhoneRegex = /^(?:\+?218|0)?(9[1-5][0-9]{7})$/;

export const zLibyanPhone = z
  .string()
  .trim()
  .regex(libyanPhoneRegex, "must be a Libyan mobile number")
  .transform((value) => value.replace(/^(\+?218|0)/, ""));

export const zOtp = z.string().trim().regex(/^[0-9]{4,6}$/, "must be a 4-6 digit OTP");

export const zAmountWire = z.string().trim().regex(/^-?[0-9]+(?:\.[0-9]{1,6})?$/, "must be a decimal string");

export const zReference = z.string().trim().min(1).max(128);

export const zIdempotencyKey = z.string().trim().min(1).max(200);

export const zMaskPhone = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length < 4) return "****";
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
};

export const zMaskCard = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const digits = value.replace(/[^0-9]/g, "");
  return digits.length >= 4 ? `**** **** **** ${digits.slice(-4)}` : "****";
};

export const zMaskWallet = (value: string | null | undefined): string | null => {
  if (!value) return null;
  return value.length >= 4 ? `${value.slice(0, 3)}***${value.slice(-3)}` : "***";
};
