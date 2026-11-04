import { dc } from "kt-dc";
import { onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import { AcademyShell } from "@/components/academy/AcademyShell";
import { TeamTable } from "@/components/academy/TeamTable";
import { fmtDateTime } from "@/components/academy/exam/ExamBriefing";
import { loadTracks } from "@/content/academy";
import type { TeamResponse } from "@/content/academy/apiTypes";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";

const TeamPage = dc(() => {
    const { t } = useLocale();
    const data = ref<TeamResponse | null>(null);
    const trackTitles = ref<Record<string, string>>({});
    const loading = ref(true);
    const error = ref<string | null>(null);
    const forbidden = ref(false);

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

    return () => (
        <AcademyShell title={t("Team progress")} subtitle={data.value ? `${t("Updated")} ${fmtDateTime(data.value.generatedAt)} · ${t("Content version")} ${data.value.contentVersion}` : undefined} backTo={{ name: "AdminAcademy", label: t("Back to Academy") }} wide>
            {loading.value ? (
                <div role="status" aria-busy="true" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {[0, 1, 2, 3, 4].map((i) => <div key={i} style={{ blockSize: "44px", borderRadius: "8px", background: "var(--pg-bg-surface-subtle)" }} />)}
                    <span style={{ position: "absolute", insetInlineStart: "-9999px" }}>{t("Loading")}</span>
                </div>
            ) : forbidden.value ? (
                <div role="alert" style={{ maxInlineSize: "620px" }}>
                    <h2 style={{ marginBlock: 0 }}>{t("You are not allowed to see this page")}</h2>
                    <p>{t("Team progress is available to security administrators only.")}</p>
                </div>
            ) : error.value || !data.value ? (
                <div role="alert" style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                    <span>{t("We could not load team progress.")} {error.value}</span>
                    <VBtn variant="outlined" onClick={() => void load()}>{t("Retry")}</VBtn>
                </div>
            ) : (
                <TeamTable rows={data.value.rows} trackTitles={trackTitles.value} />
            )}
        </AcademyShell>
    );
});

export default TeamPage;
