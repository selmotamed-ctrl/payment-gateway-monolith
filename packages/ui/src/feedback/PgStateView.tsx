import { createIf } from "@vue/runtime-vapor";

/** The Vapor JSX return type is a Block at runtime; the public type is narrower. */
const branch = createIf as any;
import { createSlot } from "vue";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { PgButton } from "../actions/PgButton";
import { PgIcon } from "../actions/PgIcon";
import { PgSpinner } from "../actions/PgFeedbackAtoms";
import { PgCard } from "../layout/PgLayout";
import { PgEmptyState } from "./PgEmptyState";

/**
 * Extracts a human-readable message from the many shapes an API error can take
 * (Axios, fetch wrappers, core `{ error: { message } }` envelopes). It never
 * returns `[object Object]`.
 */
const extractErrorMessage = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value instanceof Error) return value.message || "";
    if (typeof value !== "object") return "";

    const record = value as Record<string, unknown>;
    for (const key of ["message", "detail", "error_description", "error", "reason"]) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.trim()) return candidate;
        if (candidate && typeof candidate === "object") {
            const nested = extractErrorMessage(candidate);
            if (nested) return nested;
        }
    }
    const data = record.data;
    if (data && typeof data === "object") {
        const nested = extractErrorMessage(data);
        if (nested) return nested;
    }
    return "";
};

const minHeightStyle = (value?: string | number) => {
    if (value === undefined || value === null || value === "") return undefined;
    return { minHeight: typeof value === "number" ? `${value}px` : String(value) };
};

/** Loading / error / empty / content switch used by every page. */
export const PgStateView = dc(
    (props: Record<string, any>, _expose, { attrs, emit, slots }) => {
        const { t } = useLocale();
        return () =>
            branch(
                () => Boolean(props.loading),
                () =>
                    slots.loading ? (
                        <>{createSlot("loading")}</>
                    ) : (
                        <PgLoadingScreen
                            label={props.loadingLabel}
                            minHeight={props.minHeight ?? "240px"}
                            fullScreen={Boolean(props.fullScreen)}
                        />
                    ),
                () =>
                    branch(
                        () => Boolean(props.error),
                        () =>
                            slots.error ? (
                                <>{createSlot("error")}</>
                            ) : (
                                <div
                                    class={["pg-state-view", "pg-state-view--error", attrs.class].filter(Boolean).join(" ")}
                                    role="alert"
                                    aria-live="assertive"
                                    aria-atomic="true"
                                    style={minHeightStyle(props.minHeight ?? "240px")}
                                >
                                    <PgCard noPadding class="pg-state-view__error-card">
                                        <div class="pg-state-view__error-body">
                                            <span class="pg-state-view__error-icon" aria-hidden="true">
                                                <PgIcon icon="mdi-alert-circle-outline" size={22} />
                                            </span>
                                            <div class="pg-state-view__title">
                                                {props.errorTitle || t("Something went wrong")}
                                            </div>
                                            {extractErrorMessage(props.error) ? (
                                                <div class="pg-state-view__message">{extractErrorMessage(props.error)}</div>
                                            ) : null}
                                            {branch(
                                                () => typeof props.onRetry === "function" || Boolean(attrs.onRetry),
                                                () => (
                                                    <PgButton
                                                        variant="tonal"
                                                        size="sm"
                                                        prependIcon="mdi-reload"
                                                        onClick={() => emit?.("retry")}
                                                    >
                                                        {props.retryLabel || t("Retry")}
                                                    </PgButton>
                                                ),
                                            )}
                                        </div>
                                    </PgCard>
                                </div>
                            ),
                        () =>
                            branch(
                                () => Boolean(props.empty),
                                () =>
                                    slots.empty ? (
                                        <>{createSlot("empty")}</>
                                    ) : (
                                        <div
                                            class="pg-state-view pg-state-view--empty"
                                            style={minHeightStyle(props.minHeight ?? "240px")}
                                        >
                                            <PgEmptyState
                                                title={props.emptyTitle || t("No Data Found")}
                                                description={props.emptyDescription}
                                                icon={props.emptyIcon ?? "mdi-inbox-outline"}
                                                actionLabel={props.emptyActionLabel}
                                                onAction={() => emit?.("emptyAction")}
                                            />
                                        </div>
                                    ),
                                () => <>{createSlot("default")}</>,
                            ),
                    ),
            );
    },
    {
        props: {
            loading: { type: Boolean, default: false },
            error: { default: "" },
            empty: { type: Boolean, default: false },
            emptyTitle: { type: String, default: "" },
            emptyDescription: { type: String, default: "" },
            emptyIcon: { type: String, default: "" },
            emptyActionLabel: { type: String, default: "" },
            errorTitle: { type: String, default: "" },
            loadingLabel: { type: String, default: "" },
            retryLabel: { type: String, default: "" },
            minHeight: { type: [String, Number], default: "" },
            fullScreen: { type: Boolean, default: false },
            onRetry: { type: Function as unknown as () => (() => void) | undefined, default: undefined },
        },
        emits: ["retry", "emptyAction"],
        slots: ["default", "loading", "error", "empty"],
        inheritAttrs: true,
    },
);

export const StateView = PgStateView;

/** Full-page loading surface. */
export const PgLoadingScreen = dc(
    (
        props: { label?: string; msg?: string; fullScreen?: boolean; minHeight?: string | number },
        _expose,
        { attrs },
    ) => {
        const { t } = useLocale();
        const label = () => props.label || props.msg || t("Loading");
        return () => (
            <div
                {...attrs}
                class={[
                    "pg-loading-screen",
                    props.fullScreen ? "pg-loading-screen--fullscreen" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
                role="status"
                aria-live="polite"
                aria-busy="true"
                style={props.fullScreen ? undefined : minHeightStyle(props.minHeight ?? "240px")}
            >
                <PgSpinner size={46} label={label()} />
                <span class="pg-loading-screen__label">{label()}</span>
            </div>
        );
    },
    {
        props: {
            label: { type: String, default: "" },
            msg: { type: String, default: "" },
            fullScreen: { type: Boolean, default: false },
            minHeight: { type: [String, Number], default: "" },
        },
        inheritAttrs: true,
    },
);

export const LoadingScreen = PgLoadingScreen;
