import { dc } from "@/utils/dc";
import { computed, ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import {VAlert, PgButton, PgAutocomplete, PgSwitch, PgTextField, PgTextarea} from "@pg/ui";
import { useRouter } from "vue-router";
import {PgPage as ScreenContainer} from "@pg/ui";
import {PageHeader} from "@pg/ui";
import {ThemedView} from "@pg/ui";
import {ThemedText} from "@pg/ui";
import {SurfaceCard, SurfaceCardText} from "@pg/ui";
import {StatusBadge} from "@pg/ui";
import {EmptyState} from "@pg/ui";
import {type MetricItem} from "@pg/ui";
import {SummaryExportCard} from "@pg/ui";
import {FormChecklist} from "@pg/ui";
import {SegmentedTabs} from "@pg/ui";
import {SlideOverDrawer} from "@pg/ui";
import {FormModal} from "@pg/ui";
import {FormField} from "@pg/ui";
import {MonoRef} from "@pg/ui";
import {ApiTable} from "@pg/ui";
import {TableRowActions} from "@pg/ui";
import type { TableHeader } from "@pg/ui";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { showConfirm } from "@/utils/confirm";
import { areChecklistsVisible } from "@/constants/env";
import { xlsxUIPipeline } from "@/utils/xlsx";

type Incident = {
    id: string;
    reference: string;
    title: string;
    summary: string | null;
    category: string;
    severity: string;
    status: string;
    impactScope: string;
    detectedAt: string;
    declaredAt: string | null;
    containedAt: string | null;
    resolvedAt: string | null;
    closedAt: string | null;
    commanderUserId: string | null;
    commanderName?: string | null;
    reporterUserId: string | null;
    reporterName?: string | null;
    affectedServices: string[];
    affectedMerchantIds: string[];
    affectedAttemptIds: string[];
    regulatorsNotified: boolean;
    regulatoryReportId: string | null;
    postmortemRequired: boolean;
    postmortemDueAt: string | null;
    rootCause: string | null;
    postmortemSummary: string | null;
    createdAt: string;
    updatedAt: string;
    timeline?: TimelineEntry[];
    responders?: Responder[];
    actions?: ActionItem[];
    links?: IncidentLink[];
    communications?: Communication[];
};
type TimelineEntry = { id: string; occurredAt: string; type: string; summary: string; actorName?: string | null };
type Responder = { id: string; name: string; role: string; isCommander: boolean; acknowledgedAt: string | null; releasedAt: string | null };
type ActionItem = { id: string; title: string; priority: number; status: string; dueAt: string | null; ownerUserId: string | null; ownerName?: string | null; completedAt: string | null; notes: string | null };
type IncidentLink = { id: string; linkType: string; targetId: string; label: string | null };
type Communication = { id: string; channel: string; audience: string; subject: string; body: string; sentAt: string | null; sentByName?: string | null };
type IncidentSummary = { open: number; high: number; postmortemDue: number; total: number };

const COMMUNICATION_CHECKS = [
    { key: "COMMUNICATION_SCOPE_VERIFIED", label: "Communication scope verified" },
    { key: "AUDIENCE_AND_CHANNEL_REVIEWED", label: "Audience and channel reviewed" },
    { key: "AUTHORITY_CONFIRMED", label: "Communication authority confirmed" },
] as const;

const TRANSITION_CHECKS = [
    { key: "INCIDENT_STATE_VERIFIED", label: "Incident state and gates verified" },
    { key: "IMPACT_REVIEWED", label: "Impact and affected scope reviewed" },
    { key: "COMMUNICATIONS_REVIEWED", label: "Communications posture reviewed" },
    { key: "AUTHORITY_CONFIRMED", label: "Transition authority confirmed" },
] as const;

const SUMMARY_EXPORT_CHECKS = [
    { key: "INCIDENT_SCOPE_VERIFIED", label: "Incident scope verified" },
    { key: "SEVERITY_STATUS_REVIEWED", label: "Severity and status breakdown reviewed" },
    { key: "POSTMORTEM_BACKLOG_REVIEWED", label: "Postmortem backlog reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const INCIDENT_EXPORT_CHECKS = [
    { key: "INCIDENT_SCOPE_VERIFIED", label: "Incident queue scope verified" },
    { key: "INCIDENT_DATA_REVIEWED", label: "Confidential incident data reviewed" },
    { key: "EXPORT_AUTHORITY_CONFIRMED", label: "Export authority confirmed" },
] as const;

const SEVERITIES = ["SEV1", "SEV2", "SEV3", "SEV4"];
const STATUSES = ["DETECTED", "TRIAGED", "DECLARED", "CONTAINED", "MONITORING", "RESOLVED", "POSTMORTEM", "CLOSED"];
const CATEGORIES = ["AVAILABILITY", "DATA_INTEGRITY", "SECURITY", "FRAUD", "COMPLIANCE", "THIRD_PARTY", "PAYMENT_PROCESSING", "OTHER"];
const IMPACTS = ["PLATFORM", "MERCHANT", "CHECKOUT", "ADMIN", "MULTI_TENANT"];
const TRANSITIONS: Record<string, string[]> = {
    DETECTED: ["TRIAGED", "DECLARED"],
    TRIAGED: ["DECLARED", "MONITORING"],
    DECLARED: ["CONTAINED"],
    CONTAINED: ["MONITORING", "RESOLVED"],
    MONITORING: ["RESOLVED", "CONTAINED"],
    RESOLVED: ["POSTMORTEM", "CLOSED"],
    POSTMORTEM: ["CLOSED"],
    CLOSED: [],
};
const toneFor = (status: string) => status === "CLOSED" || status === "RESOLVED" ? "success" : status === "CONTAINED" || status === "MONITORING" ? "info" : status === "DETECTED" ? "danger" : "warning";
const severityTone = (severity: string) => severity === "SEV1" ? "danger" : severity === "SEV2" ? "warning" : severity === "SEV3" ? "info" : "neutral";
const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
};
const emptyEdit = () => ({ title: "", summary: "", category: "OTHER", severity: "SEV3", impactScope: "PLATFORM", commanderUserId: "", regulatorsNotified: false, affectedServices: "", affectedMerchantIds: "", affectedAttemptIds: "" });

const IncidentsPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const rows = ref<Incident[]>([]);
    const total = ref(0);
    const summary = ref<IncidentSummary | null>(null);
    const search = ref<string | null>(null);
    const statusFilter = ref<string | null>(null);
    const severityFilter = ref<string | null>(null);
    const categoryFilter = ref<string | null>(null);
    const pageSize = ref(20);
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    const createOpen = ref(false);
    const creating = ref(false);
    const createError = ref("");
    const selected = ref<Incident | null>(null);
    const drawerOpen = ref(false);
    const detailLoading = ref(false);
    const activeTab = ref("overview");
    const transitionTo = ref<string | null>(null);
    const transitionNote = ref("");
    const transitionChecklist = ref<Record<string, boolean>>({});
    const transitionChecklistComplete = computed(() => !showChecklists || TRANSITION_CHECKS.every((check) => transitionChecklist.value[check.key] === true));
    const timelineNote = ref("");
    const actionTitle = ref("");
    const actionDue = ref("");
    const actionPriority = ref(3);
    const responderName = ref("");
    const responderRole = ref("INCIDENT_COMMANDER");
    const linkType = ref("ATTEMPT");
    const linkTarget = ref("");
    const linkLabel = ref("");
    const commChannel = ref("STATUS_PAGE");
    const commAudience = ref("Merchants");
    const commSubject = ref("");
    const commBody = ref("");
    const commChecklist = ref<Record<string, boolean>>({});
    const commChecklistComplete = computed(() => !showChecklists || COMMUNICATION_CHECKS.every((check) => commChecklist.value[check.key] === true));
    const working = ref(false);
    const showChecklists = areChecklistsVisible();
    const summaryExportLoading = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});
    const summaryExportChecklistComplete = computed(() => !showChecklists || SUMMARY_EXPORT_CHECKS.every((check) => summaryExportChecklist.value[check.key] === true));
    const listExportOpen = ref(false);
    const listExportLoading = ref(false);
    const listExportChecklist = ref<Record<string, boolean>>({});
    const listExportChecklistComplete = computed(() => !showChecklists || INCIDENT_EXPORT_CHECKS.every((check) => listExportChecklist.value[check.key] === true));
    const edit = ref(emptyEdit());
    const form = ref({ title: "", summary: "", category: "OTHER", severity: "SEV3", impactScope: "PLATFORM", detectedAt: "", commanderUserId: "", affectedServices: "", affectedMerchantIds: "", affectedAttemptIds: "" });
    const tabs = computed(() => [
        { label: t("Overview"), value: "overview" },
        { label: t("Timeline"), value: "timeline" },
        { label: t("Responders"), value: "responders" },
        { label: t("Actions"), value: "actions" },
        { label: t("Communications"), value: "comms" },
        { label: t("Postmortem"), value: "postmortem" },
    ]);
    const metrics = computed<MetricItem[]>(() => [
        { key: "open", label: t("Open"), value: String(summary.value?.open ?? 0) },
        { key: "high", label: t("SEV1 / SEV2"), value: String(summary.value?.high ?? 0) },
        { key: "postmortem", label: t("Postmortem due"), value: String(summary.value?.postmortemDue ?? 0) },
        { key: "total", label: t("Total"), value: String(summary.value?.total ?? total.value) },
    ]);
    const headers = computed<TableHeader<Incident>[]>(() => [
        {
            key: "reference",
            label: "Reference",
            value: (row) => row.reference,
            Value: ({ row }: { row: Incident }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <MonoRef value={row.reference} />
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{formatDateTime(row.detectedAt)}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "title",
            label: "Title",
            value: (row) => row.title,
            Value: ({ row }: { row: Incident }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.title}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.category} · {row.impactScope}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "severity",
            label: "Severity",
            value: (row) => row.severity,
            Value: ({ row }: { row: Incident }) => <StatusBadge status={row.severity} toneOverride={severityTone(row.severity)} />,
        },
        {
            key: "status",
            label: "Status",
            value: (row) => row.status,
            Value: ({ row }: { row: Incident }) => <StatusBadge status={row.status} toneOverride={toneFor(row.status)} />,
        },
        {
            key: "commander",
            label: "Commander",
            value: (row) => row.commanderName ?? row.commanderUserId ?? "",
            Value: ({ row }: { row: Incident }) => <ThemedText style={{ fontSize: "11px" }}>{row.commanderName ?? row.commanderUserId ?? "—"}</ThemedText>,
        },
        {
            key: "actions",
            label: "Open",
            sortable: false,
            Value: ({ row }: { row: Incident }) => (
                <TableRowActions
                    primaryAction={{ label: t("Open incident"), icon: "mdi-open-in-new", onClick: () => void openIncident(row) }}
                />
            ),
        },
    ]);
    const resetTransient = () => {
        transitionTo.value = null;
        transitionNote.value = "";
        transitionChecklist.value = {};
        timelineNote.value = "";
        actionTitle.value = "";
        actionDue.value = "";
        actionPriority.value = 3;
        responderName.value = "";
        responderRole.value = "INCIDENT_COMMANDER";
        linkType.value = "ATTEMPT";
        linkTarget.value = "";
        linkLabel.value = "";
        commChannel.value = "STATUS_PAGE";
        commAudience.value = "Merchants";
        commSubject.value = "";
        commBody.value = "";
        commChecklist.value = {};
    };
    const loadSelected = async (id: string) => {
        const response = await api.get(urlsMap.incident(id));
        selected.value = (response.data?.data ?? response.data ?? {}).incident ?? null;
        if (selected.value) {
            edit.value = {
                title: selected.value.title,
                summary: selected.value.summary ?? "",
                category: selected.value.category,
                severity: selected.value.severity,
                impactScope: selected.value.impactScope,
                commanderUserId: selected.value.commanderUserId ?? "",
                regulatorsNotified: selected.value.regulatorsNotified,
                affectedServices: selected.value.affectedServices.join(", "),
                affectedMerchantIds: selected.value.affectedMerchantIds.join(", "),
                affectedAttemptIds: selected.value.affectedAttemptIds.join(", "),
            };
        }
    };
    const openIncident = async (incident: Incident) => {
        resetTransient();
        selected.value = null;
        drawerOpen.value = true;
        activeTab.value = "overview";
        detailLoading.value = true;
        try {
            await loadSelected(incident.id);
        } catch (error) {
            drawerOpen.value = false;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };
    const refreshSelected = async () => {
        if (selected.value) await loadSelected(selected.value.id);
    };
    const refreshAll = () => {
        refreshHook.value?.refreshAsIs();
    };
    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        if (!summaryExportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all summary export checklist items before exporting") });
            return;
        }
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.incidentSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const snapshot = (response.data?.data ?? response.data ?? {}) as IncidentSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const lines = ["metric,value", ...([
                ["total", snapshot.total],
                ["open", snapshot.open],
                ["sev1_sev2_open", snapshot.high],
                ["postmortem_due", snapshot.postmortemDue],
                ["filtered_total", total.value],
            ] as Array<[string, unknown]>).map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({ title: `incident-summary-${new Date().toISOString().slice(0, 10)}.xlsx`, lines });
            showSnackBar({ type: "success", message: t("Incident summary exported") });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            summaryExportLoading.value = false;
        }
    };

    const exportIncidents = async () => {
        if (listExportLoading.value) return;
        if (!listExportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all export checklist items before exporting") });
            return;
        }
        listExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.incidentsExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...(statusFilter.value ? { status: statusFilter.value } : {}),
                    ...(severityFilter.value ? { severity: severityFilter.value } : {}),
                    ...(categoryFilter.value ? { category: categoryFilter.value } : {}),
                    checklist: INCIDENT_EXPORT_CHECKS.filter((check) => listExportChecklist.value[check.key]).map((check) => check.key).join(","),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.incidents ?? []) as Incident[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No incidents match the current filters.") });
                return;
            }
            const truncated = payload.truncated === true;
            const exportedTotal = Number(payload.total ?? rowsData.length);
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "reference", "title", "severity", "status", "category", "impactScope", "detectedAt", "commander", "postmortemRequired", "regulatorsNotified", "affectedServices"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) => [
                    row.id,
                    row.reference,
                    row.title,
                    row.severity,
                    row.status,
                    row.category,
                    row.impactScope,
                    row.detectedAt,
                    row.commanderName ?? row.commanderUserId ?? "",
                    row.postmortemRequired,
                    row.regulatorsNotified,
                    (row.affectedServices ?? []).join(";"),
                ].map(escape).join(",")),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({ title: `incidents-${new Date().toISOString().slice(0, 10)}.xlsx`, lines });
            listExportOpen.value = false;
            listExportChecklist.value = {};
            showSnackBar({
                type: truncated ? "warning" : "success",
                message: truncated
                    ? t("Exported {exported} of {total} incidents; narrow the filters to export the rest.", { exported: rowsData.length, total: exportedTotal })
                    : t("Incidents exported"),
            });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            listExportLoading.value = false;
        }
    };

    const createIncident = async () => {
        creating.value = true;
        createError.value = "";
        try {
            await api.post(urlsMap.incidents, {
                title: form.value.title,
                summary: form.value.summary || undefined,
                category: form.value.category,
                severity: form.value.severity,
                impactScope: form.value.impactScope,
                detectedAt: form.value.detectedAt ? new Date(form.value.detectedAt).toISOString() : undefined,
                commanderUserId: form.value.commanderUserId || undefined,
                affectedServices: form.value.affectedServices.split(",").map((value) => value.trim()).filter(Boolean),
                affectedMerchantIds: form.value.affectedMerchantIds.split(",").map((value) => value.trim()).filter(Boolean),
                affectedAttemptIds: form.value.affectedAttemptIds.split(",").map((value) => value.trim()).filter(Boolean),
            });
            createOpen.value = false;
            form.value = { title: "", summary: "", category: "OTHER", severity: "SEV3", impactScope: "PLATFORM", detectedAt: "", commanderUserId: "", affectedServices: "", affectedMerchantIds: "", affectedAttemptIds: "" };
            showSnackBar({ type: "success", message: t("Incident opened") });
            refreshAll();
        } catch (error) {
            createError.value = extractApiErrorMessage(error);
        } finally {
            creating.value = false;
        }
    };
    const saveIncident = async () => {
        if (!selected.value) return;
        working.value = true;
        try {
            await api.patch(urlsMap.incident(selected.value.id), {
                title: edit.value.title,
                summary: edit.value.summary || null,
                category: edit.value.category,
                severity: edit.value.severity,
                impactScope: edit.value.impactScope,
                commanderUserId: edit.value.commanderUserId || null,
                regulatorsNotified: edit.value.regulatorsNotified,
                affectedServices: edit.value.affectedServices.split(",").map((value) => value.trim()).filter(Boolean),
                affectedMerchantIds: edit.value.affectedMerchantIds.split(",").map((value) => value.trim()).filter(Boolean),
                affectedAttemptIds: edit.value.affectedAttemptIds.split(",").map((value) => value.trim()).filter(Boolean),
            });
            showSnackBar({ type: "success", message: t("Incident updated") });
            await refreshSelected();
            refreshAll();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            working.value = false;
        }
    };
    const transition = async () => {
        if (!selected.value || !transitionTo.value) return;
        if (!transitionChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all transition checklist items before continuing") });
            return;
        }
        if (transitionTo.value === "CLOSED" && !(await showConfirm({ title: t("Close incident"), message: t("Closing the incident is irreversible."), type: "error" }))) return;
        working.value = true;
        try {
            await api.post(urlsMap.incidentTransition(selected.value.id), {
                status: transitionTo.value,
                note: transitionNote.value || undefined,
                checklist: TRANSITION_CHECKS.filter((check) => transitionChecklist.value[check.key]).map((check) => check.key),
            });
            transitionTo.value = null;
            transitionNote.value = "";
            transitionChecklist.value = {};
            showSnackBar({ type: "success", message: t("Incident status updated") });
            await refreshSelected();
            refreshAll();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            working.value = false;
        }
    };
    const savePostmortem = async () => {
        if (!selected.value) return;
        working.value = true;
        try {
            await api.patch(urlsMap.incident(selected.value.id), { rootCause: selected.value.rootCause, postmortemSummary: selected.value.postmortemSummary });
            showSnackBar({ type: "success", message: t("Postmortem saved") });
            await refreshSelected();
            refreshAll();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            working.value = false;
        }
    };
    const addTimeline = async () => {
        if (!selected.value || !timelineNote.value.trim()) return;
        working.value = true;
        try {
            await api.post(urlsMap.incidentTimeline(selected.value.id), { type: "NOTE", summary: timelineNote.value });
            timelineNote.value = "";
            await refreshSelected();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            working.value = false;
        }
    };
    const addAction = async () => {
        if (!selected.value || !actionTitle.value.trim()) return;
        working.value = true;
        try {
            await api.post(urlsMap.incidentActions(selected.value.id), { title: actionTitle.value, dueAt: actionDue.value ? new Date(actionDue.value).toISOString() : undefined, priority: actionPriority.value });
            actionTitle.value = "";
            actionDue.value = "";
            await refreshSelected();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            working.value = false;
        }
    };
    const updateAction = async (action: ActionItem, status: string) => {
        if (!selected.value) return;
        working.value = true;
        try {
            await api.patch(urlsMap.incidentAction(selected.value.id, action.id), { status });
            await refreshSelected();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            working.value = false;
        }
    };
    const addResponder = async () => {
        if (!selected.value || !responderName.value.trim()) return;
        working.value = true;
        try {
            await api.post(urlsMap.incidentResponders(selected.value.id), { name: responderName.value, role: responderRole.value, isCommander: responderRole.value === "INCIDENT_COMMANDER" });
            responderName.value = "";
            await refreshSelected();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            working.value = false;
        }
    };
    const updateResponder = async (responder: Responder, change: "acknowledged" | "released") => {
        if (!selected.value) return;
        working.value = true;
        try {
            await api.patch(urlsMap.incidentResponder(selected.value.id, responder.id), { [change]: true });
            await refreshSelected();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            working.value = false;
        }
    };
    const addLink = async () => {
        if (!selected.value || !linkTarget.value.trim()) return;
        working.value = true;
        try {
            await api.post(urlsMap.incidentLinks(selected.value.id), { linkType: linkType.value, targetId: linkTarget.value, label: linkLabel.value || undefined });
            linkTarget.value = "";
            linkLabel.value = "";
            await refreshSelected();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            working.value = false;
        }
    };
    const removeLink = async (link: IncidentLink) => {
        if (!selected.value) return;
        working.value = true;
        try {
            await api.delete(urlsMap.incidentLink(selected.value.id, link.id));
            await refreshSelected();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            working.value = false;
        }
    };
    const addCommunication = async () => {
        if (!selected.value || !commSubject.value.trim() || !commBody.value.trim()) return;
        if (!commChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all communication checklist items before recording") });
            return;
        }
        working.value = true;
        try {
            await api.post(urlsMap.incidentCommunications(selected.value.id), {
                channel: commChannel.value,
                audience: commAudience.value,
                subject: commSubject.value,
                body: commBody.value,
                checklist: COMMUNICATION_CHECKS.filter((check) => commChecklist.value[check.key]).map((check) => check.key),
            });
            commSubject.value = "";
            commBody.value = "";
            await refreshSelected();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            working.value = false;
        }
    };
    const draftReport = async () => {
        if (!selected.value) return;
        if (!(await showConfirm({ title: t("Draft regulatory report"), message: t("This creates a confidential incident report pending maker-checker approval."), type: "primary" }))) return;
        working.value = true;
        try {
            await api.post(urlsMap.incidentReport(selected.value.id), {});
            showSnackBar({ type: "success", message: t("Incident report submitted for approval") });
            await refreshSelected();
            refreshAll();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            working.value = false;
        }
    };
    return () => (
        <ScreenContainer>
            <PageHeader title={t("Incidents")} subtitle={t("Operational resilience, response timeline and regulatory incident reporting")} badge="AML-CONFIDENTIAL" badgeTone="danger">(
                    <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                        <PgButton variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</PgButton>
                        <PgButton variant="tonal" prependIcon="mdi-download" loading={listExportLoading.value} onClick={() => { listExportChecklist.value = {}; listExportOpen.value = true; }}>{t("Export Excel")}</PgButton>
                        <PgButton color="primary" prependIcon="mdi-plus" onClick={() => (createOpen.value = true)}>{t("Open incident")}</PgButton>
                    </ThemedView>
                )</PageHeader>
            <SummaryExportCard
                title={t("Incident health")}
                metrics={metrics.value}
                checks={[...SUMMARY_EXPORT_CHECKS]}
                checklist={summaryExportChecklist.value}
                onUpdate:checklist={(value: Record<string, boolean>) => (summaryExportChecklist.value = value)}
                showChecklists={showChecklists}
                checklistComplete={summaryExportChecklistComplete.value}
                exportLoading={summaryExportLoading.value}
                exportDisabled={!summaryExportChecklistComplete.value}
                exportLabel={t("Export summary")}
                onExport={() => void exportSummary()}
            />
            <ApiTable<Incident>
                title={t("Incident queue")}
                url={urlsMap.incidents}
                localSearch={false}
                xlsx={false}
                showNumber={true}
                numberOfItemsPerPage={pageSize.value}
                numberOfItemsPerPageChoices={[{ label: "10", value: 10 }, { label: "20", value: 20 }, { label: "50", value: 50 }]}
                setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
                searchValue={search.value}
                setSearchValue={(value) => (search.value = value)}
                headers={headers.value}
                rowTone={(row) => row.severity === "SEV1" || row.severity === "SEV2" ? "error" : "neutral"}
                apiDataExtractor={(data) => {
                    const payload = data as { incidents?: Incident[]; summary?: IncidentSummary };
                    summary.value = payload.summary ?? null;
                    return payload.incidents ?? [];
                }}
                apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                onData={(nextRows, nextTotal) => {
                    rows.value = nextRows;
                    total.value = nextTotal;
                }}
                setRefreshHook={(hook) => {
                    refreshHook.value = hook as typeof refreshHook.value;
                }}
                clearRefreshHook={() => {
                    refreshHook.value = null;
                }}
                onRefresh={(table, refresh) => {
                    void refresh({
                        queryParams: {
                            page: table.page,
                            pageSize: pageSize.value,
                            ...(search.value ? { search: search.value } : {}),
                            ...(statusFilter.value ? { status: statusFilter.value } : {}),
                            ...(severityFilter.value ? { severity: severityFilter.value } : {}),
                            ...(categoryFilter.value ? { category: categoryFilter.value } : {}),
                        },
                    });
                }}
                TopSlot={({ reset }) => (
                    <ThemedView style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid var(--pg-border-subtle)" }}>
                        <PgAutocomplete items={STATUSES.map((value) => ({ title: value, value }))} clearable modelValue={statusFilter.value} onUpdate:modelValue={(value: string | null) => { statusFilter.value = value; reset(); }} label={t("Status")} hideDetails density="compact" style={{ maxWidth: "190px" }} />
                        <PgAutocomplete items={SEVERITIES.map((value) => ({ title: value, value }))} clearable modelValue={severityFilter.value} onUpdate:modelValue={(value: string | null) => { severityFilter.value = value; reset(); }} label={t("Severity")} hideDetails density="compact" style={{ maxWidth: "160px" }} />
                        <PgAutocomplete items={CATEGORIES.map((value) => ({ title: value, value }))} clearable modelValue={categoryFilter.value} onUpdate:modelValue={(value: string | null) => { categoryFilter.value = value; reset(); }} label={t("Category")} hideDetails density="compact" style={{ maxWidth: "210px" }} />
                    </ThemedView>
                )}
            />

            <FormModal
                modelValue={listExportOpen.value}
                onUpdate:modelValue={(value: boolean) => (listExportOpen.value = value)}
                title={t("Export incidents")}
                size="md"
                loading={listExportLoading.value}
                submitLabel={t("Export")}
                onSubmit={() => void exportIncidents()}
            >
                <VAlert type="error" variant="tonal">
                    {t("Incident exports contain confidential operational and regulatory data. Confirm scope, handling and authority before exporting.")}
                </VAlert>
                <FormChecklist
                    checks={[...INCIDENT_EXPORT_CHECKS]}
                    modelValue={listExportChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (listExportChecklist.value = value)}
                    show={showChecklists}
                    title={t("Incident export checklist")}
                    complete={listExportChecklistComplete.value}
                    incompleteMessage={t("Complete all export checklist items before exporting")}
                />
            </FormModal>
            <FormModal modelValue={createOpen.value} onUpdate:modelValue={(value: boolean) => (createOpen.value = value)} title={t("Open incident")} size="lg" loading={creating.value} submitLabel={t("Open incident")} onSubmit={() => void createIncident()}>
                {createError.value && <VAlert type="error" variant="tonal" class="mb-4">{createError.value}</VAlert>}
                <FormField label={t("Title")} required><PgTextField modelValue={form.value.title} onUpdate:modelValue={(value: string) => (form.value.title = value)} hideDetails /></FormField>
                <FormField label={t("Summary")}><PgTextarea modelValue={form.value.summary} onUpdate:modelValue={(value: string) => (form.value.summary = value)} rows={4} hideDetails /></FormField>
                <FormField label={t("Severity")} required><PgAutocomplete items={SEVERITIES.map((value) => ({ title: value, value }))} modelValue={form.value.severity} onUpdate:modelValue={(value: string) => (form.value.severity = value)} hideDetails /></FormField>
                <FormField label={t("Category")} required><PgAutocomplete items={CATEGORIES.map((value) => ({ title: value, value }))} modelValue={form.value.category} onUpdate:modelValue={(value: string) => (form.value.category = value)} hideDetails /></FormField>
                <FormField label={t("Impact scope")} required><PgAutocomplete items={IMPACTS.map((value) => ({ title: value, value }))} modelValue={form.value.impactScope} onUpdate:modelValue={(value: string) => (form.value.impactScope = value)} hideDetails /></FormField>
                <FormField label={t("Detected at")}><PgTextField type="datetime-local" modelValue={form.value.detectedAt} onUpdate:modelValue={(value: string) => (form.value.detectedAt = value)} hideDetails /></FormField>
                <FormField label={t("Commander user ID")}><PgTextField modelValue={form.value.commanderUserId} onUpdate:modelValue={(value: string) => (form.value.commanderUserId = value)} hideDetails /></FormField>
                <FormField label={t("Affected services (comma separated)")}><PgTextField modelValue={form.value.affectedServices} onUpdate:modelValue={(value: string) => (form.value.affectedServices = value)} hideDetails /></FormField>
                <FormField label={t("Affected merchant IDs (comma separated)")}><PgTextField modelValue={form.value.affectedMerchantIds} onUpdate:modelValue={(value: string) => (form.value.affectedMerchantIds = value)} hideDetails /></FormField>
                <FormField label={t("Affected attempt IDs (comma separated)")}><PgTextField modelValue={form.value.affectedAttemptIds} onUpdate:modelValue={(value: string) => (form.value.affectedAttemptIds = value)} hideDetails /></FormField>
            </FormModal>

            <SlideOverDrawer modelValue={drawerOpen.value} onUpdate:modelValue={(value: boolean) => (drawerOpen.value = value)} title={selected.value?.reference ?? t("Incident")} subtitle={selected.value ? `${selected.value.severity} · ${selected.value.status} · ${selected.value.category}` : ""} width={1100}>
                {detailLoading.value || !selected.value ? <ThemedText>{t("Loading incident")}</ThemedText> : (
                    <ThemedView style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedView style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                            <StatusBadge status={selected.value.status} toneOverride={toneFor(selected.value.status)} />
                            <StatusBadge status={selected.value.severity} toneOverride={severityTone(selected.value.severity)} />
                            <ThemedText>{selected.value.title}</ThemedText>
                        </ThemedView>
                        <ThemedView style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                            <PgAutocomplete items={(TRANSITIONS[selected.value.status] ?? []).map((value) => ({ title: value, value }))} modelValue={transitionTo.value} onUpdate:modelValue={(value: string | null) => (transitionTo.value = value)} label={t("Next status")} hideDetails density="compact" style={{ maxWidth: "220px" }} />
                            <PgTextField modelValue={transitionNote.value} onUpdate:modelValue={(value: string) => (transitionNote.value = value)} label={t("Transition note")} hideDetails density="compact" style={{ maxWidth: "320px" }} />
                            <PgButton size="small" color="primary" disabled={!transitionTo.value || !transitionChecklistComplete.value} loading={working.value} onClick={() => void transition()}>{t("Transition")}</PgButton>
                        </ThemedView>
                        <FormChecklist
                            checks={[...TRANSITION_CHECKS]}
                            modelValue={transitionChecklist.value}
                            onUpdate:modelValue={(value: Record<string, boolean>) => (transitionChecklist.value = value)}
                            show={showChecklists}
                            title={t("Transition checklist")}
                            complete={transitionChecklistComplete.value}
                            incompleteMessage={t("Complete all transition checklist items before continuing")}
                        />
                        <ThemedView style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                            {!selected.value.regulatoryReportId && <PgButton size="small" variant="tonal" loading={working.value} onClick={() => void draftReport()}>{t("Draft regulatory report")}</PgButton>}
                            {selected.value.regulatoryReportId && <PgButton size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => void router.push({ name: "AmlReports", query: { open: selected.value?.regulatoryReportId } })}>{t("Open regulatory report")}</PgButton>}
                        </ThemedView>
                        <SegmentedTabs modelValue={activeTab.value} onUpdate:modelValue={(value: string) => (activeTab.value = value)} tabs={tabs.value} />
                        {activeTab.value === "overview" && (
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                                <SurfaceCard title={t("Incident facts")}>
                                    <SurfaceCardText>
                                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
                                            <FormField label={t("Title")} required><PgTextField modelValue={edit.value.title} onUpdate:modelValue={(value: string) => (edit.value.title = value)} hideDetails density="compact" /></FormField>
                                            <FormField label={t("Severity")} required><PgAutocomplete items={SEVERITIES.map((value) => ({ title: value, value }))} modelValue={edit.value.severity} onUpdate:modelValue={(value: string) => (edit.value.severity = value)} hideDetails density="compact" /></FormField>
                                            <FormField label={t("Category")} required><PgAutocomplete items={CATEGORIES.map((value) => ({ title: value, value }))} modelValue={edit.value.category} onUpdate:modelValue={(value: string) => (edit.value.category = value)} hideDetails density="compact" /></FormField>
                                            <FormField label={t("Impact scope")} required><PgAutocomplete items={IMPACTS.map((value) => ({ title: value, value }))} modelValue={edit.value.impactScope} onUpdate:modelValue={(value: string) => (edit.value.impactScope = value)} hideDetails density="compact" /></FormField>
                                            <FormField label={t("Commander user ID")}><PgTextField modelValue={edit.value.commanderUserId} onUpdate:modelValue={(value: string) => (edit.value.commanderUserId = value)} hideDetails density="compact" /></FormField>
                                        </ThemedView>
                                        <FormField label={t("Summary")}><PgTextarea modelValue={edit.value.summary} onUpdate:modelValue={(value: string) => (edit.value.summary = value)} rows={4} hideDetails density="compact" /></FormField>
                                        <FormField label={t("Affected services (comma separated)")}><PgTextField modelValue={edit.value.affectedServices} onUpdate:modelValue={(value: string) => (edit.value.affectedServices = value)} hideDetails density="compact" /></FormField>
                                        <FormField label={t("Affected merchant IDs (comma separated)")}><PgTextField modelValue={edit.value.affectedMerchantIds} onUpdate:modelValue={(value: string) => (edit.value.affectedMerchantIds = value)} hideDetails density="compact" /></FormField>
                                        <FormField label={t("Affected attempt IDs (comma separated)")}><PgTextField modelValue={edit.value.affectedAttemptIds} onUpdate:modelValue={(value: string) => (edit.value.affectedAttemptIds = value)} hideDetails density="compact" /></FormField>
                                        <PgSwitch modelValue={edit.value.regulatorsNotified} onUpdate:modelValue={(value: boolean | null) => (edit.value.regulatorsNotified = Boolean(value))} label={t("Regulators notified")} hideDetails density="compact" />
                                        <ThemedView style={{ display: "flex", gap: "14px", flexWrap: "wrap", marginTop: "8px" }}>
                                            <ThemedText><strong>{t("Detected")}:</strong> {formatDateTime(selected.value.detectedAt)}</ThemedText>
                                            <ThemedText><strong>{t("Declared")}:</strong> {formatDateTime(selected.value.declaredAt)}</ThemedText>
                                            <ThemedText><strong>{t("Contained")}:</strong> {formatDateTime(selected.value.containedAt)}</ThemedText>
                                            <ThemedText><strong>{t("Resolved")}:</strong> {formatDateTime(selected.value.resolvedAt)}</ThemedText>
                                            <ThemedText><strong>{t("Postmortem due")}:</strong> {formatDateTime(selected.value.postmortemDueAt)}</ThemedText>
                                            <ThemedText><strong>{t("Commander")}:</strong> {selected.value.commanderName ?? selected.value.commanderUserId ?? "—"}</ThemedText>
                                            <ThemedText><strong>{t("Reporter")}:</strong> {selected.value.reporterName ?? selected.value.reporterUserId ?? "—"}</ThemedText>
                                        </ThemedView>
                                        <PgButton size="small" color="primary" class="mt-4" loading={working.value} onClick={() => void saveIncident()}>{t("Save incident")}</PgButton>
                                    </SurfaceCardText>
                                </SurfaceCard>
                                <SurfaceCard title={t("Links")}>
                                    <SurfaceCardText>
                                        <ThemedView style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                            <PgAutocomplete items={["ATTEMPT", "MERCHANT", "RAIL", "GATEWAY", "REPORT", "CASE", "OTHER"].map((value) => ({ title: value, value }))} modelValue={linkType.value} onUpdate:modelValue={(value: string) => (linkType.value = value)} label={t("Link type")} hideDetails density="compact" style={{ maxWidth: "180px" }} />
                                            <PgTextField modelValue={linkTarget.value} onUpdate:modelValue={(value: string) => (linkTarget.value = value)} label={t("Target id")} hideDetails density="compact" style={{ maxWidth: "300px" }} />
                                            <PgTextField modelValue={linkLabel.value} onUpdate:modelValue={(value: string) => (linkLabel.value = value)} label={t("Label")} hideDetails density="compact" style={{ maxWidth: "240px" }} />
                                            <PgButton size="small" variant="tonal" onClick={() => void addLink()}>{t("Link record")}</PgButton>
                                        </ThemedView>
                                        {(selected.value.links ?? []).length === 0 ? <EmptyState title={t("No linked records")} /> : (selected.value.links ?? []).map((link) => (
                                            <ThemedView key={link.id} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 0", borderTop: "1px solid var(--pg-border-subtle)" }}>
                                                <ThemedText style={{ flex: 1 }}>{link.linkType}: <MonoRef value={link.targetId} /> {link.label ? `· ${link.label}` : ""}</ThemedText>
                                                <PgButton size="x-small" variant="text" color="error" onClick={() => void removeLink(link)}>{t("Remove")}</PgButton>
                                            </ThemedView>
                                        ))}
                                    </SurfaceCardText>
                                </SurfaceCard>
                            </ThemedView>
                        )}
                        {activeTab.value === "timeline" && (
                            <SurfaceCard><SurfaceCardText>
                                <ThemedView style={{ display: "flex", gap: "8px" }}><PgTextField modelValue={timelineNote.value} onUpdate:modelValue={(value: string) => (timelineNote.value = value)} label={t("Add a note")} hideDetails density="compact" /><PgButton size="small" variant="tonal" onClick={() => void addTimeline()}>{t("Add")}</PgButton></ThemedView>
                                {(selected.value.timeline ?? []).length === 0 ? <EmptyState title={t("No timeline entries")} /> : (selected.value.timeline ?? []).map((entry) => (
                                    <ThemedView key={entry.id} style={{ borderTop: "1px solid var(--pg-border-subtle)", padding: "10px 0" }}>
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{formatDateTime(entry.occurredAt)} · {entry.type}{entry.actorName ? ` · ${entry.actorName}` : ""}</ThemedText>
                                        <ThemedText>{entry.summary}</ThemedText>
                                    </ThemedView>
                                ))}
                            </SurfaceCardText></SurfaceCard>
                        )}
                        {activeTab.value === "responders" && (
                            <SurfaceCard><SurfaceCardText>
                                <ThemedView style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}><PgTextField modelValue={responderName.value} onUpdate:modelValue={(value: string) => (responderName.value = value)} label={t("Name")} hideDetails density="compact" /><PgAutocomplete items={["INCIDENT_COMMANDER", "ENGINEERING", "COMPLIANCE", "SUPPORT", "COMMUNICATIONS"].map((value) => ({ title: value, value }))} modelValue={responderRole.value} onUpdate:modelValue={(value: string) => (responderRole.value = value)} label={t("Role")} hideDetails density="compact" style={{ maxWidth: "230px" }} /><PgButton size="small" variant="tonal" onClick={() => void addResponder()}>{t("Add responder")}</PgButton></ThemedView>
                                {(selected.value.responders ?? []).length === 0 ? <EmptyState title={t("No responders")} /> : (selected.value.responders ?? []).map((responder) => (
                                    <ThemedView key={responder.id} style={{ display: "flex", gap: "8px", alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--pg-border-subtle)" }}>
                                        <ThemedText style={{ flex: 1 }}>{responder.name} · {responder.role} · {responder.acknowledgedAt ? t("Acknowledged") : t("Paged")}</ThemedText>
                                        {!responder.acknowledgedAt && <PgButton size="x-small" variant="text" onClick={() => void updateResponder(responder, "acknowledged")}>{t("Acknowledge")}</PgButton>}
                                        {!responder.releasedAt && <PgButton size="x-small" variant="text" onClick={() => void updateResponder(responder, "released")}>{t("Release")}</PgButton>}
                                    </ThemedView>
                                ))}
                            </SurfaceCardText></SurfaceCard>
                        )}
                        {activeTab.value === "actions" && (
                            <SurfaceCard><SurfaceCardText>
                                <ThemedView style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}><PgTextField modelValue={actionTitle.value} onUpdate:modelValue={(value: string) => (actionTitle.value = value)} label={t("Corrective action")} hideDetails density="compact" /><PgAutocomplete items={[1, 2, 3, 4].map((value) => ({ title: String(value), value }))} modelValue={actionPriority.value} onUpdate:modelValue={(value: number) => (actionPriority.value = value)} label={t("Priority")} hideDetails density="compact" style={{ maxWidth: "120px" }} /><PgTextField type="date" modelValue={actionDue.value} onUpdate:modelValue={(value: string) => (actionDue.value = value)} label={t("Due")} hideDetails density="compact" style={{ maxWidth: "180px" }} /><PgButton size="small" variant="tonal" onClick={() => void addAction()}>{t("Add action")}</PgButton></ThemedView>
                                {(selected.value.actions ?? []).length === 0 ? <EmptyState title={t("No corrective actions")} /> : (selected.value.actions ?? []).map((action) => (
                                    <ThemedView key={action.id} style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", padding: "8px 0", borderTop: "1px solid var(--pg-border-subtle)" }}>
                                        <PgAutocomplete items={["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"].map((value) => ({ title: value, value }))} modelValue={action.status} onUpdate:modelValue={(value: string) => void updateAction(action, value)} hideDetails density="compact" style={{ maxWidth: "170px" }} />
                                        <ThemedText style={{ flex: 1 }}>{action.title}{action.ownerName ? ` · ${action.ownerName}` : ""}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px" }}>{formatDateTime(action.dueAt)}</ThemedText>
                                    </ThemedView>
                                ))}
                            </SurfaceCardText></SurfaceCard>
                        )}
                        {activeTab.value === "comms" && (
                            <SurfaceCard><SurfaceCardText>
                                <ThemedView style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                    <PgAutocomplete items={["STATUS_PAGE", "EMAIL", "SMS", "REGULATOR", "INTERNAL"].map((value) => ({ title: value, value }))} modelValue={commChannel.value} onUpdate:modelValue={(value: string) => (commChannel.value = value)} label={t("Channel")} hideDetails density="compact" style={{ maxWidth: "220px" }} />
                                    <PgTextField modelValue={commAudience.value} onUpdate:modelValue={(value: string) => (commAudience.value = value)} label={t("Audience")} hideDetails density="compact" style={{ maxWidth: "260px" }} />
                                </ThemedView>
                                <PgTextField modelValue={commSubject.value} onUpdate:modelValue={(value: string) => (commSubject.value = value)} label={t("Subject")} hideDetails density="compact" />
                                <PgTextarea modelValue={commBody.value} onUpdate:modelValue={(value: string) => (commBody.value = value)} label={t("Message")} rows={4} hideDetails />
                                <FormChecklist
                                    checks={[...COMMUNICATION_CHECKS]}
                                    modelValue={commChecklist.value}
                                    onUpdate:modelValue={(value: Record<string, boolean>) => (commChecklist.value = value)}
                                    show={showChecklists}
                                    title={t("Communication checklist")}
                                    complete={commChecklistComplete.value}
                                    incompleteMessage={t("Complete all communication checklist items before recording")}
                                />
                                <PgButton size="small" variant="tonal" disabled={!commChecklistComplete.value} onClick={() => void addCommunication()}>{t("Record communication")}</PgButton>
                                {(selected.value.communications ?? []).length === 0 ? <EmptyState title={t("No communications")} /> : (selected.value.communications ?? []).map((communication) => (
                                    <ThemedView key={communication.id} style={{ borderTop: "1px solid var(--pg-border-subtle)", padding: "10px 0" }}>
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{communication.channel} · {communication.audience} · {formatDateTime(communication.sentAt)}</ThemedText>
                                        <ThemedText>{communication.subject}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px", whiteSpace: "pre-wrap" }}>{communication.body}</ThemedText>
                                    </ThemedView>
                                ))}
                            </SurfaceCardText></SurfaceCard>
                        )}
                        {activeTab.value === "postmortem" && (
                            <SurfaceCard><SurfaceCardText>
                                {selected.value.postmortemRequired && <VAlert type={selected.value.postmortemSummary ? "success" : "warning"} variant="tonal" class="mb-4">{selected.value.postmortemSummary ? t("Postmortem recorded") : t("A postmortem is required before close")}</VAlert>}
                                <FormField label={t("Root cause")}><PgTextarea modelValue={selected.value.rootCause ?? ""} onUpdate:modelValue={(value: string) => (selected.value!.rootCause = value)} rows={4} hideDetails /></FormField>
                                <FormField label={t("Postmortem summary")}><PgTextarea modelValue={selected.value.postmortemSummary ?? ""} onUpdate:modelValue={(value: string) => (selected.value!.postmortemSummary = value)} rows={8} hideDetails /></FormField>
                                <PgButton size="small" color="primary" loading={working.value} onClick={() => void savePostmortem()}>{t("Save postmortem")}</PgButton>
                            </SurfaceCardText></SurfaceCard>
                        )}
                    </ThemedView>
                )}
            </SlideOverDrawer>
        </ScreenContainer>
    );
});
export default IncidentsPage;
