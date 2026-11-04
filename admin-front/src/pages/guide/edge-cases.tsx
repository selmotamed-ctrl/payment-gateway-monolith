import { computed, defineComponent, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { PageHeader } from "@/components/ui/PageHeader";
import ScreenContainer from "@/components/ScreenContainer";
import { useGuideLocale } from "@/components/guide/widgets/useGuideLocale";
import { loadEdgeCases, type EdgeCase } from "@/content/guide";
import { normalizeArabicText } from "@/utils/arabic";

export const AdminGuideEdgeCasesPage = defineComponent({
    name: "AdminGuideEdgeCasesPage",
    setup() {
        const route = useRoute();
        const { L } = useGuideLocale();
        const cases = ref<EdgeCase[]>([]);
        const loading = ref(true);
        const query = ref("");
        const group = ref("");
        const severity = ref("");

        onMounted(async () => {
            cases.value = await loadEdgeCases().catch(() => []);
            loading.value = false;
        });

        const groups = computed(() => {
            const map = new Map<string, string>();
            for (const edgeCase of cases.value) map.set(edgeCase.group, edgeCase.groupName);
            return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
        });
        const filtered = computed(() => {
            const needle = normalizeArabicText(query.value);
            return cases.value.filter((edgeCase) => {
                if (group.value && edgeCase.group !== group.value) return false;
                if (severity.value && edgeCase.severity !== severity.value) return false;
                if (!needle) return true;
                return normalizeArabicText(
                    [edgeCase.scenario, edgeCase.resolution, edgeCase.groupName].join(" "),
                ).includes(needle);
            });
        });
        const selectedCase = computed(() => Number(route.query.case ?? 0));

        return () => (
            <ScreenContainer>
                <PageHeader
                    title={L("The 140 edge cases", "حالات الحافة الـ140")}
                    subtitle={L(
                        "The plain-language catalog of every known edge case and its deterministic resolution.",
                        "كتالوج بلغة بسيطة لكل حالة حافة معروفة وحلها المحدد.",
                    )}
                    breadcrumbs={[{ label: L("Guide", "الدليل"), to: "/guide" }, { label: L("Edge cases", "حالات الحافة") }]}
                />
                {loading.value ? (
                    <p class="guide-page-loading">{L("Loading the catalog…", "جارٍ تحميل الكتالوج…")}</p>
                ) : (
                    <div class="guide-edge-cases-page">
                        <div class="guide-edge-tools">
                            <input
                                type="search"
                                value={query.value}
                                placeholder={L("Search scenarios and resolutions…", "ابحث في السيناريوهات والحلول…")}
                                aria-label={L("Search edge cases", "البحث في حالات الحافة")}
                                onInput={(event) => (query.value = (event.target as HTMLInputElement).value)}
                            />
                            <select value={group.value} onChange={(event) => (group.value = (event.target as HTMLSelectElement).value)}>
                                <option value="">{L("All groups", "كل المجموعات")}</option>
                                {groups.value.map(([letter, name]) => (
                                    <option key={letter} value={letter}>{letter} — {name}</option>
                                ))}
                            </select>
                            <select value={severity.value} onChange={(event) => (severity.value = (event.target as HTMLSelectElement).value)}>
                                <option value="">{L("All severities", "كل المستويات")}</option>
                                {["Low", "Med", "High"].map((level) => (
                                    <option key={level} value={level}>{level}</option>
                                ))}
                            </select>
                            <span class="guide-edge-count">{filtered.value.length} / {cases.value.length}</span>
                        </div>
                        <div class="guide-edge-table-wrap">
                            <table class="guide-edge-table">
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>{L("Scenario", "السيناريو")}</th>
                                        <th>{L("Deterministic resolution", "الحل المحدد")}</th>
                                        <th>{L("Severity", "الخطورة")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.value.map((edgeCase) => (
                                        <tr
                                            key={edgeCase.n}
                                            id={`case-${edgeCase.n}`}
                                            class={selectedCase.value === edgeCase.n ? "is-highlighted" : ""}
                                        >
                                            <td>{edgeCase.n}</td>
                                            <td>
                                                <strong>{edgeCase.scenario}</strong>
                                                <small>{edgeCase.group} — {edgeCase.groupName}</small>
                                            </td>
                                            <td>{edgeCase.resolution}</td>
                                            <td>
                                                <span class={`guide-severity guide-severity-${edgeCase.severity.toLowerCase()}`}>
                                                    {edgeCase.severity}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </ScreenContainer>
        );
    },
});

export default AdminGuideEdgeCasesPage;
