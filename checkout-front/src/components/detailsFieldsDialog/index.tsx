import { dc } from "kt-dc";
import type { FieldProps } from "../Field";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import { FormModal } from "@/components/ui/FormModal";
import { DescriptionList, type DescriptionItem } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { StatusBadge } from "@/components/ui/StatusBadge";

type DetailField = FieldProps & {
    hint?: string;
    source?: string;
};

type DetailSection = {
    title?: string;
    description?: string;
    fields: DetailField[];
};

type DetailDialogProps = {
    title: string;
    sections?: DetailSection[];
    slot?: (props: { close: () => void }) => JSX.Element;
};

const REF_SUFFIXES = new Set(["id", "ref", "reference", "hash", "code", "key"]);
const MONEY_SUFFIXES = new Set(["amount", "fee", "balance", "ceiling"]);
const STATUS_FIELDS = new Set(["status", "state", "kybstatus", "risktier", "healthstate"]);

const normalizeFieldName = (text: string): string =>
    text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_.\-/]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

const lastWord = (text: string): string => {
    const normalized = normalizeFieldName(text);
    const index = normalized.lastIndexOf(" ");
    return index === -1 ? normalized : normalized.slice(index + 1);
};

const compactName = (text: string): string => normalizeFieldName(text).replace(/\s+/g, "");

const isRefField = (text: string): boolean => REF_SUFFIXES.has(lastWord(text));
const isMoneyField = (text: string): boolean => MONEY_SUFFIXES.has(lastWord(text));
const isStatusField = (text: string): boolean => {
    const compact = compactName(text);
    const word = lastWord(text);
    return STATUS_FIELDS.has(compact) || word === "status" || word === "state";
};

const hasValue = (value: FieldProps["value"]): boolean =>
    value !== null && value !== undefined && String(value).trim() !== "";

const normalizeMoney = (value: FieldProps["value"]): { amount: string | number; currency?: string } => {
    if (typeof value === "number") return { amount: value };
    const raw = String(value ?? "").trim();
    const currency = raw.match(/\b([A-Z]{3})\b/)?.[1];
    const cleaned = raw.replace(/,/g, "").replace(/\b[A-Z]{3}\b/g, "").trim();
    return {
        amount: /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : raw,
        currency,
    };
};

export const DetailsFieldsDialog = dc<
    {},
    {
        show: (props: DetailDialogProps) => void;
    }
>((_, expose) => {
    const shown = ref(false);
    const fields = ref<DetailSection[]>([]);
    const title = ref(null as null | string);
    const slot = ref(null as null | ((props: { close: () => void }) => JSX.Element));

    const close = () => {
        shown.value = false;
    };

    const show = (props: DetailDialogProps) => {
        title.value = props.title;
        fields.value = props.sections || [];
        shown.value = true;
        slot.value = props.slot || null;
    };

    expose({ show });

    const { t } = useLocale();

    const renderValue = (field: DetailField) => {
        if (!hasValue(field.value)) return "—";

        if (field.onClick) {
            return (
                <VBtn
                    variant="text"
                    size="small"
                    density="compact"
                    onClick={() => void field.onClick?.()}
                >
                    {t(String(field.value))}
                </VBtn>
            );
        }

        if (isStatusField(field.text)) {
            return <StatusBadge status={String(field.value)} />;
        }

        if (isRefField(field.text)) {
            return <MonoRef value={String(field.value)} copyable />;
        }

        if (isMoneyField(field.text)) {
            const money = normalizeMoney(field.value);
            return <MoneyDisplay amount={money.amount} currency={money.currency} />;
        }

        if (field.copyOnClick) {
            return <MonoRef value={String(field.value)} copyable />;
        }

        return t(String(field.value));
    };

    const sectionItems = (section: DetailSection): DescriptionItem[] =>
        (section.fields ?? []).map((field) => ({
            label: t(field.text || ""),
            value: renderValue(field),
        }));

    return () => (
        <FormModal
            modelValue={shown.value}
            onUpdate:modelValue={(value: boolean) => {
                shown.value = value;
            }}
            title={title.value ? t(title.value) : t("Details")}
            size="lg"
            v-slots={{
                footer: () => (
                    <VBtn variant="outlined" onClick={close}>
                        {t("Close")}
                    </VBtn>
                ),
            }}
        >
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                {fields.value.map((section, index) =>
                    section.fields?.length ? (
                        <section key={`${section.title ?? "section"}-${index}`} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                            {section.title && (
                                <h4 style={{ margin: 0, fontSize: "14px", fontWeight: 600, color: "var(--pg-ink-primary)" }}>
                                    {t(section.title)}
                                </h4>
                            )}
                            {section.description && (
                                <p style={{ margin: 0, fontSize: "12.5px", lineHeight: 1.5, color: "var(--pg-ink-muted)" }}>
                                    {t(section.description)}
                                </p>
                            )}
                            <DescriptionList
                                columns={2}
                                items={sectionItems(section)}
                                ariaLabel={section.title ? t(section.title) : undefined}
                            />
                        </section>
                    ) : null,
                )}
                {slot?.value?.({ close })}
            </div>
        </FormModal>
    );
});

export default DetailsFieldsDialog;
