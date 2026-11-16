import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { VAlert, VBtn, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { StateView } from "@/components/StateView";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { SectionFields } from "@/components/SectionFields";
import { SandboxBanner } from "@/components/sandbox/SandboxBanner";
import { sandboxGet, sandboxPost, type SandboxLedgerLine, type SandboxPaymentDetail } from "@/api/sandbox";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type Tab = "OVERVIEW" | "TIMELINE" | "LEDGER" | "ADJUSTMENTS" | "DISPUTES" | "INSPECTOR";

const SandboxPaymentDetailPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const detail = ref<SandboxPaymentDetail | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const tab = ref<Tab>("OVERVIEW");
    const busy = ref<string | null>(null);
    const refundOpen = ref(false);
    const refundAmount = ref("");
    const refundReason = ref("");
    const attemptId = () => String(route.params.id ?? "");

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            detail.value = await sandboxGet<SandboxPaymentDetail>(`/payments/${encodeURIComponent(attemptId())}`);
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };
    void load();
    watch(() => route.params.id, () => void load());

    const action = async (label: string, path: string, body: Record<string, unknown> = {}) => {
        busy.value = label;
        try {
            await sandboxPost(path, body);
            showSnackBar({ type: "success", message: label });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            busy.value = null;
        }
    };

    const refund = async () => {
        if (!detail.value) return;
        await action(t("Sandbox refund processed"), `/payments/${detail.value.attempt.id}/refund`, { amountLyd: refundAmount.value.trim() || undefined, reason: refundReason.value || "Sandbox refund" });
        refundOpen.value = false;
        refundAmount.value = "";
    };

    const resolveDispute = async () => {
        if (!detail.value) return;
        const dispute = detail.value.disputes.find((row) => ["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED"].includes(String(row.status)));
        if (!dispute) return;
        await action(t("Sandbox dispute resolved"), `/disputes/${dispute.id}/resolve`, { outcome: "WON", notes: "Sandbox resolution from payment detail" });
    };

    const metrics = computed<MetricItem[]>(() => {
        const attempt = detail.value?.attempt;
        if (!attempt) return [];
        return [
            { key: "charged", label: t("Charged"), moneyAmount: attempt.totalChargedAmount, currency: attempt.currency },
            { key: "settled", label: t("Settled"), moneyAmount: attempt.settledAmount ?? "0.0000", currency: attempt.currency },
            { key: "fee", label: t("Gateway fee"), moneyAmount: String(attempt.gatewayFeeAmount ?? "0.0000"), currency: attempt.currency },
            { key: "commission", label: t("Platform commission"), moneyAmount: attempt.platformCommissionAmount, currency: attempt.currency },
            { key: "net", label: t("Net to merchant"), moneyAmount: attempt.netMerchantAmount, currency: attempt.currency },
            { key: "refundable", label: t("Refundable"), moneyAmount: detail.value?.refundableAmount ?? "0.0000", currency: attempt.currency },
        ];
    });

    const tabs = computed(() => [
        { label: t("Overview"), value: "OVERVIEW" },
        { label: t("Timeline"), value: "TIMELINE" },
        { label: t("Ledger"), value: "LEDGER" },
        { label: t("Adjustments"), value: "ADJUSTMENTS" },
        { label: t("Disputes"), value: "DISPUTES" },
        { label: t("Inspector"), value: "INSPECTOR" },
    ]);

    const ledgerHeaders: TableHeader<SandboxLedgerLine>[] = [
        { key: "createdAt", label: "Date", value: (row) => row.createdAt },
        { key: "direction", label: "Side", value: (row) => row.direction },
        { key: "amount", label: "Amount", Value: ({ row }) => <MoneyDisplay amount={row.amount} currency={detail.value?.attempt.currency ?? "LYD"} size="sm" /> },
        { key: "refType", label: "Reference type", value: (row) => row.refType },
        { key: "refId", label: "Reference", Value: ({ row }) => <MonoRef value={row.refId} truncate={22} /> },
        { key: "description", label: "Description", value: (row) => row.description },
    ];
    const eventHeaders: TableHeader<Record<string, unknown>>[] = [
        { key: "createdAt", label: "Date", value: (row) => String(row.createdAt ?? "") },
        { key: "phase", label: "Phase", value: (row) => String(row.phase ?? "") },
        { key: "status", label: "Status", value: (row) => String(row.status ?? "") },
        { key: "httpStatus", label: "HTTP", value: (row) => String(row.httpStatus ?? row.statusCode ?? "") },
        { key: "durationMs", label: "Duration", value: (row) => row.durationMs === undefined ? "" : `${String(row.durationMs)} ms` },
        { key: "fault", label: "Fault", value: (row) => String(row.fault ?? row.errorCode ?? "") },
    ];
    const adjustmentHeaders: TableHeader<Record<string, unknown>>[] = [
        { key: "type", label: "Type", value: (row) => String(row.type ?? "") },
        { key: "state", label: "State", Value: ({ row }) => <StatusBadge status={String(row.state ?? "")} /> },
        { key: "amount", label: "Amount", Value: ({ row }) => <MoneyDisplay amount={String(row.amount ?? "0")} currency={detail.value?.attempt.currency ?? "LYD"} size="sm" /> },
        { key: "reason", label: "Reason", value: (row) => String(row.reason ?? "") },
        { key: "createdAt", label: "Created", value: (row) => String(row.createdAt ?? "") },
    ];
    const disputeHeaders: TableHeader<Record<string, unknown>>[] = [
        { key: "id", label: "Dispute", Value: ({ row }) => <MonoRef value={String(row.id ?? "")} truncate={18} /> },
        { key: "status", label: "Status", Value: ({ row }) => <StatusBadge status={String(row.status ?? "")} /> },
        { key: "reasonCode", label: "Reason", value: (row) => String(row.reasonCode ?? "") },
        { key: "amount", label: "Amount", Value: ({ row }) => <MoneyDisplay amount={String(row.amount ?? "0")} currency={String(row.currency ?? "LYD")} size="sm" /> },
        { key: "evidenceDueAt", label: "Evidence due", value: (row) => String(row.evidenceDueAt ?? "") },
    ];

    const secret = (label: string, value?: string | null) => value ? <DescriptionList items={[{ label, value: <span class="pg-mono">{value}</span> }]} /> : null;

    return () => (
        <ScreenContainer>
            <PageHeader
                title={t("Sandbox Payment")}
                subtitle={detail.value?.attempt.reference ?? attemptId()}
                badge="SANDBOX"
                badgeTone="warning"
                breadcrumbs={[{ label: t("Sandbox Payments"), to: "/sandbox/payments" }, { label: detail.value?.attempt.reference ?? attemptId() }]}
                end={() => (
                    <div class="d-flex flex-wrap ga-2">
                        <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => void load()}>{t("Refresh")}</VBtn>
                        <VBtn variant="tonal" prependIcon="mdi-cash-refund" onClick={() => { refundAmount.value = ""; refundReason.value = ""; refundOpen.value = true; }}>{t("Refund")}</VBtn>
                        <VBtn variant="tonal" color="warning" loading={busy.value === t("Sandbox dispute created")} disabled={detail.value?.attempt.status !== "SUCCEEDED"} onClick={() => void action(t("Sandbox dispute created"), `/payments/${detail.value?.attempt.id}/simulate-dispute`)}>{t("Simulate dispute")}</VBtn>
                    </div>
                )}
            />
            <SandboxBanner subtitle={t("Refunds and disputes post to the sandbox ledger and governance queues only.")} />
            {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
            <StateView loading={loading.value} minHeight="220px">
                {detail.value ? (
                    <div class="d-flex flex-column ga-4">
                        <MetricStrip items={metrics.value} />
                        <div class="d-flex flex-wrap ga-2 align-center">
                            <StatusBadge status={detail.value.attempt.status} />
                            {detail.value.attempt.substatus ? <StatusBadge status={detail.value.attempt.substatus} toneOverride="warning" /> : null}
                            <span class="text-caption text-medium-emphasis">{t("Created")}: {detail.value.attempt.createdAt}</span>
                        </div>
                        <SegmentedTabs modelValue={tab.value} tabs={tabs.value} onUpdate:modelValue={(value: string) => (tab.value = value as Tab)} />
                        {tab.value === "OVERVIEW" ? (
                            <div class="d-flex flex-wrap ga-4 align-start">
                                <SurfaceCard title={t("Payment")} style={{ flex: "1 1 420px" }}>
                                    <DescriptionList columns={2} items={[
                                        { label: t("Reference"), value: <MonoRef value={detail.value.attempt.reference} /> },
                                        { label: t("Status"), value: <StatusBadge status={detail.value.attempt.status} /> },
                                        { label: t("Mode"), value: String(detail.value.attempt.mode ?? "") },
                                        { label: t("Sub-mode"), value: String(detail.value.attempt.subMode ?? detail.value.attempt.submode ?? "—") },
                                        { label: t("Rail"), value: detail.value.rail?.code ?? String(detail.value.attempt.railId ?? "") },
                                        { label: t("Gateway"), value: detail.value.gateway?.code ?? String(detail.value.attempt.gatewayVersionId ?? "") },
                                        { label: t("Application"), value: detail.value.application?.name ?? String(detail.value.attempt.applicationId ?? "") },
                                        { label: t("Link"), value: detail.value.link?.key ?? String(detail.value.attempt.linkId ?? "") },
                                        { label: t("Provider reference"), value: <MonoRef value={String(detail.value.attempt.providerReference ?? "—")} truncate={24} /> },
                                        { label: t("Network reference"), value: <MonoRef value={String(detail.value.attempt.networkReference ?? "—")} truncate={24} /> },
                                        { label: t("Fee bearer"), value: String(detail.value.attempt.feeBearer ?? "") },
                                        { label: t("Settlement target"), value: String(detail.value.attempt.settlementTarget ?? "") },
                                        { label: t("Expires"), value: String(detail.value.attempt.expiresAt ?? "—") },
                                        { label: t("Completed"), value: String(detail.value.attempt.terminalAt ?? "—") },
                                    ]} />
                                </SurfaceCard>
                                <SurfaceCard title={t("Dispute action")} style={{ flex: "1 1 320px" }}>
                                    <div class="d-flex flex-column ga-2">
                                        <VBtn variant="tonal" color="success" disabled={!detail.value.disputes.some((row) => ["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED"].includes(String(row.status)))} loading={busy.value === t("Sandbox dispute resolved")} onClick={() => void resolveDispute()}>{t("Resolve dispute as won")}</VBtn>
                                        <p class="text-caption text-medium-emphasis">{t("A lost dispute books a sandbox chargeback adjustment; a won dispute releases the attempt.")}</p>
                                    </div>
                                </SurfaceCard>
                            </div>
                        ) : null}
                        {tab.value === "TIMELINE" ? (
                            (detail.value.stepLogs ?? []).length > 0 ? <DataTable title={t("Payment timeline")} data={detail.value.stepLogs ?? []} headers={eventHeaders} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={20} /> : <EmptyState title={t("No step logs")} />
                        ) : null}
                        {tab.value === "LEDGER" ? (
                            detail.value.ledgerLines.length > 0 ? <DataTable title={t("Sandbox journal lines")} data={detail.value.ledgerLines} headers={ledgerHeaders} loading={false} showNumber={true} xlsx={false} noElevation={true} numberOfItemsPerPage={25} /> : <EmptyState title={t("No ledger lines")} />
                        ) : null}
                        {tab.value === "ADJUSTMENTS" ? (
                            (detail.value.adjustments ?? []).length > 0 ? <DataTable title={t("Refunds and adjustments")} data={detail.value.adjustments ?? []} headers={adjustmentHeaders} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={20} /> : <EmptyState title={t("No adjustments")} />
                        ) : null}
                        {tab.value === "DISPUTES" ? (
                            detail.value.disputes.length > 0 ? <DataTable title={t("Disputes")} data={detail.value.disputes} headers={disputeHeaders} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={20} /> : <EmptyState title={t("No disputes on this payment.")} />
                        ) : null}
                        {tab.value === "INSPECTOR" ? (
                            detail.value.inspector?.activeAttemptSecrets ? (
                                <SurfaceCard title={t("Checkout inspector")} subtitle={t("Test data to drive the hosted/API checkout.")}>
                                    <div class="d-flex flex-column ga-2">
                                        {secret(t("OTP"), detail.value.inspector.activeAttemptSecrets.expectedOtp)}
                                        {secret(t("Account"), detail.value.inspector.activeAttemptSecrets.boundAccountIdentifier)}
                                        {secret(t("Held"), detail.value.inspector.activeAttemptSecrets.heldAmountLyd)}
                                        {secret(t("QR payload"), detail.value.inspector.activeAttemptSecrets.qrPayload)}
                                        {secret(t("Deep link"), detail.value.inspector.activeAttemptSecrets.deepLinkUrl)}
                                        {secret(t("Redirect"), detail.value.inspector.activeAttemptSecrets.redirectUrl)}
                                    </div>
                                </SurfaceCard>
                            ) : <EmptyState title={t("No active checkout inspector data")} />
                        ) : null}
                    </div>
                ) : null}
            </StateView>
            <FormModal modelValue={refundOpen.value} onUpdate:modelValue={(v: any) => (refundOpen.value = v)} title={t("Refund sandbox payment")} size="sm" loading={busy.value === t("Sandbox refund processed")} submitLabel={t("Refund")} onSubmit={() => void refund()}>
                <SectionFields title={t("Refund")}>
                    <FormField label={t("Amount LYD")}>
                        <VTextField type="number" modelValue={refundAmount.value} onUpdate:modelValue={(v: string) => (refundAmount.value = v)} placeholder={t("Blank for full refund")} hideDetails />
                    </FormField>
                    <FormField label={t("Reason")}>
                        <VTextField modelValue={refundReason.value} onUpdate:modelValue={(v: string) => (refundReason.value = v)} hideDetails />
                    </FormField>
                    <div class="text-caption text-medium-emphasis">{t("Refundable")}: {detail.value?.refundableAmount} {detail.value?.attempt.currency}</div>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default SandboxPaymentDetailPage;
