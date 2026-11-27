import { computed, onBeforeUnmount, ref, watch, type PropType, type VNodeChild } from "vue";
import { createIf } from "@vue/runtime-vapor";
import { defineComponent } from "../../lib/dc";
import { useLocale } from "../../lib/locale";
import { usePgUiConfig } from "../../lib/config";
import { copyToClipboard } from "../../lib/dom";
import { PgIcon } from "../../actions/PgIcon";
import { JsonValueCell } from "./JsonValueCell";
import { MetaPill } from "../PgMetaPill";
import {
    entryView,
    formatJsonValue,
    humanizeSegment,
    normalizeDiff,
    type DiffEntry,
    type EntryOp,
    type JsonPatchOperation,
} from "./jsonDiffModel";

export type { JsonPatchOperation } from "./jsonDiffModel";

/** The Vapor JSX return type is a Block at runtime; the public type is narrower. */
const branch = createIf as any;

const OP_PILL: Record<EntryOp, { color: string; label: string } | null> = {
    add: { color: "success", label: "Added" },
    remove: { color: "danger", label: "Removed" },
    replace: { color: "warning", label: "Changed" },
    move: { color: "warning", label: "Moved" },
    copy: { color: "warning", label: "Copied" },
    test: { color: "neutral", label: "Checked" },
    value: null,
};

const ROW_MARK: Record<DiffEntry["status"], string> = {
    added: "+",
    removed: "-",
    modified: "~",
    unchanged: "=",
};

