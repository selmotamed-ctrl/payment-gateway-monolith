import { computed, defineComponent, ref, watch, type PropType, type VNodeChild } from "vue";
import { useRouter } from "vue-router";
import { VBtn } from "vuetify/components";
import { useLocale } from "vuetify";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { StatusBadge, formatHumanStatus } from "@/components/ui/StatusBadge";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { StateView } from "@/components/StateView";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { LedgerRefLink } from "./LedgerRefLink";
import { GlAccountDrawer } from "./GlAccountDrawer";
import { entryTotalsOf, journalReferenceTarget, tAccountSides } from "./journalModel";
import { formatDateTime } from "./format";

export interface JournalEntryLine {
    lineId: string;
    direction: "DEBIT" | "CREDIT";
    amount: string;
    createdAt: string;
    glAccount: { id: string; accountType: string; currency: string; ownerId: string | null };
}

export interface JournalEntryDetail {
    id: string;
    refType: string;
    refId: string;
    description: string;
    createdAt: string;
    balanced: boolean;
    totalDebit: string;
    totalCredit: string;
    currency: string | null;
    lines: JournalEntryLine[];
    reference: { type: string; id: string; route: string };
}

/**
 * Double-entry inspector. Open when `entryId` is set; emits `close`. The nested GL account
 * drawer opens from any account reference and is only mounted while an account is selected.
 */
