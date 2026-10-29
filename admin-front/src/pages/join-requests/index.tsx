import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VCheckbox, VDialog, VSelect, VTextField, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { statusTone } from "@/components/Table/statusTone";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { user } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type JoinRequest = {
    id: string;
    merchantId: string;
    merchantName: string;
    status: string;
    riskTier: string;
    businessCategory: string;
    expectedMonthlyVolume: string;
    currency: string;
    submittedAt: string;
    slaDueAt: string;
    reviewerName: string | null;
    fourEyesReasons: string[];
    screeningResult: string;
    beneficialOwners: { fullName: string; ownershipPercent: string; isPep: boolean }[];
    documents: { id: string; docType: string; status: string; expiresOn: string | null }[];
    requestedInfo: string | null;
};

const CHECKLIST_KEYS = [
    "Identity Verified",
    "Business Existence Verified",
    "Beneficial Owners Identified",
    "Screening Result Reviewed",
    "Category And Volume Consistent",
    "Payout Account Ownership Verified",
    "Risk Tier Assigned",
];

const REASON_CODES = [
    { title: "Incomplete Documents", value: "INCOMPLETE_DOCUMENTS" },
    { title: "Unverifiable Business", value: "UNVERIFIABLE_BUSINESS" },
    { title: "Prohibited Activity", value: "PROHIBITED_ACTIVITY" },
    { title: "Policy", value: "POLICY" },
];

const JoinRequestsPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<JoinRequest[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const detailsOpen = ref(false);
    const selected = ref<JoinRequest | null>(null);
    const checklist = ref<Record<string, boolean>>({});
    const decision = ref<"APPROVE" | "REJECT">("APPROVE");
    const reasonCode = ref<string>("POLICY");
    const notes = ref<string>("");
    const infoRequest = ref<string>("");
    const requestedItems = ref<string>("");
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.joinRequestsList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.joinRequests ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const openDetails = async (row: JoinRequest) => {
        selected.value = row;
        checklist.value = {};
        decision.value = "APPROVE";
        reasonCode.value = "POLICY";
        notes.value = "";
        infoRequest.value = "";
        requestedItems.value = "";
        detailsOpen.value = true;
        try {
            const response = await api.get(urlsMap.joinRequestDetail(row.id));
            const payload = response.data?.data ?? response.data ?? {};
            selected.value = { ...row, ...payload } as JoinRequest;
            const stored = (payload.checklist ?? {}) as Record<string, boolean>;
            checklist.value = Object.fromEntries(CHECKLIST_KEYS.map((key) => [key, !!stored[key]]));
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const runAction = async (fn: () => Promise<void>) => {
        actionLoading.value = true;
        try {
            await fn();
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const assignToMe = () =>
        runAction(async () => {
            const assigneeUserId = user.value?.userInfo?.id;
            if (!assigneeUserId) {
                throw new Error(t("Your session does not carry a user id"));
            }
            await api.post(urlsMap.joinRequestAssign(selected.value!.id), { assigneeUserId });
            showSnackBar({ type: "success", message: t("Assigned") });
        });

    const requestInfo = () =>
        runAction(async () => {
            const items = requestedItems.value
                .split(/[,\n]/)
                .map((item) => item.trim())
                .filter(Boolean);
            if (items.length === 0 || infoRequest.value.trim().length < 3) {
                throw new Error(t("Add at least one requested item and a message"));
            }
            await api.post(urlsMap.joinRequestRequestInfo(selected.value!.id), {
                requestedItems: items,
                message: infoRequest.value.trim(),
            });
            detailsOpen.value = false;
            showSnackBar({ type: "success", message: t("Request Info") });
        });

    const decide = () =>
        runAction(async () => {
            await api.post(urlsMap.joinRequestDecide(selected.value!.id), {
                decision: decision.value,
                reasonCode: reasonCode.value,
                notes: notes.value,
                checklist: checklist.value,
            });
            detailsOpen.value = false;
            showSnackBar({ type: "success", message: t("Decision") });
        });

    const checklistComplete = computed(() => CHECKLIST_KEYS.every((key) => !!checklist.value[key]));

    const slaState = (row: JoinRequest) => {
        if (!row.slaDueAt) {
            return { tone: "neutral" as const, label: "-" };
        }
        const due = new Date(row.slaDueAt).getTime();
        const diff = due - Date.now();
        if (diff < 0) {
            return { tone: "error" as const, label: t("Overdue") };
        }
        if (diff < 24 * 3600 * 1000) {
            return { tone: "warning" as const, label: `${Math.round(diff / 3600000)}h` };
        }
        return { tone: "success" as const, label: `${Math.round(diff / 86400000)}d` };
    };

    const headers: TableHeader<JoinRequest>[] = [
        { key: "merchantName", label: "Merchant Name", value: (row) => row.merchantName },
        { key: "status", label: "Status", Value: ({ row }: { row: any }) => <StatusChip label={row.status} tone={statusTone(row.status)} /> },
        { key: "riskTier", label: "Risk Class", Value: ({ row }: { row: any }) => <StatusChip label={row.riskTier} tone={statusTone(row.riskTier)} /> },
        { key: "category", label: "Business Category", value: (row) => row.businessCategory },
        { key: "volume", label: "Expected Volume", value: (row) => `${row.expectedMonthlyVolume ?? ""} ${row.currency ?? ""}` },
        { key: "submittedAt", label: "Submitted At", value: (row) => row.submittedAt },
        {
            key: "sla",
            label: "SLA",
            Value: ({ row }: { row: JoinRequest }) => {
                const sla = slaState(row);
                return <StatusChip label={sla.label} tone={sla.tone} />;
            },
        },
        { key: "reviewer", label: "Assignee", value: (row) => row.reviewerName ?? "-" },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("Join Requests")} />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <DataTable
                        title={t("Join Requests")}
                        data={rows.value}
                        headers={headers}
                        loading={loading.value}
                        showNumber={true}
                        xlsx={false}
                        searchValue={search.value}
                        setSearchValue={(value) => (search.value = value)}
                    />
                )}
            </ThemedView>

            <VDialog modelValue={detailsOpen.value} onUpdate:modelValue={(v: any) => (detailsOpen.value = v)} maxWidth="820px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                            {selected.value?.merchantName}
                        </ThemedText>

                        <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                            <StatusChip label={selected.value?.status ?? "-"} tone="info" />
                            <StatusChip label={selected.value?.riskTier ?? "-"} tone="warning" />
                            <StatusChip label={selected.value?.screeningResult ?? "-"} tone="neutral" />
                        </ThemedView>

                        {!!selected.value?.fourEyesReasons?.length && (
                            <VCard variant="tonal" color="warning">
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                    <ThemedText type="defaultSemiBold">{t("Four Eyes Required")}</ThemedText>
                                    {selected.value.fourEyesReasons.map((reason) => (
                                        <ThemedText key={reason} style={{ fontSize: "13px" }}>
                                            • {reason}
                                        </ThemedText>
                                    ))}
                                </VCardText>
                            </VCard>
                        )}

                        <ThemedView style={{ flexDirection: "column", gap: "8px" }}>
                            <ThemedText type="defaultSemiBold">{t("Checklist")}</ThemedText>
                            {CHECKLIST_KEYS.map((key) => (
                                <VCheckbox
                                    key={key}
                                    label={t(key)}
                                    modelValue={!!checklist.value[key]}
                                    onUpdate:modelValue={(value: boolean | null) => (checklist.value[key] = !!value)}
                                    density="compact"
                                    hideDetails
                                />
                            ))}
                        </ThemedView>

                        <ThemedView style={{ flexDirection: "column", gap: "8px" }}>
                            <ThemedText type="defaultSemiBold">{t("Beneficial Owners")}</ThemedText>
                            {selected.value?.beneficialOwners?.length ? (
                                selected.value.beneficialOwners.map((owner, index) => (
                                    <ThemedView key={index} style={{ flexDirection: "row", gap: "12px", fontSize: "13px" }}>
                                        <span style={{ flex: 1 }}>{owner.fullName}</span>
                                        <span>{owner.ownershipPercent}%</span>
                                        <span>{owner.isPep ? "PEP" : "-"}</span>
                                    </ThemedView>
                                ))
                            ) : (
                                <ThemedText style={{ fontSize: "13px", opacity: 0.6 }}>{t("No Data Found")}</ThemedText>
                            )}
                        </ThemedView>

                        <ThemedView style={{ flexDirection: "column", gap: "8px" }}>
                            <ThemedText type="defaultSemiBold">{t("Documents")}</ThemedText>
                            {selected.value?.documents?.length ? (
                                selected.value.documents.map((doc) => (
                                    <ThemedView key={doc.id} style={{ flexDirection: "row", gap: "12px", fontSize: "13px" }}>
                                        <span style={{ flex: 1 }}>{doc.docType}</span>
                                        <span>{doc.status}</span>
                                        <span>{doc.expiresOn ?? "-"}</span>
                                    </ThemedView>
                                ))
                            ) : (
                                <ThemedText style={{ fontSize: "13px", opacity: 0.6 }}>{t("No Data Found")}</ThemedText>
                            )}
                        </ThemedView>

                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" onClick={assignToMe} loading={actionLoading.value}>
                                {t("Assign To Me")}
                            </VBtn>
                        </ThemedView>

                        <ThemedView style={{ flexDirection: "column", gap: "10px" }}>
                            <ThemedText type="defaultSemiBold">{t("Request Info")}</ThemedText>
                            <VTextField
                                modelValue={requestedItems.value}
                                onUpdate:modelValue={(v: string) => (requestedItems.value = v)}
                                label={t("Requested items (comma separated)")}
                            />
                            <VTextarea
                                modelValue={infoRequest.value}
                                onUpdate:modelValue={(v: string) => (infoRequest.value = v)}
                                rows={2}
                                label={t("Message")}
                            />
                            <VBtn
                                variant="tonal"
                                color="warning"
                                disabled={!infoRequest.value}
                                loading={actionLoading.value}
                                onClick={requestInfo}
                            >
                                {t("Request Info")}
                            </VBtn>
                        </ThemedView>

                        <ThemedView style={{ flexDirection: "column", gap: "10px" }}>
                            <ThemedText type="defaultSemiBold">{t("Decision")}</ThemedText>
                            <VSelect
                                items={[
                                    { title: t("Approve"), value: "APPROVE" },
                                    { title: t("Reject"), value: "REJECT" },
                                ]}
                                modelValue={decision.value}
                                onUpdate:modelValue={(v: "APPROVE" | "REJECT") => (decision.value = v)}
                                label={t("Decision")}
                            />
                            <VSelect
                                items={REASON_CODES}
                                modelValue={reasonCode.value}
                                onUpdate:modelValue={(v: string) => (reasonCode.value = v)}
                                label={t("Reason Code")}
                            />
                            <VTextField
                                modelValue={notes.value}
                                onUpdate:modelValue={(v: string) => (notes.value = v)}
                                label={t("Notes")}
                            />
                            <VBtn
                                color={decision.value === "APPROVE" ? "success" : "error"}
                                disabled={!checklistComplete.value}
                                loading={actionLoading.value}
                                onClick={decide}
                            >
                                {t("Decision")}
                            </VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default JoinRequestsPage;
