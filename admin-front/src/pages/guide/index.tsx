import { dc } from "kt-dc";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import {
    VAlert,
    VBtn,
    VCard,
    VCardText,
    VChip,
    VExpansionPanel,
    VExpansionPanelText,
    VExpansionPanelTitle,
    VExpansionPanels,
    VIcon,
    VNavigationDrawer,
    VSelect,
    VTextField,
    VTextarea,
} from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import {
    ATTEMPT_STATUS_GLOSSARY,
    ERROR_CODE_GLOSSARY,
    GL_ACCOUNT_TYPES,
    GUIDE_CHAPTERS,
    type GuideChapter,
} from "@/components/guide/content";
import {
    buildLedgerRows,
    computeJournal,
    formatLedgerAmount,
    LEDGER_EVENTS,
} from "@/components/guide/ledger";
import { runTransform, TRANSFORM_OPS, type TransformResult } from "@/components/guide/transform";

const MONO_STYLE = {
    margin: 0,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "12px",
    lineHeight: 1.55,
};

const CANONICAL_MODES = [
    { title: "SORTED_KEY_VALUE_AMP", value: "SORTED_KEY_VALUE_AMP" },
    { title: "SORTED_VALUES_HASH", value: "SORTED_VALUES_HASH" },
    { title: "TIMESTAMP_DOT_RAW_BODY", value: "TIMESTAMP_DOT_RAW_BODY" },
    { title: "JSON_CANONICAL", value: "JSON_CANONICAL" },
];

const KEY_ENCODINGS = [
    { title: "UTF-8", value: "UTF-8" },
    { title: "HEX", value: "HEX" },
    { title: "BASE64", value: "BASE64" },
];

type KvRow = {
    id: number;
    key: string;
    value: string;
};

