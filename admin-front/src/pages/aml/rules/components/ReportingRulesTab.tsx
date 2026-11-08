import { computed, defineComponent, ref, type VNodeChild } from "vue";
import { VAlert, VBtn } from "vuetify/components";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { hasOneOfAuthorities } from "@/state/user";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { StateView } from "@/components/StateView";
import { FormModal } from "@/components/ui/FormModal";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MetaPill } from "@/components/ui/MetaPill";
import { MonoRef } from "@/components/ui/MonoRef";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { KeyValueSummary, type KeyValueItem } from "@/components/builders/KeyValueSummary";
import { durationText } from "@/components/builders/AmlParamsBuilder";
import { readApiErrorInfo, summarizeReportingConditions, windowSecondsLabel } from "@/components/builders/model";

type ReportingRule = {
    id: string;
    authority: string;
    reportType: string;
    thresholdAmount: string | null;
    windowSeconds: number | null;
    currency: string;
    conditions: unknown;
    sourceReference: string | null;
    status: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    approvalRequestId: string | null;
};

const TYPE_LABEL: Record<string, string> = {
    LARGE_TRANSACTION: "Large transaction",
    SUSPICIOUS_ACTIVITY: "Suspicious activity",
    PERIODIC_RETURN: "Periodic return",
};
const PROMOTE_AUTHORITIES = ["report:approve", "report:review", "aml:write", "compliance:write", "approval:check", "approval:write"];

const formatDate = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" }).format(date);
};

