export type CryptoMode =
    | "SORTED_KEY_VALUE_AMP"
    | "SORTED_VALUES_HASH"
    | "TIMESTAMP_DOT_RAW_BODY"
    | "RAW_BODY";

export type KeyEncoding = "UTF8" | "HEX" | "BASE64";
export type OutputEncoding = "HEX_LOWER" | "HEX_UPPER" | "BASE64";

export interface CryptoInput {
    mode: CryptoMode;
    key: string;
    keyEncoding: KeyEncoding;
    outputEncoding: OutputEncoding;
    fields?: Record<string, string>;
    timestamp?: string;
    body?: string;
    sortDirection?: "ASC" | "DESC";
}

export interface CryptoResult {
    canonical: string;
    canonicalVisible: string;
    keyBytes: number;
    output: string;
    error?: string;
}

const textEncoder = new TextEncoder();

const bytesToHex = (bytes: Uint8Array): string =>
    Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globalThis.btoa(binary);
};

const hexToBytes = (value: string): Uint8Array => {
    const clean = value.replace(/^0x/i, "").replace(/\s+/g, "");
    if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) {
        throw new Error("HEX key must contain an even number of hexadecimal characters.");
    }
    const bytes = new Uint8Array(clean.length / 2);
    for (let index = 0; index < clean.length; index += 2) {
        bytes[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16);
    }
    return bytes;
};

const base64ToBytes = (value: string): Uint8Array => {
    const binary = globalThis.atob(value.trim());
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
};

export const decodeKey = (key: string, encoding: KeyEncoding): Uint8Array => {
    if (encoding === "HEX") return hexToBytes(key);
    if (encoding === "BASE64") return base64ToBytes(key);
    return textEncoder.encode(key);
};

export const canonicalStringFor = (input: CryptoInput): string => {
    const fields = input.fields ?? {};
    const direction = input.sortDirection === "DESC" ? -1 : 1;
    const keys = Object.keys(fields).sort((left, right) => direction * left.localeCompare(right));
    if (input.mode === "SORTED_KEY_VALUE_AMP") {
        return keys.map((key) => `${key}=${fields[key]}`).join("&");
    }
    if (input.mode === "SORTED_VALUES_HASH") {
        return keys.map((key) => fields[key]).join("");
    }
    if (input.mode === "TIMESTAMP_DOT_RAW_BODY") {
        return `${input.timestamp ?? ""}.${input.body ?? ""}`;
    }
    return input.body ?? "";
};

export const visibleCanonicalString = (canonical: string): string =>
    canonical.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");

export const hmacSha256 = async (input: CryptoInput): Promise<CryptoResult> => {
    try {
        const keyBytes = decodeKey(input.key, input.keyEncoding);
        const canonical = canonicalStringFor(input);
        const key = await globalThis.crypto.subtle.importKey(
            "raw",
            keyBytes as unknown as BufferSource,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
        );
        const signature = await globalThis.crypto.subtle.sign(
            "HMAC",
            key,
            textEncoder.encode(canonical) as unknown as BufferSource,
        );
        const bytes = new Uint8Array(signature);
        const hex = bytesToHex(bytes);
        const output =
            input.outputEncoding === "HEX_UPPER"
                ? hex.toUpperCase()
                : input.outputEncoding === "BASE64"
                  ? bytesToBase64(bytes)
                  : hex;
        return {
            canonical,
            canonicalVisible: visibleCanonicalString(canonical),
            keyBytes: keyBytes.length,
            output,
        };
    } catch (error) {
        return {
            canonical: "",
            canonicalVisible: "",
            keyBytes: 0,
            output: "",
            error: (error as Error).message,
        };
    }
};

export const signaturesMatch = (left: string, right: string): boolean =>
    left.trim().toLowerCase() === right.trim().toLowerCase();

export const COMMON_SIGNATURE_FAILURES = [
    "Wrong key encoding: the partner gave the key in HEX or BASE64, not plain text.",
    "Wrong field order or field set: a field was added, removed, or sorted differently.",
    "Wrong output case: the partner expects HEX_UPPER or HEX_LOWER, or BASE64.",
];
