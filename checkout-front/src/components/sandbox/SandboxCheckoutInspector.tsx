import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VDivider, VIcon, VProgressCircular, VTextField } from "vuetify/components";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiError } from "@/utils/errors/extractor";
import {
    MonoRef,
    StatusBadge,
    SurfaceCard,
} from "@/components/ui";
import type {
    SandboxActiveAttemptSecrets,
    SandboxCheckoutInspectorPayload,
    SandboxInspectorAccount,
} from "@/components/renderers/types";

export interface SandboxCheckoutInspectorProps {
    linkKey: string;
    linkAmount: string;
    selectedRailCode: string | null;
    attemptId: string | null;
    phase: string;
    inspector: SandboxCheckoutInspectorPayload | null | undefined;
    activeSecrets: SandboxActiveAttemptSecrets | null;
    onAutoFillAccount: (account: SandboxInspectorAccount) => void;
    onAutoConfirmOtp: (otp: string) => void;
    onRefreshAttempt: () => void;
}

interface MovementRow {
    id: string;
    direction: string;
    amount_lyd: string;
    available_before_lyd: string;
    available_after_lyd: string;
    reason: string;
    created_at: string;
}

const isSandboxError = (error: unknown, code: string): boolean => extractApiError(error)?.code === code;

export const SandboxCheckoutInspector = dc<SandboxCheckoutInspectorProps, {}>((props) => {
    const { t } = useLocale();
    const expanded = ref(true);
    const activeTab = ref<"ACCOUNTS" | "SECRETS">("ACCOUNTS");
    const accounts = ref<SandboxInspectorAccount[]>([]);
    const loadingAccounts = ref(false);
    const unlocked = ref(props.inspector?.mode === "OPEN_IN_SANDBOX" || props.inspector?.unlocked === true);
    const pin = ref("");
    const pinError = ref<string | null>(null);
    const busyAction = ref<string | null>(null);
    const customBalance = ref<Record<string, string>>({});
    const movements = ref<Record<string, MovementRow[]>>({});
    const openMovements = ref<Record<string, boolean>>({});
    const secrets = ref<SandboxActiveAttemptSecrets | null>(props.activeSecrets);
    const actionError = ref<string | null>(null);

    const pinHeaders = computed(() => (pin.value ? { "x-pg-sandbox-pin": pin.value } : undefined));

    const loadAccounts = async (): Promise<void> => {
        if (!props.linkKey.startsWith("sbx_")) return;
        loadingAccounts.value = true;
        try {
            const response = await api.get(urlsMap.paySandboxAccounts(props.linkKey, props.selectedRailCode), {
                headers: pinHeaders.value,
            });
            const payload = response.data?.data ?? response.data ?? {};
            accounts.value = (payload.accounts ?? []) as SandboxInspectorAccount[];
            unlocked.value = true;
            pinError.value = null;
            for (const account of accounts.value) {
                customBalance.value[account.id] ??= account.availableBalanceLyd;
            }
        } catch (error) {
            if (isSandboxError(error, "SANDBOX_INSPECTOR_LOCKED")) {
                unlocked.value = false;
                pinError.value = t("Enter the inspector PIN to unlock test accounts");
            } else if (isSandboxError(error, "SANDBOX_INSPECTOR_DISABLED")) {
                actionError.value = t("The sandbox inspector is disabled for this application");
            }
        } finally {
            loadingAccounts.value = false;
        }
    };

    const loadSecrets = async (): Promise<void> => {
        if (!props.attemptId || !props.linkKey.startsWith("sbx_")) {
            secrets.value = props.activeSecrets;
            return;
        }
        try {
            const response = await api.get(urlsMap.payLogs(props.linkKey, props.attemptId), {
                headers: pinHeaders.value,
            });
            const snapshot = (response.data?.data ?? response.data ?? {}) as {
                sandboxInspector?: SandboxCheckoutInspectorPayload;
            };
            secrets.value = snapshot.sandboxInspector?.activeAttemptSecrets ?? props.activeSecrets;
        } catch {
            secrets.value = props.activeSecrets;
        }
    };

    watch(
        () => [props.selectedRailCode, props.phase, props.attemptId, props.activeSecrets] as const,
        () => {
            void loadAccounts();
            void loadSecrets();
            if (props.phase === "ACTION" || props.phase === "CONFIRMING") {
                activeTab.value = "SECRETS";
            }
        },
        { immediate: true },
    );

    const updateAccount = async (accountId: string, payload: Record<string, unknown>): Promise<void> => {
        busyAction.value = accountId;
        actionError.value = null;
        try {
            await api.patch(urlsMap.paySandboxAccount(props.linkKey, accountId), payload, {
                headers: pinHeaders.value,
            });
            await loadAccounts();
        } catch (error) {
            actionError.value = extractApiError(error)?.error ?? t("Could not update the sandbox account");
        } finally {
            busyAction.value = null;
        }
    };

    const loadMovements = async (accountId: string): Promise<void> => {
        openMovements.value = { ...openMovements.value, [accountId]: !openMovements.value[accountId] };
        if (!openMovements.value[accountId] || movements.value[accountId]) return;
        busyAction.value = accountId;
        try {
            const response = await api.get(`${urlsMap.paySandboxAccount(props.linkKey, accountId)}/movements`, {
                headers: pinHeaders.value,
            });
            const payload = response.data?.data ?? response.data ?? {};
            movements.value = { ...movements.value, [accountId]: (payload.movements ?? []) as MovementRow[] };
        } catch {
            movements.value = { ...movements.value, [accountId]: [] };
        } finally {
            busyAction.value = null;
        }
    };

    const triggerSimulate = async (action: string): Promise<void> => {
        if (!props.attemptId) return;
        busyAction.value = action;
        actionError.value = null;
        try {
            const response = await api.post(
                urlsMap.paySandboxSimulate(props.linkKey, props.attemptId),
                { action },
                { headers: pinHeaders.value },
            );
            const status = (response.data?.data ?? response.data ?? {}).status;
            props.onRefreshAttempt();
            await new Promise((resolve) => setTimeout(resolve, 500));
            await loadSecrets();
            await loadAccounts();
            if (status) props.onRefreshAttempt();
        } catch (error) {
            actionError.value = extractApiError(error)?.error ?? t("Could not simulate the customer action");
        } finally {
            busyAction.value = null;
        }
    };

    const unlock = async (): Promise<void> => {
        if (!pin.value.trim()) return;
        await loadAccounts();
        await loadSecrets();
    };

    const filteredAccounts = computed(() =>
        props.selectedRailCode
            ? accounts.value.filter((account) => account.railCode === props.selectedRailCode)
            : accounts.value,
    );

    return () => (
        <SurfaceCard
            style={{
                border: "2px solid rgb(var(--v-theme-warning))",
                background: "rgba(245, 158, 11, 0.06)",
            }}
        >
            <div class="d-flex flex-wrap justify-space-between align-center ga-2">
                <div class="d-flex align-center ga-2">
                    <VIcon icon="mdi-flask-outline" color="warning" />
                    <strong class="text-body-2">{t("Fake Rails Secret & Account Balance Inspector")}</strong>
                    <span class="text-caption text-medium-emphasis">{t("SANDBOX TEST HELPER")}</span>
                </div>
                <div class="d-flex align-center ga-1 flex-wrap">
                    <VBtn
                        size="small"
                        variant={activeTab.value === "ACCOUNTS" ? "tonal" : "text"}
                        onClick={() => { activeTab.value = "ACCOUNTS"; }}
                    >
                        {t("Test Accounts & Balances")} ({filteredAccounts.value.length})
                    </VBtn>
                    <VBtn
                        size="small"
                        color="warning"
                        variant={activeTab.value === "SECRETS" ? "flat" : "text"}
                        onClick={() => { activeTab.value = "SECRETS"; }}
                    >
                        {t("Live OTP & Simulator")}
                    </VBtn>
                    <VBtn
                        size="small"
                        icon
                        variant="text"
                        aria-label={t("Collapse")}
                        onClick={() => { expanded.value = !expanded.value; }}
                    >
                        <VIcon icon={expanded.value ? "mdi-chevron-up" : "mdi-chevron-down"} />
                    </VBtn>
                </div>
            </div>

            {expanded.value ? (
                <div class="d-flex flex-column ga-3 mt-2">
                    <VDivider />
                    {!unlocked.value ? (
                        <div class="d-flex flex-wrap align-center ga-2">
                            <VTextField
                                density="compact"
                                variant="outlined"
                                type="password"
                                label={t("Inspector PIN")}
                                modelValue={pin.value}
                                errorMessages={pinError.value ?? undefined}
                                onUpdate:modelValue={(value: string) => { pin.value = value; }}
                                style={{ maxWidth: "220px" }}
                            />
                            <VBtn size="small" color="warning" variant="flat" onClick={() => void unlock()}>
                                {t("Unlock")}
                            </VBtn>
                        </div>
                    ) : activeTab.value === "SECRETS" ? (
                        <div class="d-flex flex-column ga-3">
                            <VAlert type="warning" variant="tonal" density="compact">
                                <div class="d-flex flex-wrap justify-space-between align-center ga-2">
                                    <div>
                                        <div class="text-caption">
                                            {t("Live generated OTP or confirmation secret for the active attempt")}
                                        </div>
                                        <div class="text-h6 font-weight-bold pg-mono">
                                            {secrets.value?.expectedOtp ?? t("N/A (async push or redirect mode)")}
                                        </div>
                                    </div>
                                    {secrets.value?.expectedOtp ? (
                                        <div class="d-flex ga-2 flex-wrap">
                                            <VBtn
                                                color="success"
                                                size="small"
                                                prependIcon="mdi-check-decagram"
                                                onClick={() => props.onAutoConfirmOtp(secrets.value!.expectedOtp!)}
                                            >
                                                {t("Auto-fill & confirm OTP")} ({secrets.value.expectedOtp})
                                            </VBtn>
                                            <VBtn
                                                color="error"
                                                size="small"
                                                variant="outlined"
                                                onClick={() => props.onAutoConfirmOtp("000000")}
                                            >
                                                {t("Test wrong OTP")} (000000)
                                            </VBtn>
                                        </div>
                                    ) : null}
                                </div>
                            </VAlert>

                            {secrets.value?.boundAccountIdentifier ? (
                                <div
                                    class="d-flex flex-wrap justify-space-between align-center text-body-2 pa-2 rounded ga-2"
                                    style={{ background: "rgba(128,128,128,0.12)" }}
                                >
                                    <span>
                                        {t("Payer account")}: <MonoRef value={secrets.value.boundAccountIdentifier} />
                                    </span>
                                    <span>
                                        {t("Held")}: <strong>{secrets.value.heldAmountLyd ?? "0.0000"} LYD</strong>
                                    </span>
                                    <span>
                                        {t("Remaining available")}: <strong>
                                            {secrets.value.boundAccountBalanceAfterHoldLyd ?? "-"} LYD
                                        </strong>
                                    </span>
                                </div>
                            ) : null}

                            {secrets.value?.canSimulateMobilePushOrQrApproval ? (
                                <div class="d-flex flex-wrap ga-2 align-center">
                                    <span class="text-caption font-weight-medium">
                                        {t("Simulate customer mobile banking app")}:
                                    </span>
                                    <VBtn
                                        color="success"
                                        size="small"
                                        loading={busyAction.value === "APPROVE_PUSH_OR_QR"}
                                        onClick={() => void triggerSimulate("APPROVE_PUSH_OR_QR")}
                                    >
                                        {t("Approve push or scan QR")} ({props.linkAmount} LYD)
                                    </VBtn>
                                    <VBtn
                                        color="error"
                                        size="small"
                                        variant="outlined"
                                        loading={busyAction.value === "DECLINE_PUSH_OR_QR"}
                                        onClick={() => void triggerSimulate("DECLINE_PUSH_OR_QR")}
                                    >
                                        {t("Reject on customer phone")}
                                    </VBtn>
                                    <VBtn
                                        color="warning"
                                        size="small"
                                        variant="outlined"
                                        loading={busyAction.value === "APPROVE_WITH_VARIANCE"}
                                        onClick={() => void triggerSimulate("APPROVE_WITH_VARIANCE")}
                                    >
                                        {t("Approve with +0.0500 LYD mismatch")}
                                    </VBtn>
                                    <VBtn
                                        size="small"
                                        variant="text"
                                        loading={busyAction.value === "REPLAY_DUPLICATE_WEBHOOK"}
                                        onClick={() => void triggerSimulate("REPLAY_DUPLICATE_WEBHOOK")}
                                    >
                                        {t("Replay duplicate webhook")}
                                    </VBtn>
                                    <VBtn
                                        size="small"
                                        variant="text"
                                        loading={busyAction.value === "FIRE_TAMPERED_WEBHOOK"}
                                        onClick={() => void triggerSimulate("FIRE_TAMPERED_WEBHOOK")}
                                    >
                                        {t("Fire tampered webhook")}
                                    </VBtn>
                                </div>
                            ) : null}

                            {!secrets.value ? (
                                <span class="text-caption text-medium-emphasis">
                                    {t("Start a payment to reveal its live OTP and simulator controls")}
                                </span>
                            ) : null}
                        </div>
                    ) : (
                        <div class="d-flex flex-column ga-2">
                            <div class="text-caption text-medium-emphasis">
                                {t("Use an account to auto-fill the checkout form, or adjust a balance before paying")}
                            </div>
                            {actionError.value ? (
                                <VAlert type="error" variant="tonal" density="compact">{actionError.value}</VAlert>
                            ) : null}
                            {loadingAccounts.value && filteredAccounts.value.length === 0 ? (
                                <div class="d-flex justify-center pa-4">
                                    <VProgressCircular indeterminate size={28} color="warning" />
                                </div>
                            ) : null}
                            {filteredAccounts.value.map((account) => (
                                <div
                                    key={account.id}
                                    class="d-flex flex-column pa-2 rounded ga-2"
                                    style={{ border: "1px solid rgba(128,128,128,0.3)" }}
                                >
                                    <div class="d-flex flex-wrap align-center justify-space-between ga-2">
                                        <div class="d-flex flex-wrap align-center ga-2">
                                            <MonoRef value={account.identifier} />
                                            <StatusBadge status={account.status} />
                                            <span class="text-caption">
                                                {t("PIN / CVV")}: <code>{account.secretPin}</code>
                                            </span>
                                            {account.expiry ? (
                                                <span class="text-caption">
                                                    {t("Expiry")}: <code>{account.expiry}</code>
                                                </span>
                                            ) : null}
                                            <span class="text-caption text-medium-emphasis">{account.railCode}</span>
                                        </div>
                                        <div class="d-flex flex-wrap align-center ga-1">
                                            <VBtn
                                                size="x-small"
                                                color="primary"
                                                variant="flat"
                                                onClick={() => props.onAutoFillAccount(account)}
                                            >
                                                {t("Use account")}
                                            </VBtn>
                                            <VBtn
                                                size="x-small"
                                                variant="outlined"
                                                loading={busyAction.value === account.id}
                                                onClick={() => void updateAccount(account.id, { quickPreset: "SET_ZERO" })}
                                            >
                                                {t("Set 0 LYD (insufficient)")}
                                            </VBtn>
                                            <VBtn
                                                size="x-small"
                                                variant="outlined"
                                                loading={busyAction.value === account.id}
                                                onClick={() => void updateAccount(account.id, {
                                                    quickPreset: "SET_LINK_AMOUNT",
                                                    linkAmountLyd: props.linkAmount,
                                                })}
                                            >
                                                {t("Set exact link amount")}
                                            </VBtn>
                                            <VBtn
                                                size="x-small"
                                                variant="outlined"
                                                loading={busyAction.value === account.id}
                                                onClick={() => void updateAccount(account.id, { quickPreset: "TOP_UP_5000" })}
                                            >
                                                +5,000 LYD
                                            </VBtn>
                                            <VBtn
                                                size="x-small"
                                                color={account.status === "ACTIVE" ? "error" : "success"}
                                                variant="text"
                                                loading={busyAction.value === account.id}
                                                onClick={() => void updateAccount(account.id, {
                                                    status: account.status === "ACTIVE" ? "FROZEN" : "ACTIVE",
                                                    reason: account.status === "ACTIVE" ? "Frozen from checkout inspector" : "Unfrozen from checkout inspector",
                                                })}
                                            >
                                                {account.status === "ACTIVE" ? t("Freeze") : t("Unfreeze")}
                                            </VBtn>
                                            <VBtn
                                                size="x-small"
                                                variant="text"
                                                onClick={() => void loadMovements(account.id)}
                                            >
                                                {t("Movements")}
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
                                            loading={busyAction.value === account.id}
                                            onClick={() => void updateAccount(account.id, {
                                                availableBalanceLyd: customBalance.value[account.id] ?? account.availableBalanceLyd,
                                                reason: "Custom balance from checkout inspector",
                                            })}
                                        >
                                            {t("Apply balance")}
                                        </VBtn>
                                    </div>
                                    {openMovements.value[account.id] ? (
                                        <div class="d-flex flex-column ga-1">
                                            {(movements.value[account.id] ?? []).slice(0, 8).map((movement) => (
                                                <div key={movement.id} class="text-caption">
                                                    <code>{movement.direction}</code> {movement.amount_lyd} LYD
                                                    {" · "}
                                                    {movement.available_before_lyd} &rarr; {movement.available_after_lyd}
                                                    {" · "}
                                                    <span class="text-medium-emphasis">{movement.reason}</span>
                                                </div>
                                            ))}
                                            {(movements.value[account.id] ?? []).length === 0 ? (
                                                <span class="text-caption text-medium-emphasis">{t("No movements yet")}</span>
                                            ) : null}
                                        </div>
                                    ) : null}
                                </div>
                            ))}
                            {!loadingAccounts.value && filteredAccounts.value.length === 0 ? (
                                <span class="text-caption text-medium-emphasis">
                                    {t("No Fake Rails test accounts match this rail")}
                                </span>
                            ) : null}
                        </div>
                    )}
                </div>
            ) : null}
        </SurfaceCard>
    );
});
