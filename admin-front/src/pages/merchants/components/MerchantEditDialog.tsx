import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { VAlert, VBtn, VCard, VCardText, VCheckbox, VDialog, VSelect, VTextField, VTextarea } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import type { MerchantDetail, MerchantSummary } from "../types";

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
            <VDialog modelValue={props.open} onUpdate:modelValue={(value: boolean) => props.onUpdate(value)} maxWidth="900px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                            {isDescriptive.value ? t("Edit descriptive fields") : t("Propose sensitive change")}
                        </ThemedText>
                        <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                            {props.merchant?.tradeName} · v{props.merchant?.version}
                        </ThemedText>
                        {isDescriptive.value ? (
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "12px" }}>
                                <VTextField v-model={form.value.tradeName} label={t("Trade name")} />
                                <VTextField v-model={form.value.displayName} label={t("Display name")} />
                                <VTextField v-model={form.value.logoUrl} label={t("Logo URL")} />
                                <VTextField v-model={form.value.supportEmail} label={t("Support email")} />
                                <VTextField v-model={form.value.supportPhone} label={t("Support phone")} />
                            </div>
                        ) : (
                            <>
                                <VAlert type="info" variant="tonal">
                                    {t("Legal/tax/payout/risk/KYB/ceiling fields are sensitive. The current value stays active until an independent checker executes the change.")}
                                </VAlert>
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "12px" }}>
                                    <VTextField v-model={form.value.legalName} label={t("Legal name")} />
                                    <VTextField v-model={form.value.taxId} label={t("Tax ID")} />
                                    <VTextField v-model={form.value.registrationNo} label={t("Registration number")} />
                                    <VTextField v-model={form.value.businessCategory} label={t("Business category")} />
                                    <VSelect v-model={form.value.riskTier} label={t("Risk tier")} items={["LOW", "STANDARD", "HIGH"]} />
                                    <VSelect v-model={form.value.kybStatus} label={t("KYB status override")} items={["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"]} />
                                    <VTextField v-model={form.value.commissionReceivableCeiling} label={t("Commission receivable ceiling")} />
                                    <VTextField v-model={form.value.negativeBalanceCeiling} label={t("Negative balance ceiling")} />
                                    <VTextField v-model={form.value.contactEmail} label={t("Contact email")} />
                                    <VTextField v-model={form.value.contactPhone} label={t("Contact phone")} />
                                    <VTextField v-model={form.value.payoutBankName} label={t("Payout bank")} />
                                    <VTextField v-model={form.value.payoutAccount} label={t("Payout account / IBAN")} />
                                    <VTextField v-model={form.value.payoutHolder} label={t("Payout account holder")} />
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
                        <VTextarea v-model={form.value.reason} label={isDescriptive.value ? t("Change note (optional)") : t("Maker reason (required)")} rows={3} autoGrow />
                        {error.value && <VAlert type="error" variant="tonal">{error.value}</VAlert>}
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                            <VBtn variant="text" onClick={() => props.onUpdate(false)}>{t("Cancel")}</VBtn>
                            <VBtn color="primary" loading={saving.value} disabled={!isDescriptive.value && !checklistComplete.value} onClick={() => void submit()}>
                                {isDescriptive.value ? t("Save descriptive fields") : t("Submit for approval")}
                            </VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>
        );
    },
    { props: ["open", "mode", "merchant", "onUpdate", "onDone"] },
);

export default MerchantEditDialog;
