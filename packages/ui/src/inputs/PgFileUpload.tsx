import { FileUpload } from "vael-ui/vapor";
import { computed, ref } from "vue";
import { dc } from "../lib/dc";
import { runRules, visibleError } from "../lib/rules";
import { PgFieldShell } from "./PgFieldShell";

/**
 * Modern drag-and-drop file field with a file pill preview and validation.
 * Supports the old `modelValue` (File | File[] | null) and `allowedMimeTypes` /
 * `maximumSizeInBytes` aliases.
 */
export const PgFileUpload = dc(
    (props: Record<string, any>, _expose, { attrs, emit }) => {
        const localError = ref("");
        const files = computed<File[]>(() => {
            const value = props.modelValue;
            if (!value) return [];
            return Array.isArray(value) ? value : [value];
        });
        const validate = (next: any) => {
            localError.value = props.rules ? runRules({ ...props, ...attrs }, next) : "";
        };
        const update = (next: File[]) => {
            const value = props.multiple === false ? (next[0] ?? null) : next;
            emit?.("update:modelValue", value);
            emit?.("update:files", next);
            validate(value);
        };
        return () => {
            const error = visibleError({ ...props, ...attrs }, localError.value);
            const accept = props.accept || props.allowedMimeTypes || undefined;
            const maxSize = props.maxSize ?? props.maximumSizeInBytes ?? undefined;
            return (
                <PgFieldShell
                    label={props.label}
                    hint={props.hint}
                    error={error}
                    required={props.required}
                    disabled={props.disabled}
                    hideDetails={props.hideDetails}
                >
                    <FileUpload
                        files={files.value}
                        multiple={props.multiple !== false}
                        accept={accept}
                        maxSize={maxSize}
                        disabled={Boolean(props.disabled)}
                        name={props.name}
                        onUpdate:files={update}
                        onReject={(rejection: any) => {
                            localError.value =
                                rejection?.reason === "maxSize"
                                    ? "File is too large"
                                    : rejection?.reason === "maxFiles"
                                      ? "Too many files"
                                      : "File type is not accepted";
                        }}
                    />
                </PgFieldShell>
            );
        };
    },
    {
        props: {
            modelValue: { type: [Object, Array], default: null },
            label: { type: String, default: "" },
            hint: { type: String, default: "" },
            error: { type: String, default: "" },
            errorMessages: { type: [Array, String], default: undefined },
            accept: { type: String, default: "" },
            allowedMimeTypes: { type: [String, Array], default: undefined },
            maxSize: { type: Number, default: undefined },
            maximumSizeInBytes: { type: Number, default: undefined },
            multiple: { type: Boolean, default: true },
            disabled: { type: Boolean, default: false },
            required: { type: Boolean, default: false },
            hideDetails: { type: Boolean, default: false },
            rules: { type: Array as () => Array<(value: any) => any>, default: () => [] },
            name: { type: String, default: "" },
        },
        emits: ["update:modelValue", "update:files"],
        inheritAttrs: true,
    },
);

export const VFileInput = PgFileUpload;
