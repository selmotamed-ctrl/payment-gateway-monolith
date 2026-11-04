import { defineComponent, type PropType } from "vue";
import type { UiStatus } from "@/content/guide";

export const UiStatusBanner = defineComponent({
    name: "UiStatusBanner",
    props: {
        status: { type: String as PropType<UiStatus>, required: true },
    },
    setup(props) {
        return () => {
            if (props.status === "AVAILABLE") return null;
            const partial = props.status === "PARTIAL";
            return (
                <div class={partial ? "guide-ui-banner guide-ui-banner--partial" : "guide-ui-banner guide-ui-banner--missing"} role="status">
                    <strong>{partial ? "Partly available" : "Not built yet"}</strong>
                    <span>
                        {partial
                            ? "Some parts of this process already exist on screen; others are still handled by a person. Follow the instructions and ask when a step has no screen."
                            : "This feature is described in the design but has no screen yet. Follow the article and ask the named role who performs it today."}
                    </span>
                </div>
            );
        };
    },
});

export default UiStatusBanner;
