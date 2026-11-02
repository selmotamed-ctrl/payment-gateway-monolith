import { computed, defineComponent, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";

export interface JsonPatchOperation {
    op: "add" | "remove" | "replace" | "move" | "copy" | "test";
    path: string;
    value?: unknown;
    from?: string;
    oldValue?: unknown;
    before?: unknown;
}

type DiffRow = { path: string; before: string; after: string };

const stableStringify = (value: unknown): string => {
    if (value === undefined) return "—";
    if (value === null) return "null";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
};

const flatten = (value: unknown, prefix = ""): Array<[string, unknown]> => {
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
        return [[prefix || "(root)", value]];
    }
    const rows: Array<[string, unknown]> = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (child !== null && typeof child === "object" && !Array.isArray(child)) {
            rows.push(...flatten(child, path));
        } else {
            rows.push([path, child]);
        }
    }
    return rows;
};

const parsePayload = (payload: string | unknown): unknown => {
    if (typeof payload !== "string") return payload;
    try {
        return JSON.parse(payload);
    } catch {
        return payload;
    }
};

export const JsonDiffViewer = defineComponent({
    name: "JsonDiffViewer",
    props: {
        operations: { type: Array as PropType<JsonPatchOperation[]>, default: () => [] },
        before: { type: [Object, String] as PropType<Record<string, unknown> | string | null>, default: null },
        after: { type: [Object, String] as PropType<Record<string, unknown> | string | null>, default: null },
        beforeJson: { type: [Object, String] as PropType<Record<string, unknown> | string | null>, default: null },
        afterJson: { type: [Object, String] as PropType<Record<string, unknown> | string | null>, default: null },
        payloadDiffJson: { type: [String, Object, Array] as PropType<string | unknown>, default: "" },
    },
    setup(props) {
        const { t } = useLocale();
        const rows = computed<DiffRow[]>(() => {
            let operations = props.operations ?? [];
            if (operations.length === 0 && props.payloadDiffJson) {
                const parsed = parsePayload(props.payloadDiffJson);
                operations = Array.isArray(parsed)
                    ? parsed
                    : Array.isArray((parsed as { operations?: unknown })?.operations)
                      ? ((parsed as { operations: JsonPatchOperation[] }).operations)
                      : [];
            }
            if (operations.length > 0) {
                return operations.map((operation) => {
                    const oldValue = operation.oldValue ?? operation.before;
                    let before = "—";
                    let after = "—";
                    if (operation.op === "add") {
                        before = "—";
                        after = stableStringify(operation.value);
                    } else if (operation.op === "remove") {
                        before = stableStringify(oldValue ?? operation.value);
                        after = "—";
                    } else if (operation.op === "replace") {
                        before = stableStringify(oldValue);
                        after = stableStringify(operation.value);
                    } else if (operation.op === "move") {
                        before = operation.from ?? "—";
                        after = operation.path;
                    } else if (operation.op === "copy") {
                        before = operation.from ?? "—";
                        after = operation.path;
                    } else if (operation.op === "test") {
                        before = stableStringify(oldValue);
                        after = stableStringify(operation.value);
                    }
                    return { path: operation.path, before, after };
                });
            }
            const beforeSource = parsePayload(props.beforeJson ?? props.before);
            const afterSource = parsePayload(props.afterJson ?? props.after);
            if (beforeSource || afterSource) {
                const beforeMap = new Map(flatten(beforeSource));
                const afterMap = new Map(flatten(afterSource));
                const keys = Array.from(new Set([...beforeMap.keys(), ...afterMap.keys()])).sort();
                return keys
                    .filter((key) => stableStringify(beforeMap.get(key)) !== stableStringify(afterMap.get(key)))
                    .map((key) => ({
                        path: key,
                        before: beforeMap.has(key) ? stableStringify(beforeMap.get(key)) : "—",
                        after: afterMap.has(key) ? stableStringify(afterMap.get(key)) : "—",
                    }));
            }
            return [];
        });

        return (): VNodeChild => (
            <div class="pg-unified-table pg-json-diff" style={{ border: "1px solid var(--pg-border-subtle)", borderRadius: "var(--pg-radius-md)", overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                    <caption class="pg-sr-only">{t("Proposed change")}</caption>
                    <thead>
                        <tr>
                            {[t("Field Path"), t("Current / Before"), t("Proposed / After")].map((label) => (
                                <th
                                    key={label}
                                    scope="col"
                                    style={{
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
                                    }}
                                >
                                    {label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.value.length === 0 ? (
                            <tr>
                                <td
                                    colspan={3}
                                    style={{ padding: "18px 12px", color: "var(--pg-ink-muted)", textAlign: "center" }}
                                >
                                    {t("No changes recorded.")}
                                </td>
                            </tr>
                        ) : (
                            rows.value.map((row, idx) => (
                                <tr key={`${row.path}-${idx}`}>
                                    <td
                                        class="pg-mono"
                                        style={{
                                            padding: "8px 12px",
                                            borderBottom: "1px solid var(--pg-border-subtle)",
                                            fontSize: "12px",
                                            verticalAlign: "top",
                                        }}
                                    >
                                        {row.path}
                                    </td>
                                    <td
                                        style={{
                                            padding: "8px 12px",
                                            borderBottom: "1px solid var(--pg-border-subtle)",
                                            backgroundColor: "var(--pg-status-danger-bg)",
                                            color: "var(--pg-status-danger-text)",
                                            whiteSpace: "pre-wrap",
                                            verticalAlign: "top",
                                            maxWidth: "320px",
                                            overflowWrap: "anywhere",
                                        }}
                                    >
                                        {row.before}
                                    </td>
                                    <td
                                        style={{
                                            padding: "8px 12px",
                                            borderBottom: "1px solid var(--pg-border-subtle)",
                                            backgroundColor: "var(--pg-status-success-bg)",
                                            color: "var(--pg-status-success-text)",
                                            whiteSpace: "pre-wrap",
                                            verticalAlign: "top",
                                            maxWidth: "320px",
                                            overflowWrap: "anywhere",
                                        }}
                                    >
                                        {row.after}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        );
    },
});

export default JsonDiffViewer;
