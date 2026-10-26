import { dc } from "kt-dc";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { VChip } from "vuetify/components";

export type JsonPatchOperation = {
    op: "add" | "remove" | "replace" | "move" | "copy" | "test";
    path: string;
    value?: unknown;
    from?: string;
};

export type JsonPatchDiffProps = {
    operations: JsonPatchOperation[];
    base?: unknown;
};

const stringify = (value: unknown): string => {
    if (value === undefined) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
};

const opColor = (op: string) => {
    switch (op) {
        case "add":
            return "success";
        case "remove":
            return "error";
        case "replace":
            return "info";
        default:
            return "warning";
    }
};

export const JsonPatchDiff = dc(
    (props: JsonPatchDiffProps) => {
        return () => {
            if (!props.operations?.length) {
                return (
                    <ThemedText style={{ fontSize: "13px", opacity: 0.6 }}>
                        No JSON-Patch operations recorded for this request
                    </ThemedText>
                );
            }
            return (
                <ThemedView style={{ gap: "12px", width: "100%" }}>
                    {props.operations.map((operation, index) => (
                        <ThemedView
                            key={`${operation.path}-${index}`}
                            style={{
                                border: "1px solid rgba(100,116,139,0.28)",
                                borderRadius: "12px",
                                overflow: "hidden",
                                background: "rgba(100,116,139,0.05)",
                            }}
                        >
                            <ThemedView
                                style={{
                                    flexDirection: "row",
                                    alignItems: "center",
                                    gap: "10px",
                                    padding: "10px 12px",
                                    borderBottom: "1px solid rgba(100,116,139,0.2)",
                                }}
                            >
                                <VChip size="x-small" color={opColor(operation.op)} variant="tonal">
                                    {operation.op.toUpperCase()}
                                </VChip>
                                <ThemedText
                                    style={{
                                        fontSize: "13px",
                                        fontWeight: "700",
                                        direction: "ltr",
                                        unicodeBidi: "isolate",
                                    }}
                                >
                                    {operation.path}
                                </ThemedText>
                            </ThemedView>
                            <ThemedView style={{ padding: "12px", gap: "8px" }}>
                                {operation.from && (
                                    <ThemedView style={{ gap: "4px" }}>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>from</ThemedText>
                                        <pre
                                            style={{
                                                margin: 0,
                                                fontSize: "12px",
                                                whiteSpace: "pre-wrap",
                                                direction: "ltr",
                                                unicodeBidi: "isolate",
                                                color: "#dc2626",
                                            }}
                                        >
                                            {stringify(operation.from)}
                                        </pre>
                                    </ThemedView>
                                )}
                                {operation.op !== "remove" && (
                                    <ThemedView style={{ gap: "4px" }}>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>value</ThemedText>
                                        <pre
                                            style={{
                                                margin: 0,
                                                fontSize: "12px",
                                                whiteSpace: "pre-wrap",
                                                direction: "ltr",
                                                unicodeBidi: "isolate",
                                                color: "#059669",
                                            }}
                                        >
                                            {stringify(operation.value)}
                                        </pre>
                                    </ThemedView>
                                )}
                            </ThemedView>
                        </ThemedView>
                    ))}
                </ThemedView>
            );
        };
    },
    {
        props: ["operations", "base"],
    },
);

export default JsonPatchDiff;
