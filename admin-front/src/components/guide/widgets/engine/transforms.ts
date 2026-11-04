import { toAsciiDigits } from "../../../../utils/arabic";
import { decimal, formatDecimal, roundDecimal, safeDecimalString } from "./safeAmount";

export type TransformOperation = {
    op: string;
    args?: (string | number)[];
};

export const TRANSFORM_LIBRARY = [
    "scale",
    "div_decimal",
    "round",
    "format_decimal",
    "to_int",
    "to_number",
    "to_string",
    "concat",
    "lowercase",
    "uppercase",
    "trim",
    "pad_left",
    "pad_right",
    "substring",
    "mask",
    "arabic_digits_to_ascii",
    "phone_normalize",
    "base64_encode",
    "hex_lower",
    "hex_upper",
    "url_encode",
    "json_encode",
    "xml_escape",
    "sha256",
] as const;

export type TransformName = (typeof TRANSFORM_LIBRARY)[number];

export interface TransformStep {
    operation: string;
    value: string;
}

export interface TransformResult {
    value: string;
    steps: TransformStep[];
    error?: string;
}

const textEncoder = new TextEncoder();

const bytesToHex = (bytes: Uint8Array): string =>
    Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");

const isHexString = (value: string): boolean =>
    value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return globalThis.btoa(binary);
};

const argNumber = (args: (string | number)[] | undefined, index: number, fallback: number): number => {
    const value = args?.[index];
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

export const normalizePhoneForTeaching = (
    input: string,
    style: "LOCAL_09" | "INTL_218" | "E164",
): string => {
    const digits = toAsciiDigits(String(input ?? "")).replace(/\D+/g, "");
    let local = digits;
    if (local.startsWith("00218")) local = local.slice(2);
    if (local.startsWith("218")) local = `0${local.slice(3)}`;
    if (!local.startsWith("0") && local.length === 9) local = `0${local}`;
    if (style === "LOCAL_09") return local;
    const international = local.replace(/^0/, "");
    if (style === "INTL_218") return `218${international}`;
    return `+218${international}`;
};

const applyOperation = async (value: string, operation: TransformOperation): Promise<string> => {
    const args = operation.args ?? [];
    switch (operation.op) {
        case "scale":
            return safeDecimalString(decimal(value).mul(String(args[0] ?? 1)));
        case "div_decimal": {
            const divisor = decimal(String(args[0] ?? 1));
            if (divisor.isZero()) throw new Error("Cannot divide by zero.");
            return formatDecimal(decimal(value).div(divisor), argNumber(args, 1, 2));
        }
        case "round": {
            const mode = String(args[0] ?? "NEAREST").toUpperCase();
            return safeDecimalString(
                roundDecimal(
                    value,
                    argNumber(args, 1, 2),
                    mode === "UP" ? "UP" : mode === "DOWN" ? "DOWN" : "NEAREST",
                ),
            );
        }
        case "format_decimal":
            return formatDecimal(value, argNumber(args, 0, 2));
        case "to_int":
            return safeDecimalString(roundDecimal(value, 0, "NEAREST"));
        case "to_number":
            return safeDecimalString(decimal(value));
        case "to_string":
            return String(value);
        case "concat":
            return `${value}${String(args[0] ?? "")}`;
        case "lowercase":
            return value.toLowerCase();
        case "uppercase":
            return value.toUpperCase();
        case "trim":
            return value.trim();
        case "pad_left": {
            const length = argNumber(args, 0, 0);
            const character = String(args[1] ?? " ");
            return value.padStart(length, character);
        }
        case "pad_right": {
            const length = argNumber(args, 0, 0);
            const character = String(args[1] ?? " ");
            return value.padEnd(length, character);
        }
        case "substring":
            return value.slice(argNumber(args, 0, 0), argNumber(args, 1, value.length));
        case "mask": {
            const start = Math.max(0, argNumber(args, 0, 0));
            const end = Math.max(0, argNumber(args, 1, 0));
            if (start + end >= value.length) return value;
            return `${value.slice(0, start)}${"*".repeat(value.length - start - end)}${value.slice(value.length - end)}`;
        }
        case "arabic_digits_to_ascii":
            return toAsciiDigits(value);
        case "phone_normalize":
            return normalizePhoneForTeaching(value, String(args[0] ?? "LOCAL_09") as "LOCAL_09" | "INTL_218" | "E164");
        case "base64_encode":
            return bytesToBase64(textEncoder.encode(value));
        case "hex_lower":
            return isHexString(value)
                ? value.toLowerCase()
                : bytesToHex(textEncoder.encode(value)).toLowerCase();
        case "hex_upper":
            return isHexString(value)
                ? value.toUpperCase()
                : bytesToHex(textEncoder.encode(value)).toUpperCase();
        case "url_encode":
            return encodeURIComponent(value);
        case "json_encode":
            return JSON.stringify(value);
        case "xml_escape":
            return value
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&apos;");
        case "sha256": {
            const digest = await globalThis.crypto.subtle.digest("SHA-256", textEncoder.encode(value));
            return bytesToHex(new Uint8Array(digest));
        }
        default:
            throw new Error(`Unknown operation "${operation.op}".`);
    }
};

export const operationLabel = (operation: TransformOperation): string =>
    `${operation.op}(${(operation.args ?? []).map((arg) => JSON.stringify(arg)).join(", ")})`;

export const applyTransforms = async (
    input: string,
    operations: TransformOperation[],
): Promise<TransformResult> => {
    const steps: TransformStep[] = [];
    let value = input;
    for (const operation of operations) {
        if (!TRANSFORM_LIBRARY.includes(operation.op as TransformName)) {
            return {
                value,
                steps,
                error: `Unknown operation "${operation.op}". Choose an operation from the closed library.`,
            };
        }
        try {
            value = await applyOperation(value, operation);
            steps.push({ operation: operationLabel(operation), value });
        } catch (error) {
            return {
                value,
                steps,
                error: (error as Error).message,
            };
        }
    }
    return { value, steps };
};
