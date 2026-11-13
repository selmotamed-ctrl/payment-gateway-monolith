import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import type { MetricItem } from "@/components/ui/MetricStrip";
import { StateView } from "@/components/StateView";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { EmptyState } from "@/components/ui/EmptyState";
import { SandboxBanner } from "@/components/sandbox/SandboxBanner";
import SandboxResourceTable from "@/components/sandbox/SandboxResourceTable";
import { accountFilters, ACCOUNT_STATUS } from "@/components/sandbox/sandboxFilters";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { TableRowActions } from "@/components/Table/TableRowActions";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { SectionFields } from "@/components/SectionFields";
import { sandboxFakeRails, type FakeRailsAccountRow, type FakeRailsScenario, type FakeRailsTransactionRow } from "@/api/sandbox";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { xlsxUIPipeline } from "@/utils/xlsx";

type Tab = "ACCOUNTS" | "CLEARING" | "CHAOS" | "TRANSACTIONS" | "WEBHOOKS";

const AdminFakeRailsPage = dc(() => {
    const { t } = useLocale();
    const tab = ref<Tab>("ACCOUNTS");
    const loading = ref(true);
    const error = ref<string | null>(null);
    const busy = ref<string | null>(null);
    const accountsSummary = ref<Record<string, unknown> | null>(null);
    const accountsRefresh = ref<(() => void) | null>(null);
    const selectedAccount = ref<FakeRailsAccountRow | null>(null);
    const accountDrawer = ref(false);
    const movements = ref<Array<Record<string, unknown>>>([]);
    const holds = ref<Array<Record<string, unknown>>>([]);
    const exact = ref<Record<string, string>>({});
    const scenarios = ref<FakeRailsScenario[]>([]);
    const editScenario = ref<FakeRailsScenario | null>(null);
    const scenarioForm = ref({ failure: "0", latencyMin: "20", latencyMax: "120", autoApprove: "" });
    const statements = ref<Array<Record<string, unknown>>>([]);
    const deliveries = ref<Array<Record<string, unknown>>>([]);
    const pools = ref<Array<Record<string, unknown>>>([]);
    const statementGateway = ref("");
    const statementFrom = ref("");
    const statementTo = ref("");
    const statementResult = ref<Record<string, unknown> | null>(null);
    const transactionDetail = ref<Record<string, unknown> | null>(null);
    const transactionDrawer = ref(false);
    const transactionEvents = ref<Array<Record<string, unknown>>>([]);
    const transactionDeliveries = ref<Array<Record<string, unknown>>>([]);
    const transactionsRefresh = ref<(() => void) | null>(null);
    const exportLoading = ref(false);
    const createOpen = ref(false);
    const creating = ref(false);
    const createError = ref("");
    const createForm = ref({ railCode: "", gatewayCode: "", instrumentType: "CARD", identifier: "", holderName: "", secretPin: "1234", expiry: "12/28", availableBalanceLyd: "5000.0000", dailyLimitLyd: "10000.0000" });
    const clearingRows = computed(() => ((statementResult.value?.rows as Array<Record<string, unknown>> | undefined) ?? []));

    const loadAccountsSummary = async () => {
        try {
            const data = await sandboxFakeRails.accountsSummary();
            accountsSummary.value = data.summary;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        }
    };

    const loadScenarios = async () => {
        loading.value = true; error.value = null;
        try { scenarios.value = (await sandboxFakeRails.scenarios()).scenarios ?? []; }
        catch (e) { error.value = extractApiErrorMessage(e); }
        finally { loading.value = false; }
    };
    const loadWebhooks = async () => {
        loading.value = true; error.value = null;
        try { deliveries.value = (await sandboxFakeRails.webhooks()).deliveries ?? []; }
        catch (e) { error.value = extractApiErrorMessage(e); }
        finally { loading.value = false; }
    };
    const loadClearing = async () => {
        loading.value = true; error.value = null;
        try {
            const [poolData, statementData] = await Promise.all([sandboxFakeRails.clearingPools(), sandboxFakeRails.statements()]);
            pools.value = poolData.pools ?? [];
            statements.value = statementData.statements ?? [];
        } catch (e) { error.value = extractApiErrorMessage(e); }
        finally { loading.value = false; }
    };

    const load = () => {
        if (tab.value === "ACCOUNTS") void loadAccountsSummary();
        else if (tab.value === "CHAOS") void loadScenarios();
        else if (tab.value === "CLEARING") void loadClearing();
        else if (tab.value === "WEBHOOKS") void loadWebhooks();
        else void transactionsRefresh.value?.();
    };
    void load();
    watch(tab, () => load());

    const accountMetrics = computed<MetricItem[]>(() => {
        const data = accountsSummary.value ?? {};
        const status = (data.status ?? {}) as Record<string, number>;
        return [
            { key: "total", label: t("Test accounts"), value: String(data.total ?? 0) },
            { key: "merchant", label: t("Merchant copies"), value: String(data.merchant ?? 0) },
            { key: "global", label: t("Shared presets"), value: String(data.global ?? 0) },
            { key: "active", label: t("Active"), value: String(status.ACTIVE ?? 0) },
            { key: "available", label: t("Available"), moneyAmount: String(data.available ?? "0"), currency: "LYD" },
            { key: "held", label: t("Held"), moneyAmount: String(data.held ?? "0"), currency: "LYD" },
        ];
    });

    const openAccount = async (row: FakeRailsAccountRow) => {
        selectedAccount.value = row;
        accountDrawer.value = true;
        busy.value = `detail:${row.id}`;
        try {
            const [account, movementData] = await Promise.all([
                sandboxFakeRails.accounts({ search: row.identifier, includeGlobal: true, page: 1, pageSize: 5 }),
                sandboxFakeRails.movements(row.id),
            ]);
            selectedAccount.value = account.accounts.find((entry) => entry.id === row.id) ?? row;
            movements.value = movementData.movements ?? [];
            holds.value = movementData.holds ?? [];
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally { busy.value = null; }
    };

    const patchAccount = async (row: FakeRailsAccountRow, body: Record<string, unknown>, message = t("Test account updated")) => {
        busy.value = row.id;
        try {
            await sandboxFakeRails.adjustAccount(row.id, { ...body, merchantId: row.merchant_id ?? undefined });
            showSnackBar({ type: "success", message });
            accountsRefresh.value?.();
            await loadAccountsSummary();
        } catch (e) { showSnackBar({ type: "error", message: extractApiErrorMessage(e) }); }
        finally { busy.value = null; }
    };

    const accountHeaders: TableHeader<FakeRailsAccountRow>[] = [
        { key: "scope", label: "Scope", Value: ({ row }) => <StatusBadge status={row.merchant_id ? "MERCHANT" : "GLOBAL"} toneOverride={row.merchant_id ? "info" : "neutral"} /> },
        { key: "rail_code", label: "Rail / gateway", value: (row) => `${row.rail_code} / ${row.gateway_code}` },
        { key: "holder_name", label: "Holder", value: (row) => row.holder_name },
        { key: "identifier", label: "Identifier", Value: ({ row }) => <MonoRef value={row.identifier} truncate={18} /> },
        { key: "instrument_type", label: "Type", value: (row) => row.instrument_type },
        { key: "available_balance_lyd", label: "Available", Value: ({ row }) => <MoneyDisplay amount={row.available_balance_lyd} currency="LYD" size="sm" /> },
        { key: "reserved_balance_lyd", label: "Held", Value: ({ row }) => <MoneyDisplay amount={row.reserved_balance_lyd} currency="LYD" size="sm" /> },
        { key: "daily", label: "Daily", value: (row) => `${row.daily_spent_lyd} / ${row.daily_limit_lyd}` },
        { key: "status", label: "Status", Value: ({ row }) => <StatusBadge status={row.status} toneOverride={row.status === "ACTIVE" ? "success" : "warning"} /> },
        { key: "actions", label: "Actions", Value: ({ row }) => <TableRowActions primaryAction={{ label: t("Inspect"), icon: "mdi-eye-outline", onClick: () => void openAccount(row) }} items={[
            { key: "topup", label: t("+1,000 LYD"), icon: "mdi-plus", onClick: () => void patchAccount(row, { deltaLyd: "1000.0000" }) },
            { key: "zero", label: t("Drain"), icon: "mdi-arrow-down", danger: true, onClick: () => void patchAccount(row, { availableBalanceLyd: "0.0000" }) },
            { key: "daily", label: t("Reset daily spent"), icon: "mdi-calendar-refresh", onClick: () => void patchAccount(row, { quickPreset: "RESET_DAILY_SPENT" }) },
            { key: "status", label: row.status === "ACTIVE" ? t("Freeze") : t("Activate"), icon: row.status === "ACTIVE" ? "mdi-pause" : "mdi-play", onClick: () => void patchAccount(row, { status: row.status === "ACTIVE" ? "FROZEN" : "ACTIVE" }) },
        ]} /> },
    ];

    const scenarioHeaders: TableHeader<FakeRailsScenario>[] = [
        { key: "railCode", label: "Rail / gateway", value: (row) => `${row.railCode} / ${row.gatewayCode}` },
        { key: "enabled", label: "Enabled", Value: ({ row }) => <StatusBadge status={row.enabled ? "ENABLED" : "DISABLED"} toneOverride={row.enabled ? "success" : "danger"} /> },
        { key: "failure", label: "Failure %", value: (row) => String(row.overallFailureChancePercent) },
        { key: "latency", label: "Latency", value: (row) => `${row.latencyMs.min}–${row.latencyMs.max} ms` },
        { key: "auto", label: "Auto-approve", value: (row) => row.autoApproveAsyncAfterSec === null ? "—" : `${row.autoApproveAsyncAfterSec}s` },
        { key: "webhook", label: "Webhook", value: (row) => `${row.webhookBehavior.delaySeconds}s delay · ${row.webhookBehavior.duplicateCount} copies` },
        { key: "actions", label: "Actions", Value: ({ row }) => <TableRowActions primaryAction={{ label: t("Edit"), icon: "mdi-pencil-outline", onClick: () => { editScenario.value = row; scenarioForm.value = { failure: String(row.overallFailureChancePercent), latencyMin: String(row.latencyMs.min), latencyMax: String(row.latencyMs.max), autoApprove: row.autoApproveAsyncAfterSec === null ? "" : String(row.autoApproveAsyncAfterSec) }; } }} items={[
            { key: "healthy", label: t("Healthy preset"), icon: "mdi-check", onClick: () => void sandboxFakeRails.preset(row.railCode, "healthy").then(loadScenarios) },
            { key: "flaky", label: t("Flaky preset"), icon: "mdi-flash", onClick: () => void sandboxFakeRails.preset(row.railCode, "flaky").then(loadScenarios) },
            { key: "outage", label: t("Outage preset"), icon: "mdi-close-octagon", danger: true, onClick: () => void sandboxFakeRails.preset(row.railCode, "outage").then(loadScenarios) },
        ]} /> },
    ];

    const transactionHeaders: TableHeader<FakeRailsTransactionRow>[] = [
        { key: "rail_code", label: "Rail / gateway", value: (row) => `${row.rail_code} / ${row.gateway_code}` },
        { key: "our_reference", label: "Reference", Value: ({ row }) => <MonoRef value={row.our_reference} truncate={18} /> },
        { key: "normalized_amount_lyd", label: "Amount", Value: ({ row }) => <MoneyDisplay amount={row.normalized_amount_lyd} currency={row.currency} size="sm" /> },
        { key: "status", label: "Status", Value: ({ row }) => <StatusBadge status={row.status} /> },
        { key: "collection_mode", label: "Mode", value: (row) => row.collection_mode },
        { key: "created_at", label: "Created", value: (row) => row.created_at },
        { key: "actions", label: "Actions", Value: ({ row }) => <TableRowActions primaryAction={{ label: t("Inspect"), icon: "mdi-text-search", onClick: () => void openTransaction(row) }} items={[
            { key: "approve", label: t("Approve"), icon: "mdi-check", onClick: () => void sandboxFakeRails.transactionAction(row.id, { action: "APPROVE" }).then(loadTransactions) },
            { key: "reject", label: t("Reject"), icon: "mdi-close", danger: true, onClick: () => void sandboxFakeRails.transactionAction(row.id, { action: "REJECT" }).then(loadTransactions) },
            { key: "mismatch", label: t("Approve mismatch"), icon: "mdi-scale-balance", onClick: () => void sandboxFakeRails.transactionAction(row.id, { action: "APPROVE_MISMATCH" }).then(loadTransactions) },
            { key: "late", label: t("Approve late"), icon: "mdi-clock-check", onClick: () => void sandboxFakeRails.transactionAction(row.id, { action: "APPROVE_LATE" }).then(loadTransactions) },
            { key: "force", label: t("Force decline"), icon: "mdi-flash-off", danger: true, onClick: () => void sandboxFakeRails.transactionAction(row.id, { action: "FORCE_OUTCOME", phase: "SUBMIT", failureMode: "TERMINAL_DECLINE_INSUFFICIENT_FUNDS" }).then(loadTransactions) },
            { key: "cancel", label: t("Cancel"), icon: "mdi-cancel", onClick: () => void sandboxFakeRails.transactionAction(row.id, { action: "CANCEL" }).then(loadTransactions) },
        ]} /> },
    ];

    const openTransaction = async (row: FakeRailsTransactionRow) => {
        transactionDrawer.value = true;
        busy.value = `transaction:${row.id}`;
        try {
            const data = await sandboxFakeRails.transaction(row.id);
            transactionDetail.value = data;
            transactionEvents.value = (data.events as Array<Record<string, unknown>>) ?? [];
            transactionDeliveries.value = (data.deliveries as Array<Record<string, unknown>>) ?? [];
        } catch (e) { showSnackBar({ type: "error", message: extractApiErrorMessage(e) }); }
        finally { busy.value = null; }
    };

    const loadTransactions = async () => {
        transactionsRefresh.value?.();
    };

    const createAccount = async () => {
        if (!createForm.value.railCode.trim() || !createForm.value.gatewayCode.trim() || !createForm.value.identifier.trim() || !createForm.value.holderName.trim()) {
            createError.value = t("Rail, gateway, identifier and holder are required");
            return;
        }
        creating.value = true;
        createError.value = "";
        try {
            await sandboxFakeRails.createAccount({
                railCode: createForm.value.railCode.trim(),
                gatewayCode: createForm.value.gatewayCode.trim(),
                instrumentType: createForm.value.instrumentType,
                identifier: createForm.value.identifier.trim(),
                holderName: createForm.value.holderName.trim(),
                secretPin: createForm.value.secretPin,
                expiry: createForm.value.expiry,
                availableBalanceLyd: createForm.value.availableBalanceLyd,
                dailyLimitLyd: createForm.value.dailyLimitLyd,
            });
            createOpen.value = false;
            showSnackBar({ type: "success", message: t("Test account created") });
            accountsRefresh.value?.();
            await loadAccountsSummary();
        } catch (e) { createError.value = extractApiErrorMessage(e); }
        finally { creating.value = false; }
    };

    const generateClearing = async () => {
        if (!statementGateway.value) { error.value = t("Choose a gateway first."); return; }
        busy.value = "statement";
        try {
            statementResult.value = await sandboxFakeRails.generateClearing({ gatewayCode: statementGateway.value, from: statementFrom.value || undefined, to: statementTo.value || undefined, includeIncluded: false });
            showSnackBar({ type: "success", message: t("Settlement statement generated") });
            await loadClearing();
        } catch (e) { error.value = extractApiErrorMessage(e); }
        finally { busy.value = null; }
    };
    const settle = async () => {
        busy.value = "settle";
        try { await sandboxFakeRails.settleClearing({ gatewayCode: statementGateway.value || undefined }); showSnackBar({ type: "success", message: t("Clearing pools settled") }); await loadClearing(); }
        catch (e) { error.value = extractApiErrorMessage(e); }
        finally { busy.value = null; }
    };

    const saveScenario = async () => {
        if (!editScenario.value) return;
        busy.value = editScenario.value.railCode;
        try {
            await sandboxFakeRails.updateScenario(editScenario.value.railCode, { overallFailureChancePercent: Number(scenarioForm.value.failure), latencyMs: { min: Number(scenarioForm.value.latencyMin), max: Number(scenarioForm.value.latencyMax) }, autoApproveAsyncAfterSec: scenarioForm.value.autoApprove === "" ? null : Number(scenarioForm.value.autoApprove) });
            editScenario.value = null;
            await loadScenarios();
        } catch (e) { showSnackBar({ type: "error", message: extractApiErrorMessage(e) }); }
        finally { busy.value = null; }
    };

    const exportAccounts = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            await xlsxUIPipeline.downloadXlsxFromCsvLines({ title: `fake-rails-accounts-summary-${new Date().toISOString().slice(0, 10)}.xlsx`, lines: ["metric,value", ...accountMetrics.value.map((item) => `${escape(item.label)},${escape(item.value ?? item.moneyAmount ?? "")}`)] });
        } catch (e) { showSnackBar({ type: "error", message: extractApiErrorMessage(e) }); }
        finally { exportLoading.value = false; }
    };

    return () => (
        <ScreenContainer>
            <PageHeader title={t("Fake Rails Accounts & Clearing")} subtitle={t("Global test customers, balances, states, chaos and synthetic settlements.")} badge="SANDBOX" badgeTone="warning" end={() => <div class="d-flex flex-wrap ga-2"><VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => load()}>{t("Refresh")}</VBtn><VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportAccounts()}>{t("Export summary")}</VBtn></div>} />
            <SandboxBanner />
            <div class="mb-4"><SegmentedTabs modelValue={tab.value} tabs={[{ label: t("Accounts"), value: "ACCOUNTS" }, { label: t("Clearing"), value: "CLEARING" }, { label: t("Chaos"), value: "CHAOS" }, { label: t("Transactions"), value: "TRANSACTIONS" }, { label: t("Webhooks"), value: "WEBHOOKS" }]} onUpdate:modelValue={(value: string) => (tab.value = value as Tab)} /></div>
            {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
            <StateView loading={loading.value && !accountsSummary.value} minHeight="180px">
                {tab.value === "ACCOUNTS" ? <div class="d-flex flex-column ga-4">
                    <SummaryExportCard title={t("Test account health")} metrics={accountMetrics.value} exportLoading={exportLoading.value} exportLabel={t("Export summary")} onExport={() => void exportAccounts()}>
                        <div class="d-flex flex-wrap ga-2">
                            <VBtn variant="tonal" onClick={() => void sandboxFakeRails.resetAccounts().then(() => { accountsRefresh.value?.(); void loadAccountsSummary(); })}>{t("Reset accounts to defaults")}</VBtn>
                            <VBtn color="primary" prependIcon="mdi-plus" onClick={() => { createError.value = ""; createOpen.value = true; }}>{t("Create test account")}</VBtn>
                        </div>
                    </SummaryExportCard>
                    <SandboxResourceTable<FakeRailsAccountRow> title={t("Fake Rails accounts")} url="/v1/admin/sandbox/fake-rails/accounts" listKey="accounts" headers={accountHeaders} filters={accountFilters()} pageSize={20} showNumber={true} onRefreshReady={(next) => (accountsRefresh.value = next)} />
                </div> : null}
                {tab.value === "CLEARING" ? <div class="d-flex flex-column ga-4">
                    <SurfaceCard title={t("Settlement statements")}>
                        <div class="d-flex flex-wrap ga-2 align-center">
                            <VTextField density="compact" variant="outlined" hideDetails label={t("Gateway")} modelValue={statementGateway.value} onUpdate:modelValue={(v: string) => (statementGateway.value = v)} />
                            <VTextField type="date" density="compact" variant="outlined" hideDetails label={t("From")} modelValue={statementFrom.value} onUpdate:modelValue={(v: string) => (statementFrom.value = v)} />
                            <VTextField type="date" density="compact" variant="outlined" hideDetails label={t("To")} modelValue={statementTo.value} onUpdate:modelValue={(v: string) => (statementTo.value = v)} />
                            <VBtn color="primary" loading={busy.value === "statement"} onClick={() => void generateClearing()}>{t("Generate")}</VBtn>
                            <VBtn variant="tonal" loading={busy.value === "settle"} onClick={() => void settle()}>{t("Settle pools")}</VBtn>
                        </div>
                        {clearingRows.value.length > 0 ? <div class="mt-3"><DataTable title={t("Generated settlement lines")} data={clearingRows.value} headers={[{ key: "ourReference", label: "Our reference", value: (row) => String(row.ourReference ?? "") }, { key: "providerReference", label: "Provider reference", value: (row) => String(row.providerReference ?? "") }, { key: "amountLyd", label: "Amount", value: (row) => String(row.amountLyd ?? "") }, { key: "gatewayFeeLyd", label: "Fee", value: (row) => String(row.gatewayFeeLyd ?? "") }]} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={10} /></div> : null}
                    </SurfaceCard>
                    <DataTable title={t("Statements")} data={statements.value} headers={[{ key: "gateway_code", label: "Gateway", value: (row) => String(row.gateway_code ?? "") }, { key: "format", label: "Format", value: (row) => String(row.format ?? "") }, { key: "row_count", label: "Rows", value: (row) => String(row.row_count ?? "") }, { key: "created_at", label: "Created", value: (row) => String(row.created_at ?? "") }]} loading={false} showNumber={true} xlsx={false} noElevation={true} numberOfItemsPerPage={10} />
                    <DataTable title={t("Clearing pools")} data={pools.value} headers={[{ key: "gateway_code", label: "Gateway", value: (row) => String(row.gateway_code ?? "") }, { key: "rail_code", label: "Rail", value: (row) => String(row.rail_code ?? "") }, { key: "pending_settlement_lyd", label: "Pending", value: (row) => String(row.pending_settlement_lyd ?? "") }, { key: "settled_lyd", label: "Settled", value: (row) => String(row.settled_lyd ?? "") }, { key: "tx_count", label: "Transactions", value: (row) => String(row.tx_count ?? "") }]} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={10} />
                </div> : null}
                {tab.value === "CHAOS" ? <DataTable title={t("Chaos scenarios")} data={scenarios.value} headers={scenarioHeaders} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={50} /> : null}
                {tab.value === "WEBHOOKS" ? <DataTable title={t("Webhook deliveries")} data={deliveries.value} headers={[{ key: "created_at", label: "Date", value: (row) => String(row.created_at ?? "") }, { key: "event", label: "Event", value: (row) => String(row.event ?? row.event_type ?? "") }, { key: "status", label: "Status", value: (row) => String(row.status ?? "") }, { key: "attempts", label: "Attempts", value: (row) => String(row.attempts ?? "") }, { key: "response_status", label: "Response", value: (row) => String(row.response_status ?? row.status_code ?? "") }]} loading={false} showNumber={true} xlsx={false} noElevation={true} numberOfItemsPerPage={25} /> : null}
                {tab.value === "TRANSACTIONS" ? <SandboxResourceTable<FakeRailsTransactionRow> title={t("Fake Rails transactions")} url="/v1/admin/sandbox/fake-rails/transactions" listKey="rows" headers={transactionHeaders} filters={[{ key: "railCode", label: t("Rail"), type: "text" }, { key: "gatewayCode", label: t("Gateway"), type: "text" }, { key: "status", label: t("Status"), type: "text" }]} pageSize={20} showNumber={true} onRefreshReady={(next) => (transactionsRefresh.value = next)} /> : null}
            </StateView>
            <SlideOverDrawer modelValue={accountDrawer.value} onUpdate:modelValue={(v: boolean) => (accountDrawer.value = v)} title={selectedAccount.value?.holder_name ?? t("Test account")} subtitle={selectedAccount.value?.identifier ?? ""}>
                {selectedAccount.value ? <div class="d-flex flex-column ga-4">
                    <DescriptionList columns={2} items={[
                        { label: t("Account ID"), value: <MonoRef value={selectedAccount.value.id} /> },
                        { label: t("Scope"), value: selectedAccount.value.merchant_id ? t("Merchant copy") : t("Shared preset · read-only") },
                        { label: t("Rail / gateway"), value: `${selectedAccount.value.rail_code} / ${selectedAccount.value.gateway_code}` },
                        { label: t("Identifier"), value: <MonoRef value={selectedAccount.value.identifier} /> },
                        { label: t("Available"), value: <MoneyDisplay amount={selectedAccount.value.available_balance_lyd} currency="LYD" size="sm" /> },
                        { label: t("Held"), value: <MoneyDisplay amount={selectedAccount.value.reserved_balance_lyd} currency="LYD" size="sm" /> },
                        { label: t("Daily spent / limit"), value: `${selectedAccount.value.daily_spent_lyd} / ${selectedAccount.value.daily_limit_lyd}` },
                        { label: t("Status"), value: <StatusBadge status={selectedAccount.value.status} /> },
                    ]} />
                    <DataTable title={t("Movements")} data={movements.value} headers={[{ key: "created_at", label: "Date", value: (row) => String(row.created_at ?? "") }, { key: "direction", label: "Side", value: (row) => String(row.direction ?? "") }, { key: "amount_lyd", label: "Amount", value: (row) => String(row.amount_lyd ?? "") }]} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={10} />
                    <DataTable title={t("Holds")} data={holds.value} headers={[{ key: "created_at", label: "Created", value: (row) => String(row.created_at ?? "") }, { key: "amount_lyd", label: "Amount", value: (row) => String(row.amount_lyd ?? "") }, { key: "state", label: "State", value: (row) => String(row.state ?? row.status ?? "") }]} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={10} />
                </div> : null}
            </SlideOverDrawer>
            <SlideOverDrawer modelValue={transactionDrawer.value} onUpdate:modelValue={(v: boolean) => (transactionDrawer.value = v)} title={t("Fake Rails transaction")} subtitle={String((transactionDetail.value?.transaction as Record<string, unknown> | undefined)?.our_reference ?? "")}>
                {transactionDetail.value ? <div class="d-flex flex-column ga-4">
                    <DescriptionList columns={2} items={Object.entries((transactionDetail.value.transaction ?? {}) as Record<string, unknown>).slice(0, 20).map(([key, value]) => ({ label: key.replaceAll("_", " "), value: String(value ?? "—") }))} />
                    <DataTable title={t("Step events")} data={transactionEvents.value} headers={[{ key: "created_at", label: "Date", value: (row) => String(row.created_at ?? "") }, { key: "phase", label: "Phase", value: (row) => String(row.phase ?? "") }, { key: "status", label: "Status", value: (row) => String(row.status ?? "") }]} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={10} />
                    <DataTable title={t("Webhook deliveries")} data={transactionDeliveries.value} headers={[{ key: "created_at", label: "Date", value: (row) => String(row.created_at ?? "") }, { key: "status", label: "Status", value: (row) => String(row.status ?? "") }, { key: "attempts", label: "Attempts", value: (row) => String(row.attempts ?? "") }]} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={10} />
                </div> : null}
            </SlideOverDrawer>
            <FormModal modelValue={createOpen.value} onUpdate:modelValue={(v: any) => (createOpen.value = v)} title={t("Create test account")} size="md" loading={creating.value} errorMessage={createError.value} submitLabel={t("Create")} onSubmit={() => void createAccount()}>
                <SectionFields title={t("Account details")}>
                    <FormField label={t("Rail code")} required><VTextField modelValue={createForm.value.railCode} onUpdate:modelValue={(v: string) => (createForm.value.railCode = v)} hideDetails /></FormField>
                    <FormField label={t("Gateway code")} required><VTextField modelValue={createForm.value.gatewayCode} onUpdate:modelValue={(v: string) => (createForm.value.gatewayCode = v)} hideDetails /></FormField>
                    <FormField label={t("Instrument type")}><VSelect items={["MOBILE_WALLET", "BANK_ACCOUNT", "CARD", "VOUCHER"].map((value) => ({ title: value.replaceAll("_", " "), value }))} modelValue={createForm.value.instrumentType} onUpdate:modelValue={(v: string) => (createForm.value.instrumentType = v)} hideDetails /></FormField>
                    <FormField label={t("Identifier")} required><VTextField modelValue={createForm.value.identifier} onUpdate:modelValue={(v: string) => (createForm.value.identifier = v)} hideDetails /></FormField>
                    <FormField label={t("Holder name")} required><VTextField modelValue={createForm.value.holderName} onUpdate:modelValue={(v: string) => (createForm.value.holderName = v)} hideDetails /></FormField>
                    <FormField label="PIN / CVV"><VTextField modelValue={createForm.value.secretPin} onUpdate:modelValue={(v: string) => (createForm.value.secretPin = v)} hideDetails /></FormField>
                    <FormField label={t("Expiry")}><VTextField modelValue={createForm.value.expiry} onUpdate:modelValue={(v: string) => (createForm.value.expiry = v)} hideDetails /></FormField>
                    <FormField label={t("Available balance")}><VTextField type="number" modelValue={createForm.value.availableBalanceLyd} onUpdate:modelValue={(v: string) => (createForm.value.availableBalanceLyd = v)} hideDetails /></FormField>
                    <FormField label={t("Daily limit")}><VTextField type="number" modelValue={createForm.value.dailyLimitLyd} onUpdate:modelValue={(v: string) => (createForm.value.dailyLimitLyd = v)} hideDetails /></FormField>
                </SectionFields>
            </FormModal>
            <FormModal modelValue={Boolean(editScenario.value)} onUpdate:modelValue={(v: any) => { if (!v) editScenario.value = null; }} title={t("Edit rail scenario")} size="sm" loading={Boolean(busy.value)} submitLabel={t("Save")} onSubmit={() => void saveScenario()}>
                <SectionFields title={t("Chaos")}>
                    <FormField label={t("Failure %")}><VTextField type="number" modelValue={scenarioForm.value.failure} onUpdate:modelValue={(v: string) => (scenarioForm.value.failure = v)} hideDetails /></FormField>
                    <FormField label={t("Minimum latency (ms)")}><VTextField type="number" modelValue={scenarioForm.value.latencyMin} onUpdate:modelValue={(v: string) => (scenarioForm.value.latencyMin = v)} hideDetails /></FormField>
                    <FormField label={t("Maximum latency (ms)")}><VTextField type="number" modelValue={scenarioForm.value.latencyMax} onUpdate:modelValue={(v: string) => (scenarioForm.value.latencyMax = v)} hideDetails /></FormField>
                    <FormField label={t("Auto-approve after seconds")}><VTextField type="number" modelValue={scenarioForm.value.autoApprove} onUpdate:modelValue={(v: string) => (scenarioForm.value.autoApprove = v)} hideDetails /></FormField>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default AdminFakeRailsPage;