/** The "Reporting rules" tab of AML rules: regulatory reporting thresholds and the approval-based promotion. */
export const ReportingRulesTab = defineComponent({
    name: "ReportingRulesTab",
    setup() {
        const { t } = useLocale();
        const router = useRouter();
        const canPromote = computed(() => hasOneOfAuthorities(PROMOTE_AUTHORITIES));
        const rules = ref<ReportingRule[]>([]);
        const loading = ref(true);
        const loadError = ref<string | null>(null);
        const promoting = ref<ReportingRule | null>(null);
        const promoteLoading = ref(false);
        const promoteError = ref("");
        const submittedApproval = ref<string | null>(null);

        const load = async () => {
            loading.value = true;
            loadError.value = null;
            try {
                const response = await api.get(urlsMap.amlReportingRules);
                const payload = response.data?.data ?? response.data ?? {};
                rules.value = (payload.rules ?? []) as ReportingRule[];
            } catch (error) {
                loadError.value = extractApiErrorMessage(error);
            } finally {
                loading.value = false;
            }
        };
        void load();

        const openPromote = (rule: ReportingRule) => {
            promoting.value = rule;
            promoteError.value = "";
        };

        const promote = async () => {
            const rule = promoting.value;
            if (!rule || promoteLoading.value) return;
            promoteLoading.value = true;
            promoteError.value = "";
            try {
                const response = await api.post(urlsMap.amlReportingRulePromote(rule.id), {});
                const payload = response.data?.data ?? response.data ?? {};
                // 202: the promotion is only a request until a different checker approves it.
                submittedApproval.value = typeof payload.approvalRequestId === "string" ? payload.approvalRequestId : "";
                showSnackBar({ type: "primary", message: t("Promotion submitted for four-eyes approval. The rule stays provisional until a checker approves it.") });
                promoting.value = null;
                await load();
            } catch (error) {
                const info = readApiErrorInfo(error);
                if (info.code === "REPORTING_RULE_PROMOTION_PENDING") {
                    promoteError.value = t("A promotion of this rule is already waiting for approval.");
                    const pendingId = info.details?.approvalRequestId;
                    if (typeof pendingId === "string") submittedApproval.value = pendingId;
                } else if (info.code === "REPORTING_RULE_ALREADY_CONFIRMED") {
                    promoteError.value = t("This rule is already confirmed.");
                    void load();
                } else {
                    promoteError.value = extractApiErrorMessage(error);
                }
            } finally {
                promoteLoading.value = false;
            }
        };

        const conditionItems = (rule: ReportingRule): KeyValueItem[] =>
            summarizeReportingConditions(rule.conditions).map((row) => ({
                label: t(row.label),
                ...(row.list ? { list: row.list } : { text: row.text ?? "—" }),
            }));

        const th = (label: string): VNodeChild => (
            <th scope="col" style={{ textAlign: "start", padding: "8px 10px", fontSize: "11.5px", fontWeight: 600, color: "var(--pg-ink-muted)", borderBlockEnd: "1px solid var(--pg-border-subtle)", whiteSpace: "nowrap" }}>{label}</th>
        );
        const cell = { padding: "10px", verticalAlign: "top", fontSize: "12.5px", borderBlockEnd: "1px solid var(--pg-border-subtle)" } as const;

        return (): VNodeChild => (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                <VAlert type="info" variant="tonal">
                    {t("Reporting rules decide when a transaction or pattern must be reported to the regulator. A provisional rule becomes confirmed only after a different checker approves its promotion.")}
                </VAlert>
                {submittedApproval.value !== null && (
                    <VAlert type="success" variant="tonal" closable onClick:close={() => (submittedApproval.value = null)}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
                            <span>{t("Promotion submitted for four-eyes approval.")}</span>
                            {submittedApproval.value && <MonoRef value={submittedApproval.value} />}
                            <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => void router.push({ name: "Approvals" })}>{t("Open approvals")}</VBtn>
                        </div>
                    </VAlert>
                )}
                {loadError.value ? (
                    <StateView error={loadError.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : rules.value.length === 0 ? (
                    <SurfaceCard>
                        <SurfaceCardText>
                            <StateView empty={true} emptyTitle={t("No reporting rules")} emptyDescription={t("Reporting rules created by compliance appear here.")} minHeight="160px" />
                        </SurfaceCardText>
                    </SurfaceCard>
                ) : (
                    <SurfaceCard>
                        <SurfaceCardText style={{ overflowX: "auto" }}>
                            <table style={{ inlineSize: "100%", borderCollapse: "collapse" }} aria-label={t("Reporting rules")}>
                                <thead>
                                    <tr>
                                        {th(t("Rule"))}
                                        {th(t("Report type"))}
                                        {th(t("Threshold"))}
                                        {th(t("Window"))}
                                        {th(t("Conditions"))}
                                        {th(t("Status"))}
                                        {th(t("Effective"))}
                                        {th("")}
                                    </tr>
                                </thead>
                                <tbody>
                                    {rules.value.map((rule) => {
                                        const window = windowSecondsLabel(rule.windowSeconds);
                                        const confirmed = rule.status === "CONFIRMED";
                                        return (
                                            <tr key={rule.id}>
                                                <td style={cell}>
                                                    <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                                                        <span dir="auto" style={{ fontWeight: 600 }}>{rule.sourceReference || "—"}</span>
                                                        <span style={{ fontSize: "11px", color: "var(--pg-ink-faint)" }}>{rule.authority}</span>
                                                    </div>
                                                </td>
                                                <td style={cell}><MetaPill size="x-small" variant="tonal" color="primary">{t(TYPE_LABEL[rule.reportType] ?? rule.reportType)}</MetaPill></td>
                                                <td style={cell}>
                                                    {rule.thresholdAmount ? <MoneyDisplay amount={rule.thresholdAmount} currency={rule.currency} size="sm" /> : <span style={{ color: "var(--pg-ink-faint)" }}>—</span>}
                                                </td>
                                                <td style={cell}>{window ? durationText(rule.windowSeconds as number, t) : "—"}</td>
                                                <td style={cell}><KeyValueSummary items={conditionItems(rule)} compact emptyLabel={t("All transactions")} maxRows={3} /></td>
                                                <td style={cell}>
                                                    <div style={{ display: "flex", flexDirection: "column", gap: "4px", alignItems: "flex-start" }}>
                                                        <StatusBadge status={rule.status} label={t(confirmed ? "Confirmed" : "Provisional")} toneOverride={confirmed ? "success" : "warning"} />
                                                        {!confirmed && rule.approvalRequestId && <StatusBadge status="PROMOTION_REQUESTED" label={t("Promotion requested")} toneOverride="info" showDot={false} />}
                                                    </div>
                                                </td>
                                                <td style={cell}>
                                                    <div style={{ display: "flex", flexDirection: "column", gap: "2px", fontSize: "11.5px" }}>
                                                        <span>{formatDate(rule.effectiveFrom)}</span>
                                                        {rule.effectiveTo && <span style={{ color: "var(--pg-ink-muted)" }}>→ {formatDate(rule.effectiveTo)}</span>}
                                                    </div>
                                                </td>
                                                <td style={cell}>
                                                    {!confirmed && canPromote.value && (
                                                        <VBtn size="small" variant="tonal" prependIcon="mdi-arrow-up-bold-circle-outline" onClick={() => openPromote(rule)}>
                                                            {t("Promote to confirmed")}
                                                        </VBtn>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </SurfaceCardText>
                    </SurfaceCard>
                )}

                <FormModal
                    modelValue={promoting.value !== null}
                    onUpdate:modelValue={(value: boolean) => {
                        if (!value) promoting.value = null;
                    }}
                    title={t("Promote reporting rule")}
                    subtitle={promoting.value?.sourceReference ?? ""}
                    loading={promoteLoading.value}
                    errorMessage={promoteError.value}
                    submitLabel={t("Submit for approval")}
                    onSubmit={() => void promote()}
                >
                    <VAlert type="info" variant="tonal">
                        {t("This does not change the rule yet. It creates a request that a different checker must approve; only then does the rule become confirmed and start driving regulatory reports.")}
                    </VAlert>
                </FormModal>
            </div>
        );
    },
});
