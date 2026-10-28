import Decimal from "decimal.js";

export type TransformOp = {
    value: string;
    group: "numeric" | "string" | "json" | "encoding" | "crypto";
    description: string;
};

export type TransformStep = {
    op: string;
    args: string[];
    output: string;
    ok: boolean;
    note?: string;
};

export type TransformResult = {
    steps: TransformStep[];
    final: string;
    failed: boolean;
};

export const TRANSFORM_OPS: TransformOp[] = [
    { value: "scale", group: "numeric", description: "value × 10^arg" },
    { value: "MUL_INT", group: "numeric", description: "value × integer arg" },
    { value: "DIV_DECIMAL", group: "numeric", description: "value ÷ decimal arg" },
    { value: "round", group: "numeric", description: "round half-up to arg decimal places" },
    { value: "format_decimal", group: "numeric", description: "fixed decimal string with arg places" },
    { value: "to_int", group: "numeric", description: "truncate toward zero" },
    { value: "to_number", group: "numeric", description: "parse as a decimal number" },
    { value: "to_string", group: "string", description: "render as text" },
    { value: "concat", group: "string", description: "append the joined args" },
    { value: "template", group: "string", description: "replace {value} in the arg" },
    { value: "lowercase", group: "string", description: "lower-case the text" },
    { value: "uppercase", group: "string", description: "upper-case the text" },
    { value: "trim", group: "string", description: "trim surrounding whitespace" },
    { value: "pad_left", group: "string", description: "pad with arg[0] to width arg[1]" },
    { value: "pad_right", group: "string", description: "pad with arg[0] to width arg[1]" },
    { value: "substring", group: "string", description: "slice from arg[0] for arg[1] chars" },
    { value: "mask", group: "string", description: "mask all but the last arg[0] chars" },
    { value: "prepend", group: "string", description: "prepend the joined args" },
    { value: "arabic_digits_to_ascii", group: "string", description: "convert ٠-٩ and ۰-۹ to 0-9" },
    { value: "phone_normalize", group: "string", description: "normalize a phone number to +digits" },
    { value: "sort_keys", group: "json", description: "recursively sort JSON object keys" },
    { value: "values_only", group: "json", description: "JSON object values as an array" },
    { value: "join_pairs", group: "json", description: "JSON object to k=v&k=v" },
    { value: "format_date", group: "json", description: "epoch/date to ISO-8601" },
    { value: "epoch_seconds", group: "json", description: "date to Unix seconds" },
    { value: "epoch_millis", group: "json", description: "date to Unix milliseconds" },
    { value: "uuid", group: "encoding", description: "generate an RFC 4122 v4 id" },
    { value: "numeric_random", group: "encoding", description: "generate arg[0] random digits" },
    { value: "base64_encode", group: "encoding", description: "UTF-8 base64 encode" },
    { value: "hex_lower", group: "encoding", description: "UTF-8 bytes as lower-case hex" },
    { value: "hex_upper", group: "encoding", description: "UTF-8 bytes as upper-case hex" },
    { value: "url_encode", group: "encoding", description: "encodeURIComponent" },
    { value: "json_encode", group: "encoding", description: "compact JSON encoding" },
    { value: "xml_escape", group: "encoding", description: "escape XML text entities" },
    { value: "sha256", group: "crypto", description: "backend-computed SHA-256" },
    { value: "sha512", group: "crypto", description: "backend-computed SHA-512" },
    { value: "hmac_sha256", group: "crypto", description: "backend-computed HMAC-SHA256" },
    { value: "hmac_sha512", group: "crypto", description: "backend-computed HMAC-SHA512" },
    { value: "rsa_sha256_sign", group: "crypto", description: "backend-computed RSA-SHA256 signature" },
];

const BACKEND_OPS = new Set(["sha256", "sha512", "hmac_sha256", "hmac_sha512", "rsa_sha256_sign"]);

const parseInput = (raw: string): unknown => {
    const trimmed = raw.trim();
    if (!trimmed) {
        return "";
    }
    try {
        return JSON.parse(trimmed) as unknown;
    } catch {
        return trimmed;
    }
};

const toText = (value: unknown): string => {
    if (value instanceof Decimal) {
        return value.toString();
    }
    if (typeof value === "string") {
        return value;
    }
    if (value === null || value === undefined) {
        return value === null ? "null" : "";
    }
    if (typeof value === "object") {
        return JSON.stringify(value);
    }
    return String(value);
};

