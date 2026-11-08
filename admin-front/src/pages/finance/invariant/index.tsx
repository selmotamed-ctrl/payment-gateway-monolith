import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MetricStrip } from "@/components/ui/MetricStrip";
import { MonoRef } from "@/components/ui/MonoRef";
import { EmptyState } from "@/components/ui/EmptyState";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { TableRowActions } from "@/components/Table/TableRowActions";
import { GlAccountDrawer } from "@/components/ledger/GlAccountDrawer";
import { LedgerRefLink } from "@/components/ledger/LedgerRefLink";
import { isValidReason, normalizeReason } from "@/components/ledger/mutationReason";
import { errorCodeOf, errorDetailsOf } from "@/components/ledger/format";
import { hasOneOfAuthorities } from "@/state/user";
type InvariantResult = {
    ok?: boolean;
    drift?: string;
    currency?: string;
    checkedAt?: string;
    sides?: {
        treasury: string;
        clearing: string;
        commissionReceivable: string;
        merchantWallet: string;
        platformIncome: string;
        providerFeeExpense: string;
        gatewayFeeExpense: string;
        gatewayFeeAccrual: string;
        amlHold: string;
        chargebackReserve: string;
        suspense: string;
    };
    leftSide?: string;
    rightSide?: string;
    accounts?: { accountId: string; accountType: string; liveBalance: string; naturalBalance: string; checkpointAt: string | null }[];
};

const InvariantPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const data = ref<InvariantResult | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const exportLoading = ref(false);
    const inspectAccountId = ref<string | null>(null);
    const canRollup = computed(() => hasOneOfAuthorities(["finance:write"]));
    const rollupAccountId = ref<string | null>(null);
    const rollupReason = ref("");
    const rollupLoading = ref(false);
    const rollupError = ref("");

    const openRollup = (accountId: string) => {
        rollupAccountId.value = accountId;
        rollupReason.value = "";
        rollupError.value = "";
    };

    const runRollup = async () => {
        const accountId = rollupAccountId.value;
        if (!accountId) return;
        if (!isValidReason(rollupReason.value)) {
            rollupError.value = t("Reason is required (at least 10 characters)");
            return;
        }
        rollupLoading.value = true;
        rollupError.value = "";
        try {
            await api.post(urlsMap.financeGlAccountCheckpoint(accountId), { reason: normalizeReason(rollupReason.value) });
            rollupAccountId.value = null;
            showSnackBar({ type: "success", message: t("Checkpoint rollup completed") });
            void load();
        } catch (e) {
            if (errorCodeOf(e) === "LEDGER_SHARD_PARITY_MISMATCH") {
                const details = errorDetailsOf(e);
                const shard = details.shardId === undefined ? "" : ` ${t("Shard")} #${String(details.shardId)}.`;
                rollupError.value = details.kind === "GAP"
                    ? `${t("A shard's journal lines are not gapless; its checkpoint was refused.")}${shard} ${t("Lines found")}: ${String(details.linesFound ?? "—")} / ${String(details.linesExpected ?? "—")}`
                    : `${t("The shard total differs from the journal total; the checkpoint was refused.")}${shard} ${t("Shard total")}: ${String(details.shardTotal ?? "—")} · ${t("Journal total")}: ${String(details.journalTotal ?? "—")} · ${t("Drift")}: ${String(details.drift ?? "—")}`;
            } else {
                rollupError.value = extractApiErrorMessage(e);
            }
        } finally {
            rollupLoading.value = false;
        }
    };

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.financeInvariantCheck);
            data.value = (response.data?.data ?? response.data ?? {}) as InvariantResult;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    void load();

    const exportSnapshot = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.financeInvariantExport);
            const snapshot = (response.data?.data ?? response.data ?? {}) as InvariantResult;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["checked_at", snapshot.checkedAt ?? ""],
                ["ok", snapshot.ok === true],
                ["drift", snapshot.drift ?? "0"],
                ["currency", snapshot.currency ?? "LYD"],
                ["left_side", snapshot.leftSide ?? "0"],
                ["right_side", snapshot.rightSide ?? "0"],
            ];
            for (const [key, value] of Object.entries(snapshot.sides ?? {})) {
                rows.push([`side.${key}`, value]);
            }
            for (const row of snapshot.accounts ?? []) {
                rows.push([`account.${row.accountId}.type`, row.accountType]);
                rows.push([`account.${row.accountId}.live_balance`, row.liveBalance]);
                rows.push([`account.${row.accountId}.natural_balance`, row.naturalBalance]);
                rows.push([`account.${row.accountId}.checkpoint_at`, row.checkpointAt ?? ""]);
            }
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `invariant-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Invariant snapshot exported") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            exportLoading.value = false;
        }
    };

    const currency = () => data.value?.currency ?? "LYD";

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Ledger Audit & Invariant")}
                    subtitle={t("Verify the double-entry ledger invariant and inspect account-level balances.")}
                    badge={t("Ledger control")}
                    badgeTone="info"
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            {data.value?.checkedAt && <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>{t("Last run")} {new Date(data.value.checkedAt).toLocaleTimeString()}</ThemedText>}
                            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportSnapshot()}>{t("Export snapshot")}</VBtn>
                        </ThemedView>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : (
                    <>
                        <VAlert type={data.value?.ok ? "success" : "error"} variant="tonal">
                            {data.value?.ok
                                ? t("The double-entry invariant is balanced. Payouts may continue subject to normal policy.")
                                : t("Ledger drift detected. Automated payouts must halt until finance resolves the drift.")}
                        </VAlert>

                        <MetricStrip items={[
                            { key: "drift", label: t("Drift"), moneyAmount: data.value?.drift ?? "0", currency: currency(), badge: data.value?.ok ? t("Passed") : t("Failed"), badgeTone: data.value?.ok ? "success" : "danger" },
                            { key: "debit", label: t("Debit side"), moneyAmount: data.value?.leftSide ?? "0.0000", currency: currency() },
                            { key: "credit", label: t("Credit side"), moneyAmount: data.value?.rightSide ?? "0.0000", currency: currency() },
                            { key: "accounts", label: t("Accounts"), value: String(data.value?.accounts?.length ?? 0) },
                        ]} />

                        <SurfaceCard title={t("Invariant Status")}>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
                                    <StatusBadge
                                        status={data.value?.ok ? "PASSED" : "FAILED"}
                                        label={data.value?.ok ? t("Passed") : t("Failed")}
                                        toneOverride={data.value?.ok ? "success" : "danger"}
                                    />
                                    <ThemedText style={{ fontSize: "13px" }}>
                                        {t("Last Run")}: {data.value?.checkedAt ? new Date(data.value.checkedAt).toLocaleString() : "-"}
                                    </ThemedText>
                                </ThemedView>
                                <MoneyDisplay amount={data.value?.drift ?? "0"} currency={currency()} size="xl" colorSign />
                            </SurfaceCardText>
                        </SurfaceCard>

                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "18px" }}>
                            <SurfaceCard title={t("Treasury Cover")}>
                                <DescriptionList
                                    items={[
                                        { label: t("Treasury Balance"), value: data.value?.sides?.treasury ?? "0", money: true, currency: currency() },
                                        { label: t("GATEWAY_CLEARING"), value: data.value?.sides?.clearing ?? "0", money: true, currency: currency() },
                                        { label: t("Commission Receivable"), value: data.value?.sides?.commissionReceivable ?? "0", money: true, currency: currency() },
                                    ]}
                                />
                            </SurfaceCard>
                            <SurfaceCard title={t("Ledger")}>
                                <DescriptionList
                                    items={[
                                        { label: t("MERCHANT_WALLET"), value: data.value?.sides?.merchantWallet ?? "0", money: true, currency: currency() },
                                        { label: t("PLATFORM_INCOME"), value: data.value?.sides?.platformIncome ?? "0", money: true, currency: currency() },
                                        { label: t("PROVIDER_FEE_EXPENSE"), value: data.value?.sides?.providerFeeExpense ?? "0", money: true, currency: currency() },
                                        { label: t("GATEWAY_FEE_EXPENSE"), value: data.value?.sides?.gatewayFeeExpense ?? "0", money: true, currency: currency() },
                                        { label: t("GATEWAY_FEE_ACCRUAL"), value: data.value?.sides?.gatewayFeeAccrual ?? "0", money: true, currency: currency() },
                                        { label: t("AML_HOLD"), value: data.value?.sides?.amlHold ?? "0", money: true, currency: currency() },
                                        { label: t("CHARGEBACK_RESERVE"), value: data.value?.sides?.chargebackReserve ?? "0", money: true, currency: currency() },
                                        { label: t("SUSPENSE"), value: data.value?.sides?.suspense ?? "0", money: true, currency: currency() },
                                    ]}
                                />
                            </SurfaceCard>
                        </ThemedView>

                        <SurfaceCard title={t("Ledger accounts")} noPadding>
                            {(data.value?.accounts ?? []).length === 0 ? (
                                <EmptyState title={t("No Data Found")} description={t("No ledger accounts returned by the invariant check.")} />
                            ) : (
                                <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                        <thead>
                                            <tr>
                                                <th style={{ textAlign: "start" }}>{t("Account")}</th>
                                                <th style={{ textAlign: "start" }}>{t("Type")}</th>
                                                <th style={{ textAlign: "end" }}>{t("Live balance")}</th>
                                                <th style={{ textAlign: "end" }}>{t("Natural balance")}</th>
                                                <th style={{ textAlign: "end" }}>{t("Actions")}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {(data.value?.accounts ?? []).map((row) => (
                                                <tr key={row.accountId}>
                                                    <td><LedgerRefLink value={row.accountId} truncate={18} label={t("Open GL account")} onOpen={() => (inspectAccountId.value = row.accountId)} /></td>
                                                    <td><StatusBadge status={row.accountType} label={row.accountType} showDot={false} /></td>
                                                    <td style={{ textAlign: "end" }}><MoneyDisplay amount={row.liveBalance} currency={currency()} size="sm" showCurrency={false} /></td>
                                                    <td style={{ textAlign: "end" }}><MoneyDisplay amount={row.naturalBalance} currency={currency()} size="sm" showCurrency={false} colorSign /></td>
                                                    <td style={{ textAlign: "end" }}>
                                                        <TableRowActions
                                                            primaryAction={{ label: t("Inspect shards & lines"), icon: "mdi-text-search", onClick: () => void (inspectAccountId.value = row.accountId) }}
                                                            items={[
                                                                {
                                                                    key: "journal",
                                                                    label: t("View journal entries"),
                                                                    icon: "mdi-book-open-variant",
                                                                    onClick: () => void router.push({ name: "JournalEntries", query: { glAccountId: row.accountId } }),
                                                                },
                                                                {
                                                                    key: "rollup",
                                                                    label: t("Run checkpoint rollup"),
                                                                    icon: "mdi-database-sync-outline",
                                                                    hidden: !canRollup.value,
                                                                    onClick: () => openRollup(row.accountId),
                                                                },
                                                            ]}
                                                        />
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </SurfaceCard>
                    </>
                )}
            </ThemedView>
            <GlAccountDrawer accountId={inspectAccountId.value} onClose={() => (inspectAccountId.value = null)} onChanged={() => void load()} />
            <FormModal
                modelValue={rollupAccountId.value !== null}
                onUpdate:modelValue={(value: boolean) => {
                    if (!value) rollupAccountId.value = null;
                }}
                title={t("Run checkpoint rollup")}
                subtitle={t("Verifies every shard against the journal and moves its checkpoint forward")}
                submitLabel={t("Run rollup")}
                loading={rollupLoading.value}
                errorMessage={rollupError.value}
                onSubmit={() => void runRollup()}
            >
                {rollupAccountId.value && <MonoRef value={rollupAccountId.value} />}
                <VAlert type="info" variant="tonal" density="compact">
                    {t("A shard whose lines do not add up to its balance is not advanced and the action names that shard. Payments are not blocked. The action is audited.")}
                </VAlert>
                <FormField label={t("Reason")} required hint={t("At least 10 characters; written to the audit log")}>
                    <VTextarea modelValue={rollupReason.value} onUpdate:modelValue={(value: string) => void (rollupReason.value = value)} rows={3} autoGrow {...{ maxlength: 500 }} />
                </FormField>
            </FormModal>
        </ScreenContainer>
    );
});

export default InvariantPage;
