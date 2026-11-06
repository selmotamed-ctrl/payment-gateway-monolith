import Decimal from "decimal.js";
import { computed, defineComponent, ref, watch, type PropType, type VNodeChild } from "vue";
import { VAlert, VBtn, VTextarea } from "vuetify/components";
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
import { LedgerRefLink } from "./LedgerRefLink";
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
        checkpointBalance: string;
        checkpointAt: string | null;
    };
    /** Debit-positive (the sign shards and checkpoints are stored in). */
    liveBalance: string;
    /** Natural sign of the account type: liabilities, income and reserves read positive. */
    naturalBalance: string;
    balanceSource: "shards" | "journal" | string;
    shards: { shardId: number; currentBalance: string; updatedAt: string }[];
    recentLines: {
        lineId: string;
        entryId: string;
        direction: "DEBIT" | "CREDIT";
        amount: string;
        createdAt: string;
        refType: string;
        refId: string;
        description: string;
    }[];
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
                    rollupError.value = `${t("The shard total differs from the journal total; the checkpoint was refused.")} ${t("Shard total")}: ${String(details.shardTotal ?? "—")} · ${t("Journal total")}: ${String(details.journalTotal ?? "—")} · ${t("Drift")}: ${String(details.drift ?? "—")}`;
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
                        <StatusBadge status={data.balanceSource === "shards" ? "SHARDS" : "JOURNAL"} label={data.balanceSource === "shards" ? t("Balance from shards") : t("Balance from journal")} toneOverride="info" showDot={false} />
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
                            <span style={{ fontSize: "11.5px", color: "var(--pg-ink-muted)" }}>{t("Debit-positive, as stored")}</span>
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

                    <SurfaceCard title={t("Shards")} subtitle={t("Balance of each hot-account shard (debit-positive)")} noPadding>
                        {data.shards.length === 0 ? (
                            <EmptyState title={t("No shard rows")} description={t("This account has no shards; its balance derives from the journal since the last checkpoint.")} />
                        ) : (
                            <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                    <thead>
                                        <tr>
                                            {th(t("Shard"))}
                                            {th(t("Balance"), "end")}
                                            {th(t("Updated"))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.shards.map((shard) => (
                                            <tr key={shard.shardId}>
                                                <td class="pg-tabular">#{shard.shardId}</td>
                                                <td style={{ textAlign: "end" }}><MoneyDisplay amount={shard.currentBalance} currency={currency} size="sm" showCurrency={false} /></td>
                                                <td>{formatDateTime(shard.updatedAt)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                    <tfoot>
                                        <tr style={{ fontWeight: 600 }}>
                                            <td>{t("Total")}</td>
                                            <td style={{ textAlign: "end" }}><MoneyDisplay amount={shardTotal.value} currency={currency} size="sm" showCurrency={false} /></td>
                                            <td />
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        )}
                    </SurfaceCard>

                    <SurfaceCard title={t("Recent lines")} subtitle={t("Latest postings to this account")} noPadding>
                        {data.recentLines.length === 0 ? (
                            <EmptyState title={t("No journal lines")} description={t("Nothing has been posted to this account yet.")} />
                        ) : (
                            <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                    <thead>
                                        <tr>
                                            {th(t("Entry"))}
                                            {th(t("Reference type"))}
                                            {th(t("Side"))}
                                            {th(t("Amount"), "end")}
                                            {th(t("Posted at"))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.recentLines.map((line) => (
                                            <tr key={line.lineId}>
                                                <td><LedgerRefLink value={line.entryId} label={t("Open journal entry")} onOpen={(id: string) => (entryId.value = id)} /></td>
                                                <td title={line.description}>{formatHumanStatus(line.refType)}</td>
                                                <td><StatusBadge status={line.direction} label={line.direction === "DEBIT" ? t("Debit") : t("Credit")} toneOverride={line.direction === "DEBIT" ? "info" : "neutral"} showDot={false} /></td>
                                                <td style={{ textAlign: "end" }}><MoneyDisplay amount={line.amount} currency={currency} size="sm" showCurrency={false} /></td>
                                                <td>{formatDateTime(line.createdAt)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
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
                                <VBtn variant="text" prependIcon="mdi-refresh" onClick={() => props.accountId && void load(props.accountId, true)}>{t("Refresh")}</VBtn>
                                {canRollup.value && snapshot.value && (
                                    <VBtn variant="tonal" color="primary" prependIcon="mdi-database-sync-outline" onClick={openRollup}>{t("Run checkpoint rollup")}</VBtn>
                                )}
                                <VBtn variant="text" onClick={() => emit("close")}>{t("Close")}</VBtn>
                            </>
                        ),
                    }}
                />
                {entryId.value && <JournalEntryDrawer entryId={entryId.value} onClose={() => (entryId.value = null)} />}
                <FormModal
                    modelValue={rollupOpen.value}
                    onUpdate:modelValue={(value: boolean) => (rollupOpen.value = value)}
                    title={t("Run checkpoint rollup")}
                    subtitle={t("Folds the shard deltas into the stored checkpoint balance")}
                    submitLabel={t("Run rollup")}
                    loading={rollupLoading.value}
                    errorMessage={rollupError.value}
                    onSubmit={() => void runRollup()}
                >
                    <VAlert type="info" variant="tonal" density="compact">
                        {t("The rollup is refused if the shard total differs from the journal total. The action is audited.")}
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
            </>
        );
    },
});

export default GlAccountDrawer;