const display = (value: unknown): string => {
    if (value instanceof Decimal) {
        return value.toString();
    }
    if (typeof value === "string") {
        return value;
    }
    if (value === null || value === undefined) {
        return value === null ? "null" : "";
    }
    if (typeof value === "object") {
        return JSON.stringify(value, null, 2);
    }
    return String(value);
};

const toDecimal = (value: unknown): Decimal => new Decimal(toText(value));

const sortKeysDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((entry) => sortKeysDeep(entry));
    }
    if (value !== null && typeof value === "object") {
        const source = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort()) {
            result[key] = sortKeysDeep(source[key]);
        }
        return result;
    }
    return value;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return null;
};

const textBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const toHex = (text: string, upper: boolean): string => {
    let out = "";
    for (const byte of textBytes(text)) {
        const part = byte.toString(16).padStart(2, "0");
        out += upper ? part.toUpperCase() : part;
    }
    return out;
};

const base64Encode = (text: string): string => {
    let binary = "";
    for (const byte of textBytes(text)) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
};

const arabicToAsciiDigits = (text: string): string => {
    const map: Record<string, string> = {
        "٠": "0",
        "١": "1",
        "٢": "2",
        "٣": "3",
        "٤": "4",
        "٥": "5",
        "٦": "6",
        "٧": "7",
        "٨": "8",
        "٩": "9",
        "۰": "0",
        "۱": "1",
        "۲": "2",
        "۳": "3",
        "۴": "4",
        "۵": "5",
        "۶": "6",
        "۷": "7",
        "۸": "8",
        "۹": "9",
    };
    return Array.from(text)
        .map((char) => map[char] ?? char)
        .join("");
};

const normalizePhone = (text: string): string => {
    const trimmed = text.trim().replace(/[^\d+]/g, "");
    if (trimmed.startsWith("00")) {
        return `+${trimmed.slice(2)}`;
    }
    if (trimmed.startsWith("+")) {
        return `+${trimmed.slice(1).replace(/\D/g, "")}`;
    }
    return trimmed.replace(/\D/g, "");
};

const uuidV4 = (): string => {
    const webCrypto = globalThis.crypto as Crypto | undefined;
    if (webCrypto && typeof webCrypto.randomUUID === "function") {
        return webCrypto.randomUUID();
    }
    const hex = "0123456789abcdef";
    let body = "";
    for (let index = 0; index < 32; index += 1) {
        const char = hex[Math.floor(Math.random() * 16)] ?? "0";
        body += char;
    }
    return `${body.slice(0, 8)}-${body.slice(8, 12)}-4${body.slice(13, 16)}-a${body.slice(17, 20)}-${body.slice(20, 32)}`;
};

const dateValue = (text: string): Date => {
    const numeric = Number(text);
    if (!Number.isNaN(numeric) && text.trim() !== "") {
        return new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    }
    return new Date(text);
};

