import { computed, defineComponent, onBeforeUnmount, onMounted, ref, type PropType } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { useLocale } from "vuetify";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
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

/** Replace `{name}` placeholders after translation. */
export const fmt = (template: string, values: Record<string, string | number>): string =>
    template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

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

const CSS = `
.ac-wrap{max-inline-size:820px;margin-inline:auto}
.ac-wrap--wide{max-inline-size:none}
.ac-nav{display:flex;flex-wrap:wrap;gap:4px;margin-block-end:16px;align-items:center}
.ac-nav a{padding:6px 14px;border-radius:var(--pg-radius-md);color:var(--pg-ink-secondary);text-decoration:none;border:1px solid transparent}
.ac-nav a:hover{background:var(--pg-bg-surface-hover)}
.ac-nav a.ac-nav--on{background:var(--pg-accent-interactive-soft);color:var(--pg-ink-primary);border-color:var(--pg-border-strong);font-weight:600}
.ac-nav a:focus-visible,.ac-btn:focus-visible,.ac-option:focus-visible,.ac-card a:focus-visible{outline:2px solid var(--pg-border-focus);outline-offset:2px}
.ac-grow{flex:1 1 auto}
.ac-card{background:var(--pg-bg-surface);border:1px solid var(--pg-border-subtle);border-radius:var(--pg-radius-lg);padding:16px 18px;margin-block-end:14px}
.ac-card--active{border-color:var(--pg-accent-interactive)}
.ac-card p{margin-block:6px}
.ac-between{display:flex;flex-wrap:wrap;gap:8px 12px;justify-content:space-between;align-items:center}
.ac-h2{font-size:18px;font-weight:700;margin:0 0 8px;color:var(--pg-ink-primary)}
.ac-h3{font-size:15px;font-weight:700;margin:0 0 6px;color:var(--pg-ink-primary)}
.ac-muted{color:var(--pg-ink-muted);font-size:13px}
.ac-stem{font-size:15px;font-weight:600}
.ac-list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:2px}
.ac-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;padding:6px 0;border-block-start:1px solid var(--pg-border-subtle)}
.ac-row:first-child{border-block-start:0}
.ac-grow-end{margin-inline-start:auto}
.ac-state{inline-size:1.2em;text-align:center;color:var(--pg-ink-faint)}
.ac-state--done{color:var(--pg-status-success-text);font-weight:700}
.ac-modules{list-style:none;padding:0;margin:0}
.ac-chip{display:inline-flex;gap:6px;align-items:center;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--pg-border-strong);background:var(--pg-bg-surface-subtle);color:var(--pg-ink-secondary)}
.ac-chip--success{background:var(--pg-status-success-bg);border-color:var(--pg-status-success-border);color:var(--pg-status-success-text)}
.ac-chip--warning{background:var(--pg-status-warning-bg);border-color:var(--pg-status-warning-border);color:var(--pg-status-warning-text)}
.ac-chip--danger{background:var(--pg-status-danger-bg);border-color:var(--pg-status-danger-border);color:var(--pg-status-danger-text)}
.ac-btn{display:inline-flex;align-items:center;gap:8px;padding:9px 18px;border-radius:var(--pg-radius-md);font-weight:600;cursor:pointer;text-decoration:none;border:1px solid var(--pg-accent-primary);background:var(--pg-accent-primary);color:#fff;font-size:14px}
.ac-btn:hover{background:var(--pg-accent-primary-hover)}
.ac-btn--secondary{background:transparent;color:var(--pg-ink-primary);border-color:var(--pg-border-strong)}
.ac-btn--secondary:hover{background:var(--pg-bg-surface-hover)}
.ac-btn--big{padding:14px 28px;font-size:17px}
.ac-btn[disabled],.ac-btn[aria-disabled=true]{opacity:.55;cursor:not-allowed;pointer-events:none}
.ac-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-block:12px}
.ac-rings{display:flex;flex-wrap:wrap;gap:20px;margin-block:12px}
.ac-ring{margin:0;text-align:center;font-size:12px;color:var(--pg-ink-secondary)}
.ac-ring figcaption{margin-block-start:4px}
.ac-facts{display:flex;flex-wrap:wrap;gap:6px 22px;margin:8px 0 12px}
.ac-facts dt{font-size:11px;text-transform:uppercase;color:var(--pg-ink-muted)}
.ac-facts dd{margin:0;font-weight:600}
.ac-options{list-style:none;margin:10px 0;padding:0;display:flex;flex-direction:column;gap:8px}
.ac-option{display:flex;gap:10px;align-items:flex-start;inline-size:100%;text-align:start;padding:10px 12px;border-radius:var(--pg-radius-md);border:1px solid var(--pg-border-strong);background:var(--pg-bg-surface);color:var(--pg-ink-primary);cursor:pointer;font:inherit}
.ac-option:hover:not([disabled]){background:var(--pg-bg-surface-hover)}
.ac-option--good{background:var(--pg-status-success-bg);border-color:var(--pg-status-success-border);color:var(--pg-status-success-text);opacity:1}
.ac-option--bad{background:var(--pg-status-danger-bg);border-color:var(--pg-status-danger-border);color:var(--pg-status-danger-text);opacity:1}
.ac-option[disabled]{cursor:default}
.ac-option-tag{margin-inline-start:auto;font-weight:700;font-size:12px}
.ac-note{margin:4px 0 0 !important;padding-inline-start:12px;font-size:13px;color:var(--pg-ink-secondary)}
.ac-result{min-block-size:1px}
.ac-result--good{color:var(--pg-status-success-text)}
.ac-result--bad{color:var(--pg-status-danger-text)}
.ac-skel{border-radius:var(--pg-radius-md);background:linear-gradient(90deg,var(--pg-bg-surface-subtle),var(--pg-bg-surface-hover),var(--pg-bg-surface-subtle));background-size:200% 100%;animation:ac-shimmer 1.4s infinite;margin-block-end:12px}
@keyframes ac-shimmer{to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.ac-skel{animation:none}}
.ac-footer{margin-block-start:28px;padding-block-start:12px;border-block-start:1px solid var(--pg-border-subtle);color:var(--pg-ink-muted);font-size:13px}
.ac-pager{display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px;margin-block:16px}
.ac-missing{margin:8px 0;padding-inline-start:20px}
.ac-details summary{cursor:pointer;font-weight:600;padding-block:6px}
`;

