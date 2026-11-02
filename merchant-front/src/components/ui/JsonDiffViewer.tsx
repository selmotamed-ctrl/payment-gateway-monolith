import { computed, defineComponent, type PropType, type VNodeChild } from "vue";

export interface JsonPatchOperation {
    op: "add" | "remove" | "replace" | "move" | "copy" | "test";
    path: string;
    value?: unknown;
    from?: string;
}

type DiffRow = { path: string; before: string; after: string };

const stableStringify = (value: unknown): string => {
    if (value === undefined) return "—";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
};

const flatten = (value: unknown, prefix = ""): Array<[string, unknown]> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
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

export const JsonDiffViewer = defineComponent({
    name: "JsonDiffViewer",
    props: {
        operations: { type: Array as PropType<JsonPatchOperation[]>, default: () => [] },
        before: { type: Object as PropType<Record<string, unknown> | null>, default: null },
        after: { type: Object as PropType<Record<string, unknown> | null>, default: null },
        payloadDiffJson: { type: String, default: "" },
    },
    setup(props) {
        const rows = computed<DiffRow[]>(() => {
            let operations = props.operations ?? [];
            if (operations.length === 0 && props.payloadDiffJson) {
                try {
                    const parsed = JSON.parse(props.payloadDiffJson);
                    operations = Array.isArray(parsed) ? parsed : parsed?.operations ?? [];
                } catch {
                    operations = [];
                }
            }
            if (operations.length > 0) {
                return operations.map((operation) => {
                    const before =
                        operation.op === "remove" || operation.op === "test"
                            ? stableStringify(operation.value)
                            : operation.op === "move" || operation.op === "copy"
                              ? operation.from ?? "—"
                              : "—";
                    const after =
                        operation.op === "remove"
                            ? "—"
                            : operation.op === "move"
                              ? operation.path
                              : operation.op === "copy"
                                ? `${operation.from ?? ""} → ${operation.path}`
                                : operation.op === "test"
                                  ? stableStringify(operation.value)
                                  : stableStringify(operation.value);
                    return { path: operation.path, before, after };
                });
            }
            if (props.before || props.after) {
                const beforeMap = new Map(flatten(props.before));
                const afterMap = new Map(flatten(props.after));
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
            <div style={{ border: "1px solid var(--pg-border-subtle)", borderRadius: "var(--pg-radius-md)", overflowX: "auto" }}>
                <table class="pg-unified-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                    <thead>
                        <tr>
                            {["Field Path", "Current / Before", "Proposed / After"].map((label) => (
                                <th
                                    key={label}
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
                                    No changes recorded.
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
