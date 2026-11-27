import { createIf } from "@vue/runtime-vapor";

/** The Vapor JSX return type is a Block at runtime; the public type is narrower. */
const branch = createIf as any;
import { computed, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import { useFocusTrap, lockBodyScroll, useEscape } from "../lib/dom";
import { useLocale } from "../lib/locale";
import { PgIcon } from "../actions/PgIcon";

/**
 * Strict three-zone modal. The close button lives in the header's flex end slot
 * (never `position: absolute`), so it can never overlap the title, an input or a
 * badge. Header 20/24, body 24 with a 20px row gap, footer 16/24.
 */
export const PgDialog = dc(
    (props: Record<string, any>, _expose, { emit, slots }) => {
        const { t } = useLocale();
        const root = ref<HTMLElement | null>(null);
        const titleId = useId();
        const active = computed(() => Boolean(props.modelValue));
        let releaseScroll: (() => void) | null = null;

        watch(
            active,
            (open) => {
                if (open) releaseScroll = lockBodyScroll();
                else {
                    releaseScroll?.();
                    releaseScroll = null;
                }
            },
            { immediate: true },
        );
        useFocusTrap(root, active);
        useEscape(
            () => {
                if (props.persistent) return;
                emit?.("update:modelValue", false);
            },
            active,
        );

        const close = () => {
            if (props.persistent) return;
            emit?.("update:modelValue", false);
        };

        return () =>
            branch(
                () => active.value,
                () => {
                    const width = props.maxWidth ? `${props.maxWidth}px` : undefined;
                    return (
                        <div
                            class="pg-dialog-backdrop"
                            onPointerdown={(event: PointerEvent) => {
                                if (event.target === event.currentTarget) close();
                            }}
                        >
                            <div
                                ref={root}
                                class={["pg-dialog", `pg-dialog--${props.size ?? "md"}`, props.class]}
                                role={props.role ?? "dialog"}
                                aria-modal="true"
                                aria-labelledby={props.title ? titleId : undefined}
                                aria-label={!props.title ? props.ariaLabel : undefined}
                                tabindex={-1}
                                style={[{ width: width ? `min(100%, ${width})` : undefined }, props.style]}
                            >
                                {(props.title || props.subtitle || slots.header) && (
                                    <div class="pg-dialog__header">
                                        <div class="pg-dialog__heading">
                                            {props.title && (
                                                <h2 id={titleId} class="pg-dialog__title">
                                                    {props.title}
                                                </h2>
                                            )}
                                            {props.subtitle && <p class="pg-dialog__subtitle">{props.subtitle}</p>}
                                            {slots.header?.()}
                                        </div>
                                        {slots.headerActions?.()}
                                        {props.showClose !== false && (
                                            <button
                                                type="button"
                                                class="pg-dialog__close pg-icon-btn"
                                                aria-label={t("Close")}
                                                disabled={props.persistent}
                                                onClick={close}
                                            >
                                                <PgIcon icon="mdi-close" size={18} />
                                            </button>
                                        )}
                                    </div>
                                )}
                                <div class="pg-dialog__body">{slots.default?.()}</div>
                                {slots.footer && <div class="pg-dialog__footer">{slots.footer()}</div>}
                            </div>
                        </div>
                    );
                },
            );
        },
    {
        props: {
            modelValue: { type: Boolean, default: false },
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            size: { type: String, default: "md" },
            maxWidth: { type: [Number, String], default: undefined },
            persistent: { type: Boolean, default: false },
            showClose: { type: Boolean, default: true },
            role: { type: String, default: "dialog" },
            ariaLabel: { type: String, default: "" },
        },
        emits: ["update:modelValue"],
    },
);

export const VDialog = PgDialog;