export const JournalEntryDrawer = defineComponent({
    name: "JournalEntryDrawer",
    props: {
        entryId: { type: String as PropType<string | null>, default: null },
    },
    emits: ["close"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const router = useRouter();
        const entry = ref<JournalEntryDetail | null>(null);
        const loading = ref(false);
        const error = ref<string | null>(null);
        const accountId = ref<string | null>(null);
        let requestSeq = 0;

        const load = async (id: string) => {
            const seq = ++requestSeq;
            loading.value = true;
            error.value = null;
            entry.value = null;
            try {
                const response = await api.get(urlsMap.financeJournalEntryDetail(id));
                if (seq !== requestSeq) return;
                entry.value = (response.data?.data ?? response.data) as JournalEntryDetail;
            } catch (cause) {
                if (seq !== requestSeq) return;
                error.value = extractApiErrorMessage(cause);
            } finally {
                if (seq === requestSeq) loading.value = false;
            }
        };

        watch(
            () => props.entryId,
            (id) => {
                accountId.value = null;
                if (id) {
                    void load(id);
                } else {
                    requestSeq += 1;
                    entry.value = null;
                    error.value = null;
                    loading.value = false;
                }
            },
            { immediate: true },
        );

        const totals = computed(() => (entry.value ? entryTotalsOf(entry.value) : null));
        const reference = computed(() => journalReferenceTarget(entry.value?.reference));

        const openReference = () => {
            const target = reference.value;
            if (target.kind !== "link") return;
            emit("close");
            void router.push(target.location);
        };

        const closeDrawer = (open: boolean) => {
            if (!open) emit("close");
        };

        const th = (label: string, align: "start" | "end" = "start") => <th style={{ textAlign: align }}>{label}</th>;

        const linesTable = (detail: JournalEntryDetail): VNodeChild => (
            <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                        <tr>
                            {th("#")}
                            {th(t("GL account"))}
                            {th(t("Currency"))}
                            {th(t("Debit"), "end")}
                            {th(t("Credit"), "end")}
                        </tr>
                    </thead>
                    <tbody>
                        {detail.lines.map((line, index) => {
                            const sides = tAccountSides(line);
                            return (
                                <tr key={line.lineId}>
                                    <td class="pg-tabular" style={{ color: "var(--pg-ink-muted)" }}>{index + 1}</td>
                                    <td>
                                        <div
                                            style={{
                                                display: "flex",
                                                flexDirection: "column",
                                                gap: "3px",
                                                // Credit lines are indented, the way a journal is written.
                                                paddingInlineStart: line.direction === "CREDIT" ? "18px" : 0,
                                            }}
                                        >
                                            <LedgerRefLink value={line.glAccount.id} label={t("Open GL account")} onOpen={(id: string) => (accountId.value = id)} />
                                            <StatusBadge status={line.glAccount.accountType} label={line.glAccount.accountType} showDot={false} />
                                        </div>
                                    </td>
                                    <td>{line.glAccount.currency}</td>
                                    <td style={{ textAlign: "end" }}>
                                        {sides.debit ? <MoneyDisplay amount={sides.debit} currency={line.glAccount.currency} size="sm" showCurrency={false} /> : <span style={{ color: "var(--pg-ink-faint)" }}>—</span>}
                                    </td>
                                    <td style={{ textAlign: "end" }}>
                                        {sides.credit ? <MoneyDisplay amount={sides.credit} currency={line.glAccount.currency} size="sm" showCurrency={false} /> : <span style={{ color: "var(--pg-ink-faint)" }}>—</span>}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                    {totals.value && (
                        <tfoot>
                            <tr style={{ fontWeight: 600 }}>
                                <td colspan={3}>{t("Totals")}</td>
                                <td style={{ textAlign: "end" }}><MoneyDisplay amount={totals.value.totalDebit} currency={detail.currency && detail.currency !== "MIXED" ? detail.currency : "LYD"} size="sm" showCurrency={false} /></td>
                                <td style={{ textAlign: "end" }}><MoneyDisplay amount={totals.value.totalCredit} currency={detail.currency && detail.currency !== "MIXED" ? detail.currency : "LYD"} size="sm" showCurrency={false} /></td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>
        );

        const body = (): VNodeChild => {
            if (loading.value) return <StateView loading minHeight="200px" />;
            if (error.value) return <StateView error={error.value} minHeight="200px" onRetry={() => props.entryId && void load(props.entryId)} />;
            const detail = entry.value;
            if (!detail) return null;
            const sums = totals.value!;
            const target = reference.value;
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <StatusBadge
                            status={sums.balanced ? "BALANCED" : "UNBALANCED"}
                            label={sums.balanced ? t("Balanced") : t("Unbalanced")}
                            toneOverride={sums.balanced ? "success" : "danger"}
                        />
                        <span class="pg-tabular" dir="ltr" style={{ fontSize: "12.5px", color: "var(--pg-ink-secondary)" }}>
                            {t("Σ Debits")} {sums.balanced ? "=" : "≠"} {t("Σ Credits")}
                        </span>
                        {!sums.balanced && (
                            <span class="pg-tabular" dir="ltr" style={{ fontSize: "12.5px", color: "var(--pg-status-danger-text)" }}>
                                {t("Difference")}: {sums.difference}
                            </span>
                        )}
                    </div>

                    <DescriptionList
                        items={[
                            { label: t("Entry ID"), value: <MonoRef value={detail.id} truncate={22} /> },
                            { label: t("Reference type"), value: <StatusBadge status={detail.refType} label={formatHumanStatus(detail.refType)} showDot={false} /> },
                            {
                                label: t("Reference"),
                                value:
                                    target.kind === "link" ? (
                                        <LedgerRefLink value={detail.refId} truncate={22} label={t("Open record")} onOpen={openReference} />
                                    ) : (
                                        <MonoRef value={detail.refId} truncate={22} />
                                    ),
                            },
                            { label: t("Posted at"), value: formatDateTime(detail.createdAt) },
                            { label: t("Memo"), value: detail.description || "—" },
                            { label: t("Currency"), value: detail.currency === "MIXED" ? t("Mixed currencies") : detail.currency ?? "—" },
                        ]}
                    />

                    <SurfaceCard title={t("Double-entry lines")} subtitle={`${sums.lineCount} ${t("lines")}`} noPadding>
                        {detail.lines.length === 0 ? <EmptyState title={t("No journal lines")} description={t("This entry has no lines; it cannot be balanced.")} /> : linesTable(detail)}
                    </SurfaceCard>
                </div>
            );
        };

        return (): VNodeChild => (
            <>
                <SlideOverDrawer
                    modelValue={!!props.entryId}
                    onUpdate:modelValue={closeDrawer}
                    title={t("Journal entry")}
                    subtitle={entry.value ? formatHumanStatus(entry.value.refType) : props.entryId ?? ""}
                    width={720}
                    v-slots={{
                        default: body,
                        footer: () => (
                            <>
                                {reference.value.kind === "link" && (
                                    <VBtn variant="tonal" prependIcon="mdi-open-in-new" onClick={openReference}>{t("Open record")}</VBtn>
                                )}
                                <VBtn variant="text" onClick={() => emit("close")}>{t("Close")}</VBtn>
                            </>
                        ),
                    }}
                />
                {accountId.value && (
                    <GlAccountDrawer accountId={accountId.value} onClose={() => (accountId.value = null)} onChanged={() => props.entryId && void load(props.entryId)} />
                )}
            </>
        );
    },
});

export default JournalEntryDrawer;
