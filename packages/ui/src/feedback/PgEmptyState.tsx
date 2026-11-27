import { createSlot } from "vue";
import { dc } from "../lib/dc";
import { PgIcon } from "../actions/PgIcon";
import { PgButton } from "../actions/PgButton";

/** Calm empty state: icon tile, title, guidance and one CTA. */
export const PgEmptyState = dc(
    (props: Record<string, any>, _expose, { emit, slots }) => () => (
        <div class="pg-empty" role="status" aria-live="polite">
            <span class="pg-empty__icon" aria-hidden="true">
                <PgIcon icon={props.icon ?? "mdi-inbox-outline"} size={20} />
            </span>
            {props.title && <div class="pg-empty__title">{props.title}</div>}
            {props.description && <div class="pg-empty__description">{props.description}</div>}
            {createSlot("default")}
            {props.actionLabel && (
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
        },
        emits: ["action"],
        slots: ["default"],
    },
);

export const EmptyState = PgEmptyState;

/** Shimmer skeleton block for cards, tables and KPI strips. */
export const PgSkeleton = dc(
    (props: { width?: string; height?: string; radius?: string; lines?: number }, _expose, { attrs }) => () => (
        <div class={["pg-skeleton", attrs.class].filter(Boolean).join(" ")} aria-hidden="true">
            {props.lines && props.lines > 1
                ? Array.from({ length: props.lines }, (_, index) => (
                      <span
                          key={index}
                          class="pg-skeleton__bar"
                          style={{ width: index === props.lines! - 1 ? "62%" : "100%", height: props.height ?? "12px", borderRadius: props.radius }}
                      />
                  ))
                : (
                      <span
                          class="pg-skeleton__bar"
                          style={{ width: props.width ?? "100%", height: props.height ?? "16px", borderRadius: props.radius }}
                      />
                  )}
        </div>
    ),
    {
        props: {
            width: { type: String, default: "" },
            height: { type: String, default: "" },
            radius: { type: String, default: "" },
            lines: { type: Number, default: 1 },
        },
        inheritAttrs: true,
    },
);
