import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { VAlert, VBtn, VCard, VCardText, VSelect, VTextField } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";


type KvRow = { id: number; key: string; value: string };

const MODES = [
    { title: "SORTED_KEY_VALUE_AMP (Moamalat NPG)", value: "SORTED_KEY_VALUE_AMP" },
    { title: "TIMESTAMP_DOT_RAW_BODY (DPay)", value: "TIMESTAMP_DOT_RAW_BODY" },
    { title: "SORTED_VALUES_HASH (Plutu callback)", value: "SORTED_VALUES_HASH" },
    { title: "RAW_BODY (MyPay)", value: "RAW_BODY" },
    { title: "TEMPLATE_STRING", value: "TEMPLATE_STRING" },
    { title: "JSON_CANONICAL", value: "JSON_CANONICAL" },
];

const ENCODINGS = [
    { title: "UTF-8", value: "UTF8" },
    { title: "HEX", value: "HEX" },
    { title: "BASE64", value: "BASE64" },
];

const MONO = {
    margin: 0,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "12px",
    lineHeight: 1.55,
};

const sortKeysDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((entry) => sortKeysDeep(entry));
    if (value !== null && typeof value === "object") {
        const source = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort()) result[key] = sortKeysDeep(source[key]);
        return result;
    }
    return value;
};

const hexToBytes = (hex: string): Uint8Array => {
    const normalized = hex.replace(/[^0-9a-fA-F]/g, "");
    const pairs = normalized.match(/.{1,2}/g) ?? [];
    return new Uint8Array(pairs.map((pair) => Number.parseInt(pair.padEnd(2, "0"), 16)));
};

const decodeKey = (secret: string, encoding: string): Uint8Array => {
    if (encoding === "HEX") return hexToBytes(secret);
    if (encoding === "BASE64") {
        const binary = atob(secret);
        return new Uint8Array([...binary].map((char) => char.charCodeAt(0)));
    }
    return new TextEncoder().encode(secret);
};

