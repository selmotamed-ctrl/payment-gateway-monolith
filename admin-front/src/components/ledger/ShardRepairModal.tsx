import { computed, defineComponent, ref, watch, type PropType, type VNodeChild } from "vue";
import { useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VTextarea } from "vuetify/components";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { StateView } from "@/components/StateView";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { errorCodeOf, unwrap } from "./format";
import { isValidReason, normalizeReason } from "./mutationReason";

export interface ShardRepairPlan {
    needsRepair: boolean;
    kind: "RECOMPUTE" | "REBASELINE" | null;
    sequenceIntact: boolean;
    status: string;
    before: { balance: string; lineSeq: string; checkpointBalance: string; checkpointSeq: string; baselineSeq: string };
    journal: { total: string; highestSequence: string; linesAfterBaseline: string };
    after: { balance: string; lineSeq: string; baselineSeq: string };
    delta: string;
    planHash: string;
}

/**
 * Repair of one ledger shard that failed its checkpoint proof. It always starts with a PREVIEW computed from the whole
 * journal of the shard. A shard whose sequence is intact is recomputed from the journal right away (the same operation the
 * system does automatically after repeated failures). A shard whose sequence is damaged is re-baselined only after a second
 * person approves it; this dialog then submits the request to Approvals.
 */
export const ShardRepairModal = defineComponent({
    name: "ShardRepairModal",
    props: {
        accountId: { type: String as PropType<string | null>, default: null },
        shardId: { type: Number as PropType<number | null>, default: null },
        currency: { type: String, default: "LYD" },
    },
    emits: ["close", "changed"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const router = useRouter();
        const plan = ref<ShardRepairPlan | null>(null);
        const loading = ref(false);
        const loadError = ref("");
        const reason = ref("");
        const submitting = ref(false);
        const submitError = ref("");
        const submitted = ref<string | null>(null);

        const open = computed(() => props.accountId !== null && props.shardId !== null);

        const load = async () => {
            if (props.accountId === null || props.shardId === null) return;
            loading.value = true;
            loadError.value = "";
            plan.value = null;
            try {
                const response = await api.get(urlsMap.financeGlShardRepairPlan(props.accountId, props.shardId));
                plan.value = unwrap<ShardRepairPlan>(response.data);
            } catch (cause) {
                loadError.value = extractApiErrorMessage(cause);
            } finally {
                loading.value = false;
            }
        };

        watch(
            () => [props.accountId, props.shardId] as const,
            () => {
                reason.value = "";
                submitError.value = "";
                submitted.value = null;
                if (open.value) void load();
                else plan.value = null;
            },
            { immediate: true },
        );

        const submit = async () => {
            const current = plan.value;
            if (!current || props.accountId === null || props.shardId === null || !current.kind) return;
            if (!isValidReason(reason.value)) {
                submitError.value = t("Reason is required (at least 10 characters)");
                return;
            }
            submitting.value = true;
            submitError.value = "";
            const body = { reason: normalizeReason(reason.value), planHash: current.planHash };
            try {
                if (current.kind === "RECOMPUTE") {
                    await api.post(urlsMap.financeGlShardRepair(props.accountId, props.shardId), body);
                    showSnackBar({ type: "success", message: t("Shard recomputed from the journal") });
                    emit("changed");
                    emit("close");
                } else {
                    const response = await api.post(urlsMap.financeGlShardRepairRequest(props.accountId, props.shardId), body);
                    submitted.value = String(unwrap<{ approvalRequestId?: string }>(response.data).approvalRequestId ?? "");
                    showSnackBar({ type: "success", message: t("Submitted for approval. The repair is applied only after an independent checker approves it.") });
                    emit("changed");
                }
            } catch (cause) {
                const code = errorCodeOf(cause);
                submitError.value =
                    code === "SHARD_REPAIR_PLAN_CHANGED"
                        ? t("The shard changed since this preview. Close the dialog and preview it again.")
                        : code === "SHARD_REPAIR_NEEDS_APPROVAL"
                          ? t("This shard's sequence is damaged: it needs a second person's approval.")
                          : code === "SHARD_REPAIR_APPROVAL_PENDING"
                            ? t("A repair of this shard is already awaiting a checker.")
                            : extractApiErrorMessage(cause);
            } finally {
                submitting.value = false;
            }
        };

        const body = (): VNodeChild => {
            if (loading.value) return <StateView loading minHeight="160px" />;
            if (loadError.value) return <StateView error={loadError.value} minHeight="160px" onRetry={() => void load()} />;
            const current = plan.value;
            if (!current) return null;
            if (!current.needsRepair) {
                return <VAlert type="success" variant="tonal" density="compact">{t("This shard already matches its journal. Nothing to repair.")}</VAlert>;
            }
            const recompute = current.kind === "RECOMPUTE";
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    <VAlert type={recompute ? "info" : "warning"} variant="tonal" density="compact">
                        {recompute
                            ? t("The shard's postings are complete and in order. Only its stored balance or checkpoint disagrees with the journal, so they will be recomputed from the journal. No ledger entry is created.")
                            : t("The shard's postings are NOT complete or in order (a line is missing or a number is used twice). Recomputing from the journal could remove money the shard holds, so a second person must approve it. The damaged history is then exempted from the proof and the shard continues from its highest number.")}
                    </VAlert>
                    <DescriptionList
                        items={[
                            { label: t("Status"), value: <StatusBadge status={current.status} label={current.status} toneOverride={current.status === "OK" ? "success" : "danger"} showDot={false} /> },
                            { label: t("Stored shard balance"), value: current.before.balance, money: true, currency: props.currency },
                            { label: t("Balance according to the journal"), value: current.journal.total, money: true, currency: props.currency },
                            { label: t("Correction"), value: <MoneyDisplay amount={current.delta} currency={props.currency} size="md" colorSign /> },
                            { label: t("Postings counted by the shard"), value: current.before.lineSeq },
                            { label: t("Highest posting number in the journal"), value: current.journal.highestSequence },
                        ]}
                    />
                    {submitted.value !== null ? (
                        <VAlert type="success" variant="tonal" density="compact">
                            {t("Submitted for approval. The repair is applied only after an independent checker approves it.")}{" "}
                            <VBtn size="small" variant="text" onClick={() => void router.push({ name: "Approvals", query: submitted.value ? { open: submitted.value } : {} })}>{t("Open Approvals")}</VBtn>
                        </VAlert>
                    ) : (
                        <FormField label={t("Reason")} required hint={t("At least 10 characters; written to the audit log")}>
                            <VTextarea modelValue={reason.value} onUpdate:modelValue={(value: string) => void (reason.value = value)} rows={3} autoGrow {...{ maxlength: 500 }} />
                        </FormField>
                    )}
                </div>
            );
        };

        return (): VNodeChild => (
            <FormModal
                modelValue={open.value}
                onUpdate:modelValue={(value: boolean) => {
                    if (!value) emit("close");
                }}
                title={t("Repair shard")}
                subtitle={props.shardId === null ? "" : `${t("Shard")} #${props.shardId}`}
                submitLabel={plan.value?.kind === "REBASELINE" ? t("Request approval") : t("Recompute from journal")}
                loading={submitting.value}
                errorMessage={submitError.value}
                onSubmit={() => {
                    if (plan.value?.needsRepair && submitted.value === null) void submit();
                    else emit("close");
                }}
            >
                {body()}
            </FormModal>
        );
    },
});

export default ShardRepairModal;
