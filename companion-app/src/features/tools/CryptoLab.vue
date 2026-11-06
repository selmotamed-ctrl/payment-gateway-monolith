<script setup lang="ts">
import { computed, ref } from "vue";
import {
    COMMON_SIGNATURE_FAILURES,
    hmacSha256,
    type CryptoInput,
    type CryptoMode,
    type CryptoResult,
    type KeyEncoding,
    type OutputEncoding,
} from "./engine/crypto";
import { useI18n } from "@/lib/i18n";

const { L } = useI18n();
const mode = ref<CryptoMode>("SORTED_KEY_VALUE_AMP");
const key = ref("local-demo-key");
const keyEncoding = ref<KeyEncoding>("UTF8");
const outputEncoding = ref<OutputEncoding>("HEX_LOWER");
const timestamp = ref("1700000000");
const body = ref('{"amount":"100.000","currency":"LYD"}');
const fieldsText = ref("amount=100.000\ncurrency=LYD\nreference=PL-48213");
const output = ref<CryptoResult | null>(null);
const expected = ref("");
const match = ref<boolean | null>(null);

const modes = computed<{ value: CryptoMode; label: string }[]>(() => [
    { value: "SORTED_KEY_VALUE_AMP", label: "Sorted key=value with &" },
    { value: "SORTED_VALUES_HASH", label: "Sorted values concatenated" },
    { value: "TIMESTAMP_DOT_RAW_BODY", label: "timestamp.raw-body" },
    { value: "RAW_BODY", label: "Raw body" },
]);

const parseFields = (): Record<string, string> => {
    const fields: Record<string, string> = {};
    for (const line of fieldsText.value.split("\n")) {
        const separator = line.indexOf("=");
        if (separator <= 0) continue;
        fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    return fields;
};

const run = async (): Promise<void> => {
    const input: CryptoInput = {
        mode: mode.value,
        key: key.value,
        keyEncoding: keyEncoding.value,
        outputEncoding: outputEncoding.value,
        fields: parseFields(),
        timestamp: timestamp.value,
        body: body.value,
    };
    output.value = await hmacSha256(input);
    match.value = expected.value.trim()
        ? output.value.output.toLowerCase() === expected.value.trim().toLowerCase()
        : null;
};

const reset = (): void => {
    mode.value = "SORTED_KEY_VALUE_AMP";
    key.value = "local-demo-key";
    keyEncoding.value = "UTF8";
    outputEncoding.value = "HEX_LOWER";
    timestamp.value = "1700000000";
    body.value = '{"amount":"100.000","currency":"LYD"}';
    fieldsText.value = "amount=100.000\ncurrency=LYD\nreference=PL-48213";
    output.value = null;
    expected.value = "";
    match.value = null;
};
</script>

<template>
    <section class="tool-card">
        <header class="tool-card__head">
            <div>
                <p class="eyebrow">{{ L("tool.title") }}</p>
                <h3>{{ L("tool.crypto") }}</h3>
            </div>
            <button type="button" class="btn btn--small btn--ghost" @click="reset">{{ L("tool.reset") }}</button>
        </header>
        <p class="tool-note">{{ L("tool.teaching") }}</p>
        <div class="field-row">
            <label class="field">
                <span>Canonical mode</span>
                <select v-model="mode" class="select">
                    <option v-for="entry in modes" :key="entry.value" :value="entry.value">{{ entry.label }}</option>
                </select>
            </label>
            <label class="field">
                <span>Key encoding</span>
                <select v-model="keyEncoding" class="select">
                    <option value="UTF8">UTF-8</option>
                    <option value="HEX">HEX</option>
                    <option value="BASE64">BASE64</option>
                </select>
            </label>
            <label class="field">
                <span>Output</span>
                <select v-model="outputEncoding" class="select">
                    <option value="HEX_LOWER">hex lower</option>
                    <option value="HEX_UPPER">hex upper</option>
                    <option value="BASE64">base64</option>
                </select>
            </label>
        </div>
        <label class="field"><span>Key</span><input v-model="key" class="input" dir="ltr" /></label>
        <label class="field"><span>Fields (key=value per line)</span><textarea v-model="fieldsText" class="input textarea" rows="4" dir="ltr" /></label>
        <div class="field-row">
            <label class="field"><span>Timestamp</span><input v-model="timestamp" class="input" dir="ltr" /></label>
            <label class="field"><span>Body</span><input v-model="body" class="input" dir="ltr" /></label>
        </div>
        <div class="field-row field-row--end">
            <label class="field"><span>Expected signature (optional)</span><input v-model="expected" class="input" dir="ltr" /></label>
            <button type="button" class="btn btn--primary" @click="run">Sign</button>
        </div>
        <div v-if="output" class="tool-output" aria-live="polite">
            <p class="eyebrow">Canonical string</p>
            <pre class="mono break" dir="ltr">{{ output.canonicalVisible || "—" }}</pre>
            <p class="eyebrow">HMAC-SHA256 · {{ output.keyBytes }} key bytes</p>
            <pre class="mono break" dir="ltr">{{ output.output || "—" }}</pre>
            <p v-if="output.error" class="error-text">{{ output.error }}</p>
            <p v-if="match !== null" class="chip" :class="match ? 'chip--success' : 'chip--danger'">
                {{ match ? "Signatures match" : "Signatures differ" }}
            </p>
            <details v-if="!match" class="helper-details">
                <summary>Common reasons a signature fails</summary>
                <ul>
                    <li v-for="entry in COMMON_SIGNATURE_FAILURES" :key="entry">{{ entry }}</li>
                </ul>
            </details>
        </div>
    </section>
</template>
