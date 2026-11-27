import { computed, onBeforeUnmount, ref, watch } from "vue";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { PgDialog } from "./PgDialog";
import { PgFieldsSection, type PgFieldSection } from "../data/PgFieldsSection";
import type { PgFieldItem } from "../data/PgField";
import { PgSpinner } from "../actions/PgFeedbackAtoms";

type DetailSection = PgFieldSection & {
    fields: Array<PgFieldItem & { hint?: string; source?: string }>;
};

type DetailDialogOptions = {
    title?: string;
    subtitle?: string;
    sections?: DetailSection[];
    loading?: boolean;
    size?: string;
    slot?: (props: { close: () => void }) => any;
};

const REF_SUFFIXES = new Set(["id", "ref", "reference", "hash", "code", "key"]);

const normalize = (text: string) =>
    text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_.\-/]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

const lastWord = (text: string) => {
    const words = normalize(text).split(" ");
    return words[words.length - 1] ?? "";
};

const hasValue = (value: any) => value !== null && value !== undefined && String(value).trim() !== "";

/**
 * Read-only detail inspector used by every "view details" action.
 *
 * Sections render through `PgFieldsSection`/`PgField` (one hairline grid per
 * section). Empty sections are skipped rather than rendering blank cards, and
 * reference-like fields (id/ref/hash/code/key) become copy-to-clipboard fields.
 *
 * Supports both `v-model` with declarative props and the legacy imperative
 * `ref.show({ title, sections })` service used by `showDetails()`.
 */
export const PgDetailsDialog = dc<Record<string, any>, { show(options: DetailDialogOptions): Promise<boolean> }>(
    (props, expose, { emit, slots }) => {
        const { t } = useLocale();
        const visible = ref(Boolean(props.modelValue));
        const title = ref("");
        const subtitle = ref("");
        const sections = ref<DetailSection[]>([]);
        const loading = ref(false);
        const content = ref<((props: { close: () => void }) => any) | null>(null);
        let resolver: ((value: boolean) => void) | null = null;

        watch(
            () => props.modelValue,
            (value) => {
                if (value !== undefined) visible.value = Boolean(value);
            },
        );
        watch(
            () => props.title,
            (value) => {
                if (value) title.value = String(value);
            },
            { immediate: true },
        );
        watch(
            () => props.subtitle,
            (value) => {
                if (value) subtitle.value = String(value);
            },
            { immediate: true },
        );
        watch(
            () => props.sections,
            (value) => {
                if (Array.isArray(value)) sections.value = value as DetailSection[];
            },
            { immediate: true, deep: false },
        );
        watch(
            () => props.loading,
            (value) => {
                loading.value = Boolean(value);
            },
            { immediate: true },
        );

        const close = (notify = true) => {
            visible.value = false;
            resolver?.(false);
            resolver = null;
            content.value = null;
            if (notify) emit?.("update:modelValue", false);
        };

        expose?.({
            show(options: DetailDialogOptions = {}) {
                if (resolver) {
                    resolver(false);
                    resolver = null;
                }
                title.value = options.title ?? props.title ?? "";
                subtitle.value = options.subtitle ?? props.subtitle ?? "";
                sections.value = options.sections ?? [];
                loading.value = Boolean(options.loading ?? false);
                content.value = options.slot ?? null;
                visible.value = true;
                emit?.("update:modelValue", true);
                return new Promise<boolean>((resolve) => {
                    resolver = resolve;
                });
            },
        });

        onBeforeUnmount(() => {
            if (resolver) {
                resolver(false);
                resolver = null;
            }
        });

        const normalizedSections = computed<PgFieldSection[]>(() =>
            sections.value
                .filter((section) => Array.isArray(section.fields) && section.fields.length > 0)
                .map((section) => ({
                    title: section.title ? t(section.title) : undefined,
                    description: section.description ? t(section.description) : undefined,
                    defaultExpanded: section.defaultExpanded,
                    fields: section.fields.map<PgFieldItem>((field) => {
                        const word = lastWord(field.text || "");
                        const reference = REF_SUFFIXES.has(word) && hasValue(field.value);
                        return {
                            text: field.text,
                            value: hasValue(field.value) ? String(field.value) : null,
                            onClick: field.onClick,
                            copyOnClick: Boolean(field.copyOnClick || reference),
                            hint: field.hint,
                            source: field.source,
                        };
                    }),
                })),
        );

        const displayTitle = computed(() => t(title.value || props.title || "Details"));

        const dialogSlots: Record<string, any> = {
            default: () => (
                <div class="pg-details">
                    {loading.value ? (
                        <div class="pg-details__loading" role="status" aria-live="polite" aria-busy="true">
                            <PgSpinner size={36} />
                            <span>{t("Loading")}</span>
                        </div>
                    ) : (
                        <>
                            {normalizedSections.value.length > 0 && (
                                <PgFieldsSection sections={normalizedSections.value} class="pg-details__sections" />
                            )}
                            {content.value?.({ close })}
                            {!normalizedSections.value.length && !content.value && (
                                <p class="pg-details__empty">{t("No Data Found")}</p>
                            )}
                            {slots.default?.()}
                        </>
                    )}
                </div>
            ),
            footer: () => (
                <>
                    {slots.footer?.()}
                    <button type="button" class="pg-btn pg-btn--md pg-btn--outlined" onClick={() => close()}>
                        <span class="pg-btn__label">{t("Close")}</span>
                    </button>
                </>
            ),
        };
        if (slots.headerExtra) dialogSlots.headerActions = () => slots.headerExtra?.();

        return () => (
            <PgDialog
                modelValue={visible.value}
                onUpdate:modelValue={(value: boolean) => {
                    if (value) {
                        visible.value = true;
                        return;
                    }
                    close();
                }}
                title={displayTitle.value}
                subtitle={subtitle.value ? t(subtitle.value) : ""}
                size={props.size ?? "lg"}
                ariaLabel={displayTitle.value}
                class="pg-details-dialog"
            >
                {dialogSlots}
            </PgDialog>
        );
    },
    {
        props: {
            modelValue: { type: Boolean, default: false },
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            sections: { type: Array as () => DetailSection[], default: () => [] },
            loading: { type: Boolean, default: false },
            size: { type: String, default: "lg" },
        },
        emits: ["update:modelValue"],
        slots: ["default", "headerExtra", "footer"],
    },
);

export const DetailsFieldsDialog = PgDetailsDialog;
export default PgDetailsDialog;
