import { inject, onBeforeUnmount, onMounted, provide, type InjectionKey } from "vue";

/**
 * Lightweight form-control registry shared by `PgForm` and every input. In
 * Vapor there is no VDOM ref tree to walk, so controls register themselves and
 * expose a validate/focus handle. Conditional fields unregister on unmount, so
 * a hidden field can never block submission.
 */
export type PgFormControlHandle = {
    id: string;
    validate: () => { valid: boolean; message: string };
    focus: () => void;
};

export type PgFormValidationError = { id: string; errorMessages: string[] };

export type PgFormApi = {
    register: (control: PgFormControlHandle) => void;
    unregister: (id: string) => void;
    validate: () => Promise<{ valid: boolean; errors: PgFormValidationError[] }>;
    resetValidation: () => void;
    reset: () => void;
    registerReset: (fn: () => void) => void;
};

const FORM_KEY: InjectionKey<PgFormApi & { controls: Map<string, PgFormControlHandle> }> = Symbol(
    "pg-form",
) as InjectionKey<PgFormApi & { controls: Map<string, PgFormControlHandle> }>;

let uid = 0;

export const nextFormControlId = (prefix = "pg-control"): string => `${prefix}-${++uid}`;

export const providePgForm = () => {
    const controls = new Map<string, PgFormControlHandle>();
    const resetters = new Set<() => void>();
    const api = {
        controls,
        register: (control: PgFormControlHandle) => {
            controls.set(control.id, control);
        },
        unregister: (id: string) => {
            controls.delete(id);
        },
        validate: async () => {
            const errors: PgFormValidationError[] = [];
            for (const control of controls.values()) {
                let result: { valid: boolean; message: string };
                try {
                    result = control.validate();
                } catch {
                    result = { valid: false, message: "Invalid value" };
                }
                if (!result.valid) errors.push({ id: control.id, errorMessages: [result.message || "Invalid value"] });
            }
            if (errors.length) {
                const first = controls.get(errors[0]!.id);
                try {
                    first?.focus();
                } catch {
                    /* focus is best effort */
                }
            }
            return { valid: errors.length === 0, errors };
        },
        resetValidation: () => {
            for (const control of controls.values()) {
                if ("resetValidation" in control && typeof (control as any).resetValidation === "function") {
                    (control as any).resetValidation();
                }
            }
        },
        reset: () => {
            for (const resetter of resetters) {
                try {
                    resetter();
                } catch {
                    /* a broken resetter must not block the others */
                }
            }
        },
        registerReset: (fn: () => void) => {
            resetters.add(fn);
            return () => resetters.delete(fn);
        },
    };
    provide(FORM_KEY, api);
    return api;
};

export const usePgFormApi = () => inject(FORM_KEY, null);

/**
 * Registers a control with the nearest `PgForm` (if any). Safe outside a form.
 * The returned id should be applied to the control's native input for focus and
 * label association.
 */
export const usePgFormControl = (handle: {
    id?: string;
    validate: () => { valid: boolean; message: string };
    focus: () => void;
    resetValidation?: () => void;
    reset?: () => void;
}) => {
    const form = usePgFormApi();
    const id = handle.id || nextFormControlId();
    if (form) {
        const control: PgFormControlHandle & { resetValidation?: () => void } = { ...handle, id };
        onMounted(() => {
            form.register(control);
            if (handle.reset && form.registerReset) form.registerReset(handle.reset);
        });
        onBeforeUnmount(() => form.unregister(id));
    }
    return { form, id };
};