const scoreChapter = (chapter: GuideChapter, terms: string[]): number => {
    const title = `${chapter.titleEn} ${chapter.titleAr}`.toLowerCase();
    const tags = chapter.tags.join(" ").toLowerCase();
    const body = `${chapter.bodyEn} ${chapter.bodyAr}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
        const inTitle = title.includes(term);
        const inTags = tags.includes(term);
        const inBody = body.includes(term);
        if (!inTitle && !inTags && !inBody) {
            return 0;
        }
        if (inTitle) {
            score += 120;
        }
        if (inTags) {
            score += 50;
        }
        if (inBody) {
            score += 10;
        }
    }
    return score;
};

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

const GuidePage = dc(() => {
    const { t, current } = useLocale();
    const isArabic = computed(() => current.value === "ar");

    const query = ref("");
    const searchRef = ref<any>(null);
    const drawerOpen = ref(false);
    const selectedChapter = ref<GuideChapter | null>(null);

    const tokens = computed(() =>
        query.value
            .trim()
            .toLowerCase()
            .split(/\s+/)
            .filter((entry) => entry.length > 0),
    );

    const firstTerm = computed(() => tokens.value[0] ?? "");

    const filteredChapters = computed(() => {
        const terms = tokens.value;
        if (terms.length === 0) {
            return GUIDE_CHAPTERS;
        }
        return GUIDE_CHAPTERS.map((chapter) => ({ chapter, score: scoreChapter(chapter, terms) }))
            .filter((entry) => entry.score > 0)
            .sort((left, right) => right.score - left.score || left.chapter.book - right.chapter.book)
            .map((entry) => entry.chapter);
    });

    const chapterTitle = (chapter: GuideChapter): string => (isArabic.value ? chapter.titleAr : chapter.titleEn);
    const chapterBody = (chapter: GuideChapter): string => (isArabic.value ? chapter.bodyAr : chapter.bodyEn);

    const openChapter = (chapter: GuideChapter) => {
        selectedChapter.value = chapter;
        drawerOpen.value = true;
    };

    const highlight = (text: string, term: string): (string | JSX.Element)[] => {
        const needle = term.trim().toLowerCase();
        if (!needle) {
            return [text];
        }
        const parts: (string | JSX.Element)[] = [];
        const lower = text.toLowerCase();
        let cursor = 0;
        let index = lower.indexOf(needle);
        let key = 0;
        while (index >= 0) {
            if (index > cursor) {
                parts.push(text.slice(cursor, index));
            }
            parts.push(
                <mark
                    key={`mark-${key}`}
                    style={{ background: "rgba(250, 204, 21, 0.45)", color: "inherit", borderRadius: "3px", padding: "0 1px" }}
                >
                    {text.slice(index, index + needle.length)}
                </mark>,
            );
            key += 1;
            cursor = index + needle.length;
            index = lower.indexOf(needle, cursor);
        }
        if (cursor < text.length) {
            parts.push(text.slice(cursor));
        }
        return parts;
    };

    const previewBody = (chapter: GuideChapter): string => {
        const body = chapterBody(chapter);
        const term = firstTerm.value;
        if (!term) {
            return body.length > 260 ? `${body.slice(0, 260)}…` : body;
        }
        const index = body.toLowerCase().indexOf(term);
        if (index < 0) {
            return body.length > 260 ? `${body.slice(0, 260)}…` : body;
        }
        const start = Math.max(0, index - 70);
        const end = Math.min(body.length, start + 280);
        return `${start > 0 ? "…" : ""}${body.slice(start, end)}${end < body.length ? "…" : ""}`;
    };

    const focusSearch = () => {
        searchRef.value?.focus?.();
    };

    const onKeydown = (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            focusSearch();
            return;
        }
        if (event.key === "Escape") {
            query.value = "";
            drawerOpen.value = false;
        }
    };

    onMounted(() => {
        window.addEventListener("keydown", onKeydown);
    });

    onBeforeUnmount(() => {
        window.removeEventListener("keydown", onKeydown);
    });

    const transformInput = ref("12500.555");
    const transformOps = ref<string[]>(["scale", "round"]);
    const transformArgs = ref("3,3");
    const transformResult = ref<TransformResult | null>(null);

    const transformItems = TRANSFORM_OPS.map((op) => ({
        title: `${op.value} — ${op.description}`,
        value: op.value,
    }));

    const runTransformSandbox = () => {
        transformResult.value = runTransform(transformInput.value, transformOps.value, transformArgs.value);
    };

    let kvSequence = 4;
    const kvRows = ref<KvRow[]>([
        { id: 1, key: "amount", value: "1250.500" },
        { id: 2, key: "currency", value: "LYD" },
        { id: 3, key: "merchantId", value: "MRC-1042" },
    ]);
    const canonicalMode = ref("SORTED_KEY_VALUE_AMP");
    const timestamp = ref(String(Math.floor(Date.now() / 1000)));
    const secret = ref("demo-secret");
    const keyEncoding = ref("UTF-8");

    const updateKv = (id: number, field: "key" | "value", value: string) => {
        kvRows.value = kvRows.value.map((row) => (row.id === id ? { ...row, [field]: value } : row));
    };

    const addKvRow = () => {
        kvRows.value = [...kvRows.value, { id: kvSequence, key: "", value: "" }];
        kvSequence += 1;
    };

    const removeKvRow = (id: number) => {
        kvRows.value = kvRows.value.filter((row) => row.id !== id);
    };

    const canonicalString = computed(() => {
        const rows = kvRows.value.filter((row) => row.key.trim().length > 0);
        const record = rows.reduce<Record<string, string>>((accumulator, row) => {
            accumulator[row.key] = row.value;
            return accumulator;
        }, {});

        switch (canonicalMode.value) {
            case "SORTED_VALUES_HASH":
                return rows
                    .map((row) => row.value)
                    .sort()
                    .join("&");
            case "TIMESTAMP_DOT_RAW_BODY":
                return `${timestamp.value}.${JSON.stringify(record)}`;
            case "JSON_CANONICAL":
                return JSON.stringify(sortKeysDeep(record));
            case "SORTED_KEY_VALUE_AMP":
            default:
                return rows
                    .slice()
                    .sort((left, right) => left.key.localeCompare(right.key))
                    .map((row) => `${row.key}=${row.value}`)
                    .join("&");
        }
    });

    const ledgerEventId = ref("1");
    const ledgerAmount = ref("1250.500");
    const ledgerCommission = ref("2.5");

    const ledgerEventItems = computed(() =>
        LEDGER_EVENTS.map((event) => ({
            title: isArabic.value ? event.labelAr : event.labelEn,
            value: event.id,
        })),
    );

    const journal = computed(() => computeJournal(ledgerEventId.value, ledgerAmount.value, ledgerCommission.value));
    const ledgerRows = computed(() => buildLedgerRows(journal.value.lines));
    const ledgerEvent = computed(() => LEDGER_EVENTS.find((event) => event.id === ledgerEventId.value) ?? LEDGER_EVENTS[0]!);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Interactive Guide")}
                    end={() => (
                        <VChip color="primary" variant="tonal" size="small">
                            {t("Knowledge Base")}
                        </VChip>
                    )}
                />

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <VTextField
                            ref={searchRef}
                            modelValue={query.value}
                            onUpdate:modelValue={(value: string) => (query.value = value ?? "")}
                            label={t("Search the guide by title, tag, or body")}
                            prependInnerIcon="mdi-magnify"
                            clearable
                            autofocus
                            onKeydown={(event: KeyboardEvent) => {
                                if (event.key === "Escape") {
                                    query.value = "";
                                }
                            }}
                        />
                        <ThemedView
                            style={{
                                flexDirection: "row",
                                flexWrap: "wrap",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: "10px",
                            }}
                        >
                            <ThemedText style={{ fontSize: "13px", opacity: 0.75 }}>
                                {`${filteredChapters.value.length} / ${GUIDE_CHAPTERS.length} ${t("chapters")}`}
                            </ThemedText>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                                <StatusChip label="Ctrl / Cmd + K" tone="neutral" size="x-small" />
                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{t("focuses search")}</ThemedText>
                                <StatusChip label="Esc" tone="neutral" size="x-small" />
                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{t("clears search")}</ThemedText>
                            </ThemedView>
                        </ThemedView>
                    </VCardText>
                </VCard>

                {filteredChapters.value.length === 0 ? (
                    <StateView
                        empty
                        emptyTitle={t("No chapters match your search")}
                        emptyDescription={t("Try a tag such as ledger, UNKNOWN, mTLS, or chargeback.")}
                    />
                ) : (
                    <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "14px" }}>
                        {filteredChapters.value.map((chapter) => (
                            <VCard key={chapter.id} style={{ flex: "1 1 320px", maxWidth: "100%" }}>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px", height: "100%" }}>
                                    <ThemedView style={{ flexDirection: "row", alignItems: "flex-start", gap: "10px" }}>
                                        <StatusChip label={`B${chapter.book}`} tone="info" size="x-small" />
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "15px", flex: 1 }}>
                                            {highlight(chapterTitle(chapter), firstTerm.value)}
                                        </ThemedText>
                                    </ThemedView>
                                    <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "6px" }}>
                                        {chapter.tags.slice(0, 6).map((tag) => (
                                            <VChip key={`${chapter.id}-${tag}`} size="x-small" variant="tonal">
                                                {tag}
                                            </VChip>
                                        ))}
                                    </ThemedView>
                                    <ThemedText style={{ fontSize: "13px", opacity: 0.8, whiteSpace: "pre-line" }}>
                                        {highlight(previewBody(chapter), firstTerm.value)}
                                    </ThemedText>
                                    <ThemedView style={{ flex: 1 }} />
                                    <VBtn size="small" variant="text" appendIcon="mdi-arrow-right" onClick={() => openChapter(chapter)}>
                                        {t("Read chapter")}
                                    </VBtn>
                                </VCardText>
                            </VCard>
                        ))}
                    </ThemedView>
                )}

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                            {t("Glossary")}
                        </ThemedText>
                        <VExpansionPanels multiple>
                            <VExpansionPanel value="errors">
                                <VExpansionPanelTitle>{t("Canonical error codes")}</VExpansionPanelTitle>
                                <VExpansionPanelText>
                                    <ThemedView style={{ gap: "12px", paddingTop: "4px" }}>
                                        {ERROR_CODE_GLOSSARY.map((entry) => (
                                            <ThemedView key={entry.code} style={{ gap: "4px" }}>
                                                <StatusChip label={entry.code} tone="error" size="x-small" />
                                                <ThemedText style={{ fontSize: "13px", opacity: 0.85 }}>
                                                    {isArabic.value ? entry.meaningAr : entry.meaningEn}
                                                </ThemedText>
                                            </ThemedView>
                                        ))}
                                    </ThemedView>
                                </VExpansionPanelText>
                            </VExpansionPanel>
                            <VExpansionPanel value="gl-accounts">
                                <VExpansionPanelTitle>{t("GL account types")}</VExpansionPanelTitle>
                                <VExpansionPanelText>
                                    <ThemedView style={{ gap: "12px", paddingTop: "4px" }}>
                                        {GL_ACCOUNT_TYPES.map((entry) => (
                                            <ThemedView key={entry.code} style={{ gap: "4px" }}>
                                                <StatusChip label={entry.code} tone="primary" size="x-small" />
                                                <ThemedText style={{ fontSize: "13px", opacity: 0.85 }}>
                                                    {isArabic.value ? entry.meaningAr : entry.meaningEn}
                                                </ThemedText>
                                            </ThemedView>
                                        ))}
                                    </ThemedView>
                                </VExpansionPanelText>
                            </VExpansionPanel>
                            <VExpansionPanel value="statuses">
                                <VExpansionPanelTitle>{t("The 13 attempt statuses")}</VExpansionPanelTitle>
                                <VExpansionPanelText>
                                    <ThemedView style={{ gap: "12px", paddingTop: "4px" }}>
                                        {ATTEMPT_STATUS_GLOSSARY.map((entry) => (
                                            <ThemedView key={entry.code} style={{ gap: "4px" }}>
                                                <StatusChip label={entry.code} tone="info" size="x-small" />
                                                <ThemedText style={{ fontSize: "13px", opacity: 0.85 }}>
                                                    {isArabic.value ? entry.meaningAr : entry.meaningEn}
                                                </ThemedText>
                                            </ThemedView>
                                        ))}
                                    </ThemedView>
                                </VExpansionPanelText>
                            </VExpansionPanel>
                        </VExpansionPanels>
                    </VCardText>
                </VCard>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                            {t("Embedded simulators")}
                        </ThemedText>
                        <VExpansionPanels multiple>
                            <VExpansionPanel value="transform">
                                <VExpansionPanelTitle>{t("Transform Sandbox")}</VExpansionPanelTitle>
                                <VExpansionPanelText>
                                    <ThemedView style={{ gap: "12px", paddingTop: "6px" }}>
                                        <VTextarea
                                            modelValue={transformInput.value}
                                            onUpdate:modelValue={(value: string) => (transformInput.value = value ?? "")}
                                            label={t("Input (JSON, number, or text)")}
                                            rows={3}
                                        />
                                        <VSelect
                                            multiple
                                            chips
                                            closableChips
                                            modelValue={transformOps.value}
                                            onUpdate:modelValue={(value: string[] | null) => (transformOps.value = value ?? [])}
                                            items={transformItems}
                                            label={t("Operations (applied in order)")}
                                        />
                                        <VTextField
                                            modelValue={transformArgs.value}
                                            onUpdate:modelValue={(value: string) => (transformArgs.value = value ?? "")}
                                            label={t("Arguments (comma separated)")}
                                            hint={t("Example: 3,3 for scale exponent 3 and round 3 places")}
                                            persistentHint
                                        />
                                        <ThemedView style={{ flexDirection: "row", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                                            <VBtn prependIcon="mdi-play" onClick={runTransformSandbox}>
                                                {t("Run")}
                                            </VBtn>
                                            <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                                {t("No eval: each operation is a typed local function.")}
                                            </ThemedText>
                                        </ThemedView>
                                        {transformResult.value ? (
                                            <ThemedView style={{ gap: "10px" }}>
                                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                                    <StatusChip
                                                        label={transformResult.value.failed ? t("Stopped on error") : t("Completed")}
                                                        tone={transformResult.value.failed ? "error" : "success"}
                                                    />
                                                    <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>
                                                        {`${transformResult.value.steps.length} ${t("steps")}`}
                                                    </ThemedText>
                                                </ThemedView>
                                                <ThemedView style={{ gap: "8px" }}>
                                                    {transformResult.value.steps.map((step, index) => (
                                                        <VCard key={`${step.op}-${index}`} variant="outlined">
                                                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                                                    <StatusChip label={`${index + 1}. ${step.op}`} tone={step.ok ? "primary" : "error"} size="x-small" />
                                                                    {step.args.length > 0 && (
                                                                        <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>
                                                                            {`args: ${step.args.join(", ")}`}
                                                                        </ThemedText>
                                                                    )}
                                                                </ThemedView>
                                                                <pre style={{ ...MONO_STYLE, padding: "8px", borderRadius: "8px", background: "rgba(100,116,139,0.10)" }}>
                                                                    {step.output}
                                                                </pre>
                                                                {step.note && (
                                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>{step.note}</ThemedText>
                                                                )}
                                                            </VCardText>
                                                        </VCard>
                                                    ))}
                                                </ThemedView>
                                                <ThemedView style={{ gap: "4px" }}>
                                                    <ThemedText type="defaultSemiBold">{t("Final value")}</ThemedText>
                                                    <pre style={{ ...MONO_STYLE, padding: "10px", borderRadius: "8px", background: "rgba(15,107,255,0.08)" }}>
                                                        {transformResult.value.final}
                                                    </pre>
                                                </ThemedView>
                                            </ThemedView>
                                        ) : (
                                            <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                                                {t("Choose operations and run to see every intermediate value.")}
                                            </ThemedText>
                                        )}
                                    </ThemedView>
                                </VExpansionPanelText>
                            </VExpansionPanel>

                            <VExpansionPanel value="crypto">
                                <VExpansionPanelTitle>{t("Crypto Signature Lab")}</VExpansionPanelTitle>
                                <VExpansionPanelText>
                                    <ThemedView style={{ gap: "12px", paddingTop: "6px" }}>
                                        <VSelect
                                            modelValue={canonicalMode.value}
                                            onUpdate:modelValue={(value: string | null) => (canonicalMode.value = value ?? "SORTED_KEY_VALUE_AMP")}
                                            items={CANONICAL_MODES}
                                            label={t("Canonicalization mode")}
                                        />
                                        <ThemedView style={{ gap: "8px" }}>
                                            {kvRows.value.map((row) => (
                                                <ThemedView key={row.id} style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                                    <VTextField
                                                        modelValue={row.key}
                                                        onUpdate:modelValue={(value: string) => updateKv(row.id, "key", value ?? "")}
                                                        label={t("Key")}
                                                        style={{ flex: "1 1 160px" }}
                                                    />
                                                    <VTextField
                                                        modelValue={row.value}
                                                        onUpdate:modelValue={(value: string) => updateKv(row.id, "value", value ?? "")}
                                                        label={t("Value")}
                                                        style={{ flex: "2 1 220px" }}
                                                    />
                                                    <VBtn icon="mdi-delete-outline" variant="text" color="error" onClick={() => removeKvRow(row.id)} />
                                                </ThemedView>
                                            ))}
                                            <VBtn size="small" variant="tonal" prependIcon="mdi-plus" onClick={addKvRow} style={{ alignSelf: "flex-start" }}>
                                                {t("Add row")}
                                            </VBtn>
                                        </ThemedView>
                                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                                            <VTextField
                                                modelValue={timestamp.value}
                                                onUpdate:modelValue={(value: string) => (timestamp.value = value ?? "")}
                                                label={t("Timestamp")}
                                                style={{ flex: "1 1 180px" }}
                                            />
                                            <VTextField
                                                modelValue={secret.value}
                                                onUpdate:modelValue={(value: string) => (secret.value = value ?? "")}
                                                label={t("Secret (demo only)")}
                                                type="password"
                                                style={{ flex: "1 1 220px" }}
                                            />
                                            <VSelect
                                                modelValue={keyEncoding.value}
                                                onUpdate:modelValue={(value: string | null) => (keyEncoding.value = value ?? "UTF-8")}
                                                items={KEY_ENCODINGS}
                                                label={t("Key encoding")}
                                                style={{ flex: "1 1 160px" }}
                                            />
                                        </ThemedView>
                                        <ThemedView style={{ gap: "4px" }}>
                                            <ThemedText type="defaultSemiBold">{t("Exact canonical string")}</ThemedText>
                                            <pre style={{ ...MONO_STYLE, padding: "10px", borderRadius: "8px", background: "rgba(100,116,139,0.10)" }}>
                                                {canonicalString.value || t("No key/value rows yet")}
                                            </pre>
                                        </ThemedView>
                                        <VAlert type="info" variant="tonal" density="compact">
                                            <ThemedText style={{ fontSize: "12px" }}>
                                                {`${t("Hash placeholder")}: ${keyEncoding.value} · ${t("computed by the server during a real request")}`}
                                            </ThemedText>
                                            <pre style={{ ...MONO_STYLE, marginTop: "6px", opacity: 0.7 }}>
                                                {"<hash computed by the server during a real request>"}
                                            </pre>
                                        </VAlert>
                                    </ThemedView>
                                </VExpansionPanelText>
                            </VExpansionPanel>

                            <VExpansionPanel value="ledger">
                                <VExpansionPanelTitle>{t("Ledger T-Account Explorer")}</VExpansionPanelTitle>
                                <VExpansionPanelText>
                                    <ThemedView style={{ gap: "12px", paddingTop: "6px" }}>
                                        <VSelect
                                            modelValue={ledgerEventId.value}
                                            onUpdate:modelValue={(value: string | null) => (ledgerEventId.value = value ?? "1")}
                                            items={ledgerEventItems.value}
                                            label={t("Business event")}
                                        />
                                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                                            <VTextField
                                                modelValue={ledgerAmount.value}
                                                onUpdate:modelValue={(value: string) => (ledgerAmount.value = value ?? "")}
                                                label={t("Amount (LYD)")}
                                                type="number"
                                                style={{ flex: "1 1 180px" }}
                                            />
                                            <VTextField
                                                modelValue={ledgerCommission.value}
                                                onUpdate:modelValue={(value: string) => (ledgerCommission.value = value ?? "")}
                                                label={t("Commission %")}
                                                type="number"
                                                style={{ flex: "1 1 160px" }}
                                            />
                                        </ThemedView>
                                        <ThemedText style={{ fontSize: "13px", opacity: 0.75 }}>
                                            {isArabic.value ? ledgerEvent.value.noteAr : ledgerEvent.value.noteEn}
                                        </ThemedText>
                                        <ThemedView style={{ flexDirection: "row", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                                            <StatusChip
                                                label={journal.value.balanced ? "balanced ✓" : "DR ≠ CR ✗"}
                                                tone={journal.value.balanced ? "success" : "error"}
                                            />
                                            <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>
                                                {`DR ${formatLedgerAmount(journal.value.debitTotal)} · CR ${formatLedgerAmount(journal.value.creditTotal)}`}
                                            </ThemedText>
                                        </ThemedView>
                                        <div style={{ overflowX: "auto" }}>
                                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                                                <thead>
                                                    <tr style={{ textAlign: "start", opacity: 0.7 }}>
                                                        <th style={{ textAlign: "start", padding: "8px 6px" }}>{t("Account")}</th>
                                                        <th style={{ textAlign: "start", padding: "8px 6px" }}>{t("Type")}</th>
                                                        <th style={{ textAlign: "start", padding: "8px 6px" }}>{t("Side")}</th>
                                                        <th style={{ textAlign: "end", padding: "8px 6px" }}>{t("Debit")}</th>
                                                        <th style={{ textAlign: "end", padding: "8px 6px" }}>{t("Credit")}</th>
                                                        <th style={{ textAlign: "end", padding: "8px 6px" }}>{t("Running balance")}</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {ledgerRows.value.map((row, index) => (
                                                        <tr key={`${row.account}-${index}`} style={{ borderTop: "1px solid rgba(100,116,139,0.18)" }}>
                                                            <td style={{ padding: "8px 6px", fontWeight: 600 }}>{row.account}</td>
                                                            <td style={{ padding: "8px 6px" }}>{row.accountType}</td>
                                                            <td style={{ padding: "8px 6px" }}>
                                                                <StatusChip
                                                                    label={row.side}
                                                                    tone={row.side === "DEBIT" ? "primary" : "warning"}
                                                                    size="x-small"
                                                                />
                                                            </td>
                                                            <td style={{ padding: "8px 6px", textAlign: "end" }}>
                                                                {row.side === "DEBIT" ? formatLedgerAmount(row.amount) : "-"}
                                                            </td>
                                                            <td style={{ padding: "8px 6px", textAlign: "end" }}>
                                                                {row.side === "CREDIT" ? formatLedgerAmount(row.amount) : "-"}
                                                            </td>
                                                            <td style={{ padding: "8px 6px", textAlign: "end", fontWeight: 600 }}>
                                                                {formatLedgerAmount(row.runningBalance)}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>
                                            {t("Running balance uses the normal side of each account type; a partial journal can end non-zero.")}
                                        </ThemedText>
                                    </ThemedView>
                                </VExpansionPanelText>
                            </VExpansionPanel>
                        </VExpansionPanels>
                    </VCardText>
                </VCard>
            </ThemedView>

            <VNavigationDrawer
                modelValue={drawerOpen.value}
                onUpdate:modelValue={(value: boolean) => (drawerOpen.value = value)}
                location="end"
                temporary
                width={560}
            >
                <ThemedView style={{ padding: "20px", gap: "14px", height: "100%", overflowY: "auto" }}>
                    {selectedChapter.value ? (
                        <>
                            <ThemedView style={{ flexDirection: "row", alignItems: "start", gap: "10px" }}>
                                <VBtn icon="mdi-close" variant="text" onClick={() => (drawerOpen.value = false)} />
                                <ThemedView style={{ flex: 1, gap: "6px" }}>
                                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                        <StatusChip label={`Book ${selectedChapter.value.book}`} tone="info" size="x-small" />
                                        <StatusChip label={selectedChapter.value.id} tone="neutral" size="x-small" />
                                    </ThemedView>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "19px", lineHeight: 1.25 }}>
                                        {chapterTitle(selectedChapter.value)}
                                    </ThemedText>
                                </ThemedView>
                            </ThemedView>
                            <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "6px" }}>
                                {selectedChapter.value.tags.map((tag) => (
                                    <VChip key={`drawer-${tag}`} size="x-small" variant="tonal">
                                        {tag}
                                    </VChip>
                                ))}
                            </ThemedView>
                            <ThemedText style={{ fontSize: "14px", lineHeight: 1.75, whiteSpace: "pre-line" }}>
                                {chapterBody(selectedChapter.value)}
                            </ThemedText>
                            <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center" }}>
                                <VIcon icon="mdi-lightbulb-on-outline" size="18" color="warning" />
                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                    {t("Search state is preserved while this drawer is open.")}
                                </ThemedText>
                            </ThemedView>
                        </>
                    ) : (
                        <ThemedText style={{ opacity: 0.7 }}>{t("Select a chapter to read it here.")}</ThemedText>
                    )}
                </ThemedView>
            </VNavigationDrawer>
        </ScreenContainer>
    );
});

export default GuidePage;
