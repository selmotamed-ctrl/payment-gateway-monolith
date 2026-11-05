import { dc } from "kt-dc";
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
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

const TeamPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
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

    const header = () => (
        <PageHeader
            title={t("Team progress")}
            subtitle={data.value ? `${t("Updated")} ${fmtDateTime(data.value.generatedAt)} · ${t("Content version")} ${data.value.contentVersion}` : ""}
            breadcrumbs={[{ label: t("My learning"), to: router.resolve({ name: "AdminAcademy" }).fullPath }, { label: t("Team progress") }]}
            end={() => (
                <VBtn variant="outlined" size="small" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>
                    {t("Refresh")}
                </VBtn>
            )}
        />
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
        </AcademyShell>
    );
});

export default TeamPage;
