import { computed, onMounted, ref } from "vue";
import { defineComponent } from "@/utils/dc";
import { loadData, type VisibleRailsData } from "@/content/guide";
import { evaluateVisibleRails } from "./engine/visibleRails";
import { useGuideLocale } from "./useGuideLocale";
import { PgAutocomplete, PgTextField } from "@pg/ui";

const parseWhitelist = (value: string): string[] | null => {
    const entries = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    return entries.length > 0 ? entries : null;
};

export const VisibleRailsExplainer = defineComponent({
    name: "VisibleRailsExplainer",
    setup() {
        const { L } = useGuideLocale();
        const data = ref<VisibleRailsData | null>(null);
        const amount = ref("100");
        const currency = ref("LYD");
        const timeOfDay = ref("12:00");
        const applicationWhitelist = ref("");
        const linkWhitelist = ref("");
        const overrides = ref<Record<string, string>>({});

        onMounted(async () => {
            const loaded = await loadData().catch(() => null);
            data.value = loaded?.["visible-rails"] ?? null;
        });

        const results = computed(() =>
            data.value
                ? evaluateVisibleRails(data.value, {
                      amount: amount.value,
                      currency: currency.value,
                      timeOfDay: timeOfDay.value,
                      applicationWhitelist: parseWhitelist(applicationWhitelist.value),
                      linkWhitelist: parseWhitelist(linkWhitelist.value),
                      routeOverrides: Object.fromEntries(
                          Object.entries(overrides.value).map(([routeId, health]) => [routeId, { health }]),
                      ),
                  })
                : [],
        );

        const reset = () => {
            amount.value = "100";
            currency.value = "LYD";
            timeOfDay.value = "12:00";
            applicationWhitelist.value = "";
            linkWhitelist.value = "";
            overrides.value = {};
        };

        return () => (
            <section class="guide-tool">
                <header class="guide-tool__header">
                    <div>
                        <h2>{L("Why is a payment method visible?", "لماذا تظهر وسيلة الدفع؟")}</h2>
                        <p>{L("Change the inputs and watch the nine predicates decide.", "غيّر المدخلات وشاهد الشروط التسعة تقرر.")}</p>
                    </div>
                    <button type="button" class="guide-secondary-button" onClick={reset}>
                        {L("Reset", "إعادة تعيين")}
                    </button>
                </header>
                <p class="guide-tool__warning">
                    {L("Teaching tool — not connected to any real system.", "أداة تعليمية — غير متصلة بأي نظام حقيقي.")}
                </p>
                {!data.value ? (
                    <p>{L("Loading teaching data…", "جارٍ تحميل البيانات التعليمية…")}</p>
                ) : (
                    <>
                        <div class="guide-tool__grid">
                            <div class="guide-field">
                                <span>{L("Link amount", "مبلغ الرابط")}</span>
                                <PgTextField density="compact" modelValue={amount.value} onUpdate:modelValue={(value: string) => (amount.value = value)} />
                            </div>
                            <div class="guide-field">
                                <span>{L("Currency", "العملة")}</span>
                                <PgAutocomplete density="compact" searchable={false} clearable={false} items={["LYD", "USD"]} modelValue={currency.value} onUpdate:modelValue={(value: string) => (currency.value = value)} />
                            </div>
                            <div class="guide-field">
                                <span>{L("Time of day", "وقت اليوم")}</span>
                                <PgTextField type="time" density="compact" modelValue={timeOfDay.value} onUpdate:modelValue={(value: string) => (timeOfDay.value = value)} />
                            </div>
                            <div class="guide-field">
                                <span>{L("Application whitelist (comma separated)", "قائمة تطبيق المسموح (مفصولة بفواصل)")}</span>
                                <PgTextField density="compact" modelValue={applicationWhitelist.value} onUpdate:modelValue={(value: string) => (applicationWhitelist.value = value)} />
                            </div>
                            <div class="guide-field">
                                <span>{L("Link whitelist (comma separated)", "قائمة الرابط المسموح (مفصولة بفواصل)")}</span>
                                <PgTextField density="compact" modelValue={linkWhitelist.value} onUpdate:modelValue={(value: string) => (linkWhitelist.value = value)} />
                            </div>
                        </div>
                        <div class="guide-rail-list" aria-live="polite">
                            {results.value.map((rail) => (
                                <div key={rail.code} class={`guide-rail ${rail.visible ? "guide-rail--visible" : "guide-rail--hidden"}`}>
                                    <div class="guide-rail__header">
                                        <strong>{rail.name}</strong>
                                        <span>{rail.visible ? L("Visible", "ظاهرة") : `${L("Hidden because", "مخفية لأن")}: ${rail.reason?.predicate}`}</span>
                                    </div>
                                    {rail.reason ? <p>{rail.reason.message}</p> : null}
                                    <div class="guide-rail__routes">
                                        {rail.routes.map((route) => (
                                            <label key={route.id} class="guide-rail__route">
                                                <span>{route.id}</span>
                                                <PgAutocomplete
                                                    density="compact"
                                                    searchable={false}
                                                    clearable={false}
                                                    items={["HEALTHY", "DEGRADED", "OPEN_BREAKER"]}
                                                    modelValue={overrides.value[route.id] ?? "HEALTHY"}
                                                    onUpdate:modelValue={(value: string) => {
                                                        const next = { ...overrides.value };
                                                        if (value === "HEALTHY") delete next[route.id];
                                                        else next[route.id] = value;
                                                        overrides.value = next;
                                                    }}
                                                />
                                                <small>
                                                    {route.passed
                                                        ? L("passes", "ناجح")
                                                        : `${L("fails predicate", "يفشل الشرط")} ${route.failedPredicate}`}
                                                </small>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div class="guide-tool__explain">
                            <h3>{L("Explain this result", "اشرح هذه النتيجة")}</h3>
                            <p>
                                {L(
                                    "Predicates 1, 2, 3 and 9 apply to the whole rail. Predicates 4 to 8 apply to each route. A rail is visible when at least one route passes all five route checks.",
                                    "الشروط 1 و2 و3 و9 تنطبق على الوسيلة كلها. الشروط 4 إلى 8 تنطبق على كل مسار. تظهر الوسيلة عندما ينجح مسار واحد على الأقل في الشروط الخمسة.",
                                )}
                            </p>
                        </div>
                    </>
                )}
            </section>
        );
    },
});

export default VisibleRailsExplainer;
