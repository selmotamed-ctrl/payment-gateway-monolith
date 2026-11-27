import { type PropType, type VNodeChild } from "vue";
import { defineComponent } from "../../lib/dc";
import { useLocale } from "../../lib/locale";
import { JsonValueCell } from "./JsonValueCell";
import { coerceValue, humanizeSegment, isPlainObject, toPointer } from "./jsonDiffModel";

const CURRENCY_CODE = /^[A-Z]{3}$/;

const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] =>
    Array.isArray(value) || isPlainObject(value);

const hasEntries = (value: Record<string, unknown> | unknown[]): boolean =>
    Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0;

/**
 * Read-only typed tree for arbitrary JSON payloads (audit evidence, webhook
 * bodies, severity inputs, list versions).
 *
 * Keys are humanised by default (`settlement_iban_number` -> `Settlement IBAN
 * Number`), nested objects/arrays are indented with a hairline rule, cycles are
 * cut off as `[Circular]` and anything deeper than `maxDepth` becomes
 * `[Nested Object]`.
 */
export const JsonValueList = defineComponent({
    name: "JsonValueList",
    props: {
        /** Root payload (legacy prop name). */
        value: { type: null as unknown as PropType<unknown>, default: undefined },
        /** Root payload (2026 prop name; wins over `value` when both are set). */
        data: { type: null as unknown as PropType<unknown>, default: undefined },
        /** Human label overrides keyed by the raw top-level key or full dotted path. */
        labels: { type: Object as PropType<Record<string, string>>, default: () => ({}) },
        /** Raw top-level keys to list first, in this order. */
        order: { type: Array as PropType<string[]>, default: () => [] },
        /** Raw keys (or dotted paths) to omit. */
        hidden: { type: Array as PropType<string[]>, default: () => [] },
        /** Kept for backward compatibility with the old description-list layout. */
        columns: { type: Number as PropType<1 | 2>, default: 1 },
        emptyText: { type: String, default: "" },
        ariaLabel: { type: String, default: "" },
        /** Humanise raw keys (`merchant_id` -> `Merchant ID`). */
        humanize: { type: Boolean, default: true },
        /** Object nesting levels rendered before `[Nested Object]`. */
        maxDepth: { type: Number, default: 4 },
        /** Current nesting depth (0 at the root). */
        depth: { type: Number, default: 0 },
        /** Ancestor objects used for circular-reference protection. */
        ancestors: { type: Array as PropType<readonly unknown[]>, default: () => [] },
        /** Long strings inside cells truncate at this length. */
        maxLength: { type: Number, default: 120 },
        /** Copy buttons on leaf values. */
        copyable: { type: Boolean, default: true },
        /** Full dotted path of this node (internal, used by nested rows). */
        path: { type: Array as PropType<string[]>, default: () => [] },
        /** Currency inherited from the nearest `currency` field. */
        currency: { type: String, default: "" },
    },
    setup(props) {
        const { t } = useLocale();

        const rootValue = (): unknown => coerceValue(props.data !== undefined ? props.data : props.value);

        const empty = (): VNodeChild => (
            <span class="pg-json-value-list__empty">{props.emptyText || t("No data recorded.")}</span>
        );

        const guard = (label: string): VNodeChild => (
            <span class="pg-json-value-list__guard" dir="ltr">{label}</span>
        );

        const renderRows = (node: Record<string, unknown> | unknown[], depth: number, path: string[], ancestors: readonly unknown[]): VNodeChild => {
            const currency =
                isPlainObject(node) && typeof node.currency === "string" && CURRENCY_CODE.test(node.currency)
                    ? node.currency
                    : props.currency;
            const keys = Array.isArray(node) ? node.map((_, index) => String(index)) : Object.keys(node);
            const visibleKeys = keys.filter((key) => {
                const full = [...path, key].join(".");
                return !props.hidden.includes(key) && !props.hidden.includes(full) && !props.hidden.includes(toPointer([...path, key]));
            });
            const rank = (key: string) => {
                const index = props.order.indexOf(key);
                return index === -1 ? props.order.length : index;
            };
            const ordered = visibleKeys
                .map((key, index) => ({ key, index }))
                .sort((a, b) => rank(a.key) - rank(b.key) || a.index - b.index)
                .map(({ key }) => key);

            if (ordered.length === 0) return empty();
            const nextAncestors = [...ancestors, node];

            return (
                <dl class="pg-json-value-list" aria-label={path.length === 0 && props.ariaLabel ? props.ariaLabel : undefined}>
                    {ordered.map((key) => {
                        const child = (node as Record<string, unknown>)[key];
                        const fullPath = [...path, key];
                        const override = props.labels[fullPath.join(".")];
                        const label = t(override ?? (props.humanize ? humanizeSegment(key) : key));
                        const childDepth = depth + 1;
                        let body: VNodeChild;
                        if (isContainer(child)) {
                            if (ancestors.includes(child) || nextAncestors.includes(child)) {
                                body = guard("[Circular]");
                            } else if (childDepth >= props.maxDepth) {
                                body = guard(Array.isArray(child) ? "[Nested Array]" : "[Nested Object]");
                            } else if (!hasEntries(child)) {
                                body = (
                                    <JsonValueCell
                                        value={child}
                                        keyName={key}
                                        currency={currency}
                                        depth={childDepth}
                                        maxDepth={props.maxDepth}
                                        ancestors={nextAncestors}
                                        maxLength={props.maxLength}
                                        copyable={props.copyable}
                                    />
                                );
                            } else {
                                body = (
                                    <div class="pg-json-value-list__nested">
                                        <JsonValueList
                                            data={child}
                                            depth={childDepth}
                                            maxDepth={props.maxDepth}
                                            ancestors={nextAncestors}
                                            labels={props.labels}
                                            hidden={props.hidden}
                                            order={[]}
                                            humanize={props.humanize}
                                            maxLength={props.maxLength}
                                            copyable={props.copyable}
                                            path={fullPath}
                                            currency={currency}
                                        />
                                    </div>
                                );
                            }
                        } else {
                            body = (
                                <JsonValueCell
                                    value={child}
                                    keyName={key}
                                    currency={currency}
                                    depth={childDepth}
                                    maxDepth={props.maxDepth}
                                    ancestors={nextAncestors}
                                    maxLength={props.maxLength}
                                    copyable={props.copyable}
                                />
                            );
                        }
                        return (
                            <div key={`${key}-${childDepth}`} class="pg-json-value-list__row" data-key={key}>
                                <dt
                                    class="pg-json-value-list__key"
                                    dir={override ? "auto" : "ltr"}
                                    title={toPointer(fullPath)}
                                >
                                    {label}
                                </dt>
                                <dd class="pg-json-value-list__value">{body}</dd>
                            </div>
                        );
                    })}
                </dl>
            );
        };

        return (): VNodeChild => {
            const value = rootValue();
            if (value === null || value === undefined || value === "" || (isContainer(value) && !hasEntries(value))) {
                return empty();
            }
            if (isContainer(value)) {
                if (props.ancestors.includes(value)) return <span class="pg-json-value-list__guard" dir="ltr">[Circular]</span>;
                return renderRows(value, props.depth, props.path, props.ancestors);
            }
            return (
                <dl class="pg-json-value-list" aria-label={props.ariaLabel || undefined}>
                    <div class="pg-json-value-list__row" data-key="">
                        <dt class="pg-json-value-list__key" dir="auto">{t("Entire record")}</dt>
                        <dd class="pg-json-value-list__value">
                            <JsonValueCell value={value} depth={props.depth} maxDepth={props.maxDepth} ancestors={props.ancestors} maxLength={props.maxLength} copyable={props.copyable} />
                        </dd>
                    </div>
                </dl>
            );
        };
    },
});

export default JsonValueList;
