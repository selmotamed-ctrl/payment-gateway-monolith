import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VFileInput, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { DataTable } from "@/components/Table/DataTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { SectionFields } from "@/components/SectionFields";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
type Attachment = {
    id: string;
    label: string;
    fileName: string | null;
    mimeType: string | null;
    byteSize: string | null;
    sha256: string | null;
    status: string | null;
    avScanStatus: string | null;
    createdAt: string;
};

type Dispute = {
    id: string;
    disputeRef: string;
    source: string;
    state: string;
    amount: string;
    currency: string;
    reasonCode: string;
    evidenceDueAt: string;
    evidenceSubmitted: boolean;
    openedAt: string;
};

const DisputesPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<Dispute[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const selected = ref<Dispute | null>(null);
    const note = ref<string>("");
    const file = ref<File | null>(null);
    const actionLoading = ref(false);
    const formError = ref("");
    const attachments = ref<Attachment[]>([]);
    const attachmentsLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.disputesList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.disputes ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const loadAttachments = async (disputeId: string) => {
        attachmentsLoading.value = true;
        try {
            const response = await api.get(urlsMap.disputeAttachments(disputeId));
            const payload = response.data?.data ?? response.data ?? {};
            attachments.value = (payload.attachments ?? []) as Attachment[];
        } catch (e) {
            attachments.value = [];
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            attachmentsLoading.value = false;
        }
    };

    const submitEvidence = async () => {
        if (!selected.value) {
            return;
        }
        if (!file.value) {
            formError.value = t("Choose an evidence file");
            return;
        }
        actionLoading.value = true;
        formError.value = "";
        try {
            const body = new FormData();
            body.append("file", file.value);
            body.append("label", note.value.trim() || file.value.name);
            await api.post(urlsMap.disputeAttachments(selected.value.id), body, {
                headers: { "Content-Type": "multipart/form-data" },
            });
            showSnackBar({ type: "success", message: t("Evidence uploaded") });
            file.value = null;
            note.value = "";
            await loadAttachments(selected.value.id);
            await load();
        } catch (e) {
            const message = extractApiErrorMessage(e);
            formError.value = message;
            showSnackBar({ type: "error", message });
        } finally {
            actionLoading.value = false;
        }
    };

    const downloadAttachment = async (attachment: Attachment) => {
        if (!selected.value) return;
        try {
            const response = await api.get(urlsMap.disputeAttachmentContent(selected.value.id, attachment.id), { responseType: "blob" });
            const blob = new Blob([response.data], { type: attachment.mimeType ?? "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = attachment.fileName ?? attachment.label;
            anchor.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const deleteAttachment = async (attachment: Attachment) => {
        if (!selected.value || !window.confirm(t("Delete this evidence file?"))) return;
        try {
            await api.delete(urlsMap.disputeAttachmentDelete(selected.value.id, attachment.id));
            await loadAttachments(selected.value.id);
            showSnackBar({ type: "success", message: t("Evidence deleted") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const stateTone = (state: string) => {
        switch (state) {
            case "WON":
                return "success" as const;
            case "LOST":
            case "EXPIRED":
                return "danger" as const;
            default:
                return "warning" as const;
        }
    };

    const headers: TableHeader<Dispute>[] = [
        {
            key: "disputeRef",
            label: "Reference",
            Value: ({ row }: { row: Dispute }) => <MonoRef value={row.disputeRef} truncate={18} />,
        },
        { key: "source", label: "Dispute Source", value: (row) => row.source },
        {
            key: "state",
            label: "Status",
            Value: ({ row }: { row: Dispute }) => (
                <StatusBadge status={row.state} toneOverride={stateTone(row.state)} />
            ),
        },
        {
            key: "amount",
            label: "Amount",
            Value: ({ row }: { row: Dispute }) => (
                <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" />
            ),
        },
        { key: "reasonCode", label: "Reason Code Label", value: (row) => row.reasonCode },
        { key: "evidenceDueAt", label: "Evidence Deadline", value: (row) => row.evidenceDueAt },
        {
            key: "evidenceSubmitted",
            label: "Evidence",
            Value: ({ row }: { row: Dispute }) => (
                <StatusBadge
                    status={row.evidenceSubmitted ? "SUBMITTED" : "PENDING"}
                    label={row.evidenceSubmitted ? t("Submitted") : t("Pending")}
                    toneOverride={row.evidenceSubmitted ? "success" : "warning"}
                />
            ),
        },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Dispute }) => (
                <TableRowActions
                    primaryAction={{
                        label: t("Respond"),
                        icon: "mdi-file-document-edit-outline",
                        onClick: () => {
                            selected.value = row;
                            note.value = "";
                            file.value = null;
                            formError.value = "";
                            attachments.value = [];
                            dialogOpen.value = true;
                            void loadAttachments(row.id);
                        },
                    }}
                    items={[]}
                />
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Disputes")}
                    subtitle={t("Chargeback cases, evidence, and resolution status.")}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <DataTable
                        title={t("Disputes")}
                        data={rows.value}
                        headers={headers}
                        loading={loading.value}
                        showNumber={true}
                        xlsx={false}
                        noElevation={true}
                        searchValue={search.value}
                        setSearchValue={(value) => (search.value = value)}
                    />
                )}
            </ThemedView>

            <FormModal
                modelValue={dialogOpen.value}
                onUpdate:modelValue={(v: any) => (dialogOpen.value = v)}
                title={selected.value?.disputeRef ?? t("Dispute")}
                size="md"
                loading={actionLoading.value}
                errorMessage={formError.value}
                submitLabel={t("Submit")}
                onSubmit={() => void submitEvidence()}
            >
                <SectionFields title={t("Evidence")}>
                    <FormField label={t("Label or note")}>
                        <VTextarea
                            modelValue={note.value}
                            onUpdate:modelValue={(v: string) => (note.value = v)}
                            rows={2}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Evidence file")}>
                        <VFileInput
                            modelValue={file.value}
                            onUpdate:modelValue={(v: File | File[] | null) => {
                                file.value = Array.isArray(v) ? (v[0] ?? null) : v;
                            }}
                            hideDetails
                        />
                    </FormField>
                </SectionFields>
                <SectionFields title={t("Uploaded evidence")}>
                    {attachmentsLoading.value ? (
                        <ThemedText>{t("Loading…")}</ThemedText>
                    ) : attachments.value.length === 0 ? (
                        <ThemedText class="text-medium-emphasis">{t("No evidence uploaded yet.")}</ThemedText>
                    ) : attachments.value.map((attachment) => (
                        <ThemedView key={attachment.id} style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "8px 0", borderBottom: "1px solid var(--pg-border-subtle)" }}>
                            <ThemedView style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                <ThemedText>{attachment.label}</ThemedText>
                                <StatusBadge status={attachment.avScanStatus ?? "PENDING"} />
                                <MonoRef value={attachment.sha256 ?? ""} truncate={12} />
                                {attachment.byteSize && <ThemedText class="text-medium-emphasis">{attachment.byteSize} B</ThemedText>}
                            </ThemedView>
                            <ThemedView style={{ display: "flex", gap: "6px" }}>
                                <VBtn size="small" variant="text" disabled={attachment.status !== "ACTIVE"} onClick={() => void downloadAttachment(attachment)}>{t("Download")}</VBtn>
                                <VBtn size="small" variant="text" color="error" onClick={() => void deleteAttachment(attachment)}>{t("Delete")}</VBtn>
                            </ThemedView>
                        </ThemedView>
                    ))}
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default DisputesPage;
