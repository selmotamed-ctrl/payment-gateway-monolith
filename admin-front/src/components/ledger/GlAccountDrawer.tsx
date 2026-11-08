import Decimal from "decimal.js";
import { computed, defineComponent, ref, watch, type PropType, type VNodeChild } from "vue";
import { VAlert, VBtn, VTextarea, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { StatusBadge, formatHumanStatus } from "@/components/ui/StatusBadge";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { StateView } from "@/components/StateView";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { hasOneOfAuthorities } from "@/state/user";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { AccountLinesTable } from "./AccountLinesTable";
import { ShardRepairModal } from "./ShardRepairModal";
import { JournalEntryDrawer } from "./JournalEntryDrawer";
import { checkpointLag } from "./journalModel";
import { errorCodeOf, errorDetailsOf, formatDateTime } from "./format";
import { isValidReason, normalizeReason } from "./mutationReason";

export interface GlAccountSnapshot {
    account: {
        id: string;
        accountType: string;
        ownerId: string | null;
        currency: string;
        gatewayId: string | null;
        /** Derived: the sum of the shard checkpoints (debit-positive) and the oldest checkpoint time. */
        checkpointBalance: string;
        checkpointAt: string | null;
        /** Routing width: new lines are spread over this many shards. */
        shardCount: number;
        shardScaledAt: string | null;
    };
    checkpoint?: { status: "OK" | "GAP" | "PARITY" | string; pendingLines: string; shardsBehind: number };
    /** Debit-positive (the sign shards and checkpoints are stored in). */
    liveBalance: string;
    /** Natural sign of the account type: liabilities, income and reserves read positive. */
    naturalBalance: string;
    balanceSource: "shards" | "journal" | string;
    shards: GlShardSnapshot[];
}

/** Sequence numbers are 64-bit, so they travel as strings. */
export interface GlShardSnapshot {
    shardId: number;
    currentBalance: string;
    lineSeq: string;
    checkpointBalance: string;
    checkpointSeq: string;
    checkpointAt: string | null;
    pendingLines: string;
    status: "OK" | "GAP" | "PARITY" | string;
    failureKind: string | null;
    consecutiveFailures: number;
    updatedAt: string;
}

/**
 * GL account + shard inspector. Open when `accountId` is set; emits `close`, and `changed` after a
 * checkpoint rollup. The nested journal entry drawer is only mounted while an entry is selected.
 */
export const GlAccountDrawer = defineComponent({
    name: "GlAccountDrawer",
    props: {
        accountId: { type: String as PropType<string | null>, default: null },
    },
    emits: ["close", "changed"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const snapshot = ref<GlAccountSnapshot | null>(null);
        const loading = ref(false);
        const error = ref<string | null>(null);
        const entryId = ref<string | null>(null);
        const linesTable = ref<{ refresh: () => void } | null>(null);
        const repairShard = ref<number | null>(null);
        const scaleOpen = ref(false);
        const scaleWidth = ref(1);
        const scaleReason = ref("");
        const scaleLoading = ref(false);
        const scaleError = ref("");
        const rollupOpen = ref(false);
        const rollupReason = ref("");
        const rollupLoading = ref(false);
        const rollupError = ref("");
        let requestSeq = 0;

        const canRollup = computed(() => hasOneOfAuthorities(["finance:write"]));

        const load = async (id: string, silent = false) => {
            const seq = ++requestSeq;
            if (!silent) {
                loading.value = true;
                snapshot.value = null;
            }
            error.value = null;
            try {
                const response = await api.get(urlsMap.financeGlAccountDetail(id));
                if (seq !== requestSeq) return;
                snapshot.value = (response.data?.data ?? response.data) as GlAccountSnapshot;
            } catch (cause) {
                if (seq !== requestSeq) return;
                error.value = extractApiErrorMessage(cause);
            } finally {
                if (seq === requestSeq) loading.value = false;
            }
        };

        watch(
            () => props.accountId,
            (id) => {
                entryId.value = null;
                rollupOpen.value = false;
                if (id) {
                    void load(id);
                } else {
                    requestSeq += 1;
                    snapshot.value = null;
                    error.value = null;
                    loading.value = false;
                }
            },
            { immediate: true },
        );

        const lag = computed(() => (snapshot.value ? checkpointLag(snapshot.value.liveBalance, snapshot.value.account.checkpointBalance) : null));
        const shardTotal = computed(() => (snapshot.value ? snapshot.value.shards.reduce((sum, shard) => sum.plus(new Decimal(shard.currentBalance || "0")), new Decimal(0)).toFixed(4) : "0.0000"));

        const openScale = () => {
            scaleWidth.value = snapshot.value?.account.shardCount ?? 1;
            scaleReason.value = "";
            scaleError.value = "";
            scaleOpen.value = true;
        };

        const runScale = async () => {
            const id = props.accountId;
            if (!id) return;
            if (!isValidReason(scaleReason.value)) {
                scaleError.value = t("Reason is required (at least 10 characters)");
                return;
            }
            const width = Math.trunc(Number(scaleWidth.value));
            if (!Number.isFinite(width) || width < 1 || width > 256) {
                scaleError.value = t("The shard count must be between 1 and 256");
                return;
            }
            scaleLoading.value = true;
            scaleError.value = "";
            try {
                const response = await api.post(urlsMap.financeGlAccountShardsScale(id), { width, reason: normalizeReason(scaleReason.value) });
                snapshot.value = (response.data?.data ?? response.data) as GlAccountSnapshot;
                scaleOpen.value = false;
                showSnackBar({ type: "success", message: t("Shard count updated") });
                emit("changed");
            } catch (cause) {
                scaleError.value = errorCodeOf(cause) === "SHARD_WIDTH_UNCHANGED" ? t("The account already routes over that many shards") : extractApiErrorMessage(cause);
            } finally {
                scaleLoading.value = false;
            }
        };

        const openRollup = () => {
            rollupReason.value = "";
            rollupError.value = "";
            rollupOpen.value = true;
        };

        const runRollup = async () => {
            const id = props.accountId;
            if (!id) return;
            if (!isValidReason(rollupReason.value)) {
                rollupError.value = t("Reason is required (at least 10 characters)");
                return;
            }
            rollupLoading.value = true;
            rollupError.value = "";
            try {
                const response = await api.post(urlsMap.financeGlAccountCheckpoint(id), { reason: normalizeReason(rollupReason.value) });
                snapshot.value = (response.data?.data ?? response.data) as GlAccountSnapshot;
                rollupOpen.value = false;
                showSnackBar({ type: "success", message: t("Checkpoint rollup completed") });
                emit("changed");
            } catch (cause) {
                if (errorCodeOf(cause) === "LEDGER_SHARD_PARITY_MISMATCH") {
                    const details = errorDetailsOf(cause);
                    const shard = details.shardId === undefined ? "" : ` ${t("Shard")} #${String(details.shardId)}.`;
                    rollupError.value = details.kind === "GAP"
                        ? `${t("A shard's journal lines are not gapless; its checkpoint was refused.")}${shard} ${t("Lines found")}: ${String(details.linesFound ?? "—")} / ${String(details.linesExpected ?? "—")}`
                        : `${t("The shard total differs from the journal total; the checkpoint was refused.")}${shard} ${t("Shard total")}: ${String(details.shardTotal ?? "—")} · ${t("Journal total")}: ${String(details.journalTotal ?? "—")} · ${t("Drift")}: ${String(details.drift ?? "—")}`;
                } else {
                    rollupError.value = extractApiErrorMessage(cause);
                }
            } finally {
                rollupLoading.value = false;
            }
        };

        const th = (label: string, align: "start" | "end" = "start") => <th style={{ textAlign: align }}>{label}</th>;

        const body = (): VNodeChild => {
            if (loading.value) return <StateView loading minHeight="200px" />;
            if (error.value) return <StateView error={error.value} minHeight="200px" onRetry={() => props.accountId && void load(props.accountId)} />;
            const data = snapshot.value;
            if (!data) return null;
            const currency = data.account.currency;
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                        <StatusBadge status={data.account.accountType} label={data.account.accountType} showDot={false} />
                        <StatusBadge status="SHARDS" label={`${t("Balance from shards")} · ${data.account.shardCount ?? 1} ${(data.account.shardCount ?? 1) === 1 ? t("shard wide") : t("shards wide")}`} toneOverride="info" showDot={false} />
                        {data.checkpoint && (
                            <StatusBadge
                                status={data.checkpoint.status === "OK" ? (Number(data.checkpoint.shardsBehind) > 0 ? "PENDING" : "SUCCESS") : "DRIFT"}
                                label={
                                    data.checkpoint.status !== "OK"
                                        ? t("Checkpoint proof failed")
                                        : Number(data.checkpoint.shardsBehind) > 0
                                          ? `${t("Checkpoint behind")} · ${data.checkpoint.pendingLines} ${t("lines")}`
                                          : t("Checkpoints up to date")
                                }
                                toneOverride={data.checkpoint.status !== "OK" ? "danger" : Number(data.checkpoint.shardsBehind) > 0 ? "warning" : "success"}
                                showDot={false}
                            />
                        )}
                    </div>

                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                            gap: "1px",
                            backgroundColor: "var(--pg-border-subtle)",
                            border: "1px solid var(--pg-border-subtle)",
                            borderRadius: "var(--pg-radius-md)",
                            overflow: "hidden",
                        }}
                    >
                        <div style={{ padding: "14px 16px", backgroundColor: "var(--pg-bg-surface)", display: "flex", flexDirection: "column", gap: "4px" }}>
                            <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--pg-ink-muted)" }}>{t("Natural balance")}</span>
                            <MoneyDisplay amount={data.naturalBalance} currency={currency} size="xl" colorSign />
                        </div>
                        <div style={{ padding: "14px 16px", backgroundColor: "var(--pg-bg-surface)", display: "flex", flexDirection: "column", gap: "4px" }}>
                            <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--pg-ink-muted)" }}>{t("Checkpoint balance")}</span>
                            <MoneyDisplay amount={data.account.checkpointBalance} currency={currency} size="lg" />
                            <span style={{ fontSize: "11.5px", color: "var(--pg-ink-muted)" }}>{t("Sum of the shard checkpoints, debit-positive")}</span>
                        </div>
                    </div>

                    <DescriptionList
                        items={[
                            { label: t("Account ID"), value: <MonoRef value={data.account.id} truncate={22} /> },
                            { label: t("Owner ID"), value: data.account.ownerId ? <MonoRef value={data.account.ownerId} truncate={22} /> : "—" },
                            { label: t("Gateway ID"), value: data.account.gatewayId ? <MonoRef value={data.account.gatewayId} truncate={22} /> : "—" },
                            { label: t("Currency"), value: currency },
                            { label: t("Live balance (debit-positive)"), value: data.liveBalance, money: true, currency },
                            { label: t("Posted since last checkpoint"), value: lag.value?.lag ?? "0.0000", money: true, currency },
                            { label: t("Last checkpoint at"), value: formatDateTime(data.account.checkpointAt) },
                        ]}
                    />

                    <SurfaceCard title={t("Shards")} subtitle={t("Each shard keeps its own balance, line sequence and checkpoint (debit-positive)")} noPadding>
                        {data.shards.length === 0 ? (
                            <EmptyState title={t("No shard rows")} description={t("This account has no shard rows yet; they are created with the account.")} />
                        ) : (
                            <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                    <thead>
                                        <tr>
                                            {th(t("Shard"))}
                                            {th(t("Balance"), "end")}
                                            {th(t("Lines"), "end")}
                                            {th(t("Pending"), "end")}
                                            {th(t("Checkpoint"), "end")}
                                            {th(t("Checkpoint age"))}
                                            {th(t("Status"))}
                                            {canRollup.value && th("")}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.shards.map((shard) => (
                                            <tr key={shard.shardId}>
                                                <td class="pg-tabular">#{shard.shardId}{shard.shardId >= (data.account.shardCount ?? 1) ? ` (${t("not routed")})` : ""}</td>
                                                <td style={{ textAlign: "end" }}><MoneyDisplay amount={shard.currentBalance} currency={currency} size="sm" showCurrency={false} /></td>
                                                <td class="pg-tabular" style={{ textAlign: "end" }}>{shard.lineSeq}</td>
                                                <td class="pg-tabular" style={{ textAlign: "end" }}>{shard.pendingLines}</td>
                                                <td style={{ textAlign: "end" }}><MoneyDisplay amount={shard.checkpointBalance} currency={currency} size="sm" showCurrency={false} /></td>
                                                <td>{shard.checkpointAt ? formatDateTime(shard.checkpointAt) : "—"}</td>
                                                <td>
                                                    <StatusBadge
                                                        status={shard.status}
                                                        label={shard.status === "OK" ? t("OK") : `${shard.status} · ${shard.consecutiveFailures}`}
                                                        toneOverride={shard.status === "OK" ? "success" : "danger"}
                                                        showDot={false}
                                                    />
                                                </td>
                                                {canRollup.value && (
                                                    <td style={{ textAlign: "end" }}>
                                                        {shard.status !== "OK" && (
                                                            <VBtn size="x-small" variant="tonal" color="error" prependIcon="mdi-wrench-outline" onClick={() => (repairShard.value = shard.shardId)}>
                                                                {t("Repair")}
                                                            </VBtn>
                                                        )}
                                                    </td>
                                                )}
                                            </tr>
                                        ))}
                                    </tbody>
                                    <tfoot>
                                        <tr>
                                            <td>{t("Total")}</td>
                                            <td style={{ textAlign: "end" }}><MoneyDisplay amount={shardTotal.value} currency={currency} size="sm" showCurrency={false} /></td>
                                            <td class="pg-tabular" style={{ textAlign: "end" }}>{data.shards.reduce((sum, shard) => sum + BigInt(shard.lineSeq || "0"), 0n).toString()}</td>
                                            <td class="pg-tabular" style={{ textAlign: "end" }}>{data.shards.reduce((sum, shard) => sum + BigInt(shard.pendingLines || "0"), 0n).toString()}</td>
                                            <td style={{ textAlign: "end" }}><MoneyDisplay amount={data.account.checkpointBalance} currency={currency} size="sm" showCurrency={false} /></td>
                                            <td colspan={canRollup.value ? 3 : 2} />
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        )}
                    </SurfaceCard>

                    <SurfaceCard title={t("Lines")} subtitle={t("Every posting to this account, newest first")} noPadding>
                        <AccountLinesTable
                            ref={linesTable}
                            key={props.accountId ?? ""}
                            url={urlsMap.financeGlAccountLines(data.account.id)}
                            currency={currency}
                            accountType={data.account.accountType}
                            compact
                            noElevation
                            onOpenEntry={(id: string) => (entryId.value = id)}
                        />
                    </SurfaceCard>
                </div>
            );
        };

        return (): VNodeChild => (
            <>
                <SlideOverDrawer
                    modelValue={!!props.accountId}
                    onUpdate:modelValue={(open: boolean) => {
                        if (!open) emit("close");
                    }}
                    title={t("GL account")}
                    subtitle={snapshot.value ? formatHumanStatus(snapshot.value.account.accountType) : props.accountId ?? ""}
                    width={720}
                    v-slots={{
                        default: body,
                        footer: () => (
                            <>
                                <VBtn variant="text" prependIcon="mdi-refresh" onClick={() => {
                                    if (props.accountId) void load(props.accountId, true);
                                    linesTable.value?.refresh();
                                }}>{t("Refresh")}</VBtn>
                                {canRollup.value && snapshot.value && (
                                    <VBtn variant="text" prependIcon="mdi-table-split-cell" onClick={openScale}>{t("Set shard count")}</VBtn>
                                )}
                                {canRollup.value && snapshot.value && (
                                    <VBtn variant="tonal" color="primary" prependIcon="mdi-database-sync-outline" onClick={openRollup}>{t("Run checkpoint rollup")}</VBtn>
                                )}
                                <VBtn variant="text" onClick={() => emit("close")}>{t("Close")}</VBtn>
                            </>
                        ),
                    }}
                />
                {entryId.value && <JournalEntryDrawer entryId={entryId.value} onClose={() => (entryId.value = null)} />}
                <ShardRepairModal
                    accountId={repairShard.value === null ? null : props.accountId}
                    shardId={repairShard.value}
                    currency={snapshot.value?.account.currency ?? "LYD"}
                    onClose={() => (repairShard.value = null)}
                    onChanged={() => {
                        if (props.accountId) void load(props.accountId, true);
                        linesTable.value?.refresh();
                        emit("changed");
                    }}
                />
                <FormModal
                    modelValue={rollupOpen.value}
                    onUpdate:modelValue={(value: boolean) => (rollupOpen.value = value)}
                    title={t("Run checkpoint rollup")}
                    subtitle={t("Verifies every shard against the journal and moves its checkpoint forward")}
                    submitLabel={t("Run rollup")}
                    loading={rollupLoading.value}
                    errorMessage={rollupError.value}
                    onSubmit={() => void runRollup()}
                >
                    <VAlert type="info" variant="tonal" density="compact">
                        {t("A shard whose lines do not add up to its balance is not advanced and the action names that shard. Payments are not blocked. The action is audited.")}
                    </VAlert>
                    <FormField label={t("Reason")} required hint={t("At least 10 characters; written to the audit log")}>
                        <VTextarea
                            modelValue={rollupReason.value}
                            onUpdate:modelValue={(value: string) => void (rollupReason.value = value)}
                            rows={3}
                            autoGrow
                            {...{ maxlength: 500 }}
                        />
                    </FormField>
                </FormModal>
                <FormModal
                    modelValue={scaleOpen.value}
                    onUpdate:modelValue={(value: boolean) => (scaleOpen.value = value)}
                    title={t("Set shard count")}
                    subtitle={t("How many shards new postings are spread over")}
                    submitLabel={t("Apply")}
                    loading={scaleLoading.value}
                    errorMessage={scaleError.value}
                    onSubmit={() => void runScale()}
                >
                    <VAlert type="info" variant="tonal" density="compact">
                        {t("Widening adds shards for new postings. Narrowing only changes where new postings go; existing shards keep their balances and checkpoints. Nothing is moved. The action is audited.")}
                    </VAlert>
                    <FormField label={t("Shard count")} required hint={t("1 to 256")}>
                        <VTextField
                            modelValue={scaleWidth.value}
                            onUpdate:modelValue={(value: string) => void (scaleWidth.value = Number(value))}
                            type="number"
                            {...{ min: 1, max: 256 }}
                        />
                    </FormField>
                    <FormField label={t("Reason")} required hint={t("At least 10 characters; written to the audit log")}>
                        <VTextarea
                            modelValue={scaleReason.value}
                            onUpdate:modelValue={(value: string) => void (scaleReason.value = value)}
                            rows={3}
                            autoGrow
                            {...{ maxlength: 500 }}
                        />
                    </FormField>
                </FormModal>
            </>
        );
    },
});

export default GlAccountDrawer;
