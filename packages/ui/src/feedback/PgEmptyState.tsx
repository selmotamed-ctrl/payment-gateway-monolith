
import { dc } from "../lib/dc";
import { PgIcon } from "../actions/PgIcon";
import { PgButton } from "../actions/PgButton";

/** Calm empty state: icon medallion, title, guidance and one CTA. */
export const PgEmptyState = dc(
    (props: Record<string, any>, _expose, { attrs, emit, slots }) => () => (
        <div
            {...attrs}
            class={["pg-empty", props.compact ? "pg-empty--compact" : "", attrs.class].filter(Boolean).join(" ")}
            role="status"
            aria-live="polite"
        >
            <span class="pg-empty__medallion" aria-hidden="true">
                {slots.icon ? slots.icon() : <PgIcon icon={props.icon ?? "mdi-inbox-outline"} size={22} />}
            </span>
            {props.title && <div class="pg-empty__title">{props.title}</div>}
            {props.description && <div class="pg-empty__description">{props.description}</div>}
            {slots.default ? slots.default() : null}
            {(slots.actions || props.actionLabel) && (
                <div class="pg-empty__actions">
                    {slots.actions ? (
                        slots.actions()
                    ) : (
                        <PgButton
                            size="sm"
                            variant={props.actionVariant ?? "outlined"}
                            color={props.actionColor}
                            prependIcon={props.actionIcon}
                            loading={props.actionLoading}
                            onClick={() => emit?.("action")}
                        >
                            {props.actionLabel}
                        </PgButton>
                    )}
                </div>
            )}
        </div>
    ),
    {
        props: {
            title: { type: String, default: "" },
            description: { type: String, default: "" },
            icon: { type: String, default: "mdi-inbox-outline" },
            actionLabel: { type: String, default: "" },
            actionVariant: { type: String, default: "outlined" },
            actionColor: { type: String, default: "" },
            actionIcon: { type: String, default: "" },
            actionLoading: { type: Boolean, default: false },
            compact: { type: Boolean, default: false },
        },
        emits: ["action"],
        slots: ["default", "icon", "actions"],
        inheritAttrs: true,
    },
);

export const EmptyState = PgEmptyState;

export type SkeletonVariant = "text" | "heading" | "rect" | "circle" | "metric" | "row" | "chart";

const SKELETON_VARIANTS: ReadonlySet<string> = new Set([
    "text",
    "heading",
    "rect",
    "circle",
    "metric",
    "row",
    "chart",
]);

const DEFAULT_HEIGHT: Record<SkeletonVariant, string> = {
    text: "14px",
    heading: "22px",
    rect: "80px",
    circle: "36px",
    metric: "84px",
    row: "44px",
    chart: "260px",
};

/** Shimmer skeleton block for cards, tables, KPI strips and charts. */
export const PgSkeleton = dc(
    (
        props: {
            variant?: SkeletonVariant | string;
            width?: string;
            height?: string;
            count?: number;
            lines?: number;
            radius?: string;
        },
        _expose,
        { attrs },
    ) => {
        const variant = (): SkeletonVariant =>
            SKELETON_VARIANTS.has(String(props.variant)) ? (props.variant as SkeletonVariant) : "text";
        const count = (): number => Math.max(1, Number(props.count ?? props.lines ?? 1) || 1);

        return () => {
            const currentVariant = variant();
            const total = count();
            return (
                <div class={["pg-skeleton-stack", attrs.class].filter(Boolean).join(" ")} aria-hidden="true" aria-busy="true">
                    {Array.from({ length: total }, (_, index) => {
                        const last = index === total - 1;
                        const width =
                            props.width ||
                            (currentVariant === "text" && total > 1 && last
                                ? "72%"
                                : currentVariant === "circle"
                                  ? "36px"
                                  : "100%");
                        const height = props.height || DEFAULT_HEIGHT[currentVariant];
                        return (
                            <span
                                key={index}
                                class={[
                                    "pg-skeleton",
                                    "pg-skeleton__bar",
                                    `pg-skeleton--${currentVariant}`,
                                    currentVariant === "text" && total > 1 && last ? "pg-skeleton__bar--last" : "",
                                ]
                                    .filter(Boolean)
                                    .join(" ")}
                                style={{ width, height, borderRadius: props.radius }}
                                aria-hidden="true"
                            />
                        );
                    })}
                </div>
            );
        };
    },
    {
        props: {
            variant: { type: String, default: "text" },
            width: { type: String, default: "" },
            height: { type: String, default: "" },
            count: { type: Number, default: undefined },
            lines: { type: Number, default: 1 },
            radius: { type: String, default: "" },
        },
        inheritAttrs: true,
    },
);