/**
 * Human-readable change viewer for maker-checker approvals and audit logs.
 *
 * `diff` accepts an RFC-6902 patch array, a `{ operations }` wrapper, a
 * `{ before, after }` pair or a plain payload object; the legacy props
 * (`operations`, `before`/`after`, `beforeJson`/`afterJson`, `payloadDiffJson`)
 * still fold into the same model. Changed rows carry a 3px semantic bar,
 * `+` / `-` prefixes, success/danger/warning surfaces and a copy button;
 * unchanged rows are collapsed unless `showUnchanged` (or the toolbar toggle)
 * reveals them.
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
        /** Start with equal leaves visible (default `false`). */
        showUnchanged: { type: Boolean, default: false },
    },
    setup(props) {
        const { t } = useLocale();
        const config = usePgUiConfig();
        const expanded = ref(Boolean(props.showUnchanged));
        const copiedKey = ref<string | null>(null);
        let timer: ReturnType<typeof setTimeout> | undefined;

        watch(
            () => props.showUnchanged,
            (value) => (expanded.value = Boolean(value)),
        );
        onBeforeUnmount(() => timer && clearTimeout(timer));

        const safeModel = (input: unknown) => {
            try {
                return normalizeDiff(input, { includeUnchanged: true });
            } catch {
                return { mode: "empty" as const, entries: [] };
            }
        };

        const model = computed(() => {
            if (props.diff !== undefined) return safeModel(props.diff);
            if ((props.operations ?? []).length > 0) return safeModel(props.operations);
            if (props.payloadDiffJson) return safeModel(props.payloadDiffJson);
            return safeModel({ before: props.beforeJson ?? props.before, after: props.afterJson ?? props.after });
        });

        const unchangedCount = computed(() => model.value.entries.filter((entry) => entry.status === "unchanged").length);
        const canToggle = computed(
            () => unchangedCount.value > 0 && (model.value.mode === "compare" || model.value.mode === "patch"),
        );
        const visibleEntries = computed(() => {
            const { mode, entries } = model.value;
            if (mode === "payload" || expanded.value) return entries;
            return entries.filter((entry) => entry.status !== "unchanged");
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

        const copy = async (entry: DiffEntry, key: string) => {
            if (!entry.hasBefore && !entry.hasAfter) return;
            const value = entry.hasAfter ? entry.after : entry.before;
            const text = formatJsonValue(value);
            const ok = config.copyText ? await config.copyText(text) : await copyToClipboard(text);
            if (!ok) return;
            copiedKey.value = key;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => (copiedKey.value = null), 1400);
        };

        return (): VNodeChild => {
            const { mode } = model.value;
            const twoColumn = mode === "payload";
            const headers = twoColumn ? [t("Field"), t("Value")] : [t("Field"), t("Current / Before"), t("Proposed / After")];
            const columnCount = twoColumn ? 4 : 5;

            return (
                <div class="pg-json-diff" data-mode={mode}>
                    {branch(
                        () => canToggle.value,
                        () => (
                            <div class="pg-json-diff__toolbar">
                                <button
                                    type="button"
                                    class="pg-json-diff__toggle"
                                    aria-expanded={expanded.value ? "true" : "false"}
                                    onClick={() => (expanded.value = !expanded.value)}
                                >
                                    <PgIcon size={14} icon={expanded.value ? "mdi-eye-off-outline" : "mdi-eye-outline"} />
                                    <span>{expanded.value ? t("Hide unchanged") : t("Show unchanged")}</span>
                                    <span class="pg-json-diff__count">{unchangedCount.value}</span>
                                </button>
                            </div>
                        ),
                    )}
                    <div class="pg-json-diff__scroll">
                        <table class="pg-json-diff__table">
                            <caption class="pg-sr-only">{t("Proposed change")}</caption>
                            <thead>
                                <tr>
                                    <th scope="col" class="pg-json-diff__th pg-json-diff__bar" aria-hidden="true" />
                                    {headers.map((label) => (
                                        <th key={label} scope="col" class="pg-json-diff__th">
                                            {label}
                                        </th>
                                    ))}
                                    <th scope="col" class="pg-json-diff__th pg-json-diff__copy-cell">
                                        <span class="pg-sr-only">{t("Copy value")}</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {branch(
                                    () => visibleEntries.value.length === 0,
                                    () => (
                                        <tr>
                                            <td colspan={columnCount} class="pg-json-diff__empty">
                                                {t("No changes recorded.")}
                                            </td>
                                        </tr>
                                    ),
                                    () => (
                                        <>
                                            {visibleEntries.value.map((entry, index) => {
                                                const rowKey = `${entry.path}-${index}`;
                                                const pill = OP_PILL[entry.op];
                                                return (
                                                    <tr
                                                        key={rowKey}
                                                        class={`pg-json-diff__row pg-json-diff__row--${entry.status}`}
                                                        data-status={entry.status}
                                                        data-kind={entry.kind}
                                                        data-path={entry.path}
                                                    >
                                                        <td class="pg-json-diff__bar" aria-hidden="true">
                                                            <span class="pg-json-diff__mark">{ROW_MARK[entry.status]}</span>
                                                        </td>
                                                        <th scope="row" class="pg-json-diff__field" title={entry.path || undefined}>
                                                            <span class="pg-json-diff__label">{labelOf(entry)}</span>
                                                            {entry.path && (
                                                                <span class="pg-json-diff__path" dir="ltr">
                                                                    {entry.path}
                                                                </span>
                                                            )}
                                                            <span class="pg-json-diff__meta">
                                                                {pill && (
                                                                    <MetaPill size="x-small" color={pill.color}>
                                                                        {t(pill.label)}
                                                                    </MetaPill>
                                                                )}
                                                                <span class="pg-sr-only">{t(pill?.label ?? "Unchanged")}</span>
                                                            </span>
                                                        </th>
                                                        {twoColumn ? (
                                                            <td class="pg-json-diff__value pg-json-diff__value--after" dir="ltr">
                                                                {renderSide(entry, "after")}
                                                            </td>
                                                        ) : (
                                                            <>
                                                                <td class="pg-json-diff__value pg-json-diff__value--before" dir="ltr">
                                                                    {renderSide(entry, "before")}
                                                                </td>
                                                                <td class="pg-json-diff__value pg-json-diff__value--after" dir="ltr">
                                                                    {renderSide(entry, "after")}
                                                                </td>
                                                            </>
                                                        )}
                                                        <td class="pg-json-diff__copy-cell">
                                                            <button
                                                                type="button"
                                                                class={[
                                                                    "pg-json-diff__copy",
                                                                    copiedKey.value === rowKey ? "pg-json-diff__copy--done" : "",
                                                                ]
                                                                    .filter(Boolean)
                                                                    .join(" ")}
                                                                aria-label={copiedKey.value === rowKey ? t("Copied") : t("Copy value")}
                                                                title={copiedKey.value === rowKey ? t("Copied") : t("Copy value")}
                                                                disabled={!entry.hasBefore && !entry.hasAfter}
                                                                onClick={() => void copy(entry, rowKey)}
                                                            >
                                                                <PgIcon size={12} icon={copiedKey.value === rowKey ? "mdi-check" : "mdi-content-copy"} />
                                                            </button>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </>
                                    ),
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            );
        };
    },
});

export default JsonDiffViewer;
