import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VIcon, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { PageHeader } from "@/components/ui/PageHeader";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
import { FormModal } from "@/components/ui/FormModal";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { activeEnvironment } from "@/state/environment";

interface SandboxAccount {
    id: string;
    railCode: string;
    gatewayCode: string;
    instrumentType: string;
    identifier: string;
    holderName: string;
    secretPin: string;
    expiry: string | null;
    availableBalanceLyd: string;
    reservedBalanceLyd: string;
    dailyLimitLyd: string;
    dailySpentLyd: string;
    status: string;
    notes: string | null;
}

interface MovementRow {
    id: string;
    transaction_id: string | null;
    direction: string;
    amount_lyd: string;
    available_before_lyd: string;
    available_after_lyd: string;
    reason: string;
    actor: string;
    created_at: string;
}

const SandboxAccountsPage = dc(() => {
    const { t } = useLocale();
    const tab = ref<"ACCOUNTS" | "SETTLEMENTS" | "WORKSPACE">("ACCOUNTS");
    const accounts = ref<SandboxAccount[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const actionError = ref<string | null>(null);
    const busy = ref<string | null>(null);
    const railFilter = ref<string | null>(null);
    const search = ref("");
    const customBalance = ref<Record<string, string>>({});

    const movementsOpen = ref(false);
    const movementsAccount = ref<SandboxAccount | null>(null);
    const movements = ref<MovementRow[]>([]);

    const settlementGateway = ref<string | null>(null);
    const settlementFeeVariance = ref(false);
    const settlementOmitOne = ref(false);
    const settlementResult = ref<Record<string, unknown> | null>(null);
    const seeding = ref(false);
    const resetting = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.sandboxAccounts);
            const payload = response.data?.data ?? response.data ?? {};
            accounts.value = (payload.accounts ?? []) as SandboxAccount[];
            for (const account of accounts.value) {
                customBalance.value[account.id] ??= account.availableBalanceLyd;
            }
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            accounts.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const rails = computed(() =>
        [...new Set(accounts.value.map((account) => account.railCode))].sort(),
    );
    const gateways = computed(() =>
        [...new Set(accounts.value.map((account) => account.gatewayCode))].sort(),
    );
    const filtered = computed(() => {
        const needle = search.value.trim().toLowerCase();
        return accounts.value.filter((account) => {
            if (railFilter.value && account.railCode !== railFilter.value) return false;
            if (!needle) return true;
            return `${account.identifier} ${account.holderName} ${account.railCode}`.toLowerCase().includes(needle);
        });
    });

    const updateAccount = async (account: SandboxAccount, payload: Record<string, unknown>) => {
        busy.value = account.id;
        actionError.value = null;
        try {
            await api.patch(urlsMap.sandboxAccount(account.id), payload);
            await load();
            showSnackBar({ type: "success", message: t("Sandbox account updated") });
        } catch (e) {
            actionError.value = extractApiErrorMessage(e);
        } finally {
            busy.value = null;
        }
    };

    const openMovements = async (account: SandboxAccount) => {
        movementsAccount.value = account;
        movements.value = [];
        movementsOpen.value = true;
        busy.value = account.id;
        try {
            const response = await api.get(urlsMap.sandboxAccountMovements(account.id));
            const payload = response.data?.data ?? response.data ?? {};
            movements.value = (payload.movements ?? []) as MovementRow[];
        } catch (e) {
            actionError.value = extractApiErrorMessage(e);
        } finally {
            busy.value = null;
        }
    };

    const generateSettlement = async () => {
        if (!settlementGateway.value) return;
        busy.value = "settlement";
        actionError.value = null;
        settlementResult.value = null;
        try {
            const response = await api.post(urlsMap.sandboxSettlementGenerate, {
                gatewayCode: settlementGateway.value,
                anomalies: {
                    feeVariancePercent: settlementFeeVariance.value ? 15 : 0,
                    omitOne: settlementOmitOne.value,
                },
            });
            settlementResult.value = (response.data?.data ?? response.data ?? {}) as Record<string, unknown>;
            showSnackBar({ type: "success", message: t("Settlement statement generated and reconciled") });
        } catch (e) {
            actionError.value = extractApiErrorMessage(e);
        } finally {
            busy.value = null;
        }
    };

    const seedLinks = async () => {
        seeding.value = true;
        actionError.value = null;
        try {
            await api.post(urlsMap.sandboxSeedLinks, {});
            showSnackBar({ type: "success", message: t("Sample sandbox links created") });
        } catch (e) {
            actionError.value = extractApiErrorMessage(e);
        } finally {
            seeding.value = false;
        }
    };

    const resetWorkspace = async () => {
        resetting.value = true;
        actionError.value = null;
        try {
            await api.post(urlsMap.sandboxReset, {});
            await load();
            settlementResult.value = null;
            showSnackBar({ type: "success", message: t("Sandbox workspace reset") });
        } catch (e) {
            actionError.value = extractApiErrorMessage(e);
        } finally {
            resetting.value = false;
        }
    };

    const tabs = computed(() => [
        { value: "ACCOUNTS", label: t("Test Accounts & Balances"), count: accounts.value.length },
        { value: "SETTLEMENTS", label: t("Settlement Generator") },
        { value: "WORKSPACE", label: t("Workspace Controls") },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Sandbox Test Accounts & Fake Rails Balances")}
                    subtitle={t("Control customer account balances, generate settlement statements and reset your isolated sandbox workspace.")}
                    badge={activeEnvironment.value}
                    badgeLabel={activeEnvironment.value}
                    badgeTone={activeEnvironment.value === "SANDBOX" ? "warning" : "success"}
                    end={() => (
                        <VBtn variant="tonal" onClick={() => void load()} loading={loading.value}>
                            {t("Refresh")}
                        </VBtn>
                    )}
                />

                {activeEnvironment.value !== "SANDBOX" ? (
                    <VAlert type="info" variant="tonal" density="compact">
                        {t("Switch the portal to SANDBOX to manage Fake Rails test accounts and workspace data.")}
                    </VAlert>
                ) : null}

                {actionError.value ? (
                    <VAlert type="error" variant="tonal" density="compact">{actionError.value}</VAlert>
                ) : null}

                <SegmentedTabs
                    modelValue={tab.value}
                    onUpdate:modelValue={(value: string) => (tab.value = value as typeof tab.value)}
                    tabs={tabs.value}
                    ariaLabel={t("Sandbox sections")}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : tab.value === "ACCOUNTS" ? (
                    <div class="d-flex flex-column ga-3">
                        <SurfaceCard subtle>
                            <div class="d-flex flex-wrap align-center ga-3">
                                <VSelect
                                    density="compact"
                                    variant="outlined"
                                    clearable
                                    label={t("Rail")}
                                    items={rails.value}
                                    modelValue={railFilter.value}
                                    onUpdate:modelValue={(value: string | null) => (railFilter.value = value)}
                                    style={{ maxWidth: "220px" }}
                                />
                                <VTextField
                                    density="compact"
                                    variant="outlined"
                                    label={t("Search identifier, holder or rail")}
                                    modelValue={search.value}
                                    onUpdate:modelValue={(value: string) => (search.value = value)}
                                    style={{ maxWidth: "320px" }}
                                />
                                <span class="text-caption text-medium-emphasis">
                                    {filtered.value.length} / {accounts.value.length}
                                </span>
                            </div>
                        </SurfaceCard>

                        {loading.value ? (
                            <SurfaceCard>
                                <div class="d-flex justify-center pa-6">
                                    <VIcon icon="mdi-loading" class="mdi-spin" size={28} />
                                </div>
                            </SurfaceCard>
                        ) : filtered.value.length === 0 ? (
                            <SurfaceCard>
                                <div class="text-caption text-medium-emphasis pa-4">
                                    {t("No Fake Rails test accounts match this filter.")}
                                </div>
                            </SurfaceCard>
                        ) : (
                            filtered.value.map((account) => (
                                <SurfaceCard key={account.id}>
                                    <div class="d-flex flex-column ga-3">
                                        <div class="d-flex flex-wrap justify-space-between align-center ga-2">
                                            <div class="d-flex flex-wrap align-center ga-2">
                                                <MonoRef value={account.identifier} />
                                                <StatusBadge status={account.status} />
                                                <span class="text-caption">
                                                    {t("Rail")}: <strong>{account.railCode}</strong>
                                                </span>
                                                <span class="text-caption">
                                                    {t("PIN / CVV")}: <code>{account.secretPin}</code>
                                                </span>
                                                {account.expiry ? (
                                                    <span class="text-caption">
                                                        {t("Expiry")}: <code>{account.expiry}</code>
                                                    </span>
                                                ) : null}
                                            </div>
                                            <div class="d-flex flex-wrap ga-1">
                                                <VBtn
                                                    size="small"
                                                    variant="outlined"
                                                    loading={busy.value === account.id}
                                                    onClick={() => void updateAccount(account, { quickPreset: "SET_ZERO" })}
                                                >
                                                    {t("Set 0 LYD (insufficient)")}
                                                </VBtn>
                                                <VBtn
                                                    size="small"
                                                    variant="outlined"
                                                    loading={busy.value === account.id}
                                                    onClick={() => void updateAccount(account, { quickPreset: "TOP_UP_5000" })}
                                                >
                                                    +5,000 LYD
                                                </VBtn>
                                                <VBtn
                                                    size="small"
                                                    variant="outlined"
                                                    onClick={() => void openMovements(account)}
                                                >
                                                    {t("Movements")}
                                                </VBtn>
                                                <VBtn
                                                    size="small"
                                                    color={account.status === "ACTIVE" ? "error" : "success"}
                                                    variant="text"
                                                    loading={busy.value === account.id}
                                                    onClick={() =>
                                                        void updateAccount(account, {
                                                            status: account.status === "ACTIVE" ? "FROZEN" : "ACTIVE",
                                                            reason: "Merchant sandbox accounts page",
                                                        })
                                                    }
                                                >
                                                    {account.status === "ACTIVE" ? t("Freeze") : t("Unfreeze")}
                                                </VBtn>
                                            </div>
                                        </div>
                                        <div class="text-caption">
                                            <span class="text-medium-emphasis">{account.holderName}</span>
                                            {" · "}
                                            {t("Available")}: <strong>{account.availableBalanceLyd} LYD</strong>
                                            {" · "}
                                            {t("Held")}: <strong>{account.reservedBalanceLyd} LYD</strong>
                                            {" · "}
                                            {t("Daily limit")}: <strong>{account.dailySpentLyd} / {account.dailyLimitLyd} LYD</strong>
                                        </div>
                                        {account.notes ? (
                                            <div class="text-caption text-medium-emphasis">{account.notes}</div>
                                        ) : null}
                                        <div class="d-flex flex-wrap align-center ga-2">
                                            <VTextField
                                                density="compact"
                                                variant="outlined"
                                                type="number"
                                                label={t("Custom available balance (LYD)")}
                                                modelValue={customBalance.value[account.id] ?? account.availableBalanceLyd}
                                                onUpdate:modelValue={(value: string) => {
                                                    customBalance.value = { ...customBalance.value, [account.id]: value };
                                                }}
                                                style={{ maxWidth: "260px" }}
                                            />
                                            <VBtn
                                                size="small"
                                                variant="tonal"
                                                loading={busy.value === account.id}
                                                onClick={() =>
                                                    void updateAccount(account, {
                                                        availableBalanceLyd: customBalance.value[account.id] ?? account.availableBalanceLyd,
                                                        reason: "Merchant sandbox accounts page",
                                                    })
                                                }
                                            >
                                                {t("Apply balance")}
                                            </VBtn>
                                        </div>
                                    </div>
                                </SurfaceCard>
                            ))
                        )}
                    </div>
                ) : tab.value === "SETTLEMENTS" ? (
                    <SurfaceCard title={t("Fake Rails Settlement Generator")} subtitle={t("Generate a statement from sandbox transactions and run the reconciliation ingestor.")}>
                        <div class="d-flex flex-column ga-3">
                            <div class="d-flex flex-wrap align-center ga-3">
                                <VSelect
                                    density="compact"
                                    variant="outlined"
                                    label={t("Gateway")}
                                    items={gateways.value}
                                    modelValue={settlementGateway.value}
                                    onUpdate:modelValue={(value: string | null) => (settlementGateway.value = value)}
                                    style={{ maxWidth: "240px" }}
                                />
                                <VBtn
                                    color="primary"
                                    loading={busy.value === "settlement"}
                                    disabled={!settlementGateway.value}
                                    onClick={() => void generateSettlement()}
                                >
                                    {t("Generate & Ingest Statement")}
                                </VBtn>
                            </div>
                            <div class="d-flex flex-wrap ga-4">
                                <label class="d-flex align-center ga-2 text-caption">
                                    <input
                                        type="checkbox"
                                        checked={settlementFeeVariance.value}
                                        onChange={(event: Event) => {
                                            settlementFeeVariance.value = (event.target as HTMLInputElement).checked;
                                        }}
                                    />
                                    {t("Inject fee variance anomaly")}
                                </label>
                                <label class="d-flex align-center ga-2 text-caption">
                                    <input
                                        type="checkbox"
                                        checked={settlementOmitOne.value}
                                        onChange={(event: Event) => {
                                            settlementOmitOne.value = (event.target as HTMLInputElement).checked;
                                        }}
                                    />
                                    {t("Omit one statement row")}
                                </label>
                            </div>
                            {settlementResult.value ? (
                                <div class="d-flex flex-column ga-2">
                                    <div class="text-caption">
                                        {t("Statement")}: <code>{String(settlementResult.value.statementId ?? "")}</code>
                                        {" · "}
                                        {t("Rows")}: <strong>{String(settlementResult.value.rows ?? 0)}</strong>
                                    </div>
                                    {(() => {
                                        const ingestion = (settlementResult.value?.ingestion ?? {}) as Record<string, unknown>;
                                        return (
                                            <div class="text-caption">
                                                {t("Reconciliation run")}: <code>{String(ingestion.runId ?? "")}</code>
                                                {" · "}
                                                {t("Matched")}: <strong>{String(ingestion.matched ?? 0)}</strong>
                                                {" · "}
                                                {t("Missing at gateway")}: <strong>{String(ingestion.missingAtGateway ?? 0)}</strong>
                                                {" · "}
                                                {t("Missing locally")}: <strong>{String(ingestion.missingLocally ?? 0)}</strong>
                                                {" · "}
                                                {t("Amount mismatch")}: <strong>{String(ingestion.amountMismatch ?? 0)}</strong>
                                            </div>
                                        );
                                    })()}
                                </div>
                            ) : null}
                        </div>
                    </SurfaceCard>
                ) : (
                    <div class="d-flex flex-column ga-3">
                        <SurfaceCard title={t("Seed Sample Sandbox Transactions")} subtitle={t("Creates three sandbox payment links (25, 100 and 250 LYD) for this merchant.")}>
                            <VBtn color="primary" loading={seeding.value} onClick={() => void seedLinks()}>
                                {t("Seed Sample Sandbox Links")}
                            </VBtn>
                        </SurfaceCard>
                        <SurfaceCard title={t("Reset Sandbox Workspace")} subtitle={t("Deletes this merchant's sandbox attempts and links, and restores the canonical Fake Rails test-account balances.")}>
                            <VBtn color="error" variant="tonal" loading={resetting.value} onClick={() => void resetWorkspace()}>
                                {t("Reset Sandbox Workspace")}
                            </VBtn>
                        </SurfaceCard>
                    </div>
                )}
            </ThemedView>

            <FormModal
                modelValue={movementsOpen.value}
                onUpdate:modelValue={(value: boolean) => (movementsOpen.value = value)}
                title={t("Account Movements")}
                subtitle={movementsAccount.value?.identifier ?? ""}
                size="lg"
            >
                <div class="d-flex flex-column ga-2">
                    {movements.value.length === 0 ? (
                        <span class="text-caption text-medium-emphasis">{t("No movements yet")}</span>
                    ) : (
                        movements.value.map((movement) => (
                            <div key={movement.id} class="text-caption">
                                <code>{movement.direction}</code> {movement.amount_lyd} LYD
                                {" · "}
                                {movement.available_before_lyd} &rarr; {movement.available_after_lyd}
                                {" · "}
                                <span class="text-medium-emphasis">{movement.reason}</span>
                            </div>
                        ))
                    )}
                </div>
            </FormModal>
        </ScreenContainer>
    );
});

export default SandboxAccountsPage;
