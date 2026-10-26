import { z } from "zod";
import { normalizeArabicDigits, normalizePhone } from "@/utils/arabic";
import type { RailFieldDescriptor } from "@/components/renderers/types";

export const zRequiredText = z.string().min(1, "this field is required");

export const buildRailFieldSchema = (field: RailFieldDescriptor): z.ZodType<string> => {
    let schema = z.string();
    if (field.required) {
        schema = schema.min(1, "this field is required");
    }
    if (field.minLength != null) {
        schema = schema.min(field.minLength, `minimum length is ${field.minLength}`);
    }
    if (field.maxLength != null) {
        schema = schema.max(field.maxLength, `maximum length is ${field.maxLength}`);
    }
    if (field.regex) {
        try {
            schema = schema.regex(new RegExp(field.regex), "the format is not valid");
        } catch {
            schema = schema;
        }
    }
    switch (field.inputType) {
        case "numeric":
            schema = schema.regex(/^\d+(\.\d+)?$/, "only digits are allowed");
            break;
        case "phone":
            schema = schema.regex(/^0\d{8,9}$/, "enter a valid local mobile number");
            break;
        case "wallet_id":
            schema = schema.regex(/^NP-\d{12}$/, "enter a valid wallet id");
            break;
        case "otp":
            schema = schema.regex(/^\d{4,8}$/, "enter a valid code");
            break;
        default:
            break;
    }
    return schema;
};

export const buildRailFormSchema = (fields: RailFieldDescriptor[]) => {
    const shape: Record<string, z.ZodType<string>> = {};
    for (const field of fields) {
        shape[field.key] = buildRailFieldSchema(field);
    }
    return z.object(shape);
};

export const normalizeFieldValue = (field: RailFieldDescriptor, value: string | null | undefined): string => {
    let normalized = normalizeArabicDigits(value ?? "").trim();
    if (field.inputType === "phone") {
        normalized = normalizePhone(normalized, "LOCAL_09");
    }
    if (field.inputType === "numeric" || field.inputType === "otp") {
        normalized = normalized.replace(/[^\d.]/g, "");
    }
    return normalized;
};

export const normalizeFormValues = (
    fields: RailFieldDescriptor[],
    values: Record<string, string>,
): Record<string, string> => {
    const output: Record<string, string> = {};
    for (const field of fields) {
        output[field.key] = normalizeFieldValue(field, values[field.key]);
    }
    return output;
};

export const zAttemptId = z.string().min(1);
export const zLinkKey = z.string().min(4).max(120);
export const zIdempotencyKey = z.string().min(8).max(120);
