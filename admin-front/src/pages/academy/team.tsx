import { dc } from "@/utils/dc";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn, VTextField } from "vuetify/components";
import { AcademyShell } from "@/components/academy/AcademyShell";
import { TeamTable } from "@/components/academy/TeamTable";
import { fmtDateTime } from "@/components/academy/format";
import { Callout } from "@/components/academy/ui/Callout";
import { IconTile } from "@/components/academy/ui/IconTile";
import { PageHeader } from "@/components/ui/PageHeader";
import { loadTracks } from "@/content/academy";
import type { TeamResponse } from "@/content/academy/apiTypes";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { maskEmail } from "@/utils/privacy";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { FormModal } from "@/components/ui/FormModal";
import { FormChecklist } from "@/components/ui/FormChecklist";
import { areChecklistsVisible } from "@/constants/env";

const EXPORT_CHECKS = [
    { key: "TEAM_SCOPE_VERIFIED", label: "Team scope verified" },
    { key: "PERSONAL_DATA_REVIEWED", label: "Personal learning data reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const TeamPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const data = ref<TeamResponse | null>(null);
    const trackTitles = ref<Record<string, string>>({});
    const loading = ref(true);
    const error = ref<string | null>(null);
    const forbidden = ref(false);
    const exportOpen = ref(false);
    const exportLoading = ref(false);
    const revokeOpen = ref(false);
    const revokeLoading = ref(false);
    const revokeId = ref("");
    const revokeReason = ref("");
    const showChecklists = areChecklistsVisible();
    const exportChecklist = ref<Record<string, boolean>>({});
    const exportChecklistComplete = computed(() => !showChecklists || EXPORT_CHECKS.every((check) => exportChecklist.value[check.key] === true));

    const load = async () => {
        loading.value = true;
        error.value = null;
        forbidden.value = false;
        try {
            const [response, tracks] = await Promise.all([api.get(urlsMap.academyTeam), loadTracks()]);
            trackTitles.value = Object.fromEntries(tracks.map((track) => [track.id, track.title]));
            const body = response.data?.data ?? response.data;
            data.value = body && Array.isArray(body.rows) ? (body as TeamResponse) : null;
            if (!data.value) error.value = t("Unexpected response from the server.");
        } catch (e) {
            data.value = null;
            if ((e as { response?: { status?: number } })?.response?.status === 403) forbidden.value = true;
            else error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };
    onMounted(() => void load());

    const revokeCertificate = async () => {
        if (revokeLoading.value) return;
        const identifier = revokeId.value.trim();
        const reason = revokeReason.value.trim();
        if (identifier.length < 8 || reason.length < 5) {
            showSnackBar({ type: "warning", message: t("Enter the certificate ID and a reason of at least 5 characters") });
            return;
        }
        revokeLoading.value = true;
        try {
            await api.post(urlsMap.academyCertificateRevoke(identifier), { reason });
            showSnackBar({ type: "success", message: t("Certificate revoked") });
            revokeOpen.value = false;
            revokeId.value = "";
            revokeReason.value = "";
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            revokeLoading.value = false;
        }
    };

    const exportTeam = async () => {
        if (exportLoading.value) return;
        if (!exportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all export checklist items before exporting") });
            return;
        }
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.academyTeamExport, {
                params: { checklist: EXPORT_CHECKS.filter((check) => exportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const payload = (response.data?.data ?? response.data ?? {}) as TeamResponse;
            const rows = payload.rows ?? [];
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["userId", "email", "name", "role", "isMaker", "isChecker", "activeTrack", "lessonsCompleted", "lessonsRequired", "labsPassed", "labsRequired", "badges", "lastActivityAt", "status"];
            const lines = [
                columns.map(escape).join(","),
                ...rows.map((row) => [
                    row.userId,
                    row.email,
                    row.name,
                    row.role,
                    row.isMaker,
                    row.isChecker,
                    row.activeTrack ?? "",
                    row.lessonsCompleted,
                    row.lessonsRequired,
                    row.labsPassed,
                    row.labsRequired,
                    row.badges.map((badge) => `${badge.track}${badge.expired ? " (expired)" : ""}`).join("; "),
                    row.lastActivityAt ?? "",
                    row.status,
                ].map(escape).join(",")),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({ title: `academy-team-${new Date().toISOString().slice(0, 10)}.xlsx`, lines });
            exportOpen.value = false;
            exportChecklist.value = {};
            showSnackBar({ type: "success", message: t("Team progress exported") });
        } catch (cause) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
        } finally {
            exportLoading.value = false;
        }
    };

    const copyTeamSummary = async () => {
        const snapshot = data.value;
        if (!snapshot) return;
        const byStatus: Record<string, number> = {};
        for (const row of snapshot.rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
        const summary = {
            generatedAt: snapshot.generatedAt,
            contentVersion: snapshot.contentVersion,
            members: snapshot.rows.length,
            byStatus,
            rows: snapshot.rows.map((row) => ({
                email: maskEmail(row.email),
                role: row.role,
                status: row.status,
                lessons: `${row.lessonsCompleted}/${row.lessonsRequired}`,
                labs: `${row.labsPassed}/${row.labsRequired}`,
                badges: row.badges.length,
                lastActivityAt: row.lastActivityAt,
            })),
        };
        try {
            await navigator.clipboard.writeText(JSON.stringify(summary, null, 2));
            showSnackBar({ type: "success", message: t("Team summary copied") });
        } catch {
            showSnackBar({ type: "error", message: t("Could not copy to the clipboard") });
        }
    };

    const header = () => (
        <PageHeader title={t("Team progress")} subtitle={data.value ? `${t("Updated")} ${fmtDateTime(data.value.generatedAt)} · ${t("Content version")} ${data.value.contentVersion}` : ""} breadcrumbs={[{ label: t("My learning"), to: router.resolve({ name: "AdminAcademy" }).fullPath }, { label: t("Team progress") }]}>(
                <>
                    <VBtn variant="outlined" size="small" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>
                        {t("Refresh")}
                    </VBtn>
                    <VBtn variant="outlined" size="small" prependIcon="mdi-content-copy" disabled={!data.value} onClick={() => void copyTeamSummary()}>
                        {t("Copy team summary")}
                    </VBtn>
                    <VBtn variant="outlined" size="small" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => { exportChecklist.value = {}; exportOpen.value = true; }}>
                        {t("Export team progress")}
                    </VBtn>
                    <VBtn variant="outlined" size="small" color="error" prependIcon="mdi-certificate-outline" onClick={() => { revokeId.value = ""; revokeReason.value = ""; revokeOpen.value = true; }}>
                        {t("Revoke certificate")}
                    </VBtn>
                </>
            )</PageHeader>
    );

    /** Same silhouette as the loaded page (status strip + table card) so nothing jumps. */
    const skeleton = () => (
        <div role="status" aria-busy="true">
            <div class="ac-skel ac-team-skel-strip" />
            <div class="ac-skel ac-team-skel-table" />
            <span class="ac-sr-only">{t("Loading")}</span>
        </div>
    );

    return () => (
        <AcademyShell header={header}>
            {loading.value && !data.value ? (
                skeleton()
            ) : forbidden.value ? (
                <section class="ac-card ac-team-forbidden" role="alert">
                    <IconTile icon="mdi-lock-outline" large />
                    <h2 class="ac-h2">{t("You are not allowed to see this page")}</h2>
                    <p class="ac-text">{t("Team progress is available to security administrators only.")}</p>
                </section>
            ) : error.value || !data.value ? (
                <Callout tone="danger">
                    <div class="ac-between">
                        <span>
                            {t("We could not load team progress.")} {error.value}
                        </span>
                        <VBtn variant="outlined" size="small" onClick={() => void load()}>
                            {t("Retry")}
                        </VBtn>
                    </div>
                </Callout>
            ) : (
                <TeamTable rows={data.value.rows} trackTitles={trackTitles.value} />
            )}
            <FormModal
                modelValue={exportOpen.value}
                onUpdate:modelValue={(value: boolean) => (exportOpen.value = value)}
                title={t("Export team progress")}
                size="md"
                loading={exportLoading.value}
                submitLabel={t("Export")}
                onSubmit={() => void exportTeam()}
            >
                <FormChecklist
                    checks={[...EXPORT_CHECKS]}
                    modelValue={exportChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (exportChecklist.value = value)}
                    show={showChecklists}
                    title={t("Team export checklist")}
                    complete={exportChecklistComplete.value}
                    incompleteMessage={t("Complete all export checklist items before exporting")}
                />
            </FormModal>
            <FormModal
                modelValue={revokeOpen.value}
                onUpdate:modelValue={(value: boolean) => (revokeOpen.value = value)}
                title={t("Revoke certificate")}
                size="md"
                loading={revokeLoading.value}
                submitLabel={t("Revoke")}
                onSubmit={() => void revokeCertificate()}
            >
                <div class="ac-stack">
                    <VTextField
                        modelValue={revokeId.value}
                        onUpdate:modelValue={(value: string) => (revokeId.value = value)}
                        label={t("Certificate ID")}
                        placeholder="PG-AC-XXXXXXXX"
                        density="compact"
                        variant="outlined"
                    />
                    <VTextField
                        modelValue={revokeReason.value}
                        onUpdate:modelValue={(value: string) => (revokeReason.value = value)}
                        label={t("Reason")}
                        density="compact"
                        variant="outlined"
                    />
                    <p class="ac-text">{t("Revocation is permanent for this issuance. The holder can recertify, which creates a new certificate.")}</p>
                </div>
            </FormModal>
        </AcademyShell>
    );
});

export default TeamPage;
