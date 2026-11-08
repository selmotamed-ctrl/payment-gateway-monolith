import { computed, defineComponent, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VTextField } from "vuetify/components";
import { MAX_TIERS, emptyTier, type TierError, type TierErrorCode, type TierField, type TierRow } from "../commissionTiers";

const ERROR_TEXT: Record<TierErrorCode, string> = {
    INVALID_DECIMAL: "Enter a plain decimal number (digits and an optional decimal point).",
    MISSING_PRICE: "Each tier needs a fixed fee, a rate, or both.",
    NOT_ASCENDING: "Tier ceilings must increase from one row to the next.",
    CEILING_NOT_LAST: "Only the last tier may have no ceiling.",
    TOO_MANY: "A profile can have at most 20 tiers.",
    EMPTY: "Add at least one tier.",
};

const headerCell = {
    textAlign: "start",
    padding: "8px 10px",
    fontSize: "11px",
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "var(--pg-ink-muted)",
    backgroundColor: "var(--pg-bg-surface-subtle)",
    borderBottom: "1px solid var(--pg-border-subtle)",
    whiteSpace: "nowrap",
} as const;

/**
 * Table editor for commission tiers (replaces the raw "Tiers JSON" textarea).
 * Values are decimal strings; validation lives in `../commissionTiers`.
 */
export const CommissionTiersEditor = defineComponent({
    name: "CommissionTiersEditor",
    props: {
        modelValue: { type: Array as PropType<TierRow[]>, required: true },
        errors: { type: Array as PropType<TierError[]>, default: () => [] },
        disabled: { type: Boolean, default: false },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { t } = useLocale();

        const errorAt = (index: number, field: TierField): TierError | undefined =>
            props.errors.find((error) => error.index === index && error.field === field);
        const distinctMessages = computed(() => Array.from(new Set(props.errors.map((error) => error.code))).map((code) => t(ERROR_TEXT[code])));

        const update = (index: number, field: TierField, value: string) =>
            emit(
                "update:modelValue",
                props.modelValue.map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value ?? "" } : row)),
            );
        const add = () => emit("update:modelValue", [...props.modelValue, emptyTier()]);
        const remove = (index: number) =>
            emit(
                "update:modelValue",
                props.modelValue.filter((_, rowIndex) => rowIndex !== index),
            );

        const cell = (index: number, row: TierRow, field: TierField, label: string, placeholder: string): VNodeChild => (
            <td style={{ padding: "6px 8px", verticalAlign: "top", minInlineSize: "120px" }}>
                <VTextField
                    modelValue={row[field]}
                    onUpdate:modelValue={(value: string) => update(index, field, value)}
                    aria-label={`${label} ${index + 1}`}
                    placeholder={placeholder}
                    density="compact"
                    variant="outlined"
                    style={{ direction: "ltr" }}
                    hideDetails
                    disabled={props.disabled}
                    error={Boolean(errorAt(index, field))}
                />
            </td>
        );

        return (): VNodeChild => (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ border: "1px solid var(--pg-border-subtle)", borderRadius: "var(--pg-radius-md)", overflowX: "auto" }}>
                    <table style={{ inlineSize: "100%", borderCollapse: "collapse" }}>
                        <caption class="pg-sr-only">{t("Commission tiers")}</caption>
                        <thead>
                            <tr>
                                <th scope="col" style={{ ...headerCell, inlineSize: "40px" }}>#</th>
                                <th scope="col" style={headerCell}>{t("Up to amount")}</th>
                                <th scope="col" style={headerCell}>{t("Fixed fee")}</th>
                                <th scope="col" style={headerCell}>{t("Rate")}</th>
                                <th scope="col" style={{ ...headerCell, inlineSize: "56px" }}>
                                    <span class="pg-sr-only">{t("Actions")}</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {props.modelValue.length === 0 ? (
                                <tr>
                                    <td colspan={5} style={{ padding: "14px", textAlign: "center", color: "var(--pg-ink-muted)", fontSize: "13px" }}>
                                        {t("No tiers yet. Add the first tier.")}
                                    </td>
                                </tr>
                            ) : (
                                props.modelValue.map((row, index) => (
                                    <tr key={index} style={{ borderBottom: "1px solid var(--pg-border-subtle)" }}>
                                        <td style={{ padding: "6px 10px", color: "var(--pg-ink-muted)", fontSize: "12px", verticalAlign: "middle" }}>{index + 1}</td>
                                        {cell(index, row, "upTo", t("Up to amount"), index === props.modelValue.length - 1 ? t("No ceiling") : "")}
                                        {cell(index, row, "flat", t("Fixed fee"), "0.0000")}
                                        {cell(index, row, "percent", t("Rate"), "0.015")}
                                        <td style={{ padding: "6px 8px", verticalAlign: "middle", textAlign: "end" }}>
                                            <VBtn
                                                icon="mdi-delete-outline"
                                                size="small"
                                                variant="text"
                                                aria-label={`${t("Remove tier")} ${index + 1}`}
                                                disabled={props.disabled}
                                                onClick={() => remove(index)}
                                            />
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                    <VBtn
                        size="small"
                        variant="tonal"
                        prependIcon="mdi-plus"
                        disabled={props.disabled || props.modelValue.length >= MAX_TIERS}
                        onClick={add}
                    >
                        {t("Add tier")}
                    </VBtn>
                    <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                        {t("The first tier whose ceiling covers the amount applies. The rate is a decimal fraction, for example 0.015 for 1.5%.")}
                    </span>
                </div>
                {distinctMessages.value.length > 0 && (
                    <ul role="alert" style={{ margin: 0, paddingInlineStart: "18px", color: "var(--pg-status-danger-text)", fontSize: "12px" }}>
                        {distinctMessages.value.map((message) => (
                            <li key={message}>{message}</li>
                        ))}
                    </ul>
                )}
            </div>
        );
    },
});

export default CommissionTiersEditor;
