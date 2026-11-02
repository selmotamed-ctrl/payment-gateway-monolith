import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { VAlert, VCheckbox, VSelect, VTextField, VTextarea } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import type { MerchantDetail, MerchantSummary } from "../types";

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
const EDIT_CHECKS = [
    { key: "PATCH_REVIEWED", label: "Proposed changes reviewed" },
    { key: "SOURCE_DOCUMENT_VERIFIED", label: "Source document verified" },
    { key: "MAKER_REASON_DOCUMENTED", label: "Maker reason documented" },
    { key: "CHECKER_SCOPE_CONFIRMED", label: "Checker scope confirmed" },
] as const;

export type MerchantEditMode = "DESCRIPTIVE" | "SENSITIVE";

type EditForm = {
    tradeName: string;
    displayName: string;
    logoUrl: string;
    supportEmail: string;
    supportPhone: string;
    legalName: string;
    taxId: string;
    registrationNo: string;
    businessCategory: string;
    riskTier: string;
    kybStatus: string;
    commissionReceivableCeiling: string;
    negativeBalanceCeiling: string;
    contactEmail: string;
    contactPhone: string;
    payoutBankName: string;
    payoutAccount: string;
    payoutHolder: string;
    reason: string;
};

const asText = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
const clean = (value: string): string | undefined => (value.trim().length > 0 ? value.trim() : undefined);
const nullable = (value: string): string | null => (value.trim().length > 0 ? value.trim() : null);

const emptyForm = (): EditForm => ({
    tradeName: "",
    displayName: "",
    logoUrl: "",
    supportEmail: "",
    supportPhone: "",
    legalName: "",
    taxId: "",
    registrationNo: "",
    businessCategory: "",
    riskTier: "STANDARD",
    kybStatus: "PENDING",
    commissionReceivableCeiling: "",
    negativeBalanceCeiling: "0",
    contactEmail: "",
    contactPhone: "",
    payoutBankName: "",
    payoutAccount: "",
    payoutHolder: "",
    reason: "",
});

