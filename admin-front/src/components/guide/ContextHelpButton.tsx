import { defineComponent } from "vue";
import { useRoute } from "vue-router";
import { VIcon } from "vuetify/components";
import { useContextHelp } from "./useContextHelp";

export const ContextHelpButton = defineComponent({
    name: "ContextHelpButton",
    props: {
        routeName: { type: String, default: "" },
    },
    setup(props) {
        const route = useRoute();
        const { openContextHelp } = useContextHelp();
        return () => {
            const name =
                props.routeName ||
                String(route.meta.parentName ?? route.name ?? "");
            return (
                <button
                    type="button"
                    class="guide-context-help-button"
                    aria-label="How this page works"
                    title="How this page works"
                    onClick={() => openContextHelp(name)}
                >
                    <VIcon icon="mdi-help-circle-outline" size={18} />
                    <span>Help</span>
                </button>
            );
        };
    },
});

export default ContextHelpButton;
