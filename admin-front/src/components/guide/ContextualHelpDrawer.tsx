import type { PropType } from "vue";
import { defineComponent } from "@/utils/dc";
import { ContextHelpDrawer } from "./ContextHelpDrawer";

type ContextualHelpDrawerProps = {
    modelValue: boolean;
    routeName?: string;
    onOpenFullGuide?: () => void;
};

/**
 * Compatibility shell for the old context-help drawer.
 *
 * The drawer content moved to the shared Guide context map, so this component
 * now delegates to `ContextHelpDrawer` instead of maintaining a second,
 * drifting route-name -> book-chapter table. Existing callers keep their
 * `v-model` and `route-name` contract.
 */
export const ContextualHelpDrawer = defineComponent({
    name: "ContextualHelpDrawer",
    props: {
        modelValue: { type: Boolean, required: true },
        routeName: { type: String, default: "" },
        onOpenFullGuide: {
            type: Function as PropType<() => void>,
            default: undefined,
        },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        return () => (
            <ContextHelpDrawer
                modelValue={props.modelValue}
                routeName={props.routeName}
                onUpdate:modelValue={(value: boolean) => emit("update:modelValue", value)}
                onOpenFullGuide={() => props.onOpenFullGuide?.()}
            />
        );
    },
});

export default ContextualHelpDrawer;
