import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { AcademyShell, Skeleton } from "@/components/academy/AcademyShell";
import { CertificateView } from "@/components/academy/CertificateView";
import { badgeStateOf, useAcademyProgress } from "@/components/academy/useAcademyProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { loadMeta, loadPages, loadTracks, type Track } from "@/content/academy";
import { user } from "@/state/user";

const CertificatePage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
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
            <AcademyShell
                header={() => (
                    <PageHeader
                        title={t("Certificate")}
                        breadcrumbs={[{ label: t("Academy"), to: router.resolve({ name: "AdminAcademy" }).fullPath }, { label: t("Certificate") }]}
                    />
                )}
            >
                {!ready.value ? (
                    <Skeleton rows={2} split />
                ) : !b ? (
                    <SurfaceCard class="ac-card">
                        <EmptyState
                            icon="mdi-certificate-outline"
                            title={t("We could not find that certificate")}
                            description={t("It may belong to another person, or it may not have been issued yet. Certificates you have earned are listed on your Academy home page.")}
                            actionLabel={t("Back to Academy")}
                            actionVariant="flat"
                            actionColor="primary"
                            onAction={() => void router.push({ name: "AdminAcademy" })}
                        />
                    </SurfaceCard>
                ) : (
                    <CertificateView badge={b} trackTitle={trackTitle} holderName={holderName.value} template={template.value} state={badgeStateOf(b, recertifyFrom.value)} />
                )}
            </AcademyShell>
        );
    };
});

export default CertificatePage;
