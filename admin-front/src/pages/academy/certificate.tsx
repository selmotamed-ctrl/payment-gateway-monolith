import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import { AcademyShell } from "@/components/academy/AcademyShell";
import { CertificateView } from "@/components/academy/CertificateView";
import { badgeStateOf, useAcademyProgress } from "@/components/academy/useAcademyProgress";
import { loadMeta, loadPages, loadTracks, type Track } from "@/content/academy";
import { user } from "@/state/user";

const CertificatePage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const academy = useAcademyProgress();
    const ready = ref(false);
    const tracks = ref<Track[]>([]);
    const template = ref("");
    const recertifyFrom = ref("1.0.0");

    const badge = computed(() => academy.progress.value.badges.find((b) => b.id === String(route.params.badgeId ?? "")));
    const holderName = computed(() => {
        const info = user.value?.userInfo;
        const email = info?.email ?? "";
        return (info?.name || info?.username || email.split("@")[0] || "").trim();
    });

    onMounted(async () => {
        try {
            const [loadedTracks, pages, meta] = await Promise.all([loadTracks(), loadPages(), loadMeta(), academy.load()]);
            tracks.value = loadedTracks;
            template.value = pages.find((p) => p.id === "page-certificate")?.markdown ?? "";
            recertifyFrom.value = meta.recertifyFrom;
        } finally {
            ready.value = true;
        }
    });

    return () => {
        const b = badge.value;
        const trackTitle = tracks.value.find((track) => track.id === b?.track)?.title ?? b?.track ?? "";
        return (
            <AcademyShell title={t("Certificate")} backTo={{ name: "AdminAcademy", label: t("Back to Academy") }}>
                {!ready.value ? (
                    <div role="status" aria-busy="true" style={{ blockSize: "160px", borderRadius: "12px", background: "var(--pg-bg-surface-subtle)", maxInlineSize: "820px" }} />
                ) : !b ? (
                    <div role="status" style={{ maxInlineSize: "620px", display: "flex", flexDirection: "column", gap: "12px" }}>
                        <h2 style={{ margin: 0 }}>{t("We could not find that certificate")}</h2>
                        <p style={{ margin: 0 }}>{t("It may belong to another person, or it may not have been issued yet. Certificates you have earned are listed on your Academy home page.")}</p>
                        <div><VBtn color="primary" to={{ name: "AdminAcademy" }}>{t("Back to Academy")}</VBtn></div>
                    </div>
                ) : (
                    <CertificateView badge={b} trackTitle={trackTitle} holderName={holderName.value} template={template.value} state={badgeStateOf(b, recertifyFrom.value)} />
                )}
            </AcademyShell>
        );
    };
});

export default CertificatePage;
