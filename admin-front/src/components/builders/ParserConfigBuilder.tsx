import { defineComponent, type PropType, type VNodeChild } from "vue";
import { VAlert, VSelect, VSwitch, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PARSER_ERROR_MESSAGES } from "./messages";
import {
    COLUMN_LOGICAL_KEYS,
    REQUIRED_COLUMNS,
    STATEMENT_ENCODINGS,
    STATEMENT_FORMATS,
    positionalColumnOrder,
    summarizeColumnMapping,
    validateParserConfig,
    type ColumnLogicalKey,
    type ParserConfigForm,
    type ParserConfigState,
} from "./model/parserConfig";

export const COLUMN_LABELS: Record<ColumnLogicalKey, string> = {
    ourReference: "Our reference",
    providerReference: "Provider reference",
    batchReference: "Batch reference",
    amount: "Amount",
    fee: "Fee",
    currency: "Currency",
    occurredAt: "Transaction date",
    type: "Transaction type",
};

const COLUMN_HINTS: Partial<Record<ColumnLogicalKey, string>> = {
    ourReference: "The statement column that holds the platform payment reference.",
    providerReference: "The statement column that holds the provider's own reference.",
    batchReference: "The statement column that groups rows into a settlement batch.",
    fee: "Needed to reconcile net settlements.",
};

const GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "10px 12px" } as const;

/**
 * Structured form of a statement-source parser configuration (CSV / XLSX / JSON statements).
 * Edits a `ParserConfigState` (see `model/parserConfig.ts`); unknown keys and stored spellings survive.
 */