const MerchantEditDialog = dc(
    (props: {
        open: boolean;
        mode: MerchantEditMode;
        merchant: MerchantDetail | MerchantSummary | null;
        onUpdate: (open: boolean) => void;
        onDone: () => void;
    }) => {
        const { t } = useLocale();
        const showChecklists = areChecklistsVisible();
        const form = ref<EditForm>(emptyForm());
        const original = ref<EditForm>(emptyForm());
        const error = ref<string | null>(null);
        const saving = ref(false);
        const checklist = ref<Record<string, boolean>>({});
        const isDescriptive = computed(() => props.mode === "DESCRIPTIVE");

        const formFromMerchant = (merchant: MerchantDetail | MerchantSummary): EditForm => {
            const payout = merchant.payoutBankDetailsJson ?? {};
            return {
                tradeName: merchant.tradeName ?? "",
                displayName: merchant.displayName ?? "",
                logoUrl: merchant.logoUrl ?? "",
                supportEmail: merchant.supportEmail ?? "",
                supportPhone: merchant.supportPhone ?? "",
                legalName: merchant.legalName ?? "",
                taxId: merchant.taxId ?? "",
                registrationNo: merchant.registrationNo ?? "",
                businessCategory: merchant.businessCategory ?? "",
                riskTier: merchant.riskTier ?? "STANDARD",
                kybStatus: merchant.kybStatus ?? "PENDING",
                commissionReceivableCeiling: asText(merchant.commissionReceivableCeiling),
                negativeBalanceCeiling: asText(merchant.negativeBalanceCeiling ?? "0"),
                contactEmail: merchant.contactEmail ?? "",
                contactPhone: merchant.contactPhone ?? "",
                payoutBankName: asText(payout.bank ?? payout.bankName),
                payoutAccount: asText(payout.iban ?? payout.accountNumber ?? payout.account),
                payoutHolder: asText(payout.holder ?? payout.accountHolder),
                reason: "",
            };
        };

        watch(
            () => [props.open, props.mode, props.merchant?.id] as const,
            ([open]) => {
                if (!open || !props.merchant) return;
                form.value = formFromMerchant(props.merchant);
                original.value = formFromMerchant(props.merchant);
                checklist.value = {};
                error.value = null;
            },
            { immediate: true },
        );

        const buildPatch = () => {
            const patch: Array<{ op: "replace"; path: string; value: unknown }> = [];
            const add = (field: keyof EditForm, value: unknown) => {
                if (asText(original.value[field]) !== asText(value)) {
                    patch.push({ op: "replace", path: `/${field}`, value });
                }
            };
            add("legalName", form.value.legalName.trim());
            add("taxId", nullable(form.value.taxId));
            add("registrationNo", nullable(form.value.registrationNo));
            add("businessCategory", nullable(form.value.businessCategory));
            add("riskTier", form.value.riskTier);
            add("kybStatus", form.value.kybStatus);
            add("commissionReceivableCeiling", nullable(form.value.commissionReceivableCeiling));
            add("negativeBalanceCeiling", form.value.negativeBalanceCeiling.trim() || "0");
            add("contactEmail", nullable(form.value.contactEmail));
            add("contactPhone", nullable(form.value.contactPhone));
            const originalPayout = (props.merchant?.payoutBankDetailsJson ?? {}) as Record<string, unknown>;
            const originalBank = asText(originalPayout.bank ?? originalPayout.bankName);
            const originalAccount = asText(originalPayout.iban ?? originalPayout.accountNumber ?? originalPayout.account);
            const originalHolder = asText(originalPayout.holder ?? originalPayout.accountHolder);
            if (
                form.value.payoutBankName.trim() !== originalBank
                || form.value.payoutAccount.trim() !== originalAccount
                || form.value.payoutHolder.trim() !== originalHolder
            ) {
                patch.push({
                    op: "replace",
                    path: "/payoutBankDetailsJson",
                    value: {
                        ...originalPayout,
                        bank: form.value.payoutBankName.trim(),
                        iban: form.value.payoutAccount.trim(),
                        holder: form.value.payoutHolder.trim(),
                    },
                });
            }
            return patch;
        };

        const checklistComplete = computed(() => !showChecklists || EDIT_CHECKS.every((check) => checklist.value[check.key] === true));

        const submit = async () => {
            if (!props.merchant) return;
            error.value = null;
            if (props.mode === "SENSITIVE" && form.value.reason.trim().length < 3) {
                error.value = t("A maker reason is required for a sensitive change");
                return;
            }
            if (props.mode === "SENSITIVE" && !checklistComplete.value) {
                error.value = t("Complete all edit checklist items before submitting");
                return;
            }
            saving.value = true;
            try {
                if (props.mode === "DESCRIPTIVE") {
                    await api.patch(urlsMap.merchantDescriptive(props.merchant.id), {
                        tradeName: clean(form.value.tradeName),
                        displayName: clean(form.value.displayName),
                        logoUrl: clean(form.value.logoUrl),
                        supportEmail: clean(form.value.supportEmail),
                        supportPhone: clean(form.value.supportPhone),
                        reason: clean(form.value.reason),
                        baseVersion: props.merchant.version,
                    });
                    showSnackBar({ type: "success", message: t("Descriptive fields updated") });
                } else {
                    const patch = buildPatch();
                    if (patch.length === 0) {
                        error.value = t("No sensitive field changed");
                        return;
                    }
                    await api.post(urlsMap.merchantProposeEdit(props.merchant.id), {
                        reason: form.value.reason.trim(),
                        patch,
                        baseVersion: props.merchant.version,
                        checklist: EDIT_CHECKS.filter((check) => checklist.value[check.key]).map((check) => check.key),
                    });
                    showSnackBar({ type: "success", message: t("Sensitive change submitted for checker approval") });
                }
                props.onUpdate(false);
                props.onDone();
            } catch (cause) {
                error.value = extractApiErrorMessage(cause);
            } finally {
                saving.value = false;
            }
        };

        return () => (
            <FormModal
                modelValue={props.open}
                onUpdate:modelValue={(value: boolean) => props.onUpdate(value)}
                title={isDescriptive.value ? t("Edit descriptive fields") : t("Propose sensitive change")}
                size="lg"
                onSubmit={() => void submit()}
                submitLabel={isDescriptive.value ? t("Save descriptive fields") : t("Submit for approval")}
                cancelLabel={t("Cancel")}
                loading={saving.value}
                errorMessage={error.value ?? ""}
            >
<ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                            {props.merchant?.tradeName} · v{props.merchant?.version}
                        </ThemedText>
                        {isDescriptive.value ? (
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "12px" }}>
                                <FormField label={t("Trade name")}>
                                    <VTextField v-model={form.value.tradeName} />
                                </FormField>
                                <FormField label={t("Display name")}>
                                    <VTextField v-model={form.value.displayName} />
                                </FormField>
                                <FormField label={t("Logo URL")}>
                                    <VTextField v-model={form.value.logoUrl} />
                                </FormField>
                                <FormField label={t("Support email")}>
                                    <VTextField v-model={form.value.supportEmail} />
                                </FormField>
                                <FormField label={t("Support phone")}>
                                    <VTextField v-model={form.value.supportPhone} />
                                </FormField>
                            </div>
                        ) : (
                            <>
                                <VAlert type="info" variant="tonal">
                                    {t("Legal/tax/payout/risk/KYB/ceiling fields are sensitive. The current value stays active until an independent checker executes the change.")}
                                </VAlert>
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "12px" }}>
                                    <FormField label={t("Legal name")} sensitiveMakerChecker>
                                        <VTextField v-model={form.value.legalName} />
                                    </FormField>
                                    <FormField label={t("Tax ID")} sensitiveMakerChecker>
                                        <VTextField v-model={form.value.taxId} />
                                    </FormField>
                                    <FormField label={t("Registration number")} sensitiveMakerChecker>
                                        <VTextField v-model={form.value.registrationNo} />
                                    </FormField>
                                    <FormField label={t("Business category")} sensitiveMakerChecker>
                                        <VTextField v-model={form.value.businessCategory} />
                                    </FormField>
                                    <FormField label={t("Risk tier")} sensitiveMakerChecker>
                                        <VSelect v-model={form.value.riskTier} items={["LOW", "STANDARD", "HIGH"]} />
                                    </FormField>
                                    <FormField label={t("KYB status override")} sensitiveMakerChecker>
                                        <VSelect v-model={form.value.kybStatus} items={["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"]} />
                                    </FormField>
                                    <FormField label={t("Commission receivable ceiling")} sensitiveMakerChecker>
                                        <VTextField v-model={form.value.commissionReceivableCeiling} />
                                    </FormField>
                                    <FormField label={t("Negative balance ceiling")} sensitiveMakerChecker>
                                        <VTextField v-model={form.value.negativeBalanceCeiling} />
                                    </FormField>
                                    <FormField label={t("Contact email")} sensitiveMakerChecker>
                                        <VTextField v-model={form.value.contactEmail} />
                                    </FormField>
                                    <FormField label={t("Contact phone")} sensitiveMakerChecker>
                                        <VTextField v-model={form.value.contactPhone} />
                                    </FormField>
                                    <FormField label={t("Payout bank")} sensitiveMakerChecker>
                                        <VTextField v-model={form.value.payoutBankName} />
                                    </FormField>
                                    <FormField label={t("Payout account / IBAN")} sensitiveMakerChecker>
                                        <VTextField v-model={form.value.payoutAccount} />
                                    </FormField>
                                    <FormField label={t("Payout account holder")} sensitiveMakerChecker>
                                        <VTextField v-model={form.value.payoutHolder} />
                                    </FormField>
                                </div>
                            </>
                        )}
                        {showChecklists && !isDescriptive.value && (
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Edit checklist")}</ThemedText>
                                {EDIT_CHECKS.map((check) => (
                                    <VCheckbox
                                        key={check.key}
                                        modelValue={checklist.value[check.key] === true}
                                        onUpdate:modelValue={(value: unknown) => (checklist.value = { ...checklist.value, [check.key]: Boolean(value) })}
                                        label={t(check.label)}
                                        density="compact"
                                        hideDetails
                                    />
                                ))}
                                {!checklistComplete.value && (
                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all edit checklist items before submitting")}</ThemedText>
                                )}
                            </ThemedView>
                        )}
                        <FormField label={isDescriptive.value ? t("Change note (optional)") : t("Maker reason (required)")} required={!isDescriptive.value}>
                            <VTextarea v-model={form.value.reason} rows={3} autoGrow />
                        </FormField>
            </FormModal>
        );
    },
    { props: ["open", "mode", "merchant", "onUpdate", "onDone"] },
);

export default MerchantEditDialog;