export const Skeleton = defineComponent({
    name: "AcademySkeleton",
    props: { rows: { type: Number, default: 3 } },
    setup(props) {
        const { t } = useLocale();
        return () => (
            <div role="status" aria-busy="true" aria-label={t("Loading…")}>
                {Array.from({ length: props.rows }, (_, i) => (
                    <div key={i} class="ac-skel" style={{ blockSize: i === 0 ? "64px" : "92px" }} />
                ))}
            </div>
        );
    },
});

export const AcademyShell = defineComponent({
    name: "AcademyShell",
    props: {
        title: { type: String, required: true },
        subtitle: { type: String, default: "" },
        backTo: {
            type: Object as PropType<{ name: string; params?: Record<string, string>; label?: string } | undefined>,
            default: undefined,
        },
        wide: { type: Boolean, default: false },
    },
    setup(props, { slots }) {
        const { t } = useLocale();
        const router = useRouter();
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

        const tabs = computed(() => {
            const base = [
                { name: "AdminAcademy", label: t("My learning") },
                { name: "AdminAcademyTracks", label: t("Tracks") },
                { name: "AdminAcademyHelp", label: t("Help") },
            ];
            return isAdmin.value ? [...base, { name: "AdminAcademyTeam", label: t("Team") }] : base;
        });

        return () => {
            const current = router.currentRoute.value;
            const breadcrumbs = props.backTo
                ? [
                      {
                          label: props.backTo.label ?? t("Back"),
                          to: router.resolve({ name: props.backTo.name, params: props.backTo.params }).fullPath,
                      },
                      { label: props.title },
                  ]
                : [];
            return (
                <ScreenContainer>
                    <style innerHTML={CSS} />
                    <div class={["ac-wrap", props.wide ? "ac-wrap--wide" : ""]}>
                        <PageHeader
                            title={props.title}
                            subtitle={props.subtitle}
                            breadcrumbs={breadcrumbs}
                            end={slots.actions ? () => slots.actions!() : undefined}
                        />
                        <nav class="ac-nav" aria-label={t("Academy sections")}>
                            {tabs.value.map((tab) => (
                                <RouterLink
                                    key={tab.name}
                                    to={{ name: tab.name }}
                                    class={current.name === tab.name ? "ac-nav--on" : ""}
                                    aria-current={current.name === tab.name ? "page" : undefined}
                                >
                                    {tab.label}
                                </RouterLink>
                            ))}
                            <span class="ac-grow" />
                            {academy.unsaved.value && (
                                <span class="ac-chip ac-chip--warning" role="status">
                                    <span aria-hidden="true">⚠</span> {t("not saved yet")}
                                </span>
                            )}
                        </nav>
                        {slots.default?.()}
                        <footer class="ac-footer">
                            {t("Stuck?")} <RouterLink to={{ name: "AdminGuide" }}>{t("Open the Guide article")}</RouterLink>
                            {t(", or ask your trainer.")}
                        </footer>
                    </div>
                </ScreenContainer>
            );
        };
    },
});

export default AcademyShell;
