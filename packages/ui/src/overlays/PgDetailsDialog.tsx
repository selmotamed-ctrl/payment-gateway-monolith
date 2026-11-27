import { ref } from "vue";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { PgFormModal } from "./PgFormModal";
import { PgButton } from "../actions/PgButton";
import { PgDescriptionList, type PgDescriptionItem } from "../data/PgDescriptionList";
import { PgMonoRef } from "../data/PgMonoRef";
import { PgMoneyText } from "../data/PgMoneyText";
import { PgStatusBadge } from "../feedback/PgStatusBadge";
import type { PgFieldItem } from "../data/PgField";

type DetailSection = { title?: string; description?: string; fields: Array<PgFieldItem & { hint?: string; source?: string }> };
type DetailDialogProps = { title: string; sections?: DetailSection[]; slot?: (props: { close: () => void }) => any };

const REF_SUFFIXES = new Set(["id", "ref", "reference", "hash", "code", "key"]);
const MONEY_SUFFIXES = new Set(["amount", "fee", "balance", "ceiling"]);
const STATUS_FIELDS = new Set(["status", "state", "kybstatus", "risktier", "healthstate"]);

const normalize = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.\-/]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
const lastWord = (text: string) => {
    const words = normalize(text).split(" ");
    return words[words.length - 1] ?? "";
};
const hasValue = (value: any) => value !== null && value !== undefined && String(value).trim() !== "";

/**
 * Read-only detail dialog used by every "view details" action. It formats
 * statuses, references, money and copy fields consistently, so callers only pass
 * `{ title, sections }`.
 */
export const PgDetailsDialog = dc<Record<string, any>, { show(options: DetailDialogProps): void }>((_props, expose) => {
    const { t } = useLocale();
    const visible = ref(false);
    const title = ref("");
    const sections = ref<DetailSection[]>([]);
    const content = ref<((props: { close: () => void }) => any) | null>(null);
    const close = () => (visible.value = false);

    expose?.({
        show(options: DetailDialogProps) {
            title.value = options.title;
            sections.value = options.sections ?? [];
            content.value = options.slot ?? null;
            visible.value = true;
        },
    });

    const renderValue = (field: DetailSection["fields"][number]) => {
        if (!hasValue(field.value)) return "—";
        if (field.onClick) {
            return (
                <PgButton variant="text" size="sm" onClick={() => void field.onClick?.()}>
                    {t(String(field.value))}
                </PgButton>
            );
        }
        const compact = normalize(field.text).replace(/\s+/g, "");
        const word = lastWord(field.text);
        if (STATUS_FIELDS.has(compact) || word === "status" || word === "state") return <PgStatusBadge status={String(field.value)} />;
        if (REF_SUFFIXES.has(word)) return <PgMonoRef value={String(field.value)} />;
        if (MONEY_SUFFIXES.has(word)) {
            const raw = String(field.value).trim();
            const currency = raw.match(/\b([A-Z]{3})\b/)?.[1];
            const cleaned = raw.replace(/,/g, "").replace(/\b[A-Z]{3}\b/g, "").trim();
            return <PgMoneyText amount={/^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : raw} currency={currency} />;
        }
        if (field.copyOnClick) return <PgMonoRef value={String(field.value)} />;
        return t(String(field.value));
    };

    return () => (
        <PgFormModal
            modelValue={visible.value}
            onUpdate:modelValue={(value: boolean) => (visible.value = value)}
            title={title.value ? t(title.value) : t("Details")}
            size="lg"
            v-slots={{
                footer: () => (
                    <PgButton variant="outlined" onClick={close}>
                        {t("Close")}
                    </PgButton>
                ),
            }}
        >
            <div class="pg-stack pg-stack--lg">
                {sections.value.map((section, index) =>
                    section.fields?.length ? (
                        <section key={`${section.title ?? "section"}-${index}`} class="pg-stack">
                            {section.title && <h3 class="pg-section-title">{t(section.title)}</h3>}
                            {section.description && <p class="pg-section-description">{t(section.description)}</p>}
                            <PgDescriptionList
                                columns={2}
                                items={section.fields.map<PgDescriptionItem>((field) => ({
                                    label: t(field.text || ""),
                                    value: renderValue(field),
                                }))}
                            />
                        </section>
                    ) : null,
                )}
                {content.value?.({ close })}
            </div>
        </PgFormModal>
    );
});

export const DetailsFieldsDialog = PgDetailsDialog;
export default PgDetailsDialog;
