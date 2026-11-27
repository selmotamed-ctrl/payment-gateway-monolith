import { onBeforeUnmount } from "vue";
import { dc } from "../lib/dc";
import { PgTextField } from "./PgTextField";

/**
 * Dedicated table/toolbar search control: a `PgTextField` preset with a leading
 * magnifier, the shared 22px clear button, neutral outer focus ring, optional
 * debounced `search`, `Enter` = `enter` + `search`, `Escape` = clear.
 */
export const PgSearchInput = dc(
    (props: Record<string, any>, _expose, { attrs, emit }) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let pending: string | null = null;
        let field: any = null;

        const current = () => (props.modelValue === null || props.modelValue === undefined ? "" : String(props.modelValue));

        const cancel = () => {
            if (timer) clearTimeout(timer);
            timer = undefined;
            pending = null;
        };

        const schedule = (next: string) => {
            emit?.("update:modelValue", next);
            if (props.debounce && Number(props.debounce) > 0) {
                pending = next;
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    timer = undefined;
                    const value = pending ?? "";
                    pending = null;
                    emit?.("search", value);
                }, Number(props.debounce));
            } else {
                emit?.("search", next);
            }
        };

        const flush = (next: string) => {
            cancel();
            emit?.("search", next);
            emit?.("enter", next);
        };

        const clear = () => {
            cancel();
            if (field && typeof field.clear === "function") {
                field.clear();
            } else {
                schedule("");
                emit?.("clear");
            }
        };

        onBeforeUnmount(cancel);

        return () => (
            <PgTextField
                {...attrs}
                ref={(instance: any) => {
                    field = instance;
                }}
                id={props.id || undefined}
                modelValue={props.modelValue}
                label={props.label}
                hint={props.hint}
                error={props.error}
                hideDetails={props.hideDetails}
                type="search"
                size={props.size}
                density={props.density}
                placeholder={props.placeholder}
                aria-label={attrs["aria-label"] || props.ariaLabel || props.placeholder || "Search"}
                kbdHint={props.kbdHint}
                clearable={props.clearable !== false}
                disabled={props.disabled}
                readonly={props.readonly}
                autofocus={props.autofocus}
                name={props.name}
                leadingIcon="mdi-magnify"
                onUpdate:modelValue={(next: string) => schedule(next)}
                onClear={() => {
                    cancel();
                    emit?.("clear");
                }}
                onEnter={(value?: string) => flush(value ?? current())}
                onKeydown={(event: KeyboardEvent) => {
                    if (event.key === "Escape") {
                        event.preventDefault();
                        clear();
                    }
                    (attrs.onKeydown as ((event: KeyboardEvent) => void) | undefined)?.(event);
                }}
                onFocus={() => emit?.("focus")}
                onBlur={() => emit?.("blur")}
            />
        );
    },
    {
        props: {
            modelValue: { type: [String, Number], default: "" },
            label: { type: String, default: "" },
            placeholder: { type: String, default: "" },
            hint: { type: String, default: "" },
            error: { type: String, default: "" },
            ariaLabel: { type: String, default: "" },
            debounce: { type: Number, default: 0 },
            kbdHint: { type: String, default: "" },
            clearable: { type: Boolean, default: true },
            disabled: { type: Boolean, default: false },
            readonly: { type: Boolean, default: false },
            autofocus: { type: Boolean, default: false },
            hideDetails: { type: Boolean, default: true },
            name: { type: String, default: "" },
            id: { type: String, default: "" },
            size: { type: String, default: "sm" },
            density: { type: String, default: "" },
        },
        emits: ["update:modelValue", "search", "clear", "enter", "focus", "blur"],
        inheritAttrs: true,
    },
);
