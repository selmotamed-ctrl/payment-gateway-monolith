import { computed, defineComponent, onBeforeUnmount, onMounted, ref, type PropType, type VNodeChild } from "vue";
import { RouterLink } from "vue-router";
import { useLocale } from "vuetify";
import ScreenContainer from "@/components/ScreenContainer";
import { MetaPill } from "@/components/ui/MetaPill";
import { user } from "@/state/user";
import {
    loadCatalog,
    loadLabs,
    loadLessons,
    type AcademyMeta,
    type ExamBlueprintPublic,
    type Lab,
    type Lesson,
    type Module,
    type Track,
} from "@/content/academy";
import { useAcademyProgress } from "./useAcademyProgress";
import { AcademyNav } from "./ui/AcademyNav";

/**
 * Strings with `{name}` placeholders must be translated WITH their values: `t("Continue: {title}", { title })`.
 * vue-i18n consumes placeholders at translation time, so formatting the result afterwards finds nothing to replace.
 */

/** Lazy content for the learner pages: catalogue first (small), lessons/labs on demand. */
export const useAcademyData = () => {
    const meta = ref<AcademyMeta | null>(null);
    const tracks = ref<Track[]>([]);
    const modules = ref<Module[]>([]);
    const blueprints = ref<ExamBlueprintPublic[]>([]);
    const lessons = ref<Lesson[]>([]);
    const labs = ref<Lab[]>([]);
    const ready = ref(false);
    const failed = ref(false);

    const loadCore = async (withLessons = true, withLabs = true) => {
        try {
            const catalog = await loadCatalog();
            meta.value = catalog.meta;
            tracks.value = catalog.tracks;
            modules.value = catalog.modules;
            blueprints.value = catalog.blueprints;
            const [l, b] = await Promise.all([withLessons ? loadLessons() : [], withLabs ? loadLabs() : []]);
            lessons.value = l as Lesson[];
            labs.value = b as Lab[];
            ready.value = true;
        } catch {
            failed.value = true;
        }
    };
    return { meta, tracks, modules, blueprints, lessons, labs, ready, failed, loadCore };
};

export const userRole = (): string => String(user.value?.userInfo?.role ?? "");

/**
 * Loading placeholder. Flat blocks (no shimmer gradient), `aria-busy` while visible.
 * `split` mimics the main + aside layout so the page does not jump when content arrives.
 */
export const Skeleton = defineComponent({
    name: "AcademySkeleton",
    props: {
        rows: { type: Number, default: 3 },
        split: { type: Boolean, default: false },
    },
    setup(props) {
        const { t } = useLocale();
        const blocks = (count: number, first = 72) =>
            Array.from({ length: count }, (_, i) => <div key={i} class="ac-skel" style={{ blockSize: i === 0 ? `${first}px` : "104px" }} />);
        return () => (
            <div role="status" aria-busy="true" aria-label={t("Loading…")}>
                {props.split ? (
                    <div class="ac-split">
                        <div>{blocks(props.rows, 96)}</div>
                        <div>{blocks(2, 140)}</div>
                    </div>
                ) : (
                    blocks(props.rows)
                )}
            </div>
        );
    },
});

/**
 * Frame shared by every Academy page: full-width `ScreenContainer`, the page's own `PageHeader`
 * (passed as `header`), the section switcher with the "not saved yet" indicator, the body, and the
 * "Stuck?" footer. It also loads the progress record and flushes unsent patches on leave.
 */
export const AcademyShell = defineComponent({
    name: "AcademyShell",
    props: {
        header: { type: Function as PropType<() => VNodeChild>, default: undefined },
    },
    setup(props, { slots }) {
        const { t } = useLocale();
        const academy = useAcademyProgress();
        const isAdmin = computed(() => userRole() === "SECURITY_ADMIN");
        const flush = () => void academy.flush();

        onMounted(() => {
            void academy.load();
            window.addEventListener("beforeunload", flush);
        });
        onBeforeUnmount(() => {
            window.removeEventListener("beforeunload", flush);
            flush();
        });

        return () => (
            <ScreenContainer>
                <div class="ac-wrap">
                    {props.header?.()}
                    <div class="ac-toolbar">
                        <AcademyNav isAdmin={isAdmin.value} />
                        {academy.unsaved.value && (
                            <span role="status">
                                <MetaPill color="warning" prependIcon="mdi-cloud-off-outline">
                                    {t("not saved yet")}
                                </MetaPill>
                            </span>
                        )}
                    </div>
                    {slots.default?.()}
                    <footer class="ac-footer">
                        {t("Stuck?")} <RouterLink to={{ name: "AdminGuide" }}>{t("Open the Guide article")}</RouterLink>
                        {t(", or ask your trainer.")}
                    </footer>
                </div>
            </ScreenContainer>
        );
    },
});

export default AcademyShell;