const toHexUpper = (buffer: ArrayBuffer): string =>
    [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();

export const CryptoSignatureLab = dc(() => {
    let sequence = 4;
    const rows = ref<KvRow[]>([
        { id: 1, key: "amount", value: "10500" },
        { id: 2, key: "currency", value: "LYD" },
        { id: 3, key: "merchantId", value: "MRC-1042" },
    ]);
    const mode = ref("SORTED_KEY_VALUE_AMP");
    const timestamp = ref(String(Math.floor(Date.now() / 1000)));
    const secret = ref("30313233343536373839414243444546");
    const encoding = ref("HEX");
    const template = ref("{merchantId}:{amount}:{currency}");
    const signature = ref<string | null>(null);
    const error = ref<string | null>(null);

    const update = (id: number, field: "key" | "value", value: string) => {
        rows.value = rows.value.map((row) => (row.id === id ? { ...row, [field]: value } : row));
    };
    const add = () => {
        rows.value = [...rows.value, { id: sequence, key: "", value: "" }];
        sequence += 1;
    };
    const remove = (id: number) => {
        rows.value = rows.value.filter((row) => row.id !== id);
    };

    const record = computed(() => {
        const result: Record<string, string> = {};
        for (const row of rows.value) {
            if (row.key.trim()) result[row.key.trim()] = row.value;
        }
        return result;
    });

    const canonical = computed(() => {
        const entries = rows.value.filter((row) => row.key.trim());
        switch (mode.value) {
            case "SORTED_VALUES_HASH":
                return entries
                    .filter((row) => row.key !== "hashed")
                    .map((row) => row.value)
                    .sort()
                    .join("&");
            case "TIMESTAMP_DOT_RAW_BODY":
                return `${timestamp.value}.${JSON.stringify(record.value)}`;
            case "RAW_BODY":
                return JSON.stringify(record.value);
            case "JSON_CANONICAL":
                return JSON.stringify(sortKeysDeep(record.value));
            case "TEMPLATE_STRING":
                return template.value.replace(/\{(\w+)\}/g, (match, key: string) => record.value[key] ?? match);
            case "SORTED_KEY_VALUE_AMP":
            default:
                return entries
                    .slice()
                    .sort((left, right) => left.key.localeCompare(right.key))
                    .map((row) => `${row.key}=${row.value}`)
                    .join("&");
        }
    });

    const compute = async () => {
        signature.value = null;
        error.value = null;
        try {
            const key = decodeKey(secret.value, encoding.value);
            const keyBuffer = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
            const cryptoKey = await crypto.subtle.importKey("raw", keyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
            const digest = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(canonical.value));
            signature.value = toHexUpper(digest);
        } catch (exception) {
            error.value = exception instanceof Error ? exception.message : String(exception);
        }
    };

    return () => (
        <VCard variant="outlined">
            <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <VSelect
                    modelValue={mode.value}
                    onUpdate:modelValue={(value: string | null) => (mode.value = value ?? "SORTED_KEY_VALUE_AMP")}
                    items={MODES}
                    label="Canonicalization mode"
                />
                <ThemedView style={{ gap: "8px" }}>
                    {rows.value.map((row) => (
                        <ThemedView key={row.id} style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            <VTextField
                                modelValue={row.key}
                                onUpdate:modelValue={(value: string) => update(row.id, "key", value ?? "")}
                                label="Key"
                                style={{ flex: "1 1 160px" }}
                            />
                            <VTextField
                                modelValue={row.value}
                                onUpdate:modelValue={(value: string) => update(row.id, "value", value ?? "")}
                                label="Value"
                                style={{ flex: "2 1 220px" }}
                            />
                            <VBtn icon="mdi-delete-outline" variant="text" color="error" onClick={() => remove(row.id)} />
                        </ThemedView>
                    ))}
                    <VBtn size="small" variant="tonal" prependIcon="mdi-plus" onClick={add} style={{ alignSelf: "flex-start" }}>
                        Add row
                    </VBtn>
                </ThemedView>
                <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                    <VTextField
                        modelValue={timestamp.value}
                        onUpdate:modelValue={(value: string) => (timestamp.value = value ?? "")}
                        label="Timestamp"
                        style={{ flex: "1 1 160px" }}
                    />
                    <VTextField
                        modelValue={secret.value}
                        onUpdate:modelValue={(value: string) => (secret.value = value ?? "")}
                        label="Secret (demo only)"
                        type="password"
                        style={{ flex: "1 1 220px" }}
                    />
                    <VSelect
                        modelValue={encoding.value}
                        onUpdate:modelValue={(value: string | null) => (encoding.value = value ?? "UTF8")}
                        items={ENCODINGS}
                        label="secret_key_encoding"
                        style={{ flex: "1 1 160px" }}
                    />
                </ThemedView>
                {mode.value === "TEMPLATE_STRING" ? (
                    <VTextField
                        modelValue={template.value}
                        onUpdate:modelValue={(value: string) => (template.value = value ?? "")}
                        label="Template pattern"
                    />
                ) : null}
                <ThemedView style={{ gap: "4px" }}>
                    <ThemedText type="defaultSemiBold">Exact canonical string</ThemedText>
                    <pre style={{ ...MONO, padding: "10px", borderRadius: "8px", background: "rgba(100,116,139,0.10)" }}>
                        {canonical.value}
                    </pre>
                </ThemedView>
                <ThemedView style={{ flexDirection: "row", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                    <VBtn prependIcon="mdi-fingerprint" onClick={() => void compute()}>
                        Compute HMAC-SHA256
                    </VBtn>
                    <StatusChip label={encoding.value === "HEX" ? "Moamalat-safe HEX key" : "UTF-8 key"} tone={encoding.value === "HEX" ? "success" : "warning"} size="x-small" />
                </ThemedView>
                {error.value ? (
                    <VAlert type="error" variant="tonal" density="compact">
                        {error.value}
                    </VAlert>
                ) : null}
                {signature.value ? (
                    <VAlert type="success" variant="tonal" density="compact">
                        <ThemedText style={{ fontSize: "12px", marginBottom: "4px" }}>HEX_UPPER HMAC-SHA256</ThemedText>
                        <pre style={MONO}>{signature.value}</pre>
                    </VAlert>
                ) : null}
            </VCardText>
        </VCard>
    );
});

export default CryptoSignatureLab;
