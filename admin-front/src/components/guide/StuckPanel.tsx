import { defineComponent, type PropType } from "vue";
import { RouterLink } from "vue-router";
import type { Situation } from "@/content/guide";

export const StuckPanel = defineComponent({
    name: "StuckPanel",
    props: {
        situations: { type: Array as PropType<Situation[]>, default: () => [] },
    },
    setup(props) {
        return () => (
            <section class="guide-stuck-panel" aria-labelledby="guide-stuck-title">
                <header>
                    <h2 id="guide-stuck-title">I'm stuck</h2>
                    <RouterLink to={{ name: "AdminGuidePlaybook" }}>Open the full playbook</RouterLink>
                </header>
                <div class="guide-stuck-grid">
                    {props.situations.slice(0, 6).map((situation) => (
                        <RouterLink
                            key={situation.id}
                            to={{ name: "AdminGuidePlaybook", params: { id: situation.id } }}
                            class="guide-stuck-card"
                        >
                            <strong>{situation.title}</strong>
                            <span>Open the calm, step-by-step answer.</span>
                        </RouterLink>
                    ))}
                </div>
                <RouterLink
                    class="guide-stuck-emergency"
                    to={{ name: "AdminGuideArticle", params: { articleId: "b10-01" } }}
                >
                    Incident? Start with the runbook chooser
                </RouterLink>
            </section>
        );
    },
});

export default StuckPanel;
