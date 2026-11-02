import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VCard, VCardText, VCheckbox, VDialog, VSelect, VSwitch, VTextField, VTextarea } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { CLOSE_REASONS, SUSPENSION_REASONS } from "../merchantHelp";
import type { MerchantSummary } from "../types";

const SUSPEND_CHECKS = [
    { key: "IMPACT_REVIEWED", label: "Merchant impact reviewed" },
    { key: "REASON_DOCUMENTED", label: "Suspension reason documented" },
    { key: "NOTIFICATION_PLANNED", label: "Merchant notification planned" },
    { key: "WALLET_DISPUTE_CHECKED", label: "Wallet and open disputes checked" },
] as const;

const REINSTATE_CHECKS = [
    { key: "COMPLIANCE_CLEARANCE_VERIFIED", label: "Compliance clearance verified" },
    { key: "OUTSTANDING_ITEMS_RESOLVED", label: "Outstanding items resolved" },
    { key: "WALLET_DISPUTE_CHECKED", label: "Wallet and open disputes checked" },
    { key: "REASON_DOCUMENTED", label: "Reinstatement reason documented" },
] as const;

const CLOSE_CHECKS = [
    { key: "BALANCE_ZERO_VERIFIED", label: "Zero wallet balance verified" },
    { key: "OPEN_DISPUTES_CLEARED", label: "Open disputes cleared" },
    { key: "CASHOUTS_CLEARED", label: "Pending cash-outs cleared" },
    { key: "IRREVERSIBLE_ACKNOWLEDGED", label: "Irreversible closure acknowledged" },
] as const;

export type MerchantActionMode = "SUSPEND" | "REINSTATE" | "CLOSE";

const MerchantActionDialog = dc(
    (props: {
        open: boolean;
        mode: MerchantActionMode;
        merchant: MerchantSummary | null;
        onUpdate: (open: boolean) => void;
        onDone: () => void;
    }) => {
        const { t } = useLocale();
        const reasonCode = ref("MERCHANT_REQUEST");
        const notes = ref("");
        const emergency = ref(false);
        const ratifyHours = ref("24");
        const error = ref<string | null>(null);
        const saving = ref(false);
        const checklist = ref<Record<string, boolean>>({});
        const isClose = computed(() => props.mode === "CLOSE");
        const isSuspend = computed(() => props.mode === "SUSPEND");
        const title = computed(() =>
            props.mode === "SUSPEND" ? t("Suspend merchant") : props.mode === "REINSTATE" ? t("Reinstate merchant") : t("Close merchant"),
        );

        watch(
            () => [props.open, props.mode, props.merchant?.id] as const,
            ([open]) => {
                if (!open) return;
                reasonCode.value = props.mode === "CLOSE" ? "MERCHANT_REQUEST" : "OTHER";
                notes.value = "";
                emergency.value = false;
                ratifyHours.value = "24";
                checklist.value = {};
                error.value = null;
            },
            { immediate: true },
        );

        const checks = computed(() =>
            props.mode === "SUSPEND"
                ? SUSPEND_CHECKS
                : props.mode === "REINSTATE"
                  ? REINSTATE_CHECKS
                  : props.mode === "CLOSE"
                    ? CLOSE_CHECKS
                    : [],
        );
        const checklistComplete = computed(() => checks.value.every((check) => checklist.value[check.key] === true));

        const submit = async () => {
            if (!props.merchant) return;
            if (props.mode === "REINSTATE" && notes.value.trim().length < 3) {
                error.value = t("A reinstatement reason is required");
                return;
            }
            if (!checklistComplete.value) {
                error.value = t("Complete all checklist items before continuing");
                return;
            }
            saving.value = true;
            error.value = null;
            try {
                if (props.mode === "SUSPEND") {
                    await api.post(urlsMap.merchantSuspend(props.merchant.id), {
                        reasonCode: reasonCode.value,
                        notes: notes.value.trim() || undefined,
                        emergency: emergency.value,
                        ratifyWithinHours: emergency.value ? Number(ratifyHours.value) || 24 : undefined,
                        baseVersion: props.merchant.version,
                        checklist: checks.value.filter((check) => checklist.value[check.key]).map((check) => check.key),
                    });
                } else if (props.mode === "REINSTATE") {
                    await api.post(urlsMap.merchantReinstate(props.merchant.id), {
                        reason: notes.value.trim(),
                        baseVersion: props.merchant.version,
                        checklist: checks.value.filter((check) => checklist.value[check.key]).map((check) => check.key),
                    });
                } else {
                    await api.post(urlsMap.merchantClose(props.merchant.id), {
                        reasonCode: reasonCode.value,
                        notes: notes.value.trim() || undefined,
                        baseVersion: props.merchant.version,
                        checklist: checks.value.filter((check) => checklist.value[check.key]).map((check) => check.key),
                    });
                }
                props.onUpdate(false);
                showSnackBar({
                    type: "success",
                    message: emergency.value
                        ? t("Emergency suspension applied; a checker must ratify it")
                        : t(`${title.value} requested`),
                });
                props.onDone();
            } catch (cause) {
                error.value = extractApiErrorMessage(cause);
            } finally {
                saving.value = false;
            }
        };

        return () => (
            <VDialog modelValue={props.open} onUpdate:modelValue={(value: boolean) => props.onUpdate(value)} maxWidth="640px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{title.value}</ThemedText>
                        <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                            {props.merchant?.tradeName} · {props.merchant?.status}
                        </ThemedText>
                        {isSuspend.value && (
                            <>
                                <VSelect v-model={reasonCode.value} label={t("Reason code")} items={SUSPENSION_REASONS} />
                                <VSwitch v-model={emergency.value} label={t("Emergency suspension (immediate effect)")} color="error" hideDetails />
                                {emergency.value && (
                                    <>
                                        <VAlert type="warning" variant="tonal">
                                            {t("The suspension takes effect now. A compliance or MLRO checker must ratify it within the selected window; it remains in force if ratification is rejected.")}
                                        </VAlert>
                                        <VTextField v-model={ratifyHours.value} label={t("Ratify within hours")} type="number" />
                                    </>
                                )}
                            </>
                        )}
                        {isClose.value && (
                            <>
                                <VAlert type="error" variant="tonal">
                                    {t("Closing is irreversible and requires zero wallet balance, no open disputes and no pending cash-outs.")}
                                </VAlert>
                                <VSelect v-model={reasonCode.value} label={t("Reason code")} items={CLOSE_REASONS} />
                            </>
                        )}
                        {checks.value.length > 0 && (
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Action checklist")}</ThemedText>
                                {checks.value.map((check) => (
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
                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all checklist items before continuing")}</ThemedText>
                                )}
                            </ThemedView>
                        )}
                        <VTextarea
                            v-model={notes.value}
                            label={props.mode === "REINSTATE" ? t("Reinstatement reason") : t("Notes")}
                            rows={4}
                            autoGrow
                        />
                        {error.value && <VAlert type="error" variant="tonal">{error.value}</VAlert>}
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                            <VBtn variant="text" onClick={() => props.onUpdate(false)}>{t("Cancel")}</VBtn>
                            <VBtn color={props.mode === "REINSTATE" ? "success" : "error"} loading={saving.value} disabled={!checklistComplete.value} onClick={() => void submit()}>
                                {props.mode === "REINSTATE" ? t("Request reinstatement") : props.mode === "CLOSE" ? t("Request closure") : t("Request suspension")}
                            </VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>
        );
    },
    { props: ["open", "mode", "merchant", "onUpdate", "onDone"] },
);

export default MerchantActionDialog;
