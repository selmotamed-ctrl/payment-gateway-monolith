import { dc } from "kt-dc";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { VAlert, VBtn, VChip, VDivider, VSelect, VTextField } from "vuetify/components";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { MonoRef, StatusBadge, SurfaceCard } from "@/components/ui";
import type {
  SandboxAccountItem,
  SandboxActiveSecrets,
  SandboxInspectorPayload,
} from "@/components/renderers/types";

export interface SandboxCheckoutInspectorProps {
  linkKey: string;
  linkAmount: string;
  selectedRailCode: string | null;
  attemptId: string | null;
  phase: string;
  onAutoFillAccount: (account: SandboxAccountItem) => void;
  onAutoConfirmOtp: (otp: string) => void;
  onRefreshAttempt: () => void;
}

/**
 * The Sandbox Test Assistant.
 *
 * Only rendered on a Sandbox (`sbx_`) checkout. It reveals the generated
 * test-customer accounts and their live balances, lets the tester change a
 * balance or freeze an account without reloading the checkout, shows the
 * current OTP challenge, and can simulate a mobile-app push/QR decision.
 * Nothing here exists on a Live checkout.
 */
export const SandboxCheckoutInspector = dc<SandboxCheckoutInspectorProps, {}>((props) => {
  const expanded = ref(true);
  const activeTab = ref<"ACCOUNTS" | "SECRETS">("ACCOUNTS");
  const accounts = ref<SandboxAccountItem[]>([]);
  const activeSecrets = ref<SandboxActiveSecrets | null>(null);
  const unavailable = ref<string | null>(null);
  const loading = ref(false);
  const busyAction = ref<string | null>(null);
  const customBalance = ref("");
  const selectedAccountId = ref<string | null>(null);
  const error = ref<string | null>(null);
  const movements = ref<Array<Record<string, unknown>>>([]);
  const movementsFor = ref<string | null>(null);
  const createOpen = ref(false);
  const creating = ref(false);
  const createForm = ref({
    instrumentType: "CARD",
    identifier: "",
    holderName: "",
    secretPin: "123",
    expiry: "12/28",
    availableBalanceLyd: "5000.0000",
    dailyLimitLyd: "10000.0000",
    staticOtp: "",
  });

  let timer: number | null = null;

  const loadAccounts = async () => {
    if (!props.linkKey.startsWith("sbx_")) return;
    loading.value = true;
    try {
      const response = await api.get(urlsMap.sandboxAccounts(props.linkKey, props.selectedRailCode));
      const payload = response.data?.data ?? response.data ?? {};
      accounts.value = (payload.accounts ?? []) as SandboxAccountItem[];
      unavailable.value = null;
      if (!selectedAccountId.value && accounts.value.length > 0) {
        selectedAccountId.value = accounts.value[0]!.id;
      }
    } catch (error) {
      unavailable.value = error instanceof Error ? error.message : String(error);
    } finally {
      loading.value = false;
    }
  };

  const loadInspector = async () => {
    if (!props.linkKey.startsWith("sbx_") || !props.attemptId) return;
    try {
      const response = await api.get(urlsMap.sandboxInspector(props.linkKey, props.attemptId));
      const payload = (response.data?.data ?? response.data ?? {}) as SandboxInspectorPayload;
      activeSecrets.value = payload.activeAttemptSecrets ?? null;
      if (Array.isArray(payload.railAccounts) && payload.railAccounts.length > 0) {
        accounts.value = payload.railAccounts;
      }
      unavailable.value = payload.unavailable ?? null;
      if (payload.activeAttemptSecrets?.expectedOtp && props.phase === "ACTION") {
        activeTab.value = "SECRETS";
      }
    } catch {
      // The inspector is advisory; a transient failure must never break the payment.
    }
  };

  const stopPolling = () => {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  const startPolling = () => {
    stopPolling();
    timer = window.setInterval(() => {
      if (["ACTION", "CONFIRMING"].includes(props.phase)) {
        void loadInspector();
      }
    }, 2500);
  };

  watch(
    () => [props.linkKey, props.selectedRailCode],
    () => {
      void loadAccounts();
    },
    { immediate: true },
  );

  watch(
    () => [props.attemptId, props.phase],
    () => {
      if (props.attemptId) {
        void loadInspector();
        startPolling();
      } else {
        stopPolling();
        activeSecrets.value = null;
      }
    },
    { immediate: true },
  );

  onBeforeUnmount(stopPolling);

  const filteredAccounts = computed(() =>
    props.selectedRailCode
      ? accounts.value.filter((account) => account.railCode === props.selectedRailCode)
      : accounts.value,
  );

  const selectedAccount = computed(
    () => filteredAccounts.value.find((account) => account.id === selectedAccountId.value) ?? filteredAccounts.value[0] ?? null,
  );

  const patchAccount = async (accountId: string, payload: Record<string, unknown>) => {
    busyAction.value = accountId;
    error.value = null;
    try {
      await api.patch(urlsMap.sandboxAccount(props.linkKey, accountId), payload);
      await loadAccounts();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busyAction.value = null;
    }
  };

  const loadMovements = async (accountId: string) => {
    movementsFor.value = movementsFor.value === accountId ? null : accountId;
    if (!movementsFor.value) return;
    busyAction.value = `movements:${accountId}`;
    error.value = null;
    try {
      const response = await api.get(urlsMap.sandboxAccountMovements(props.linkKey, accountId));
      const payload = response.data?.data ?? response.data ?? {};
      movements.value = (payload.movements ?? []) as Array<Record<string, unknown>>;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      movements.value = [];
    } finally {
      busyAction.value = null;
    }
  };

  const createAccount = async () => {
    const rail = filteredAccounts.value[0]?.railCode ?? props.selectedRailCode;
    if (!rail) {
      error.value = "Select a rail first.";
      return;
    }
    creating.value = true;
    error.value = null;
    try {
      const gatewayCode = filteredAccounts.value[0]?.gatewayCode ?? rail;
      await api.post(urlsMap.sandboxAccounts(props.linkKey), {
        railCode: rail,
        gatewayCode,
        instrumentType: createForm.value.instrumentType,
        identifier: createForm.value.identifier,
        holderName: createForm.value.holderName,
        secretPin: createForm.value.secretPin,
        expiry: createForm.value.expiry,
        availableBalanceLyd: createForm.value.availableBalanceLyd,
        dailyLimitLyd: createForm.value.dailyLimitLyd,
        staticOtp: createForm.value.staticOtp || undefined,
      });
      createOpen.value = false;
      createForm.value.identifier = "";
      createForm.value.holderName = "";
      await loadAccounts();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      creating.value = false;
    }
  };

  const applyCustomBalance = async () => {
    const account = selectedAccount.value;
    if (!account || customBalance.value.trim().length === 0) return;
    await patchAccount(account.id, { availableBalanceLyd: customBalance.value.trim() });
    customBalance.value = "";
  };

  const triggerSimulate = async (action: string) => {
    if (!props.attemptId) return;
    busyAction.value = action;
    error.value = null;
    try {
      await api.post(urlsMap.sandboxSimulate(props.linkKey, props.attemptId), { action });
      props.onRefreshAttempt();
      await loadInspector();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busyAction.value = null;
    }
  };

  return () => (
    <SurfaceCard
      class="mt-4"
      style={{ border: "2px solid #f59e0b", background: "rgba(245, 158, 11, 0.04)" }}
    >
      <div class="d-flex justify-space-between align-center pa-3 flex-wrap ga-2">
        <div class="d-flex align-center ga-2 flex-wrap">
          <VChip color="warning" size="small" variant="flat">
            SANDBOX TEST HELPER
          </VChip>
          <strong class="text-body-2">Fake Rails Secret &amp; Account Balance Inspector</strong>
        </div>
        <div class="d-flex ga-2">
          <VBtn
            size="small"
            variant={activeTab.value === "ACCOUNTS" ? "tonal" : "text"}
            onClick={() => {
              activeTab.value = "ACCOUNTS";
            }}
          >
            Test Accounts ({filteredAccounts.value.length})
          </VBtn>
          <VBtn
            size="small"
            color="warning"
            variant={activeTab.value === "SECRETS" ? "flat" : "text"}
            onClick={() => {
              activeTab.value = "SECRETS";
            }}
          >
            Live OTP &amp; Simulator
          </VBtn>
          <VBtn
            size="small"
            icon={expanded.value ? "mdi-chevron-down" : "mdi-chevron-up"}
            variant="text"
            aria-label="Toggle sandbox test helper"
            onClick={() => {
              expanded.value = !expanded.value;
            }}
          />
        </div>
      </div>

      {expanded.value ? (
        <div class="pa-3 pt-0">
          <VDivider class="mb-3" />
          {unavailable.value ? (
            <VAlert type="warning" variant="tonal" density="compact" class="mb-3">
              Fake Rails is not reachable: {unavailable.value}
            </VAlert>
          ) : null}
          {error.value ? (
            <VAlert type="error" variant="tonal" density="compact" class="mb-3">
              {error.value}
            </VAlert>
          ) : null}

          {activeTab.value === "SECRETS" ? (
            <div class="d-flex flex-column ga-3">
              <VAlert type="warning" variant="tonal" density="compact">
                <div class="d-flex justify-space-between align-center flex-wrap ga-2">
                  <div>
                    <div class="text-caption">Live generated OTP / confirmation secret for this attempt</div>
                    <div class="text-h6 font-weight-bold pg-mono">
                      {activeSecrets.value?.expectedOtp ?? "N/A (async push / redirect mode)"}
                    </div>
                  </div>
                  {activeSecrets.value?.expectedOtp ? (
                    <div class="d-flex ga-2 flex-wrap">
                      <VBtn
                        color="success"
                        size="small"
                        prepend-icon="mdi-check-decagram"
                        onClick={() => props.onAutoConfirmOtp(activeSecrets.value!.expectedOtp!)}
                      >
                        Auto-fill &amp; confirm OTP ({activeSecrets.value.expectedOtp})
                      </VBtn>
                      <VBtn
                        color="error"
                        size="small"
                        variant="outlined"
                        onClick={() => props.onAutoConfirmOtp("000000")}
                      >
                        Test wrong OTP (000000)
                      </VBtn>
                    </div>
                  ) : null}
                </div>
              </VAlert>

              {activeSecrets.value?.boundAccountIdentifier ? (
                <div
                  class="d-flex justify-space-between align-center flex-wrap text-body-2 pa-2 rounded ga-2"
                  style={{ background: "rgba(0,0,0,0.04)" }}
                >
                  <span>
                    Payer account: <MonoRef value={activeSecrets.value.boundAccountIdentifier} />
                  </span>
                  <span>
                    Held: <strong>{activeSecrets.value.heldAmountLyd ?? "0.0000"} LYD</strong>
                  </span>
                  <span>
                    Remaining available:{" "}
                    <strong>{activeSecrets.value.boundAccountBalanceAfterHoldLyd ?? "-"} LYD</strong>
                  </span>
                </div>
              ) : null}

              {activeSecrets.value?.expectedOtp ? (
                <div class="text-caption text-medium-emphasis">
                  OTP expires at: {activeSecrets.value.expiresAt ?? "unknown"}
                </div>
              ) : null}
              {activeSecrets.value?.qrPayload ? (
                <div class="text-caption">
                  QR payload: <code class="pg-mono">{activeSecrets.value.qrPayload}</code>
                </div>
              ) : null}
              {activeSecrets.value?.deepLinkUrl ? (
                <div class="text-caption">
                  Deep link: <a href={activeSecrets.value.deepLinkUrl} target="_blank" rel="noreferrer">{activeSecrets.value.deepLinkUrl}</a>
                </div>
              ) : null}
              {activeSecrets.value?.redirectUrl ? (
                <div class="text-caption">
                  Redirect: <a href={activeSecrets.value.redirectUrl} target="_blank" rel="noreferrer">{activeSecrets.value.redirectUrl}</a>
                </div>
              ) : null}
              {activeSecrets.value?.recentWireEvents?.length ? (
                <div class="d-flex flex-column ga-1">
                  <div class="text-caption font-weight-medium mb-1">Recent gateway calls</div>
                  {activeSecrets.value.recentWireEvents.slice(0, 6).map((event, index) => (
                    <div key={index} class="text-caption pg-mono">
                      {event.phase} · {event.status ?? "-"} · {event.fault ?? "ok"} · {event.durationMs ?? 0} ms
                    </div>
                  ))}
                </div>
              ) : null}
              {activeSecrets.value?.canSimulateMobilePushOrQrApproval ? (
                <div class="d-flex flex-wrap ga-2 align-center">
                  <span class="text-caption font-weight-medium">Simulate the customer mobile banking app:</span>
                  <VBtn
                    color="success"
                    size="small"
                    loading={busyAction.value === "APPROVE_PUSH_OR_QR"}
                    onClick={() => void triggerSimulate("APPROVE_PUSH_OR_QR")}
                  >
                    Approve push / scan QR ({props.linkAmount} LYD)
                  </VBtn>
                  <VBtn
                    color="error"
                    size="small"
                    variant="outlined"
                    loading={busyAction.value === "DECLINE_PUSH_OR_QR"}
                    onClick={() => void triggerSimulate("DECLINE_PUSH_OR_QR")}
                  >
                    Reject on customer phone
                  </VBtn>
                  <VBtn
                    color="warning"
                    size="small"
                    variant="outlined"
                    loading={busyAction.value === "APPROVE_WITH_VARIANCE"}
                    onClick={() => void triggerSimulate("APPROVE_WITH_VARIANCE")}
                  >
                    Approve with +0.0500 LYD mismatch
                  </VBtn>
                  <VBtn
                    size="small"
                    variant="text"
                    loading={busyAction.value === "REPLAY_DUPLICATE_WEBHOOK"}
                    onClick={() => void triggerSimulate("REPLAY_DUPLICATE_WEBHOOK")}
                  >
                    Replay duplicate webhook
                  </VBtn>
                  <VBtn
                    size="small"
                    variant="text"
                    color="warning"
                    loading={busyAction.value === "FIRE_TAMPERED_WEBHOOK"}
                    onClick={() => void triggerSimulate("FIRE_TAMPERED_WEBHOOK")}
                  >
                    Fire tampered webhook
                  </VBtn>
                </div>
              ) : (
                <div class="text-caption text-medium-emphasis">
                  {props.attemptId
                    ? "Start a payment to reveal the OTP challenge and push/QR simulator."
                    : "No active attempt yet."}
                </div>
              )}
            </div>
          ) : (
            <div class="d-flex flex-column ga-2">
              <div class="d-flex justify-space-between align-center flex-wrap ga-2 mb-1">
                <div class="text-caption text-medium-emphasis">
                  Click <strong>Use account</strong> to auto-fill the checkout form, or change a balance before paying:
                </div>
                <VBtn size="x-small" variant="tonal" onClick={() => (createOpen.value = !createOpen.value)}>
                  {createOpen.value ? "Close new account" : "New test account"}
                </VBtn>
              </div>
              {createOpen.value ? (
                <div class="d-flex flex-column ga-2 pa-2 rounded" style={{ border: "1px dashed rgba(128,128,128,0.4)" }}>
                  <div class="d-flex ga-2 flex-wrap">
                    <VSelect
                      density="compact"
                      variant="outlined"
                      hide-details
                      style={{ maxWidth: "150px" }}
                      items={["CARD", "MOBILE_WALLET", "BANK_ACCOUNT", "VOUCHER"]}
                      label="Instrument"
                      modelValue={createForm.value.instrumentType}
                      onUpdate:modelValue={(value: string) => (createForm.value.instrumentType = value)}
                    />
                    <VTextField density="compact" variant="outlined" hide-details style={{ maxWidth: "180px" }} label="Identifier" modelValue={createForm.value.identifier} onUpdate:modelValue={(value: string) => (createForm.value.identifier = value)} />
                    <VTextField density="compact" variant="outlined" hide-details style={{ maxWidth: "180px" }} label="Holder" modelValue={createForm.value.holderName} onUpdate:modelValue={(value: string) => (createForm.value.holderName = value)} />
                    <VTextField density="compact" variant="outlined" hide-details style={{ maxWidth: "100px" }} label="PIN/CVV" modelValue={createForm.value.secretPin} onUpdate:modelValue={(value: string) => (createForm.value.secretPin = value)} />
                    <VTextField density="compact" variant="outlined" hide-details style={{ maxWidth: "110px" }} label="Balance" modelValue={createForm.value.availableBalanceLyd} onUpdate:modelValue={(value: string) => (createForm.value.availableBalanceLyd = value)} />
                    <VTextField density="compact" variant="outlined" hide-details style={{ maxWidth: "110px" }} label="Daily limit" modelValue={createForm.value.dailyLimitLyd} onUpdate:modelValue={(value: string) => (createForm.value.dailyLimitLyd = value)} />
                    <VTextField density="compact" variant="outlined" hide-details style={{ maxWidth: "90px" }} label="OTP" modelValue={createForm.value.staticOtp} onUpdate:modelValue={(value: string) => (createForm.value.staticOtp = value)} />
                    <VBtn size="small" color="primary" loading={creating.value} onClick={() => void createAccount()}>Create</VBtn>
                  </div>
                </div>
              ) : null}
              {loading.value && filteredAccounts.value.length === 0 ? (
                <div class="text-caption">Loading test accounts…</div>
              ) : null}
              {filteredAccounts.value.map((account) => (
                <div
                  key={account.id}
                  class={`d-flex flex-wrap justify-space-between align-center pa-2 rounded ga-2 ${
                    selectedAccountId.value === account.id ? "border" : ""
                  }`}
                  style={{ border: "1px solid rgba(128,128,128,0.25)" }}
                >
                  <div>
                    <div class="d-flex align-center ga-2 flex-wrap">
                      <input
                        type="radio"
                        name="sandbox-account"
                        checked={selectedAccountId.value === account.id}
                        aria-label={`Select ${account.identifier}`}
                        onChange={() => {
                          selectedAccountId.value = account.id;
                        }}
                      />
                      <MonoRef value={account.identifier} />
                      <StatusBadge status={account.status} />
                      <span class="text-caption">
                        PIN/CVV: <code>{account.secretPin}</code>
                      </span>
                      {account.expiry ? (
                        <span class="text-caption">
                          Exp: <code>{account.expiry}</code>
                        </span>
                      ) : null}
                    </div>
                    <div class="text-caption text-medium-emphasis">{account.holderName}</div>
                    <div class="text-caption">
                      Available: <strong>{account.availableBalanceLyd} LYD</strong> · Held:{" "}
                      <strong>{account.reservedBalanceLyd} LYD</strong> · Daily:{" "}
                      <strong>
                        {account.dailySpentLyd} / {account.dailyLimitLyd} LYD
                      </strong>
                    </div>
                  </div>
                  <div class="d-flex align-center ga-1 flex-wrap">
                    <VBtn
                      size="x-small"
                      color="primary"
                      variant="flat"
                      onClick={() => {
                        selectedAccountId.value = account.id;
                        props.onAutoFillAccount(account);
                      }}
                    >
                      Use account
                    </VBtn>
                    <VBtn
                      size="x-small"
                      variant="text"
                      loading={busyAction.value === `movements:${account.id}`}
                      onClick={() => void loadMovements(account.id)}
                    >
                      Movements
                    </VBtn>
                    <VBtn
                      size="x-small"
                      variant="outlined"
                      loading={busyAction.value === account.id}
                      onClick={() => void patchAccount(account.id, { quickPreset: "SET_ZERO" })}
                    >
                      Set 0 (insufficient)
                    </VBtn>
                    <VBtn
                      size="x-small"
                      variant="outlined"
                      loading={busyAction.value === account.id}
                      onClick={() =>
                        void patchAccount(account.id, {
                          quickPreset: "SET_LINK_AMOUNT",
                          linkAmountLyd: props.linkAmount,
                        })
                      }
                    >
                      Set exact ({props.linkAmount})
                    </VBtn>
                    <VBtn
                      size="x-small"
                      variant="outlined"
                      loading={busyAction.value === account.id}
                      onClick={() => void patchAccount(account.id, { quickPreset: "TOP_UP_5000" })}
                    >
                      +5,000 LYD
                    </VBtn>
                    <VBtn
                      size="x-small"
                      color={account.status === "ACTIVE" ? "error" : "success"}
                      variant="text"
                      loading={busyAction.value === account.id}
                      onClick={() =>
                        void patchAccount(account.id, {
                          status: account.status === "ACTIVE" ? "FROZEN" : "ACTIVE",
                        })
                      }
                    >
                      {account.status === "ACTIVE" ? "Freeze" : "Unfreeze"}
                    </VBtn>
                  </div>
                </div>
              ))}

              {movementsFor.value ? (
                <div class="pa-2 rounded" style={{ border: "1px solid rgba(128,128,128,0.25)" }}>
                  <div class="text-caption font-weight-medium mb-1">Account movements</div>
                  {movements.value.length === 0 ? (
                    <div class="text-caption text-medium-emphasis">No movements yet.</div>
                  ) : (
                    movements.value.slice(0, 20).map((movement, index) => (
                      <div key={index} class="text-caption pg-mono">
                        {String(movement.direction ?? "")} · {String(movement.amount_lyd ?? "")} LYD · {String(movement.reason ?? "")}
                      </div>
                    ))
                  )}
                </div>
              ) : null}
              {selectedAccount.value ? (
                <div class="d-flex align-center ga-2 flex-wrap mt-2">
                  <VTextField
                    density="compact"
                    variant="outlined"
                    hide-details
                    style={{ maxWidth: "180px" }}
                    label="Exact balance (LYD)"
                    modelValue={customBalance.value}
                    onUpdate:modelValue={(value: string) => {
                      customBalance.value = value;
                    }}
                  />
                  <VBtn size="small" variant="tonal" onClick={() => void applyCustomBalance()}>
                    Apply balance
                  </VBtn>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </SurfaceCard>
  );
});