export const ParserConfigBuilder = defineComponent({
    name: "ParserConfigBuilder",
    props: {
        modelValue: { type: Object as PropType<ParserConfigState>, required: true },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const patch = (change: Partial<ParserConfigForm>) =>
            emit("update:modelValue", { ...props.modelValue, form: { ...props.modelValue.form, ...change } });
        const patchColumn = (key: ColumnLogicalKey, value: string) =>
            patch({ columns: { ...props.modelValue.form.columns, [key]: value } });

        return (): VNodeChild => {
            const form = props.modelValue.form;
            const issues = validateParserConfig(form);
            const errorFor = (field: string): string => {
                const found = issues.find((entry) => entry.field === field && entry.severity === "error");
                return found ? t(PARSER_ERROR_MESSAGES[found.code]) : "";
            };
            const warnings = issues.filter((entry) => entry.severity === "warning");
            const encodingItems: string[] = [...STATEMENT_ENCODINGS];
            if (!encodingItems.includes(form.encoding)) encodingItems.push(form.encoding);
            const formatItems: string[] = [...STATEMENT_FORMATS];
            if (!formatItems.includes(form.format)) formatItems.push(form.format);
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "14px", minInlineSize: 0 }}>
                    <div style={GRID}>
                        <FormField label={t("Statement format")} error={errorFor("format")}>
                            <VSelect modelValue={form.format} onUpdate:modelValue={(value: string) => patch({ format: value })} items={formatItems} density="compact" hideDetails />
                        </FormField>
                        <FormField label={t("Text encoding")} error={errorFor("encoding")}>
                            <VSelect modelValue={form.encoding} onUpdate:modelValue={(value: string) => patch({ encoding: value })} items={encodingItems} density="compact" hideDetails />
                        </FormField>
                        {form.format === "CSV" && (
                            <FormField label={t("Delimiter")} error={errorFor("delimiter")} hint={t("One character, for example a comma or a semicolon.")}>
                                <VTextField modelValue={form.delimiter} onUpdate:modelValue={(value: string) => patch({ delimiter: value })} density="compact" hideDetails />
                            </FormField>
                        )}
                        <FormField label={t("Statement currency")} error={errorFor("currency")}>
                            <VTextField modelValue={form.currency} onUpdate:modelValue={(value: string) => patch({ currency: value.toUpperCase() })} density="compact" hideDetails />
                        </FormField>
                        <FormField label={t("Date format")} hint={t("Leave empty for ISO dates.")}>
                            <VTextField modelValue={form.dateFormat} onUpdate:modelValue={(value: string) => patch({ dateFormat: value })} density="compact" hideDetails />
                        </FormField>
                        <FormField label={t("Statement time zone")} error={errorFor("timezone")} hint={t("For example Africa/Tripoli.")}>
                            <VTextField modelValue={form.timezone} onUpdate:modelValue={(value: string) => patch({ timezone: value })} density="compact" hideDetails />
                        </FormField>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px" }}>
                        <VSwitch
                            modelValue={form.headerRow}
                            onUpdate:modelValue={(value: boolean | null) => patch({ headerRow: value === true })}
                            label={t("The first row is a header")}
                            color="primary"
                            density="compact"
                            hideDetails
                        />
                        <VSwitch
                            modelValue={form.supportsBatchNet}
                            onUpdate:modelValue={(value: boolean | null) => patch({ supportsBatchNet: value === true })}
                            label={t("Settlements are paid net of batch fees")}
                            color="primary"
                            density="compact"
                            hideDetails
                        />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <span style={{ fontSize: "13px", fontWeight: 600 }}>{t("Column mapping")}</span>
                        <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                            {form.headerRow
                                ? t("Type the statement column name that holds each field.")
                                : t("Without a header row the columns are read by position, in the order listed below.")}
                        </span>
                        <div style={GRID}>
                            {COLUMN_LOGICAL_KEYS.map((key) => {
                                const required = REQUIRED_COLUMNS.includes(key);
                                const hint = COLUMN_HINTS[key];
                                return (
                                    <FormField
                                        key={key}
                                        label={t(COLUMN_LABELS[key])}
                                        required={required}
                                        error={errorFor(`columns.${key}`)}
                                        hint={hint ? t(hint) : ""}
                                    >
                                        <VTextField modelValue={form.columns[key]} onUpdate:modelValue={(value: string) => patchColumn(key, value)} density="compact" hideDetails />
                                    </FormField>
                                );
                            })}
                        </div>
                        {!form.headerRow && positionalColumnOrder(form).length > 0 && (
                            <span style={{ fontSize: "12px", color: "var(--pg-ink-secondary)" }}>
                                {t("Column order")}: {positionalColumnOrder(form).map((key, index) => `${index + 1}. ${t(COLUMN_LABELS[key])}`).join("  ·  ")}
                            </span>
                        )}
                    </div>
                    {warnings.length > 0 && (
                        <VAlert type="warning" variant="tonal" density="compact">
                            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                {warnings.map((entry) => (
                                    <span key={`${entry.code}-${entry.field}`}>{t(PARSER_ERROR_MESSAGES[entry.code])}</span>
                                ))}
                            </div>
                        </VAlert>
                    )}
                </div>
            );
        };
    },
});

/** Mapped / missing column badges of a source (used by the table; derived from the full parser config). */
export const ColumnMappingBadges = defineComponent({
    name: "ColumnMappingBadges",
    props: {
        parserConfig: { type: null as unknown as PropType<unknown> },
    },
    setup(props) {
        const { t } = useLocale();
        return (): VNodeChild => {
            const summary = summarizeColumnMapping(props.parserConfig);
            return (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", maxInlineSize: "280px" }}>
                    {summary.mapped.map((key) => (
                        <StatusBadge key={key} status={`MAPPED_${key}`} label={t(COLUMN_LABELS[key])} toneOverride="success" showDot={false} />
                    ))}
                    {summary.missing.map((key) => (
                        <StatusBadge key={`missing-${key}`} status={`MISSING_${key}`} label={`${t(COLUMN_LABELS[key])} · ${t("not mapped")}`} toneOverride="warning" showDot={false} />
                    ))}
                    {summary.mapped.length === 0 && summary.missing.length === 0 && <span style={{ color: "var(--pg-ink-faint)" }}>—</span>}
                </div>
            );
        };
    },
});

export const firstParserError = (form: ParserConfigForm, translate: (key: string) => string): string => {
    const first = validateParserConfig(form).find((entry) => entry.severity === "error");
    return first ? translate(PARSER_ERROR_MESSAGES[first.code]) : "";
};
