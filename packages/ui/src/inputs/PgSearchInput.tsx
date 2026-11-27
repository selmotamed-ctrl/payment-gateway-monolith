import { useId } from "vue";
import { dc } from "../lib/dc";
import { controlSize } from "../lib/options";
import { PgIcon } from "../actions/PgIcon";

/**
 * Dedicated table/toolbar search input: leading magnifier, clear button,
 * optional keyboard hint and an optional debounced `onSearch`.
 */
export const PgSearchInput = dc(
    (props: Record<string, any>, _expose, { attrs, emit }) => {
        const inputId = useId();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const value = () => (props.modelValue == null ? "" : String(props.modelValue));
        const size = () => controlSize({ ...props, density: props.density ?? "compact" });

        const schedule = (next: string) => {
            emit?.("update:modelValue", next);
            if (props.debounce && props.debounce > 0) {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => emit?.("search", next), props.debounce);
            } else {
                emit?.("search", next);
            }
        };

        return () => (
            <div class={["pg-control-box", `pg-control-box--${size()}`, attrs.class].filter(Boolean).join(" ")}>
                <span class="pg-control-adornment">
                    <PgIcon icon="mdi-magnify" size={16} />
                </span>
                <input
                    id={inputId}
                    class="pg-control-native"
                    type="search"
                    value={value()}
                    placeholder={props.placeholder ?? "Search"}
                    aria-label={props.ariaLabel ?? props.placeholder ?? "Search"}
                    disabled={props.disabled}
                    onInput={(event: Event) => schedule((event.target as HTMLInputElement).value)}
                    onKeydown={(event: KeyboardEvent) => {
                        if (event.key === "Enter") emit?.("search", value());
                        if (event.key === "Escape") {
                            schedule("");
                            emit?.("clear");
                        }
                    }}
                />
                {value() && (
                    <button
                        type="button"
                        class="pg-control-clear-btn"
                        aria-label="Clear search"
                        onMousedown={(event: MouseEvent) => event.preventDefault()}
                        onClick={() => {
                            schedule("");
                            emit?.("clear");
                        }}
                    >
                        <PgIcon icon="mdi-close-circle" size={15} />
                    </button>
                )}
                {props.kbdHint && !value() && <kbd class="pg-kbd-badge">{props.kbdHint}</kbd>}
            </div>
        );
    },
    {
        props: {
            modelValue: { type: [String, Number], default: "" },
            placeholder: { type: String, default: "" },
            ariaLabel: { type: String, default: "" },
            debounce: { type: Number, default: 0 },
            kbdHint: { type: String, default: "" },
            disabled: { type: Boolean, default: false },
            size: { type: String, default: "sm" },
            density: { type: String, default: "compact" },
        },
        emits: ["update:modelValue", "search", "clear"],
        inheritAttrs: true,
    },
);
