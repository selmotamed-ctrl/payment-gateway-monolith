import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import {
    VAlert,
    VBtn,
    VCard,
    VCardText,
    VDialog,
    VTextField,
    VTextarea,
} from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import FieldsSections from "@/components/FieldsSections";
import type { FieldProps } from "@/components/Field";
import { ApiTable } from "@/components/Table/ApiTable";
import type { TableHeader } from "@/components/Table/types";
import { statusTone } from "@/components/Table/statusTone";
import { api } from "@/state/api";
import { hasOneOfAuthorities, user } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import {
    COLUMN_HELP,
    formatDateTime,
    formatMoney,
    kybStatusHelp,
    merchantStatusHelp,
    riskHelp,
} from "./merchantHelp";
import type { MerchantDetail, MerchantDetailChange, MerchantPendingChange, MerchantSummary } from "./types";
import MerchantHelpPanel from "./components/MerchantHelpPanel";
import MerchantActionDialog, { type MerchantActionMode } from "./components/MerchantActionDialog";
import MerchantEditDialog, { type MerchantEditMode } from "./components/MerchantEditDialog";

const parse = (payload: unknown): MerchantDetail => {
    const source = (payload ?? {}) as Record<string, unknown>;
    return (source.merchant ?? source) as MerchantDetail;
};

const field = (text: string, value: unknown, hint?: string, source?: string, copy = false): FieldProps => ({
    text,
    value: value === null || value === undefined ? "" : String(value),
    hint,
    source,
    copyOnClick: copy,
});

const jsonText = (value: unknown): string => {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
};

const MerchantDetailPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const merchant = ref<MerchantDetail | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const actionOpen = ref(false);
    const actionMode = ref<MerchantActionMode>("SUSPEND");
    const editOpen = ref(false);
    const editMode = ref<MerchantEditMode>("DESCRIPTIVE");
    const withdrawOpen = ref(false);
    const withdrawTarget = ref<MerchantPendingChange | null>(null);
    const withdrawReason = ref("");
    const historyOpen = ref(false);
    const historyRefreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    const historyPageSize = ref(25);

    const merchantId = computed(() => String(route.params.id ?? ""));
    const currentUserId = computed(() => user.value?.userInfo?.id ?? null);
    const isSupport = computed(() => user.value?.userInfo.role === "SUPPORT");
    const canWrite = computed(() => !isSupport.value && hasOneOfAuthorities(["merchant:write"]));
    const canFinancial = computed(() => !isSupport.value && hasOneOfAuthorities(["merchant:write", "finance:read", "finance:write"]));
    const canAml = computed(() => !isSupport.value && hasOneOfAuthorities(["aml.read_confidential", "aml.review", "aml:read", "compliance:read"]));
    const statusHelp = computed(() => merchantStatusHelp(merchant.value?.status ?? ""));
    const balance = computed(() => merchant.value?.walletBalance?.balance ?? null);
    const currency = computed(() => merchant.value?.walletBalance?.wallets?.[0]?.currency ?? "LYD");

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.merchantDetail(merchantId.value));
            merchant.value = parse(response.data?.data ?? response.data ?? {});
        } catch (cause) {
            error.value = extractApiErrorMessage(cause);
            merchant.value = null;
        } finally {
            loading.value = false;
        }
    };

    watch(merchantId, () => void load());
    void load();

    const openAction = (mode: MerchantActionMode) => {
        actionMode.value = mode;
        actionOpen.value = true;
    };

    const openEdit = (mode: MerchantEditMode) => {
        editMode.value = mode;
        editOpen.value = true;
    };

    const openWithdraw = (change: MerchantPendingChange) => {
        withdrawTarget.value = change;
        withdrawReason.value = "";
        withdrawOpen.value = true;
    };

    const withdraw = async () => {
        if (!withdrawTarget.value) return;
        try {
            await api.post(urlsMap.merchantWithdrawChange(merchantId.value, withdrawTarget.value.id), {
                reason: withdrawReason.value.trim() || undefined,
            });
            withdrawOpen.value = false;
            showSnackBar({ type: "success", message: t("Pending change withdrawn") });
            await load();
        } catch (cause) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
        }
    };

    const sections = computed(() => {
        const entry = merchant.value;
        if (!entry) return [];
        const status = merchantStatusHelp(entry.status);
        const sensitiveVisible = !entry.redactedFields.includes("taxId");
        const financialVisible = !entry.redactedFields.includes("payoutBankDetailsJson");
        const kyb = entry.kybStatus ? kybStatusHelp(entry.kybStatus) : null;
        const risk = entry.riskTier ? riskHelp(entry.riskTier) : null;
        return [
            {
                title: t("Identity and lifecycle"),
                description: t("Core merchant identity, lifecycle and support contacts. Sensitive fields are shown only when your role may see them."),
                fields: [
                    field("Display name", entry.displayName, "Customer-facing display name.", "merchants.display_name"),
                    field("Trade name", entry.tradeName, "Customer-facing trade name.", "merchants.tradeName"),
                    field("Legal name", entry.legalName, "Registered legal entity name.", "merchants.legalName", true),
                    field("Merchant ID", entry.id, "Stable merchant database identifier.", "merchants.id", true),
                    field("Status", status.label, status.meaning, "merchants.status"),
                    field("Version", entry.version, "Optimistic-concurrency version for pending edits.", "merchants.version"),
                    field("Onboarding channel", entry.onboardingChannel, COLUMN_HELP.channel, "merchants.onboardingChannel"),
                    field("Country", entry.country, COLUMN_HELP.country, "merchants.country"),
                    field("Created", formatDateTime(entry.createdAt), "Merchant record creation time.", "merchants.created_at"),
                    field("Activated", formatDateTime(entry.activatedAt), "Activation time.", "merchants.activatedAt"),
                    field("Suspended", formatDateTime(entry.suspendedAt), "Suspension time.", "merchants.suspendedAt"),
                    field("Suspension reason", entry.suspensionReasonRedacted ? t("Restricted") : entry.suspensionReasonCode, "AML reasons are restricted to compliance.", "merchants.suspensionReasonCode"),
                    field("Closed", formatDateTime(entry.closedAt), "Closure time.", "merchants.closedAt"),
                ],
            },
            {
                title: t("Contacts and descriptive profile"),
                fields: [
                    field("Contact email", entry.contactEmail, "Primary merchant contact email.", "merchants.contactEmail", true),
                    field("Contact phone", entry.contactPhone, "Primary merchant contact phone.", "merchants.contactPhone", true),
                    field("Support email", entry.supportEmail, "Merchant support contact email.", "merchants.supportEmail", true),
                    field("Support phone", entry.supportPhone, "Merchant support contact phone.", "merchants.supportPhone", true),
                    field("Logo URL", entry.logoUrl, "Optional merchant logo URL.", "merchants.logoUrl"),
                ],
            },
            {
                title: t("Commercial and risk profile"),
                fields: [
                    field("Tax ID", sensitiveVisible ? entry.taxId : t("Restricted"), "Tax registration identifier. Sensitive field.", "merchants.taxId", true),
                    field("Registration number", sensitiveVisible ? entry.registrationNo : t("Restricted"), "Commercial registration number. Sensitive field.", "merchants.registrationNo", true),
                    field("Business category", sensitiveVisible ? entry.businessCategory : t("Restricted"), COLUMN_HELP.category, "merchants.businessCategory"),
                    field("Risk tier", sensitiveVisible ? risk?.label ?? "—" : t("Restricted"), risk?.meaning, "merchants.riskTier"),
                    field("KYB status", sensitiveVisible ? kyb?.label ?? "—" : t("Restricted"), kyb?.meaning, "merchants.kybStatus"),
                    field("Next KYB review", sensitiveVisible ? formatDateTime(entry.nextKybReviewAt) : t("Restricted"), COLUMN_HELP.review, "merchants.nextKybReviewAt"),
                    field("Commission receivable ceiling", financialVisible ? formatMoney(entry.commissionReceivableCeiling, currency.value) : t("Restricted"), "Commission receivable ceiling. Sensitive financial field.", "merchants.commissionReceivableCeiling"),
                    field("Negative balance ceiling", financialVisible ? formatMoney(entry.negativeBalanceCeiling, currency.value) : t("Restricted"), "Allowed negative wallet balance ceiling. Sensitive financial field.", "merchants.negativeBalanceCeiling"),
                    field("Payout bank", financialVisible ? String((entry.payoutBankDetailsJson ?? {}).bank ?? "—") : t("Restricted"), "Payout bank name.", "merchants.payoutBankDetailsJson.bank"),
                    field("Payout account", financialVisible ? String((entry.payoutBankDetailsJson ?? {}).iban ?? (entry.payoutBankDetailsJson ?? {}).accountNumber ?? "—") : t("Restricted"), "Payout IBAN/account. Sensitive financial field.", "merchants.payoutBankDetailsJson.iban"),
                    field("Payout holder", financialVisible ? String((entry.payoutBankDetailsJson ?? {}).holder ?? "—") : t("Restricted"), "Payout account holder.", "merchants.payoutBankDetailsJson.holder"),
                ],
            },
        ];
    });


    return () => {
        if (loading.value) {
            return <ScreenContainer><StateView loading onRetry={() => void load()} /></ScreenContainer>;
        }
        if (error.value || !merchant.value) {
            return <ScreenContainer><StateView error={error.value ?? "Merchant not found"} onRetry={() => void load()} /></ScreenContainer>;
        }
        const entry = merchant.value;
        return (
            <ScreenContainer>
                <ThemedView style={{ gap: "18px" }}>
                    <PageHeader
                        title={entry.displayName || entry.tradeName || t("Merchant")}
                        end={() => (
                            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                <VBtn variant="text" prependIcon="mdi-arrow-left" onClick={() => void router.push({ name: "Merchants" })}>{t("Queue")}</VBtn>
                                <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>{t("Refresh")}</VBtn>
                                {canWrite.value && (
                                    <>
                                        <VBtn variant="tonal" prependIcon="mdi-pencil-outline" onClick={() => openEdit("DESCRIPTIVE")}>{t("Edit descriptive")}</VBtn>
                                        <VBtn variant="tonal" prependIcon="mdi-file-document-edit-outline" onClick={() => openEdit("SENSITIVE")}>{t("Propose sensitive change")}</VBtn>
                                    </>
                                )}
                                {canWrite.value && entry.status === "ACTIVE" && (
                                    <VBtn color="error" variant="tonal" onClick={() => openAction("SUSPEND")}>{t("Suspend")}</VBtn>
                                )}
                                {canWrite.value && entry.status === "SUSPENDED" && (
                                    <VBtn color="success" variant="tonal" onClick={() => openAction("REINSTATE")}>{t("Reinstate")}</VBtn>
                                )}
                                {canWrite.value && ["ACTIVE", "SUSPENDED"].includes(entry.status) && (
                                    <VBtn color="error" variant="text" onClick={() => openAction("CLOSE")}>{t("Close")}</VBtn>
                                )}
                            </ThemedView>
                        )}
                    />

                    <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                        <span title={statusHelp.value.meaning}><StatusChip label={statusHelp.value.label} tone={statusHelp.value.tone} /></span>
                        {entry.kybStatus && <StatusChip label={kybStatusHelp(entry.kybStatus).label} tone={kybStatusHelp(entry.kybStatus).tone} />}
                        {entry.riskTier && <StatusChip label={riskHelp(entry.riskTier).label} tone={riskHelp(entry.riskTier).tone} />}
                        <StatusChip label={`v${entry.version}`} tone="neutral" size="small" />
                        {entry.pendingApprovalCount > 0 && <StatusChip label={`${entry.pendingApprovalCount} ${t("pending changes")}`} tone="warning" />}
                        {entry.redactedFields.length > 0 && <StatusChip label={t("Some fields restricted")} tone="neutral" size="small" />}
                    </ThemedView>

                    {entry.redactedFields.length > 0 && (
                        <VAlert type="info" variant="tonal">
                            {t("Sensitive tax, registration, payout, ceiling, risk or AML information is hidden for your role.")}
                        </VAlert>
                    )}
                    {entry.status === "SUSPENDED" && (
                        <VAlert type="warning" variant="tonal">
                            {t("Suspended merchants cannot start new live payments. Reinstatement requires a compliance or MLRO checker.")}
                        </VAlert>
                    )}

                    <VCard><VCardText><MerchantHelpPanel /></VCardText></VCard>

                    <FieldsSections sections={sections.value} />

                    {canFinancial.value && (
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Financial overview")}</ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                    <StatusChip label={`${t("Ledger balance")}: ${formatMoney(balance.value, currency.value)}`} tone={Number(balance.value ?? 0) < 0 ? "error" : "success"} />
                                    <StatusChip label={`${t("Open disputes")}: ${entry.openDisputes ?? 0}`} tone={(entry.openDisputes ?? 0) > 0 ? "warning" : "success"} />
                                    <StatusChip label={`${t("Pending cash-outs")}: ${entry.pendingCashouts ?? 0}`} tone={(entry.pendingCashouts ?? 0) > 0 ? "warning" : "success"} />
                                </ThemedView>
                                {entry.metrics && entry.metrics.length > 0 && (
                                    <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                        {entry.metrics.map((metric) => (
                                            <StatusChip key={metric.status} label={`${metric.status}: ${metric.count} · ${metric.chargedAmount}`} tone="neutral" size="x-small" />
                                        ))}
                                    </ThemedView>
                                )}
                                {entry.walletBalance?.wallets?.map((wallet) => (
                                    <ThemedText key={wallet.id} style={{ fontSize: "12px" }}>
                                        {wallet.currency} · {wallet.status} · {formatMoney(wallet.balance, wallet.currency)}
                                    </ThemedText>
                                ))}
                                {entry.applications && entry.applications.length > 0 && (
                                    <ThemedView style={{ gap: "4px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Applications")}</ThemedText>
                                        {entry.applications.map((application) => (
                                            <ThemedText key={application.id} style={{ fontSize: "12px" }}>
                                                {application.name} · {application.status} · {formatMoney(application.expectedMonthlyVolume, currency.value)}
                                            </ThemedText>
                                        ))}
                                    </ThemedView>
                                )}
                            </VCardText>
                        </VCard>
                    )}

                    {entry.pendingChanges && entry.pendingChanges.length > 0 && (
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Pending changes")}</ThemedText>
                                {entry.pendingChanges.map((change) => (
                                    <VCard key={change.id} variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                                            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                                <StatusChip label={change.state} tone={statusTone(change.state)} size="x-small" />
                                                <ThemedText style={{ fontSize: "12px" }}>{change.maker?.email ?? change.makerUserId}</ThemedText>
                                                {change.baseVersion && <StatusChip label={`base v${change.baseVersion}`} tone="neutral" size="x-small" />}
                                            </ThemedView>
                                            {change.makerReason && <ThemedText style={{ fontSize: "12px" }}>{change.makerReason}</ThemedText>}
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{formatDateTime(change.createdAt)} · {change.mode}</ThemedText>
                                            {change.makerUserId === currentUserId.value && ["DRAFT", "PENDING_REVIEW"].includes(change.state) && (
                                                <VBtn size="x-small" variant="text" color="error" onClick={() => openWithdraw(change)}>{t("Withdraw")}</VBtn>
                                            )}
                                        </VCardText>
                                    </VCard>
                                ))}
                            </VCardText>
                        </VCard>
                    )}

                    {entry.amlCases && entry.amlCases.length > 0 && canAml.value && (
                        <VCard variant="tonal" color="error">
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("AML cases")}</ThemedText>
                                {entry.amlCases.map((amlCase) => (
                                    <ThemedView key={amlCase.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <StatusChip label={amlCase.status} tone={statusTone(amlCase.status)} size="x-small" />
                                        <StatusChip label={amlCase.severity} tone={statusTone(amlCase.severity)} size="x-small" />
                                        <ThemedText style={{ fontSize: "12px" }}>{amlCase.triggerReason}</ThemedText>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{formatDateTime(amlCase.createdAt)}</ThemedText>
                                    </ThemedView>
                                ))}
                            </VCardText>
                        </VCard>
                    )}

                    {entry.joinRequests && entry.joinRequests.length > 0 && (
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Join requests")}</ThemedText>
                                    <VBtn size="small" variant="text" onClick={() => void router.push({ name: "JoinRequests" })}>{t("Open queue")}</VBtn>
                                </ThemedView>
                                {(entry.joinRequests ?? []).map((row) => (
                                    <ThemedView key={row.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <StatusChip label={row.status} tone={statusTone(row.status)} size="x-small" />
                                        <ThemedText style={{ fontSize: "12px", direction: "ltr" }}>{row.id}</ThemedText>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{formatDateTime(row.createdAt)}</ThemedText>
                                        <VBtn size="x-small" variant="text" onClick={() => void router.push({ name: "JoinRequestDetail", params: { id: row.id } })}>
                                            {t("Open")}
                                        </VBtn>
                                    </ThemedView>
                                ))}
                            </VCardText>
                        </VCard>
                    )}

                    {entry.kybDocuments && entry.kybDocuments.length > 0 && (
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("KYB evidence")}</ThemedText>
                                    <VBtn size="small" variant="text" onClick={() => void router.push({ name: "KybReview" })}>{t("Open KYB review")}</VBtn>
                                </ThemedView>
                                {entry.kybDocuments.map((document) => (
                                    <ThemedView key={document.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <StatusChip label={document.status} tone={statusTone(document.status)} size="x-small" />
                                        <StatusChip label={document.avStatus} tone={statusTone(document.avStatus)} size="x-small" />
                                        <ThemedText style={{ fontSize: "12px" }}>{document.docType} · {document.originalFileName || document.id}</ThemedText>
                                        <VBtn size="x-small" variant="text" onClick={() => void router.push({ name: "KybReviewDetail", params: { id: document.id } })}>{t("Open")}</VBtn>
                                    </ThemedView>
                                ))}
                            </VCardText>
                        </VCard>
                    )}

                    {entry.beneficialOwners && entry.beneficialOwners.length > 0 && (
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Beneficial owners")}</ThemedText>
                                {entry.beneficialOwners.map((owner) => (
                                    <ThemedView key={owner.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <StatusChip label={owner.screeningStatus} tone={statusTone(owner.screeningStatus)} size="x-small" />
                                        {owner.pepDeclared && <StatusChip label="PEP" tone="error" size="x-small" />}
                                        <ThemedText style={{ fontSize: "12px" }}>{owner.fullNameEn || owner.fullNameAr} · {owner.role} · {owner.ownershipPercent ?? "—"}%</ThemedText>
                                    </ThemedView>
                                ))}
                            </VCardText>
                        </VCard>
                    )}

                    {entry.users && entry.users.length > 0 && canWrite.value && (
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Merchant users and access")}</ThemedText>
                                {entry.users.map((merchantUser) => (
                                    <ThemedText key={merchantUser.id} style={{ fontSize: "12px" }}>
                                        {merchantUser.email} · {merchantUser.role} · {merchantUser.status} · MFA {merchantUser.mfaRequired ? "on" : "off"}
                                    </ThemedText>
                                ))}
                                {entry.accessTokens?.map((token) => (
                                    <ThemedText key={token.id} style={{ fontSize: "12px" }}>
                                        {t("Token")} {token.name} · ****{token.lastFour} · {token.revokedAt ? t("Revoked") : t("Active")} · {t("last used")} {formatDateTime(token.lastUsedAt)}
                                    </ThemedText>
                                ))}
                                {entry.credentialSets?.map((credential) => (
                                    <ThemedText key={credential.id} style={{ fontSize: "12px" }}>
                                        {t("Credential set")} {credential.id} · {credential.env} · {credential.status}
                                    </ThemedText>
                                ))}
                            </VCardText>
                        </VCard>
                    )}

                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                            <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Field history")}</ThemedText>
                                <VBtn size="small" variant="text" onClick={() => (historyOpen.value = true)}>{t("View all")}</VBtn>
                            </ThemedView>
                            {entry.fieldHistory.length === 0 && <ThemedText style={{ opacity: 0.6 }}>{t("No field changes recorded")}</ThemedText>}
                            {entry.fieldHistory.slice(0, 8).map((change) => (
                                <ThemedView key={change.id} style={{ gap: "2px", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "6px" }}>
                                    <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <StatusChip label={change.fieldName} tone={change.redacted ? "neutral" : "info"} size="x-small" />
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{change.actorEmail || change.actorId} · {formatDateTime(change.createdAt)} · {change.source}</ThemedText>
                                    </ThemedView>
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.8 }}>
                                        {change.redacted ? t("Value restricted") : `${change.oldValue ?? "—"} → ${change.newValue ?? "—"}`}
                                    </ThemedText>
                                </ThemedView>
                            ))}
                        </VCardText>
                    </VCard>
                </ThemedView>

                <MerchantActionDialog
                    open={actionOpen.value}
                    mode={actionMode.value}
                    merchant={merchant.value}
                    onUpdate={(value) => (actionOpen.value = value)}
                    onDone={() => void load()}
                />
                <MerchantEditDialog
                    open={editOpen.value}
                    mode={editMode.value}
                    merchant={merchant.value}
                    onUpdate={(value) => (editOpen.value = value)}
                    onDone={() => void load()}
                />
                <VDialog modelValue={withdrawOpen.value} onUpdate:modelValue={(value: boolean) => (withdrawOpen.value = value)} maxWidth="560px">
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{t("Withdraw pending change")}</ThemedText>
                            <ThemedText style={{ fontSize: "13px" }}>{withdrawTarget.value?.id}</ThemedText>
                            <VTextarea v-model={withdrawReason.value} label={t("Withdrawal reason (optional)")} rows={3} autoGrow />
                            <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                                <VBtn variant="text" onClick={() => (withdrawOpen.value = false)}>{t("Cancel")}</VBtn>
                                <VBtn color="error" onClick={() => void withdraw()}>{t("Withdraw")}</VBtn>
                            </ThemedView>
                        </VCardText>
                    </VCard>
                </VDialog>
                <VDialog modelValue={historyOpen.value} onUpdate:modelValue={(value: boolean) => (historyOpen.value = value)} maxWidth="1100px" scrollable>
                    <VCard>
                        <VCardText>
                            <ApiTable<MerchantDetailChange>
                                title={t("Field history")}
                                url={urlsMap.merchantDetailChanges(merchantId.value)}
                                localSearch={false}
                                xlsx={false}
                                showNumber={true}
                                numberOfItemsPerPage={historyPageSize.value}
                                setNumberOfItemsPerPage={(value) => (historyPageSize.value = value)}
                                headers={[
                                    { key: "fieldName", label: "Field", value: (row) => row.fieldName },
                                    { key: "oldValue", label: "Old value", value: (row) => row.oldValue ?? "" },
                                    { key: "newValue", label: "New value", value: (row) => row.newValue ?? "" },
                                    { key: "actor", label: "Actor", value: (row) => row.actorEmail ?? row.actorId },
                                    { key: "source", label: "Source", value: (row) => row.source },
                                    { key: "createdAt", label: "When", value: (row) => row.createdAt },
                                ]}
                                apiDataExtractor={(data) => {
                                    const payload = data as { detailChanges?: MerchantDetailChange[]; rows?: MerchantDetailChange[] };
                                    return payload.detailChanges ?? payload.rows ?? [];
                                }}
                                apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                                setRefreshHook={(hook) => { historyRefreshHook.value = hook as typeof historyRefreshHook.value; }}
                                clearRefreshHook={() => { historyRefreshHook.value = null; }}
                                onRefresh={(props, refresh) => {
                                    void refresh({
                                        queryParams: {
                                            page: props.page,
                                            pageSize: historyPageSize.value,
                                            ...(props.sortKey ? { sortKey: props.sortKey, sortDirection: props.sortDirection } : {}),
                                        },
                                    });
                                }}
                            />
                        </VCardText>
                    </VCard>
                </VDialog>
            </ScreenContainer>
        );
    };
});

export default MerchantDetailPage;
