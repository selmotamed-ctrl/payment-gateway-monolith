import { computed, defineComponent, ref, watch, type PropType, type VNodeChild } from "vue";
import { useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { StateView } from "@/components/StateView";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { GlAccountDrawer } from "@/components/ledger/GlAccountDrawer";
import { JournalEntryDrawer } from "@/components/ledger/JournalEntryDrawer";
import { walletActionsFor, type WalletAction } from "@/pages/wallets/walletActions";
import { isRestricted } from "../commerceGovernance";
import { notifyOutcome, reportCommerceError, runGoverned } from "../governedRequest";
import { ApplicationDetailDrawer } from "./ApplicationDetailDrawer";
import ReasonModal from "./ReasonModal";
import {
    ApprovalSubmittedNotice,
    MiniTable,
    MoneyOrRestricted,
    PendingApprovalsList,
    RestrictedValue,
    formatDateTime,
    toBadgeTone,
    type PendingApprovalRow,
} from "./commerceBits";

export type WalletDetail = {
    id: string;
    merchantId: string;
    merchant: { id: string; legalName: string; tradeName: string };
    currency: string;
    status: string;
    glAccountId: string;
    liveBalance: string | null;
    checkpointBalance: string | null;
    applicationCount: number;
    paymentLinkCount: number;
    pendingCashoutCount: number;
    createdAt: string;
    redactedFields: string[];
    glAccount: { id: string; accountType: string; currency: string; checkpointBalance: string | null; checkpointAt: string | null };
    shards: Array<{ shardId: number | string; currentBalance: string; updatedAt: string }>;
    applications: Array<{ id: string; name: string; status: string }>;
    cashouts: Array<{ id: string; state: string; amount: string; currency: string; createdAt: string }>;
    statementLines: Array<{
        lineId: string;
        entryId: string;
        direction: "DEBIT" | "CREDIT";
        amount: string;
        createdAt: string;
        refType: string;
        refId: string;
        description: string | null;
    }>;
    pendingApprovals: PendingApprovalRow[];
};

type WalletTab = "overview" | "statement" | "links";

/**
 * Wallet inspector. Open when `walletId` is set; emits `close`, and `changed`
 * after a freeze / unfreeze request. Freezing is immediate (reason, audited);
 * unfreezing is submitted for four-eyes approval (HTTP 202).
 */
export const WalletDetailDrawer = defineComponent({
    name: "WalletDetailDrawer",
    props: {
        walletId: { type: String as PropType<string | null>, default: null },
    },
    emits: ["close", "changed"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const router = useRouter();
        const wallet = ref<WalletDetail | null>(null);
        const loading = ref(false);
        const error = ref<string | null>(null);
        const tab = ref<WalletTab>("overview");
        const notice = ref<{ approvalRequestId: string | null } | null>(null);
        const pendingAction = ref<WalletAction | null>(null);
        const submitting = ref(false);
        const modalError = ref("");
        const glAccountId = ref<string | null>(null);
        const entryId = ref<string | null>(null);
        const applicationId = ref<string | null>(null);
        let sequence = 0;

        const canWrite = computed(() => hasOneOfAuthorities(["merchant:write"]));

        const load = async (id: string) => {
            const current = ++sequence;
            loading.value = true;
            error.value = null;
            try {
                const response = await api.get(urlsMap.walletDetail(id));
                if (current !== sequence) return;
                const payload = response.data?.data ?? response.data ?? {};
                wallet.value = (payload.wallet ?? payload) as WalletDetail;
            } catch (cause) {
                if (current !== sequence) return;
                error.value = extractApiErrorMessage(cause);
                wallet.value = null;
            } finally {
                if (current === sequence) loading.value = false;
            }
        };

        watch(
            () => props.walletId,
            (id) => {
                tab.value = "overview";
                notice.value = null;
                pendingAction.value = null;
                if (id) {
                    wallet.value = null;
                    void load(id);
                } else {
                    sequence += 1;
                    wallet.value = null;
                    error.value = null;
                }
            },
            { immediate: true },
        );

        const actions = computed(() =>
            wallet.value
                ? walletActionsFor(wallet.value.status, { canWrite: canWrite.value, hasPendingApproval: wallet.value.pendingApprovals.length > 0 })
                : [],
        );

        const submit = async (reason: string) => {
            const action = pendingAction.value;
            if (!action || !wallet.value) return;
            submitting.value = true;
            modalError.value = "";
            try {
                const outcome = await runGoverned(() => api.post(urlsMap.walletStatus(wallet.value!.id), { status: action.targetStatus, reason }));
                notifyOutcome(outcome, "Wallet frozen");
                notice.value = outcome.kind === "approval" ? { approvalRequestId: outcome.approvalRequestId } : null;
                pendingAction.value = null;
                await load(wallet.value.id);
                emit("changed");
            } catch (cause) {
                modalError.value = reportCommerceError(cause);
            } finally {
                submitting.value = false;
            }
        };

        const restrictedLedger = computed(() => wallet.value !== null && isRestricted(wallet.value.redactedFields, "statementLines"));

        const renderOverview = (current: WalletDetail): VNodeChild => (
            <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                {notice.value && <ApprovalSubmittedNotice approvalRequestId={notice.value.approvalRequestId} onDismiss={() => (notice.value = null)} />}
                {current.pendingApprovals.length > 0 && (
                    <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <h3 style={{ margin: 0, fontSize: "13px", fontWeight: 600 }}>{t("Pending approvals")}</h3>
                        <PendingApprovalsList approvals={current.pendingApprovals} />
                    </section>
                )}
                <DescriptionList
                    items={[
                        { label: t("Wallet ID"), value: <MonoRef value={current.id} /> },
                        {
                            label: t("Merchant"),
                            value: (
                                <VBtn
                                    size="small"
                                    variant="text"
                                    style={{ paddingInline: "4px", textTransform: "none" }}
                                    onClick={() => void router.push({ name: "MerchantDetail", params: { id: current.merchantId } })}
                                >
                                    {current.merchant.tradeName || current.merchant.legalName}
                                </VBtn>
                            ),
                        },
                        { label: t("Currency"), value: current.currency },
                        { label: t("Status"), value: <StatusBadge status={current.status} toneOverride={toBadgeTone(current.status)} /> },
                        {
                            label: t("GL account"),
                            value: (
                                <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                                    <MonoRef value={current.glAccountId} truncate={18} />
                                    <VBtn
                                        size="x-small"
                                        variant="text"
                                        icon="mdi-open-in-new"
                                        aria-label={t("Inspect GL account")}
                                        onClick={() => (glAccountId.value = current.glAccountId)}
                                    />
                                </span>
                            ),
                        },
                        { label: t("Live balance"), value: <MoneyOrRestricted amount={current.liveBalance} currency={current.currency} restricted={isRestricted(current.redactedFields, "liveBalance", current.liveBalance)} /> },
                        {
                            label: t("Checkpoint balance"),
                            value: <MoneyOrRestricted amount={current.checkpointBalance} currency={current.currency} restricted={isRestricted(current.redactedFields, "checkpointBalance", current.checkpointBalance)} />,
                        },
                        { label: t("Checkpoint taken"), value: formatDateTime(current.glAccount?.checkpointAt) },
                        { label: t("Pending cash-outs"), value: String(current.pendingCashoutCount) },
                        { label: t("Applications"), value: String(current.applicationCount) },
                        { label: t("Payment links"), value: String(current.paymentLinkCount) },
                        { label: t("Created"), value: formatDateTime(current.createdAt) },
                    ]}
                />
                <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <h3 style={{ margin: 0, fontSize: "13px", fontWeight: 600 }}>{t("Shard distribution")}</h3>
                    {isRestricted(current.redactedFields, "shards") ? (
                        <RestrictedValue />
                    ) : (
                        <MiniTable
                            ariaLabel={t("Shard distribution")}
                            emptyLabel={t("No shards recorded")}
                            rows={current.shards}
                            rowKey={(row: WalletDetail["shards"][number]) => String(row.shardId)}
                            columns={[
                                { key: "shard", label: t("Shard"), render: (row: WalletDetail["shards"][number]) => <span dir="ltr">{String(row.shardId)}</span> },
                                { key: "balance", label: t("Balance"), align: "end", render: (row: WalletDetail["shards"][number]) => <MoneyDisplay amount={row.currentBalance} currency={current.currency} size="sm" /> },
                                { key: "updated", label: t("Updated"), render: (row: WalletDetail["shards"][number]) => formatDateTime(row.updatedAt) },
                            ]}
                        />
                    )}
                </section>
            </div>
        );

        const renderStatement = (current: WalletDetail): VNodeChild =>
            restrictedLedger.value ? (
                <EmptyState icon="mdi-lock-outline" title={t("Restricted")} description={t("The ledger statement is hidden for your role.")} />
            ) : (
                <MiniTable
                    ariaLabel={t("Statement")}
                    emptyLabel={t("No journal lines posted yet")}
                    rows={current.statementLines}
                    rowKey={(row: WalletDetail["statementLines"][number]) => `${row.entryId}:${row.lineId}`}
                    columns={[
                        { key: "createdAt", label: t("Posted"), render: (row: WalletDetail["statementLines"][number]) => formatDateTime(row.createdAt) },
                        { key: "refType", label: t("Reference"), render: (row: WalletDetail["statementLines"][number]) => <StatusBadge status={row.refType} toneOverride="neutral" /> },
                        {
                            key: "debit",
                            label: t("Debit"),
                            align: "end",
                            render: (row: WalletDetail["statementLines"][number]) => (row.direction === "DEBIT" ? <MoneyDisplay amount={row.amount} currency={current.currency} size="sm" /> : <span style={{ color: "var(--pg-ink-faint)" }}>—</span>),
                        },
                        {
                            key: "credit",
                            label: t("Credit"),
                            align: "end",
                            render: (row: WalletDetail["statementLines"][number]) => (row.direction === "CREDIT" ? <MoneyDisplay amount={row.amount} currency={current.currency} size="sm" /> : <span style={{ color: "var(--pg-ink-faint)" }}>—</span>),
                        },
                        {
                            key: "entry",
                            label: t("Journal entry"),
                            render: (row: WalletDetail["statementLines"][number]) => (
                                <VBtn size="x-small" variant="text" style={{ textTransform: "none", paddingInline: "4px" }} onClick={() => (entryId.value = row.entryId)}>
                                    <span dir="ltr" style={{ fontFamily: "var(--pg-font-mono)", fontSize: "11.5px" }}>{row.entryId.slice(0, 8)}</span>
                                </VBtn>
                            ),
                        },
                    ]}
                />
            );

        const renderLinks = (current: WalletDetail): VNodeChild => (
            <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <h3 style={{ margin: 0, fontSize: "13px", fontWeight: 600 }}>{t("Assigned applications")}</h3>
                    <MiniTable
                        ariaLabel={t("Assigned applications")}
                        emptyLabel={t("No application is assigned to this wallet")}
                        rows={current.applications}
                        rowKey={(row: WalletDetail["applications"][number]) => row.id}
                        columns={[
                            {
                                key: "name",
                                label: t("Application"),
                                render: (row: WalletDetail["applications"][number]) => (
                                    <VBtn size="small" variant="text" style={{ textTransform: "none", paddingInline: "4px" }} onClick={() => (applicationId.value = row.id)}>
                                        {row.name}
                                    </VBtn>
                                ),
                            },
                            { key: "status", label: t("Status"), render: (row: WalletDetail["applications"][number]) => <StatusBadge status={row.status} toneOverride={toBadgeTone(row.status)} /> },
                        ]}
                    />
                </section>
                <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                        <h3 style={{ margin: 0, fontSize: "13px", fontWeight: 600 }}>{t("Recent cash-outs")}</h3>
                        <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => void router.push({ name: "CashOuts" })}>{t("Open cash-outs")}</VBtn>
                    </div>
                    {isRestricted(current.redactedFields, "cashouts") ? (
                        <RestrictedValue />
                    ) : (
                        <MiniTable
                            ariaLabel={t("Recent cash-outs")}
                            emptyLabel={t("No cash-outs yet")}
                            rows={current.cashouts}
                            rowKey={(row: WalletDetail["cashouts"][number]) => row.id}
                            columns={[
                                { key: "id", label: t("Cash-out"), render: (row: WalletDetail["cashouts"][number]) => <MonoRef value={row.id} truncate={10} /> },
                                { key: "state", label: t("State"), render: (row: WalletDetail["cashouts"][number]) => <StatusBadge status={row.state} toneOverride={toBadgeTone(row.state)} /> },
                                { key: "amount", label: t("Amount"), align: "end", render: (row: WalletDetail["cashouts"][number]) => <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" /> },
                                { key: "createdAt", label: t("Created"), render: (row: WalletDetail["cashouts"][number]) => formatDateTime(row.createdAt) },
                            ]}
                        />
                    )}
                </section>
            </div>
        );

        return (): VNodeChild => {
            const current = wallet.value;
            const open = props.walletId !== null;
            return (
                <>
                    <SlideOverDrawer
                        modelValue={open}
                        onUpdate:modelValue={(value: boolean) => {
                            if (!value) emit("close");
                        }}
                        title={current ? `${t("Wallet")} · ${current.currency}` : t("Wallet")}
                        subtitle={current ? current.merchant.tradeName || current.merchant.legalName : ""}
                        width={620}
                        v-slots={{
                            footer: () => (
                                <>
                                    {actions.value.map((action) => (
                                        <VBtn
                                            key={action.key}
                                            variant="tonal"
                                            color={action.danger ? "error" : "primary"}
                                            prependIcon={action.icon}
                                            disabled={action.disabled}
                                            {...{ title: action.disabledReason ? t(action.disabledReason) : undefined }}
                                            onClick={() => {
                                                modalError.value = "";
                                                pendingAction.value = action;
                                            }}
                                        >
                                            {t(action.label)}
                                        </VBtn>
                                    ))}
                                    <VBtn variant="text" onClick={() => emit("close")}>{t("Close")}</VBtn>
                                </>
                            ),
                        }}
                    >
                        {loading.value && !current ? (
                            <StateView loading />
                        ) : error.value ? (
                            <StateView error={error.value} onRetry={() => props.walletId && void load(props.walletId)} />
                        ) : current ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                                <SegmentedTabs
                                    modelValue={tab.value}
                                    ariaLabel={t("Wallet sections")}
                                    tabs={[
                                        { value: "overview", label: t("Overview and shards") },
                                        { value: "statement", label: t("Statement") },
                                        { value: "links", label: t("Links and cash-outs") },
                                    ]}
                                    onUpdate:modelValue={(value: string) => (tab.value = value as WalletTab)}
                                />
                                {tab.value === "overview" && renderOverview(current)}
                                {tab.value === "statement" && (
                                    <SurfaceCard noPadding>
                                        <SurfaceCardText>{renderStatement(current)}</SurfaceCardText>
                                    </SurfaceCard>
                                )}
                                {tab.value === "links" && renderLinks(current)}
                            </div>
                        ) : null}
                    </SlideOverDrawer>

                    <ReasonModal
                        modelValue={pendingAction.value !== null}
                        onUpdate:modelValue={(value: boolean) => {
                            if (!value) pendingAction.value = null;
                        }}
                        title={pendingAction.value ? t(pendingAction.value.label) : ""}
                        description={
                            pendingAction.value?.mode === "approval"
                                ? t("Restoring a frozen wallet needs an independent checker.")
                                : t("A frozen wallet cannot be debited by cash-outs until it is restored.")
                        }
                        mode={pendingAction.value?.mode ?? "immediate"}
                        danger={pendingAction.value?.danger ?? false}
                        submitLabel={pendingAction.value ? t(pendingAction.value.label) : ""}
                        loading={submitting.value}
                        errorMessage={modalError.value}
                        onSubmit={(reason: string) => void submit(reason)}
                    />

                    <GlAccountDrawer accountId={glAccountId.value} onClose={() => (glAccountId.value = null)} onChanged={() => props.walletId && void load(props.walletId)} />
                    <JournalEntryDrawer entryId={entryId.value} onClose={() => (entryId.value = null)} />
                    <ApplicationDetailDrawer applicationId={applicationId.value} onClose={() => (applicationId.value = null)} />
                </>
            );
        };
    },
});

export default WalletDetailDrawer;
