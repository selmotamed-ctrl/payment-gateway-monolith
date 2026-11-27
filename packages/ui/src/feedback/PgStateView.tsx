import { createIf } from "@vue/runtime-vapor";

/** The Vapor JSX return type is a Block at runtime; the public type is narrower. */
const branch = createIf as any;
import { createSlot } from "vue";
import { dc } from "../lib/dc";
import { PgButton } from "../actions/PgButton";
import { PgIcon } from "../actions/PgIcon";
import { PgSpinner } from "../actions/PgFeedbackAtoms";

/** Loading / error / empty / content switch used by every page. */
export const PgStateView = dc(
    (props: Record<string, any>, _expose, { slots }) => () =>
        branch(
            () => Boolean(props.loading),
            () => (
                <div class="pg-state-view" role="status" aria-live="polite" aria-busy="true" style={{ minHeight: props.minHeight ?? "240px" }}>
                    <PgSpinner size={44} />
                    <span class="pg-state-view__label">{props.loadingLabel ?? "Loading"}</span>
                </div>
            ),
            () =>
                branch(
                    () => Boolean(props.error),
                    () => (
                        <div class="pg-state-view" role="alert" aria-live="assertive" aria-atomic="true" style={{ minHeight: props.minHeight ?? "240px" }}>
                            <PgIcon icon="mdi-alert-circle-outline" size={36} color="error" />
                            <span class="pg-state-view__message">{props.error}</span>
                            {branch(
                                () => Boolean(props.onRetry),
                                () => (
                                    <PgButton variant="tonal" size="sm" prependIcon="mdi-reload" onClick={() => props.onRetry?.()}>
                                        {props.retryLabel ?? "Retry"}
                                    </PgButton>
                                ),
                            )}
                        </div>
                    ),
                    () =>
                        branch(
                            () => Boolean(props.empty),
                            () => (
                                <div class="pg-state-view pg-state-view--empty" role="status" aria-live="polite" style={{ minHeight: props.minHeight ?? "240px" }}>
                                    <PgIcon icon="mdi-inbox-outline" size={36} color="faint" />
                                    <span class="pg-state-view__title">{props.emptyTitle ?? "No Data Found"}</span>
                                    {branch(
                                        () => Boolean(props.emptyDescription),
                                        () => <span class="pg-state-view__message">{props.emptyDescription}</span>,
                                    )}
                                </div>
                            ),
                            () => <>{createSlot("default")}</>,
                        ),
                ),
        ),
    {
        props: {
            loading: { type: Boolean, default: false },
            error: { type: String, default: "" },
            empty: { type: Boolean, default: false },
            emptyTitle: { type: String, default: "" },
            emptyDescription: { type: String, default: "" },
            loadingLabel: { type: String, default: "" },
            retryLabel: { type: String, default: "" },
            minHeight: { type: String, default: "" },
            onRetry: { type: Function as unknown as () => (() => void) | undefined, default: undefined },
        },
        slots: ["default"],
    },
);

export const StateView = PgStateView;

/** Full-page loading surface. */
export const PgLoadingScreen = dc(
    (props: { msg?: string }, _expose, { attrs }) => () => (
        <div class={["pg-loading-screen", attrs.class].filter(Boolean).join(" ")} role="status" aria-live="polite">
            <PgSpinner size={46} />
            {props.msg && <span>{props.msg}…</span>}
        </div>
    ),
    { props: { msg: { type: String, default: "" } }, inheritAttrs: true },
);

export const LoadingScreen = PgLoadingScreen;
