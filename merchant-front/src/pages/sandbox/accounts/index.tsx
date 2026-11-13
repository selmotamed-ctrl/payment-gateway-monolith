import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import type { MetricItem } from "@/components/ui/MetricStrip";
import { StateView } from "@/components/StateView";
import { SandboxBanner } from "@/components/sandbox/SandboxBanner";
import SandboxResourceTable from "@/components/sandbox/SandboxResourceTable";
import { accountFilters, ACCOUNT_STATUS, ACCOUNT_TYPE } from "@/components/sandbox/sandboxFilters";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { DataTable } from "@/components/Table/DataTable";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { SectionFields } from "@/components/SectionFields";
import { sandboxGet, sandboxPatch, sandboxPost, type FakeRailsAccount, type SandboxSummaryResponse } from "@/api/sandbox";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { copyToClipboard } from "@/utils/common";
import { xlsxUIPipeline } from "@/utils/xlsx";

const SandboxAccountsPage = dc(() => {
    const { t } = useLocale();
    const summary = ref<Record<string, unknown> | null>(null);
    const refresh = ref<(() => void) | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const exportLoading = ref(false);
    const busy = ref<string | null>(null);
    const selected = ref<FakeRailsAccount | null>(null);
    const movements = ref<Array<Record<string, unknown>>>([]);
    const holds = ref<Array<Record<string, unknown>>>([]);
    const drawerOpen = ref(false);
    const createOpen = ref(false);
    const formError = ref("");
    const exact = ref<Record<string, string>>({});
    const otp = ref<Record<string, string>>({});
    const form = ref({ railCode: "", gatewayCode: "", instrumentType: "CARD", identifier: "", holderName: "", secretPin: "1234", expiry: "12/28", availableBalanceLyd: "5000.0000", dailyLimitLyd: "10000.0000", staticOtp: "" });

    const loadSummary = async () => {
        loading.value = true;
        error.value = null;
        try {
            const data = await sandboxGet<SandboxSummaryResponse>("/fake-rails/accounts/summary");
            summary.value = data.summary;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };
    void loadSummary();

    const metrics = computed<MetricItem[]>(() => {
        const data = summary.value ?? {};
        const status = (data.status ?? {}) as Record<string, number>;
        return [
            { key: "total", label: t("Test accounts"), value: String(data.total ?? 0) },
            { key: "merchant", label: t("Merchant copies"), value: String(data.merchant ?? 0) },
            { key: "global", label: t("Shared presets"), value: String(data.global ?? 0) },
            { key: "active", label: t("Active"), value: String(status.ACTIVE ?? 0), badge: t("Ready"), badgeTone: "success" },
            { key: "frozen", label: t("Frozen / blocked"), value: String((status.FROZEN ?? 0) + (status.BLOCKED ?? 0)), badge: (status.FROZEN ?? 0) + (status.BLOCKED ?? 0) ? t("Review") : t("Clear"), badgeTone: (status.FROZEN ?? 0) + (status.BLOCKED ?? 0) ? "warning" : "success" },
            { key: "available", label: t("Available"), moneyAmount: String(data.available ?? "0"), currency: "LYD" },
            { key: "held", label: t("Held"), moneyAmount: String(data.held ?? "0"), currency: "LYD" },
        ];
    });

    const patch = async (account: FakeRailsAccount, body: Record<string, unknown>, message = t("Test account updated")) => {
        busy.value = account.id;
        try {
            await sandboxPatch(`/fake-rails/accounts/${account.id}`, body);
            showSnackBar({ type: "success", message });
            refresh.value?.();
            await loadSummary();
            if (selected.value?.id === account.id) await openDetail(account.id);
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            busy.value = null;
        }
    };

    const openDetail = async (accountId: string) => {
        busy.value = `detail:${accountId}`;
        try {
            const [account, movementData] = await Promise.all([
                sandboxGet<{ account: FakeRailsAccount }>(`/fake-rails/accounts/${accountId}`),
                sandboxGet<{ movements: Array<Record<string, unknown>>; holds: Array<Record<string, unknown>> }>(`/fake-rails/accounts/${accountId}/movements`),
            ]);
            selected.value = account.account;
            movements.value = movementData.movements ?? [];
            holds.value = movementData.holds ?? [];
            drawerOpen.value = true;
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            busy.value = null;
        }
    };

    const create = async () => {
        if (!form.value.railCode.trim() || !form.value.gatewayCode.trim() || !form.value.identifier.trim() || !form.value.holderName.trim()) {
            formError.value = t("Rail, gateway, identifier and holder are required");
            return;
        }
        busy.value = "create";
        formError.value = "";
        try {
            await sandboxPost("/fake-rails/accounts", {
                railCode: form.value.railCode.trim(),
                gatewayCode: form.value.gatewayCode.trim(),
                instrumentType: form.value.instrumentType,
                identifier: form.value.identifier.trim(),
                holderName: form.value.holderName.trim(),
                secretPin: form.value.secretPin,
                expiry: form.value.expiry,
                availableBalanceLyd: form.value.availableBalanceLyd,
                dailyLimitLyd: form.value.dailyLimitLyd,
                ...(form.value.staticOtp.trim() ? { staticOtp: form.value.staticOtp.trim() } : {}),
            });
            createOpen.value = false;
            showSnackBar({ type: "success", message: t("Test account created") });
            refresh.value?.();
            await loadSummary();
        } catch (e) {
            formError.value = extractApiErrorMessage(e);
        } finally {
            busy.value = null;
        }
    };

    const reset = async () => {
        busy.value = "reset";
        try {
            await sandboxPost("/fake-rails/accounts/reset", {});
            showSnackBar({ type: "success", message: t("Test accounts reset") });
            refresh.value?.();
            await loadSummary();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            busy.value = null;
        }
    };

    const importStatement = async () => {
        busy.value = "reconcile";
        try {
            const result = await sandboxPost<Record<string, unknown>>("/reconciliation/import-fake-rails", {});
            showSnackBar({ type: "success", message: `${t("Imported")}: ${String(result.matched ?? 0)} ${t("matched")}, ${String(result.amountMismatch ?? 0)} ${t("mismatch")}` });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            busy.value = null;
        }
    };

    const headers: TableHeader<FakeRailsAccount>[] = [
        { key: "scope", label: "Scope", Value: ({ row }) => <StatusBadge status={row.merchant_id ? "MERCHANT" : "GLOBAL"} toneOverride={row.merchant_id ? "info" : "neutral"} /> },
        { key: "rail_code", label: "Rail / gateway", value: (row) => `${row.rail_code} / ${row.gateway_code}` },
        { key: "holder_name", label: "Holder", value: (row) => row.holder_name },
        { key: "identifier", label: "Identifier", Value: ({ row }) => <MonoRef value={row.identifier} truncate={20} /> },
        { key: "instrument_type", label: "Type", value: (row) => row.instrument_type },
        { key: "credentials", label: "PIN / OTP", value: (row) => `•••• / ${row.static_otp ? "••••" : "—"}` },
        { key: "available_balance_lyd", label: "Available", Value: ({ row }) => <MoneyDisplay amount={row.available_balance_lyd} currency={row.currency} size="sm" /> },
        { key: "reserved_balance_lyd", label: "Held", Value: ({ row }) => <MoneyDisplay amount={row.reserved_balance_lyd} currency={row.currency} size="sm" /> },
        { key: "daily", label: "Daily spent / limit", value: (row) => `${row.daily_spent_lyd} / ${row.daily_limit_lyd}` },
        { key: "status", label: "Status", Value: ({ row }) => <StatusBadge status={row.status} toneOverride={row.status === "ACTIVE" ? "success" : "warning"} /> },
        { key: "actions", label: "Actions", Value: ({ row }) => (
            <TableRowActions
                primaryAction={{ label: t("Inspect"), icon: "mdi-eye-outline", onClick: () => void openDetail(row.id) }}
                items={[
                    { key: "credit", label: t("Credit 1,000 LYD"), icon: "mdi-plus", hidden: !row.merchant_id, onClick: () => void patch(row, { deltaLyd: "1000.0000" }) },
                    { key: "drain", label: t("Drain"), icon: "mdi-arrow-down", danger: true, hidden: !row.merchant_id, onClick: () => void patch(row, { availableBalanceLyd: "0.0000" }) },
                    { key: "daily", label: t("Reset daily spent"), icon: "mdi-calendar-refresh", hidden: !row.merchant_id, onClick: () => void patch(row, { quickPreset: "RESET_DAILY_SPENT" }) },
                    { key: "status", label: row.status === "ACTIVE" ? t("Freeze") : t("Activate"), icon: row.status === "ACTIVE" ? "mdi-pause" : "mdi-play", hidden: !row.merchant_id, onClick: () => void patch(row, { status: row.status === "ACTIVE" ? "FROZEN" : "ACTIVE" }) },
                    { key: "restore", label: t("Restore preset"), icon: "mdi-restore", hidden: !row.merchant_id, onClick: async () => { busy.value = row.id; try { await sandboxPost(`/fake-rails/accounts/${row.id}/restore`, {}); refresh.value?.(); } catch (e) { showSnackBar({ type: "error", message: extractApiErrorMessage(e) }); } finally { busy.value = null; } } },
                    { key: "copy", label: t("Copy identifier"), icon: "mdi-content-copy", onClick: () => { copyToClipboard(row.identifier); showSnackBar({ type: "success", message: t("Copied") }); } },
                ]}
            />
        ) },
    ];

    const movementHeaders: TableHeader<Record<string, unknown>>[] = [
        { key: "created_at", label: "Date", value: (row) => String(row.created_at ?? "") },
        { key: "direction", label: "Side", value: (row) => String(row.direction ?? "") },
        { key: "amount_lyd", label: "Amount", value: (row) => String(row.amount_lyd ?? "") },
        { key: "reason", label: "Reason", value: (row) => String(row.reason ?? "") },
    ];
    const holdHeaders: TableHeader<Record<string, unknown>>[] = [
        { key: "created_at", label: "Created", value: (row) => String(row.created_at ?? "") },
        { key: "amount_lyd", label: "Amount", value: (row) => String(row.amount_lyd ?? "") },
        { key: "state", label: "State", value: (row) => String(row.state ?? row.status ?? "") },
        { key: "expires_at", label: "Expires", value: (row) => String(row.expires_at ?? "—") },
    ];

    const exportSummary = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            await xlsxUIPipeline.downloadXlsxFromCsvLines({ title: `sandbox-accounts-summary-${new Date().toISOString().slice(0, 10)}.xlsx`, lines: ["metric,value", ...metrics.value.map((item) => `${escape(item.label)},${escape(item.value ?? item.moneyAmount ?? "")}`)] });
            showSnackBar({ type: "success", message: t("Summary exported") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            exportLoading.value = false;
        }
    };

    return () => (
        <ScreenContainer>
            <PageHeader title={t("Fake Rails Test Accounts")} subtitle={t("Control the sandbox customer cards, wallets, bank accounts and vouchers.")} badge="SANDBOX" badgeTone="warning" end={() => <div class="d-flex flex-wrap ga-2"><VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => { refresh.value?.(); void loadSummary(); }}>{t("Refresh")}</VBtn><VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn><VBtn color="primary" prependIcon="mdi-plus" onClick={() => { formError.value = ""; createOpen.value = true; }}>{t("Create account")}</VBtn></div>} />
            <SandboxBanner />
            {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
            <StateView loading={loading.value && !summary.value} minHeight="180px">
                <div class="d-flex flex-column ga-4">
                    <SummaryExportCard title={t("Test customer health")} metrics={metrics.value} exportLoading={exportLoading.value} exportLabel={t("Export summary")} onExport={() => void exportSummary()}>
                        <div class="d-flex flex-wrap ga-2">
                            <VBtn variant="tonal" loading={busy.value === "reset"} onClick={() => void reset()}>{t("Reset accounts to defaults")}</VBtn>
                            <VBtn variant="tonal" color="primary" loading={busy.value === "reconcile"} onClick={() => void importStatement()}>{t("Import Fake Rails settlement")}</VBtn>
                        </div>
                    </SummaryExportCard>
                    <SandboxResourceTable<FakeRailsAccount> title={t("Fake Rails accounts")} url="/v1/merchant/sandbox/fake-rails/accounts" listKey="accounts" headers={headers} filters={accountFilters()} pageSize={20} showNumber={true} onRefreshReady={(next) => (refresh.value = next)} />
                </div>
            </StateView>
            <SlideOverDrawer modelValue={drawerOpen.value} onUpdate:modelValue={(value: boolean) => (drawerOpen.value = value)} title={selected.value?.holder_name ?? t("Test account")} subtitle={selected.value?.identifier ?? ""}>
                {selected.value ? <div class="d-flex flex-column ga-4">
                    <DescriptionList columns={2} items={[
                        { label: t("Account ID"), value: <MonoRef value={selected.value.id} /> },
                        { label: t("Scope"), value: selected.value.merchant_id ? t("Merchant copy") : t("Shared preset · read-only") },
                        { label: t("Rail / gateway"), value: `${selected.value.rail_code} / ${selected.value.gateway_code}` },
                        { label: t("Type"), value: selected.value.instrument_type },
                        { label: t("Identifier"), value: <MonoRef value={selected.value.identifier} /> },
                        { label: t("PIN"), value: <span class="pg-mono">{selected.value.secret_pin}</span> },
                        { label: t("Expiry"), value: selected.value.expiry ?? "—" },
                        { label: t("Static OTP"), value: selected.value.static_otp ?? "—" },
                        { label: t("Available"), value: <MoneyDisplay amount={selected.value.available_balance_lyd} currency={selected.value.currency} size="sm" /> },
                        { label: t("Held"), value: <MoneyDisplay amount={selected.value.reserved_balance_lyd} currency={selected.value.currency} size="sm" /> },
                        { label: t("Daily spent / limit"), value: `${selected.value.daily_spent_lyd} / ${selected.value.daily_limit_lyd}` },
                        { label: t("Status"), value: <StatusBadge status={selected.value.status} /> },
                    ]} />
                    <div class="d-flex flex-wrap ga-2">
                        {selected.value.merchant_id ? <VTextField density="compact" variant="outlined" hideDetails style={{ maxWidth: "160px" }} label={t("Set available LYD")} modelValue={exact.value[selected.value!.id] ?? ""} onUpdate:modelValue={(v: string) => (exact.value = { ...exact.value, [selected.value!.id]: v })} /> : null}
                        {selected.value.merchant_id ? <VBtn variant="tonal" onClick={() => void patch(selected.value!, { availableBalanceLyd: exact.value[selected.value!.id] ?? "0" })}>{t("Apply balance")}</VBtn> : null}
                        {selected.value.merchant_id ? <VTextField density="compact" variant="outlined" hideDetails style={{ maxWidth: "140px" }} label={t("OTP")} modelValue={otp.value[selected.value!.id] ?? selected.value!.static_otp ?? ""} onUpdate:modelValue={(v: string) => (otp.value = { ...otp.value, [selected.value!.id]: v })} /> : null}
                        {selected.value.merchant_id ? <VBtn variant="tonal" onClick={() => void patch(selected.value!, { staticOtp: otp.value[selected.value!.id] || "123456" })}>{t("Save OTP")}</VBtn> : null}
                        {selected.value.merchant_id ? <VBtn variant="tonal" onClick={() => void patch(selected.value!, { status: selected.value!.status === "ACTIVE" ? "FROZEN" : "ACTIVE" })}>{selected.value!.status === "ACTIVE" ? t("Freeze") : t("Activate")}</VBtn> : null}
                    </div>
                    <DataTable title={t("Movements")} data={movements.value} headers={movementHeaders} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={10} />
                    <DataTable title={t("Holds")} data={holds.value} headers={holdHeaders} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={10} />
                </div> : null}
            </SlideOverDrawer>
            <FormModal modelValue={createOpen.value} onUpdate:modelValue={(v: any) => (createOpen.value = v)} title={t("Create test account")} size="md" loading={busy.value === "create"} errorMessage={formError.value} submitLabel={t("Create")} onSubmit={() => void create()}>
                <SectionFields title={t("Account details")}>
                    <FormField label={t("Rail code")} required><VTextField modelValue={form.value.railCode} onUpdate:modelValue={(v: string) => (form.value.railCode = v)} hideDetails /></FormField>
                    <FormField label={t("Gateway code")} required><VTextField modelValue={form.value.gatewayCode} onUpdate:modelValue={(v: string) => (form.value.gatewayCode = v)} hideDetails /></FormField>
                    <FormField label={t("Instrument type")}><VSelect items={ACCOUNT_TYPE.map((value) => ({ title: value.replaceAll("_", " "), value }))} modelValue={form.value.instrumentType} onUpdate:modelValue={(v: string) => (form.value.instrumentType = v)} hideDetails /></FormField>
                    <FormField label={t("Identifier")} required><VTextField modelValue={form.value.identifier} onUpdate:modelValue={(v: string) => (form.value.identifier = v)} hideDetails /></FormField>
                    <FormField label={t("Holder name")} required><VTextField modelValue={form.value.holderName} onUpdate:modelValue={(v: string) => (form.value.holderName = v)} hideDetails /></FormField>
                    <FormField label="PIN / CVV"><VTextField modelValue={form.value.secretPin} onUpdate:modelValue={(v: string) => (form.value.secretPin = v)} hideDetails /></FormField>
                    <FormField label={t("Expiry")}><VTextField modelValue={form.value.expiry} onUpdate:modelValue={(v: string) => (form.value.expiry = v)} hideDetails /></FormField>
                    <FormField label={t("Available balance")}><VTextField type="number" modelValue={form.value.availableBalanceLyd} onUpdate:modelValue={(v: string) => (form.value.availableBalanceLyd = v)} hideDetails /></FormField>
                    <FormField label={t("Daily limit")}><VTextField type="number" modelValue={form.value.dailyLimitLyd} onUpdate:modelValue={(v: string) => (form.value.dailyLimitLyd = v)} hideDetails /></FormField>
                    <FormField label={t("Static OTP")}><VTextField modelValue={form.value.staticOtp} onUpdate:modelValue={(v: string) => (form.value.staticOtp = v)} hideDetails /></FormField>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default SandboxAccountsPage;
