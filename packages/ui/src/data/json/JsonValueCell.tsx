import { onBeforeUnmount, ref, watch, type PropType, type VNodeChild } from "vue";
import { defineComponent } from "../../lib/dc";
import { useLocale } from "../../lib/locale";
import { usePgUiConfig } from "../../lib/config";
import { copyToClipboard } from "../../lib/dom";
import { PgIcon } from "../../actions/PgIcon";
import { MoneyDisplay } from "../PgMoneyText";
import { StatusBadge } from "../../feedback/PgStatusBadge";
import { MetaPill } from "../PgMetaPill";
import { JsonValueList } from "./JsonValueList";
import { isIsoDateString, isMoneyKey, isPlainObject, type ValueView } from "./jsonDiffModel";

const MAX_CHIPS = 12;
const DECIMAL = /^-?\d+(\.\d+)?$/;

const classNames = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(" ");

const formatDateTime = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
};

/**
 * One JSON value.
 *
 * - Legacy classified mode: pass `view` (money / status / chips / dates).
 * - 2026 typed mode: pass `value` for booleans (subtle pills), tabular numbers,
 *   italic `null`, ISO dates, truncated + expandable strings and nested
 *   objects/arrays rendered as an indented `JsonValueList`.
 */
export const JsonValueCell = defineComponent({
    name: "JsonValueCell",
    props: {
        /** Classified value view used by `JsonDiffViewer` and existing pages. */
        view: { type: Object as PropType<ValueView>, default: undefined },
        /** Raw value for the typed inspector mode. */
        value: { type: null as unknown as PropType<unknown>, default: undefined },
        /** Truncate long strings after this many characters (default 120). */
        maxLength: { type: Number, default: 120 },
        /** Show the copy button on leaf values. */
        copyable: { type: Boolean, default: true },
        /** Raw key used for money/status classification in typed mode. */
        keyName: { type: String, default: "" },
        /** Currency inherited from the nearest `currency` field. */
        currency: { type: String, default: "" },
        /** `false` renders an absent-value dash instead of the raw value. */
        present: { type: Boolean, default: true },
        /** Current nesting depth (0 at the root). */
        depth: { type: Number, default: 0 },
        /** Objects/arrays beyond this depth render `[Nested Object]`. */
        maxDepth: { type: Number, default: 4 },
        /** Ancestor objects for circular-reference protection. */
        ancestors: { type: Array as PropType<readonly unknown[]>, default: () => [] },
    },
    setup(props) {
        const { t } = useLocale();
        const config = usePgUiConfig();
        const expanded = ref(false);
        const copied = ref(false);
        let timer: ReturnType<typeof setTimeout> | undefined;

        watch(
            () => props.value,
            () => {
                expanded.value = false;
                copied.value = false;
            },
        );

        onBeforeUnmount(() => timer && clearTimeout(timer));

        const copy = async (text: string) => {
            if (!text) return;
            const ok = config.copyText ? await config.copyText(text) : await copyToClipboard(text);
            if (!ok) return;
            copied.value = true;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => (copied.value = false), 1400);
        };

        const copyButton = (text: string) =>
            props.copyable && text ? (
                <button
                    type="button"
                    class={classNames("pg-json-value__copy", copied.value && "pg-json-value__copy--done")}
                    aria-label={copied.value ? t("Copied") : t("Copy value")}
                    title={copied.value ? t("Copied") : t("Copy value")}
                    onClick={() => void copy(text)}
                >
                    <PgIcon size={12} icon={copied.value ? "mdi-check" : "mdi-content-copy"} />
                </button>
            ) : null;

        const renderView = (view: ValueView): VNodeChild => {
            switch (view.kind) {
                case "absent":
                    return <span class="pg-json-value__absent" style={{ color: "var(--pg-ink-faint)" }}>—</span>;
                case "empty":
                    return <span style={{ color: "var(--pg-ink-muted)", fontStyle: "italic" }}>{t("Empty")}</span>;
                case "money":
                    return <MoneyDisplay amount={view.amount} currency={view.currency} size="sm" />;
                case "status":
                    return <StatusBadge status={view.status} />;
                case "boolean":
                    return (
                        <span
                            class={classNames("pg-json-value__bool", view.value ? "pg-json-value__bool--true" : "pg-json-value__bool--false")}
                            dir="ltr"
                        >
                            {view.value ? "true" : "false"}
                        </span>
                    );
                case "datetime":
                    return <span dir="ltr" class="pg-tabular">{formatDateTime(view.iso)}</span>;
                case "list": {
                    const shown = view.items.slice(0, MAX_CHIPS);
                    const hidden = view.items.length - shown.length;
                    return (
                        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "4px", justifyContent: "inherit" }}>
                            {shown.map((item, index) => (
                                <MetaPill key={`${item}-${index}`} size="x-small" variant="outlined">
                                    <span dir="ltr" style={{ unicodeBidi: "isolate" }}>{item}</span>
                                </MetaPill>
                            ))}
                            {hidden > 0 && <MetaPill size="x-small" variant="text">{`+${hidden}`}</MetaPill>}
                        </span>
                    );
                }
                case "number":
                    return <span dir="ltr" class="pg-tabular">{view.text}</span>;
                case "text":
                    return (
                        <span dir="ltr" style={{ unicodeBidi: "isolate", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                            {view.text}
                        </span>
                    );
                default:
                    return null;
            }
        };

        const guard = (label: string) => (
            <span class="pg-json-value pg-json-value--guard">
                <span class="pg-json-value__guard" dir="ltr">{label}</span>
            </span>
        );

        const renderRaw = (): VNodeChild => {
            if (!props.present) return <span class="pg-json-value pg-json-value--absent"><span class="pg-json-value__absent">—</span></span>;

            const value = props.value;
            if (value === null || value === undefined) {
                return (
                    <span class="pg-json-value pg-json-value--null">
                        <span class="pg-json-value__null" dir="ltr">null</span>
                        {copyButton("null")}
                    </span>
                );
            }

            if (typeof value === "boolean") {
                return (
                    <span class={classNames("pg-json-value", "pg-json-value--boolean")}>
                        <span
                            class={classNames("pg-json-value__bool", value ? "pg-json-value__bool--true" : "pg-json-value__bool--false")}
                            dir="ltr"
                        >
                            {value ? "true" : "false"}
                        </span>
                        {copyButton(value ? "true" : "false")}
                    </span>
                );
            }

            if (typeof value === "number" || typeof value === "bigint") {
                const text = String(value);
                return (
                    <span class="pg-json-value pg-json-value--number">
                        <span class="pg-json-value__number pg-tabular" dir="ltr">{text}</span>
                        {copyButton(text)}
                    </span>
                );
            }

            if (value instanceof Date) {
                const iso = Number.isNaN(value.getTime()) ? "" : value.toISOString();
                return (
                    <span class="pg-json-value pg-json-value--date">
                        <span class="pg-json-value__date pg-tabular" dir="ltr" title={iso || undefined}>
                            {iso ? formatDateTime(iso) : "Invalid Date"}
                        </span>
                        {copyButton(iso)}
                    </span>
                );
            }

            if (Array.isArray(value) || isPlainObject(value)) {
                if (props.ancestors.includes(value)) return guard("[Circular]");
                if (props.depth >= props.maxDepth) return guard(Array.isArray(value) ? "[Nested Array]" : "[Nested Object]");
                return (
                    <div class="pg-json-value pg-json-value--nested">
                        <JsonValueList
                            data={value}
                            depth={props.depth}
                            maxDepth={props.maxDepth}
                            ancestors={props.ancestors}
                            maxLength={props.maxLength}
                            copyable={props.copyable}
                        />
                    </div>
                );
            }

            if (typeof value === "string") {
                if (isIsoDateString(value)) {
                    return (
                        <span class="pg-json-value pg-json-value--date">
                            <span class="pg-json-value__date pg-tabular" dir="ltr" title={value}>
                                {formatDateTime(value)}
                            </span>
                            {copyButton(value)}
                        </span>
                    );
                }
                if (isMoneyKey(props.keyName) && DECIMAL.test(value.trim())) {
                    return (
                        <span class="pg-json-value pg-json-value--money">
                            <span class="pg-json-value__money pg-tabular" dir="ltr">
                                {value}
                                {props.currency ? <span class="pg-json-value__currency"> {props.currency}</span> : null}
                            </span>
                            {copyButton(value)}
                        </span>
                    );
                }
                const text = value;
                const limit = Math.max(0, props.maxLength);
                const truncatable = text.length > limit;
                return (
                    <span class="pg-json-value pg-json-value--text">
                        <span class="pg-json-value__text" dir="auto" title={truncatable && !expanded.value ? text : undefined}>
                            {truncatable && !expanded.value ? `${text.slice(0, limit)}…` : text}
                        </span>
                        {truncatable && (
                            <button
                                type="button"
                                class="pg-json-value__expand"
                                aria-expanded={expanded.value ? "true" : "false"}
                                onClick={() => (expanded.value = !expanded.value)}
                            >
                                {expanded.value ? t("Show less") : t("Show more")}
                            </button>
                        )}
                        {copyButton(text)}
                    </span>
                );
            }

            const text = String(value);
            return (
                <span class="pg-json-value pg-json-value--text">
                    <span class="pg-json-value__text" dir="auto">{text}</span>
                    {copyButton(text)}
                </span>
            );
        };

        return (): VNodeChild => (props.view ? renderView(props.view) : renderRaw());
    },
});

export default JsonValueCell;
