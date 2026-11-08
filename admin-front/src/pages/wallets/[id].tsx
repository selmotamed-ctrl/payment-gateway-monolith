import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VAlert, VBtn } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { MonoRef } from "@/components/ui/MonoRef";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import type { TableHeader } from "@/components/Table/types";
import type { TableFilter } from "@/components/Table/filters";
import { AccountLinesTable } from "@/components/ledger/AccountLinesTable";
import { GlAccountDrawer } from "@/components/ledger/GlAccountDrawer";
import { JournalEntryDrawer } from "@/components/ledger/JournalEntryDrawer";
import { flipToNatural } from "@/components/ledger/journalModel";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { isRestricted } from "@/pages/merchants/commerceGovernance";
import { notifyOutcome, reportCommerceError, runGoverned } from "@/pages/merchants/governedRequest";
import { ApplicationDetailDrawer } from "@/pages/merchants/components/ApplicationDetailDrawer";
import MerchantResourceTable from "@/pages/merchants/components/MerchantResourceTable";
import ReasonModal from "@/pages/merchants/components/ReasonModal";
import {
    ApprovalSubmittedNotice,
    MiniTable,
    PendingApprovalsList,
    RestrictedValue,
    formatDateTime,
    toBadgeTone,
} from "@/pages/merchants/components/commerceBits";
import { walletActionsFor, type WalletAction } from "./walletActions";
import { WALLET_TABS, parseWalletTab, postedSinceCheckpoint, shardIntegrity, shardTotalNatural, statusChangeOf, type WalletTab } from "./walletModel";
import type { WalletAuditEvent, WalletDetail } from "./types";

const AUDIT_ACTIONS = ["WALLET_FROZEN", "WALLET_UNFROZEN"];

const SECTION_TITLE = { margin: 0, fontSize: "13px", fontWeight: 600 } as const;

/**
 * Wallet details: balance, the paginated statement, shards, assigned applications, cash-outs and
 * the status history of one wallet. Freezing is immediate (reason, audited); unfreezing is
 * submitted for four-eyes approval (HTTP 202). Tab and statement paging survive a refresh.
 */
const WalletDetailPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();

    const walletId = computed(() => String(route.params.id ?? ""));
    const wallet = ref<WalletDetail | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const notice = ref<{ approvalRequestId: string | null } | null>(null);
    const pendingAction = ref<WalletAction | null>(null);
    const submitting = ref(false);
    const modalError = ref("");
    const glAccountId = ref<string | null>(null);
    const entryId = ref<string | null>(null);
    const applicationId = ref<string | null>(null);
    const statement = ref<{ refresh: () => void } | null>(null);
    let sequence = 0;

    const canWrite = computed(() => hasOneOfAuthorities(["merchant:write"]));
    const tab = computed<WalletTab>(() => parseWalletTab(route.query.tab));
    const setTab = (value: string) => {
        const { tab: _previous, ...rest } = route.query;
        void router.replace({ query: value === "overview" ? rest : { ...rest, tab: value } });
    };

    const load = async (id: string, silent = false) => {
        const current = ++sequence;
        if (!silent) loading.value = true;
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
        walletId,
        (id) => {
            notice.value = null;
            pendingAction.value = null;
            wallet.value = null;
            if (id) void load(id);
        },
        { immediate: true },
    );

    const refreshAll = () => {
        void load(walletId.value, true);
        statement.value?.refresh();
    };

    const actions = computed(() =>
        wallet.value
            ? walletActionsFor(wallet.value.status, { canWrite: canWrite.value, hasPendingApproval: wallet.value.pendingApprovals.length > 0 })
            : [],
    );

    const submit = async (reason: string) => {
        const action = pendingAction.value;
        const current = wallet.value;
        if (!action || !current) return;
        submitting.value = true;
        modalError.value = "";
        try {
            const outcome = await runGoverned(() => api.post(urlsMap.walletStatus(current.id), { status: action.targetStatus, reason }));
            notifyOutcome(outcome, "Wallet frozen");
            notice.value = outcome.kind === "approval" ? { approvalRequestId: outcome.approvalRequestId } : null;
            pendingAction.value = null;
            refreshAll();
        } catch (cause) {
            modalError.value = reportCommerceError(cause);
        } finally {
            submitting.value = false;
        }
    };

    const merchantName = (current: WalletDetail) => current.merchant.tradeName || current.merchant.legalName;
    const moneyRestricted = (current: WalletDetail) => isRestricted(current.redactedFields, "liveBalance", current.liveBalance);
    const statementRestricted = (current: WalletDetail) => isRestricted(current.redactedFields, "statementLines");

    const metrics = (current: WalletDetail): MetricItem[] => {
        const restricted = moneyRestricted(current);
        const since = postedSinceCheckpoint(current.liveBalance, current.checkpointBalance);
        const money = (key: string, label: string, amount: string | null, extra: Partial<MetricItem> = {}): MetricItem =>
            restricted || amount === null
                ? { key, label, value: t("Restricted"), subLabel: t("Hidden for your role"), ...extra }
                : { key, label, moneyAmount: amount, currency: current.currency, ...extra };
        return [
            money("live", t("Live balance"), current.liveBalance, { subLabel: t("Owed to the merchant") }),
            money("checkpoint", t("Checkpoint balance"), current.checkpointBalance, {
                subLabel: current.glAccount.checkpointAt ? `${t("Taken")} ${formatDateTime(current.glAccount.checkpointAt)}` : t("No checkpoint yet"),
            }),
            money("since", t("Posted since checkpoint"), since),
            {
                key: "cashouts",
                label: t("Pending cash-outs"),
                value: String(current.pendingCashoutCount),
                badge: current.pendingCashoutCount > 0 ? t("Pending") : t("Clear"),
                badgeTone: current.pendingCashoutCount > 0 ? "warning" : "success",
            },
        ];
    };

    const th = (label: string, align: "start" | "end" = "start") => <th style={{ textAlign: align }}>{label}</th>;

    const renderShards = (current: WalletDetail) => {
        if (isRestricted(current.redactedFields, "shards")) return <RestrictedValue />;
        const integrity = shardIntegrity(current.glAccount.accountType, current.shards, current.liveBalance);
        const natural = (stored: string) => flipToNatural(current.glAccount.accountType, stored);
        const total = shardTotalNatural(current.glAccount.accountType, current.shards);
        return (
            <SurfaceCard
                title={t("Shards")}
                subtitle={t("A busy account is split into parts so many payments can post at once; the parts add up to the live balance.")}
                noPadding
            >
                {current.shards.length === 0 ? (
                    <EmptyState title={t("No shards recorded")} description={t("This wallet has no shard rows; its balance derives from the journal since the last checkpoint.")} />
                ) : (
                    <>
                        {integrity && (
                            <div style={{ padding: "10px 20px", borderBottom: "1px solid var(--pg-border-subtle)" }}>
                                {integrity.matches ? (
                                    <StatusBadge status="SUCCESS" label={t("Shards agree with the live balance")} toneOverride="success" />
                                ) : (
                                    <StatusBadge status="DRIFT" label={`${t("Shards differ from the live balance")} · ${t("Drift")}: ${integrity.drift}`} toneOverride="danger" />
                                )}
                            </div>
                        )}
                        <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse" }} aria-label={t("Shard distribution")}>
                                <thead>
                                    <tr>
                                        {th(t("Shard"))}
                                        {th(t("Balance"), "end")}
                                        {th(t("Updated"))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {current.shards.map((shard) => (
                                        <tr key={String(shard.shardId)}>
                                            <td class="pg-tabular">#{String(shard.shardId)}</td>
                                            <td style={{ textAlign: "end" }}>
                                                <MoneyDisplay amount={natural(shard.currentBalance)} currency={current.currency} size="sm" showCurrency={false} />
                                            </td>
                                            <td>{formatDateTime(shard.updatedAt)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                                <tfoot>
                                    <tr>
                                        <td>{t("Total")}</td>
                                        <td style={{ textAlign: "end" }}>
                                            <MoneyDisplay amount={total} currency={current.currency} size="sm" showCurrency={false} />
                                        </td>
                                        <td />
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    </>
                )}
            </SurfaceCard>
        );
    };

    const renderOverview = (current: WalletDetail) => (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "18px", alignItems: "start" }}>
            <SurfaceCard title={t("Wallet")} noPadding>
                <div style={{ padding: "4px 20px 16px" }}>
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
                                        {merchantName(current)}
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
                                        <VBtn size="x-small" variant="text" icon="mdi-open-in-new" aria-label={t("Inspect GL account")} onClick={() => (glAccountId.value = current.glAccountId)} />
                                    </span>
                                ),
                            },
                            { label: t("Shard width"), value: current.glAccount.shardCount === undefined ? "—" : String(current.glAccount.shardCount) },
                            { label: t("Applications"), value: String(current.applicationCount) },
                            { label: t("Payment links"), value: String(current.paymentLinkCount) },
                            { label: t("Created"), value: formatDateTime(current.createdAt) },
                        ]}
                    />
                </div>
            </SurfaceCard>
            {renderShards(current)}
        </div>
    );

    const renderStatement = (current: WalletDetail) =>
        statementRestricted(current) ? (
            <SurfaceCard>
                <EmptyState icon="mdi-lock-outline" title={t("Restricted")} description={t("The ledger statement is hidden for your role.")} />
            </SurfaceCard>
        ) : (
            <SurfaceCard title={t("Statement")} subtitle={t("Every posting to this wallet's ledger account, newest first.")} noPadding>
                <AccountLinesTable
                    ref={statement}
                    key={current.id}
                    url={urlsMap.walletStatement(current.id)}
                    currency={current.currency}
                    accountType={current.glAccount.accountType}
                    pageSize={25}
                    noElevation
                    onOpenEntry={(id: string) => (entryId.value = id)}
                />
            </SurfaceCard>
        );

    const renderLinks = (current: WalletDetail) => (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "18px", alignItems: "start" }}>
            <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <h3 style={SECTION_TITLE}>{t("Assigned applications")}</h3>
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
                    <h3 style={SECTION_TITLE}>{t("Recent cash-outs")}</h3>
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

    const activityFilters: TableFilter[] = [
        {
            key: "action",
            label: "Action",
            type: "data-autocomplete",
            multiple: true,
            options: AUDIT_ACTIONS.map((value) => ({ title: value.replaceAll("_", " "), value })),
        },
        { key: "date", label: "When", type: "date", queryFrom: "from", queryTo: "to" },
    ];

    const activityHeaders = (): TableHeader<WalletAuditEvent>[] => [
        {
            key: "createdAt",
            label: "When",
            sortKey: "createdAt",
            value: (row) => row.createdAt,
            Value: ({ row }: { row: WalletAuditEvent }) => <span class="pg-tabular">{formatDateTime(row.createdAt)}</span>,
        },
        {
            key: "action",
            label: "Action",
            sortKey: "action",
            value: (row) => row.action,
            Value: ({ row }: { row: WalletAuditEvent }) => <StatusBadge status={row.action} label={row.action.replaceAll("_", " ")} toneOverride={row.action === "WALLET_FROZEN" ? "danger" : "success"} />,
        },
        {
            key: "change",
            label: "Change",
            sortable: false,
            value: (row) => {
                const change = statusChangeOf(row);
                return change.from || change.to ? `${change.from ?? "—"} → ${change.to ?? "—"}` : "";
            },
            Value: ({ row }: { row: WalletAuditEvent }) => {
                const change = statusChangeOf(row);
                if (row.redacted && !change.from && !change.to) return <RestrictedValue />;
                return (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                        <StatusBadge status={change.from ?? "UNKNOWN"} label={change.from ?? "—"} toneOverride={toBadgeTone(change.from ?? "")} showDot={false} />
                        <span aria-hidden="true">→</span>
                        <StatusBadge status={change.to ?? "UNKNOWN"} label={change.to ?? "—"} toneOverride={toBadgeTone(change.to ?? "")} showDot={false} />
                    </span>
                );
            },
        },
        {
            key: "reason",
            label: "Reason",
            sortable: false,
            value: (row) => statusChangeOf(row).reason ?? "",
            Value: ({ row }: { row: WalletAuditEvent }) => {
                const reason = statusChangeOf(row).reason;
                if (reason) {
                    return (
                        <span title={reason} style={{ display: "inline-block", maxWidth: "360px", overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "bottom" }}>
                            {reason}
                        </span>
                    );
                }
                return row.redacted ? <RestrictedValue /> : <span style={{ color: "var(--pg-ink-faint)" }}>—</span>;
            },
        },
        {
            key: "actor",
            label: "By",
            sortable: false,
            value: (row) => row.actorEmail,
            Value: ({ row }: { row: WalletAuditEvent }) => (
                <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 1.25 }}>
                    <span>{row.actorEmail}</span>
                    <span style={{ fontSize: "11px", color: "var(--pg-ink-muted)" }}>{row.role.replaceAll("_", " ")}</span>
                </span>
            ),
        },
        {
            key: "approval",
            label: "Approval",
            sortable: false,
            value: (row) => row.approvalRequestId ?? "",
            Value: ({ row }: { row: WalletAuditEvent }) =>
                row.approvalRequestId ? (
                    <VBtn size="x-small" variant="text" style={{ textTransform: "none" }} onClick={() => void router.push({ name: "Approvals", query: { open: row.approvalRequestId! } })}>
                        {t("Open in Approvals")}
                    </VBtn>
                ) : (
                    <span style={{ color: "var(--pg-ink-faint)" }}>—</span>
                ),
        },
    ];

    const renderActivity = (current: WalletDetail) => (
        <MerchantResourceTable<WalletAuditEvent>
            key={current.id}
            title="Status history"
            url={urlsMap.walletAuditEvents(current.id)}
            listKey="auditEvents"
            headers={activityHeaders()}
            filters={activityFilters}
            pageSize={10}
        />
    );

    const frozenBanner = (current: WalletDetail) => {
        if (current.status !== "FROZEN") return null;
        const waiting = current.pendingApprovals.length > 0;
        return (
            <VAlert type="warning" variant="tonal" density="comfortable" icon="mdi-snowflake">
                {t("This wallet is frozen. Cash-outs cannot debit it until it is restored.")}{" "}
                {waiting ? t("A request to restore it is waiting for approval.") : t("Restoring it needs an independent checker.")}
            </VAlert>
        );
    };

    return () => {
        const current = wallet.value;
        const title = current ? merchantName(current) : t("Wallet");
        return (
            <ScreenContainer>
                <ThemedView style={{ gap: "18px" }}>
                    <PageHeader
                        title={title}
                        subtitle={current ? `${t("Wallet")} · ${current.currency}` : ""}
                        badge={current ? current.status.replaceAll("_", " ") : ""}
                        badgeTone={current ? toBadgeTone(current.status) : "neutral"}
                        end={() => (
                            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
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
                                <VBtn variant="text" prependIcon="mdi-arrow-left" onClick={() => void router.push({ name: "Wallets" })}>{t("Back to wallets")}</VBtn>
                                <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={refreshAll}>{t("Refresh")}</VBtn>
                            </ThemedView>
                        )}
                    />

                    {error.value ? (
                        <StateView error={error.value} onRetry={() => void load(walletId.value)} />
                    ) : loading.value && !current ? (
                        <StateView loading />
                    ) : current ? (
                        <>
                            {notice.value && <ApprovalSubmittedNotice approvalRequestId={notice.value.approvalRequestId} onDismiss={() => (notice.value = null)} />}
                            {frozenBanner(current)}
                            {current.pendingApprovals.length > 0 && (
                                <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                    <h3 style={SECTION_TITLE}>{t("Pending approvals")}</h3>
                                    <PendingApprovalsList approvals={current.pendingApprovals} />
                                </section>
                            )}
                            <MetricStrip items={metrics(current)} />
                            <SegmentedTabs
                                modelValue={tab.value}
                                ariaLabel={t("Wallet sections")}
                                tabs={WALLET_TABS.map((value) => ({
                                    value,
                                    label: {
                                        overview: t("Overview and shards"),
                                        statement: t("Statement"),
                                        links: t("Links and cash-outs"),
                                        activity: t("Status history"),
                                    }[value],
                                }))}
                                onUpdate:modelValue={setTab}
                            />
                            {tab.value === "overview" && renderOverview(current)}
                            {tab.value === "statement" && renderStatement(current)}
                            {tab.value === "links" && renderLinks(current)}
                            {tab.value === "activity" && renderActivity(current)}
                        </>
                    ) : null}
                </ThemedView>

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

                <GlAccountDrawer accountId={glAccountId.value} onClose={() => (glAccountId.value = null)} onChanged={refreshAll} />
                <JournalEntryDrawer entryId={entryId.value} onClose={() => (entryId.value = null)} />
                <ApplicationDetailDrawer applicationId={applicationId.value} onClose={() => (applicationId.value = null)} />
            </ScreenContainer>
        );
    };
});

export default WalletDetailPage;
