import { dc } from "@/utils/dc";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useLocale } from "@/utils/vael-compat";
import {PgAlert, PgButton, PgTextarea, PgStack} from "@pg/ui";
import { areChecklistsVisible } from "@/constants/env";
import {PgPage as ScreenContainer} from "@pg/ui";
import {PageHeader} from "@pg/ui";
import {ThemedView} from "@pg/ui";
import {ThemedText} from "@pg/ui";
import {StateView} from "@pg/ui";
import {StatusBadge} from "@pg/ui";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import {SurfaceCard, SurfaceCardText} from "@pg/ui";
import {MoneyDisplay} from "@pg/ui";
import {MetricStrip} from "@pg/ui";
import {MonoRef} from "@pg/ui";
import {EmptyState} from "@pg/ui";
import {DescriptionList} from "@pg/ui";
import {FormModal} from "@pg/ui";
import {FormField} from "@pg/ui";
import {FormChecklist} from "@pg/ui";
import {TableRowActions} from "@pg/ui";
import { GlAccountDrawer } from "@/components/ledger/GlAccountDrawer";
import { LedgerRefLink } from "@/components/ledger/LedgerRefLink";
import { isValidReason, normalizeReason } from "@/components/ledger/mutationReason";
import { errorCodeOf, errorDetailsOf } from "@/components/ledger/format";
import { hasOneOfAuthorities } from "@/state/user";
const EXPORT_CHECKS = [
    { key: "LEDGER_SCOPE_VERIFIED", label: "Ledger scope verified" },
    { key: "INVARIANT_RESULT_REVIEWED", label: "Invariant result and drift reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const ROLLUP_CHECKS = [
    { key: "ACCOUNT_SCOPE_VERIFIED", label: "GL account and shard scope verified" },
    { key: "JOURNAL_PARITY_REVIEWED", label: "Journal parity expectations reviewed" },
    { key: "IMPACT_ACKNOWLEDGED", label: "Rollup advances checkpoints only" },
    { key: "AUTHORITY_CONFIRMED", label: "Finance write authority confirmed" },
] as const;

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
    const exportOpen = ref(false);
    const showChecklists = areChecklistsVisible();
    const exportChecklist = ref<Record<string, boolean>>({});
    const exportChecklistComplete = computed(() => !showChecklists || EXPORT_CHECKS.every((check) => exportChecklist.value[check.key] === true));
    const rollupChecklist = ref<Record<string, boolean>>({});
    const rollupChecklistComplete = computed(() => !showChecklists || ROLLUP_CHECKS.every((check) => rollupChecklist.value[check.key] === true));
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
        rollupChecklist.value = {};
    };

    const runRollup = async () => {
        const accountId = rollupAccountId.value;
        if (!accountId) return;
        if (!isValidReason(rollupReason.value)) {
            rollupError.value = t("Reason is required (at least 10 characters)");
            return;
        }
        if (!rollupChecklistComplete.value) {
            rollupError.value = t("Complete all rollup checklist items before running");
            return;
        }
        rollupLoading.value = true;
        rollupError.value = "";
        try {
            await api.post(urlsMap.financeGlAccountCheckpoint(accountId), {
                reason: normalizeReason(rollupReason.value),
                checklist: ROLLUP_CHECKS.filter((check) => rollupChecklist.value[check.key]).map((check) => check.key),
            });
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
        if (!exportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all export checklist items before exporting") });
            return;
        }
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.financeInvariantExport, {
                params: { checklist: EXPORT_CHECKS.filter((check) => exportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
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
            exportOpen.value = false;
            exportChecklist.value = {};
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
            <PgStack gap="lg">
                <PageHeader title={t("Ledger Audit & Invariant")} subtitle={t("Verify the double-entry ledger invariant and inspect account-level balances.")} badge={t("Ledger control")} badgeTone="info">
                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            {data.value?.checkedAt && <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>{t("Last run")} {new Date(data.value.checkedAt).toLocaleTimeString()}</ThemedText>}
                            <PgButton variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>{t("Refresh")}</PgButton>
                            <PgButton variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => { exportChecklist.value = {}; exportOpen.value = true; }}>{t("Export snapshot")}</PgButton>
                        </ThemedView>
                </PageHeader>

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : (
                    <>
                        <PgAlert tone={data.value?.ok ? "success" : "danger"}>
                            {data.value?.ok
                                ? t("The double-entry invariant is balanced. Payouts may continue subject to normal policy.")
                                : t("Ledger drift detected. Automated payouts must halt until finance resolves the drift.")}
                        </PgAlert>

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

                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(340px, 100%), 1fr))", gap: "18px" }}>
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
            </PgStack>
            <GlAccountDrawer accountId={inspectAccountId.value} onClose={() => (inspectAccountId.value = null)} onChanged={() => void load()} />
            <FormModal
                modelValue={exportOpen.value}
                onUpdate:modelValue={(value: boolean) => (exportOpen.value = value)}
                title={t("Export invariant snapshot")}
                size="md"
                loading={exportLoading.value}
                submitLabel={t("Export")}
                onSubmit={() => void exportSnapshot()}
            >
                <PgAlert tone="warning">{t("The export contains ledger balances, drift and account checkpoints. Handle it as confidential financial evidence.")}</PgAlert>
                <FormChecklist
                    checks={[...EXPORT_CHECKS]}
                    modelValue={exportChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (exportChecklist.value = value)}
                    show={showChecklists}
                    title={t("Invariant export checklist")}
                    complete={exportChecklistComplete.value}
                    incompleteMessage={t("Complete all export checklist items before exporting")}
                />
            </FormModal>

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
                <PgAlert tone="info" density="compact">
                    {t("A shard whose lines do not add up to its balance is not advanced and the action names that shard. Payments are not blocked. The action is audited.")}
                </PgAlert>
                <FormField label={t("Reason")} required hint={t("At least 10 characters; written to the audit log")}>
                    <PgTextarea modelValue={rollupReason.value} onUpdate:modelValue={(value: string) => void (rollupReason.value = value)} rows={3} autoGrow {...{ maxlength: 500 }} />
                </FormField>
                <FormChecklist
                    checks={[...ROLLUP_CHECKS]}
                    modelValue={rollupChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (rollupChecklist.value = value)}
                    show={showChecklists}
                    title={t("Rollup checklist")}
                    complete={rollupChecklistComplete.value}
                    incompleteMessage={t("Complete all rollup checklist items before running")}
                />
            </FormModal>
        </ScreenContainer>
    );
});

export default InvariantPage;