const applyOp = (value: unknown, op: string, args: string[]): { value: unknown; note?: string } => {
    const arg = (index: number, fallback = ""): string => args[index] ?? fallback;

    if (BACKEND_OPS.has(op)) {
        return {
            value,
            note: "Backend-only operation in this teaching sandbox. The real pipeline runs it inside the signed edge/core boundary.",
        };
    }

    switch (op) {
        case "scale": {
            const exponent = Number(arg(0, "0")) || 0;
            return { value: toDecimal(value).times(new Decimal(10).pow(exponent)) };
        }
        case "MUL_INT":
            return { value: toDecimal(value).times(new Decimal(arg(0, "1"))) };
        case "DIV_DECIMAL":
            return { value: toDecimal(value).div(new Decimal(arg(0, "1"))) };
        case "round":
            return { value: toDecimal(value).toDecimalPlaces(Number(arg(0, "0")) || 0, Decimal.ROUND_HALF_UP) };
        case "format_decimal":
            return { value: toDecimal(value).toFixed(Number(arg(0, "2")) || 0) };
        case "to_int":
            return { value: toDecimal(value).trunc().toFixed(0) };
        case "to_number":
            return { value: toDecimal(value) };
        case "to_string":
            return { value: toText(value) };
        case "concat":
            return { value: `${toText(value)}${args.join("")}` };
        case "template":
            return { value: arg(0, "{value}").replace(/\{value\}/g, toText(value)) };
        case "lowercase":
            return { value: toText(value).toLowerCase() };
        case "uppercase":
            return { value: toText(value).toUpperCase() };
        case "trim":
            return { value: toText(value).trim() };
        case "pad_left": {
            const pad = arg(0, "0") || "0";
            const width = Number(arg(1, "0")) || 0;
            return { value: toText(value).padStart(width, pad.charAt(0)) };
        }
        case "pad_right": {
            const pad = arg(0, "0") || "0";
            const width = Number(arg(1, "0")) || 0;
            return { value: toText(value).padEnd(width, pad.charAt(0)) };
        }
        case "substring": {
            const start = Number(arg(0, "0")) || 0;
            const length = Number(arg(1, "0"));
            return { value: length > 0 ? toText(value).slice(start, start + length) : toText(value).slice(start) };
        }
        case "mask": {
            const visible = Math.max(0, Number(arg(0, "4")) || 4);
            const text = toText(value);
            const hiddenLength = Math.max(0, text.length - visible);
            return { value: `${"*".repeat(hiddenLength)}${text.slice(hiddenLength)}` };
        }
        case "prepend":
            return { value: `${args.join("")}${toText(value)}` };
        case "arabic_digits_to_ascii":
            return { value: arabicToAsciiDigits(toText(value)) };
        case "phone_normalize":
            return { value: normalizePhone(toText(value)) };
        case "sort_keys":
            return { value: sortKeysDeep(value) };
        case "values_only": {
            const record = asRecord(value);
            return { value: record ? Object.values(record) : [] };
        }
        case "join_pairs": {
            const record = asRecord(value);
            if (!record) {
                return { value: "" };
            }
            return { value: Object.entries(record).map(([key, entry]) => `${key}=${toText(entry)}`).join("&") };
        }
        case "format_date": {
            const parsed = dateValue(toText(value));
            return { value: Number.isNaN(parsed.getTime()) ? "invalid-date" : parsed.toISOString() };
        }
        case "epoch_seconds": {
            const parsed = dateValue(toText(value));
            return { value: Number.isNaN(parsed.getTime()) ? "invalid-date" : String(Math.floor(parsed.getTime() / 1000)) };
        }
        case "epoch_millis": {
            const parsed = dateValue(toText(value));
            return { value: Number.isNaN(parsed.getTime()) ? "invalid-date" : String(parsed.getTime()) };
        }
        case "uuid":
            return { value: uuidV4(), note: "Locally generated in the browser; production ids come from the core." };
        case "numeric_random": {
            const length = Math.max(1, Math.min(18, Number(arg(0, "6")) || 6));
            let out = "";
            for (let index = 0; index < length; index += 1) {
                out += String(Math.floor(Math.random() * 10));
            }
            return { value: out, note: "Math.random is illustrative only; production uses a CSPRNG." };
        }
        case "base64_encode":
            return { value: base64Encode(toText(value)) };
        case "hex_lower":
            return { value: toHex(toText(value), false) };
        case "hex_upper":
            return { value: toHex(toText(value), true) };
        case "url_encode":
            return { value: encodeURIComponent(toText(value)) };
        case "json_encode":
            return { value: JSON.stringify(value) };
        case "xml_escape":
            return {
                value: toText(value)
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/"/g, "&quot;")
                    .replace(/'/g, "&apos;"),
            };
        default:
            return { value, note: `Unknown operation "${op}" was skipped.` };
    }
};

export const parseTransformArgs = (raw: string): string[] =>
    raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

export const runTransform = (input: string, operations: string[], rawArgs: string): TransformResult => {
    const args = parseTransformArgs(rawArgs);
    let current = parseInput(input);
    const steps: TransformStep[] = [];
    let failed = false;

    for (const op of operations) {
        try {
            const applied = applyOp(current, op, args);
            current = applied.value;
            steps.push({
                op,
                args,
                output: display(current),
                ok: true,
                ...(applied.note ? { note: applied.note } : {}),
            });
        } catch (error) {
            failed = true;
            steps.push({
                op,
                args,
                output: error instanceof Error ? error.message : "operation failed",
                ok: false,
            });
            break;
        }
    }

    return {
        steps,
        final: display(current),
        failed,
    };
};
