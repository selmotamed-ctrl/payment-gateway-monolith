import { defineComponent } from "vue";

export const ReadToggle = defineComponent({
    name: "ReadToggle",
    props: {
        read: { type: Boolean, default: false },
        saving: { type: Boolean, default: false },
        onToggle: { type: Function as unknown as () => (value: boolean) => void, required: true },
    },
    setup(props) {
        return () => (
            <button
                type="button"
                class={props.read ? "guide-read-toggle guide-read-toggle--read" : "guide-read-toggle"}
                aria-pressed={props.read ? "true" : "false"}
                disabled={props.saving}
                onClick={() => props.onToggle(!props.read)}
            >
                <span aria-hidden="true">{props.read ? "✓" : "○"}</span>
                {props.read ? "Marked as read" : "Mark as read"}
            </button>
        );
    },
});

export default ReadToggle;
