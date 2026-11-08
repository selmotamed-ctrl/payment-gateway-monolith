import { computed, defineComponent, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { JsonValueCell } from "./JsonValueCell";
import { MetaPill } from "./MetaPill";
import {
    entryView,
    humanizeSegment,
    normalizeDiff,
    type DiffEntry,
    type EntryOp,
    type JsonPatchOperation,
} from "./jsonDiffModel";

export type { JsonPatchOperation } from "./jsonDiffModel";

const OP_PILL: Record<EntryOp, { color: string; label: string } | null> = {
    add: { color: "success", label: "Added" },
    remove: { color: "danger", label: "Removed" },
    replace: { color: "info", label: "Changed" },
    move: { color: "warning", label: "Moved" },
    copy: { color: "warning", label: "Copied" },
    test: { color: "neutral", label: "Checked" },
    value: null,
};

const headerCell = {
    textAlign: "start",
    padding: "9px 12px",
    fontSize: "11px",
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "var(--pg-ink-muted)",
    backgroundColor: "var(--pg-bg-surface-subtle)",
    borderBottom: "1px solid var(--pg-border-subtle)",
    whiteSpace: "nowrap",
} as const;

const bodyCell = {
    padding: "8px 12px",
    borderBottom: "1px solid var(--pg-border-subtle)",
    verticalAlign: "top",
    maxInlineSize: "340px",
    overflowWrap: "anywhere",
    fontSize: "13px",
    color: "var(--pg-ink-primary)",
} as const;

/**
 * Human-readable change viewer. `diff` accepts an RFC-6902 patch array, a
 * `{ before, after }` pair or a plain payload object; the legacy props
 * (`operations`, `before`/`after`, `beforeJson`/`afterJson`, `payloadDiffJson`)
 * keep working and are folded into the same model.
 */
export const JsonDiffViewer = defineComponent({
    name: "JsonDiffViewer",
    props: {
        diff: { type: null as unknown as PropType<unknown> },
        operations: { type: Array as PropType<JsonPatchOperation[]>, default: () => [] },
        before: { type: [Object, String] as PropType<Record<string, unknown> | string | null>, default: null },
        after: { type: [Object, String] as PropType<Record<string, unknown> | string | null>, default: null },
        beforeJson: { type: [Object, String] as PropType<Record<string, unknown> | string | null>, default: null },
        afterJson: { type: [Object, String] as PropType<Record<string, unknown> | string | null>, default: null },
        payloadDiffJson: { type: [String, Object, Array] as PropType<string | unknown>, default: "" },
    },
    setup(props) {
        const { t } = useLocale();

        const model = computed(() => {
            if (props.diff !== undefined) return normalizeDiff(props.diff);
            if ((props.operations ?? []).length > 0) return normalizeDiff(props.operations);
            if (props.payloadDiffJson) return normalizeDiff(props.payloadDiffJson);
            return normalizeDiff({ before: props.beforeJson ?? props.before, after: props.afterJson ?? props.after });
        });

        const labelOf = (entry: DiffEntry): string =>
            entry.segments.length === 0
                ? t("Entire record")
                : entry.segments.map((segment) => t(humanizeSegment(segment))).join(" · ");

        const renderSide = (entry: DiffEntry, side: "before" | "after"): VNodeChild => {
            if ((entry.op === "move" || entry.op === "copy") && side === "before") {
                return <span dir="auto">{entry.fromLabel ?? "—"}</span>;
            }
            if ((entry.op === "move" || entry.op === "copy") && side === "after") {
                return <span dir="auto">{labelOf(entry)}</span>;
            }
            return <JsonValueCell view={entryView(entry, side)} />;
        };

        return (): VNodeChild => {
            const { mode, entries } = model.value;
            const twoColumn = mode === "payload";
            const headers = twoColumn
                ? [t("Field"), t("Value")]
                : [t("Field"), t("Current / Before"), t("Proposed / After")];
            return (
                <div
                    class="pg-unified-table pg-json-diff"
                    style={{ border: "1px solid var(--pg-border-subtle)", borderRadius: "var(--pg-radius-md)", overflowX: "auto" }}
                >
                    <table style={{ inlineSize: "100%", borderCollapse: "collapse" }}>
                        <caption class="pg-sr-only">{t("Proposed change")}</caption>
                        <thead>
                            <tr>
                                {headers.map((label) => (
                                    <th key={label} scope="col" style={headerCell}>
                                        {label}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {entries.length === 0 ? (
                                <tr>
                                    <td
                                        colspan={headers.length}
                                        style={{ padding: "18px 12px", color: "var(--pg-ink-muted)", textAlign: "center" }}
                                    >
                                        {t("No changes recorded.")}
                                    </td>
                                </tr>
                            ) : (
                                entries.map((entry, index) => {
                                    const pill = OP_PILL[entry.op];
                                    return (
                                        <tr key={`${entry.path}-${index}`}>
                                            <th
                                                scope="row"
                                                title={entry.path || undefined}
                                                style={{ ...bodyCell, textAlign: "start", fontWeight: 500, minInlineSize: "140px" }}
                                            >
                                                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                                                    <span>{labelOf(entry)}</span>
                                                    {pill && (
                                                        <MetaPill size="x-small" color={pill.color}>
                                                            {t(pill.label)}
                                                        </MetaPill>
                                                    )}
                                                </span>
                                            </th>
                                            {twoColumn ? (
                                                <td style={bodyCell}>{renderSide(entry, "after")}</td>
                                            ) : (
                                                <>
                                                    <td
                                                        style={{
                                                            ...bodyCell,
                                                            backgroundColor: entry.hasBefore ? "var(--pg-status-danger-bg)" : undefined,
                                                        }}
                                                    >
                                                        {renderSide(entry, "before")}
                                                    </td>
                                                    <td
                                                        style={{
                                                            ...bodyCell,
                                                            backgroundColor: entry.hasAfter ? "var(--pg-status-success-bg)" : undefined,
                                                        }}
                                                    >
                                                        {renderSide(entry, "after")}
                                                    </td>
                                                </>
                                            )}
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            );
        };
    },
});

export default JsonDiffViewer;
