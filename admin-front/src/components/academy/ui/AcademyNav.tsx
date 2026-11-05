import { computed, defineComponent } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useLocale } from "vuetify";

/** Which of the four sections a route belongs to (sub-pages keep their section lit). */
const SECTION_OF: Record<string, string> = {
    AdminAcademy: "AdminAcademy",
    AdminAcademyLesson: "AdminAcademy",
    AdminAcademyLab: "AdminAcademy",
    AdminAcademyExam: "AdminAcademy",
    AdminAcademyCertificate: "AdminAcademy",
    AdminAcademyTracks: "AdminAcademyTracks",
    AdminAcademyTrack: "AdminAcademyTracks",
    AdminAcademyModule: "AdminAcademyTracks",
    AdminAcademyHelp: "AdminAcademyHelp",
    AdminAcademyTeam: "AdminAcademyTeam",
};

/**
 * Section switcher. Same look as `SegmentedTabs`, but real links because each tab is a route.
 * `.ac-nav` is also the layout-test hook; the accessible name must stay "Academy sections".
 */
export const AcademyNav = defineComponent({
    name: "AcademyNav",
    props: { isAdmin: { type: Boolean, default: false } },
    setup(props) {
        const { t } = useLocale();
        const route = useRoute();
        const tabs = computed(() => {
            const base = [
                { name: "AdminAcademy", label: t("My learning") },
                { name: "AdminAcademyTracks", label: t("Tracks") },
                { name: "AdminAcademyHelp", label: t("Help") },
            ];
            return props.isAdmin ? [...base, { name: "AdminAcademyTeam", label: t("Team") }] : base;
        });
        return () => {
            const current = String(route.name ?? "");
            const section = SECTION_OF[current] ?? "";
            return (
                <nav class="ac-nav" aria-label={t("Academy sections")}>
                    {tabs.value.map((tab) => (
                        <RouterLink
                            key={tab.name}
                            to={{ name: tab.name }}
                            class={["ac-nav__link", section === tab.name ? "ac-nav__link--on" : ""]}
                            aria-current={current === tab.name ? "page" : section === tab.name ? "true" : undefined}
                        >
                            {tab.label}
                        </RouterLink>
                    ))}
                </nav>
            );
        };
    },
});

export default AcademyNav;
