import { computed, nextTick, onMounted, ref, watch } from "vue";
import { defineComponent } from "@/utils/dc";
import { useRoute } from "vue-router";
import {PageHeader, PgAutocomplete, PgSearchInput} from "@pg/ui";
import {PgPage as ScreenContainer} from "@pg/ui";
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
        watch(
            [selectedCase, filtered],
            async () => {
                if (!selectedCase.value) return;
                await nextTick();
                document.getElementById(`case-${selectedCase.value}`)?.scrollIntoView({ block: "center" });
            },
            { immediate: true },
        );
        const copiedCase = ref<number | null>(null);
        const copyCaseLink = async (n: number) => {
            try {
                const url = new URL(window.location.pathname, window.location.origin);
                url.searchParams.set("case", String(n));
                await navigator.clipboard.writeText(url.toString());
                copiedCase.value = n;
                window.setTimeout(() => {
                    if (copiedCase.value === n) copiedCase.value = null;
                }, 2500);
            } catch {
                copiedCase.value = null;
            }
        };

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
                            <PgSearchInput
                                modelValue={query.value}
                                onUpdate:modelValue={(value: string) => (query.value = value)}
                                placeholder={L("Search scenarios and resolutions…", "ابحث في السيناريوهات والحلول…")}
                                ariaLabel={L("Search edge cases", "البحث في حالات الحافة")}
                            />
                            <PgAutocomplete
                                density="compact"
                                searchable={false}
                                clearable={false}
                                items={[{ value: "", label: L("All groups", "كل المجموعات") }, ...groups.value.map(([letter, name]) => ({ value: letter, label: `${letter} — ${name}` }))]}
                                modelValue={group.value}
                                onUpdate:modelValue={(value: string) => (group.value = value)}
                            />
                            <PgAutocomplete
                                density="compact"
                                searchable={false}
                                clearable={false}
                                items={[{ value: "", label: L("All severities", "كل المستويات") }, ...["Low", "Med", "High"].map((level) => ({ value: level, label: level }))]}
                                modelValue={severity.value}
                                onUpdate:modelValue={(value: string) => (severity.value = value)}
                            />
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
                                        <th />
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
                                            <td>
                                                <button type="button" class="guide-secondary-button" onClick={() => void copyCaseLink(edgeCase.n)}>
                                                    {copiedCase.value === edgeCase.n ? L("Copied", "تم النسخ") : L("Copy link", "نسخ الرابط")}
                                                </button>
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
