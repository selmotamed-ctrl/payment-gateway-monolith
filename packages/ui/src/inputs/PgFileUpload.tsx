import { computed, ref } from "vue";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { runRules, visibleError } from "../lib/rules";
import { usePgFormControl } from "../lib/formRegistry";
import { PgFieldShell } from "./PgFieldShell";
import { PgIcon } from "../actions/PgIcon";
import { PgProgressBar, PgSpinner } from "../actions/PgFeedbackAtoms";

export type PgFileRejection = {
    file: File;
    /** `maxSize`, `maxFiles` or `fileType`. */
    reason: "maxSize" | "maxFiles" | "fileType";
    /** Ready-to-display English message (translated by the caller when needed). */
    message: string;
};

const formatSize = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    const megabytes = bytes / (1024 * 1024);
    return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
};

const fileIcon = (file: File): string => {
    const name = file.name.toLowerCase();
    if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv")) return "mdi-file-excel-outline";
    if (name.endsWith(".json") || name.endsWith(".xml")) return "mdi-file-code-outline";
    return "mdi-file-document-outline";
};

/**
 * KYB / asset dropzone. Pure native markup: a real hidden file input plus a
 * focusable dropzone button (Enter/Space opens the picker), drag-and-drop with
 * an enter/leave counter so child elements cannot flicker the state, per-file
 * rows with size, progress and an individual remove button, and inline MIME /
 * size / count validation.
 *
 * The legacy `allowedMimeTypes`, `maxSize` (bytes), `maximumSizeInBytes`,
 * `prependIcon`, `loading` and `update:files` contract is preserved.
 */
export const PgFileUpload = dc(
    (props: Record<string, any>, _expose, { attrs, emit, slots }) => {
        const { t } = useLocale();
        const inputEl = ref<HTMLInputElement | null>(null);
        const localError = ref("");
        const dragging = ref(false);
        let dragDepth = 0;

        const disabled = computed(() => Boolean(props.disabled) || Boolean(props.loading));
        const compact = computed(() => props.density === "compact");
        const multiple = computed(() => props.multiple !== false);
        const accept = computed(() => {
            const value = props.accept || props.allowedMimeTypes || "";
            return Array.isArray(value) ? value.join(",") : String(value);
        });
        const maxBytes = computed(() => {
            if (props.maxSize !== undefined && props.maxSize !== null) return Number(props.maxSize);
            if (props.maximumSizeInBytes !== undefined && props.maximumSizeInBytes !== null) {
                return Number(props.maximumSizeInBytes);
            }
            return Number(props.maxSizeMb ?? 10) * 1024 * 1024;
        });
        const maxFiles = computed(() => {
            const configured = Number(props.maxFiles ?? 0);
            if (!multiple.value) return 1;
            return Number.isFinite(configured) && configured > 0 ? configured : 0;
        });
        const files = computed<File[]>(() => {
            const value = props.modelValue;
            if (!value) return [];
            if (Array.isArray(value)) return value.filter(Boolean) as File[];
            if (typeof FileList !== "undefined" && value instanceof FileList) return Array.from(value);
            return [value as File];
        });
        const error = computed(() => {
            const explicit = typeof props.errorMessages === "string" && props.errorMessages ? props.errorMessages : props.error;
            return visibleError({ ...props, ...attrs, error: explicit }, localError.value);
        });

        const validate = (next: any = props.modelValue) => {
            localError.value = props.rules || props.errorMessages
                ? runRules({ rules: props.rules, errorMessages: props.errorMessages }, next)
                : "";
        };

        const emitValue = (next: File[]) => {
            const value = multiple.value ? next : (next[0] ?? null);
            emit?.("update:modelValue", value);
            emit?.("update:files", next);
            validate(value);
        };

        const matchesAccept = (file: File): boolean => {
            const tokens = accept.value
                .split(",")
                .map((token: string) => token.trim().toLowerCase())
                .filter(Boolean);
            if (!tokens.length) return true;
            const name = file.name.toLowerCase();
            const type = (file.type || "").toLowerCase();
            return tokens.some((token: string) => {
                if (token.startsWith(".")) return name.endsWith(token);
                if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1));
                return type === token;
            });
        };

        const addFiles = (incoming: File[]) => {
            if (disabled.value) return [];
            const rejected: PgFileRejection[] = [];
            const accepted: File[] = [];
            const existing = files.value;
            const limit = maxFiles.value;

            for (const file of incoming) {
                if (!matchesAccept(file)) {
                    rejected.push({
                        file,
                        reason: "fileType",
                        message: `${file.name}: File type is not accepted`,
                    });
                    continue;
                }
                if (maxBytes.value > 0 && file.size > maxBytes.value) {
                    rejected.push({
                        file,
                        reason: "maxSize",
                        message: `${file.name}: Exceeds ${formatSize(maxBytes.value)} limit`,
                    });
                    continue;
                }
                if (limit > 0 && (multiple.value ? existing.length + accepted.length : accepted.length) >= limit) {
                    rejected.push({
                        file,
                        reason: "maxFiles",
                        message: `${file.name}: Maximum ${limit} ${limit === 1 ? "file" : "files"} allowed`,
                    });
                    continue;
                }
                accepted.push(file);
            }

            if (accepted.length) {
                const next = multiple.value ? [...existing, ...accepted] : [accepted[accepted.length - 1]!];
                emitValue(next);
            }
            if (rejected.length) {
                localError.value = rejected[0]!.message;
                emit?.("reject", rejected);
            }
            return rejected;
        };

        const process = (list: FileList | File[] | null | undefined) => {
            const incoming = list ? Array.from(list as ArrayLike<File>) : [];
            if (!incoming.length) return;
            addFiles(incoming);
            if (inputEl.value) inputEl.value.value = "";
        };

        const openPicker = () => {
            if (disabled.value) return;
            inputEl.value?.click();
        };

        const removeAt = (event: MouseEvent, index: number) => {
            event.stopPropagation();
            const next = [...files.value];
            next.splice(index, 1);
            emitValue(next);
            if (inputEl.value) inputEl.value.value = "";
        };

        const { id } = usePgFormControl({
            id: props.id || undefined,
            validate: () => {
                const value = props.modelValue;
                const count = Array.isArray(value) ? value.length : value ? 1 : 0;
                let message = props.rules || props.errorMessages
                    ? runRules({ rules: props.rules, errorMessages: props.errorMessages }, value)
                    : "";
                if (!message && props.required && count === 0) message = t("This field is required");
                localError.value = message;
                return { valid: message.length === 0, message };
            },
            focus: () => inputEl.value?.focus(),
            resetValidation: () => {
                localError.value = "";
            },
            reset: () => {
                localError.value = "";
                if (inputEl.value) inputEl.value.value = "";
            },
        });

        const progressFor = (file: File, index: number): number | null => {
            const value = props.progress;
            if (typeof value === "number") return value;
            if (typeof value === "function") {
                const next = value(file, index);
                return typeof next === "number" ? next : null;
            }
            if (value && typeof value === "object") {
                const next = value[file.name] ?? value[index];
                return typeof next === "number" ? next : null;
            }
            return null;
        };

        const acceptHint = computed(() => {
            const labels = accept.value
                .split(",")
                .map((token: string) => token.trim())
                .filter(Boolean)
                .map((token: string) => {
                    if (token.startsWith(".")) return token.slice(1).toUpperCase();
                    const subtype = token.split("/")[1] ?? token;
                    return subtype.replace(/^x-/, "").toUpperCase();
                });
            const unique = Array.from(new Set(labels));
            const size = `${t("up to")} ${formatSize(maxBytes.value)}`;
            return unique.length ? `${unique.join(", ")} · ${size}` : size;
        });

        const dragEnter = (event: DragEvent) => {
            event.preventDefault();
            if (disabled.value) return;
            dragDepth += 1;
            dragging.value = true;
        };
        const dragOver = (event: DragEvent) => {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        };
        const dragLeave = (event: DragEvent) => {
            event.preventDefault();
            dragDepth = Math.max(0, dragDepth - 1);
            if (dragDepth === 0) dragging.value = false;
        };
        const drop = (event: DragEvent) => {
            event.preventDefault();
            dragDepth = 0;
            dragging.value = false;
            if (disabled.value) return;
            process(event.dataTransfer?.files ?? null);
        };

        return () => (
            <div
                {...attrs}
                class={["pg-file-upload", compact.value ? "pg-file-upload--compact" : "", attrs.class]
                    .filter(Boolean)
                    .join(" ")}
                data-pg-file-upload
            >
                <PgFieldShell
                    forId={id}
                    label={props.label}
                    hint={props.hint}
                    error={error.value}
                    required={Boolean(props.required)}
                    disabled={disabled.value}
                    hideDetails={Boolean(props.hideDetails)}
                >
                    <input
                        ref={inputEl}
                        id={id}
                        class="pg-file__native"
                        type="file"
                        name={props.name || undefined}
                        accept={accept.value || undefined}
                        multiple={multiple.value}
                        disabled={disabled.value}
                        required={Boolean(props.required)}
                        tabindex={-1}
                        onChange={(event: Event) => process((event.target as HTMLInputElement).files)}
                    />
                    <button
                        type="button"
                        class={[
                            "pg-dropzone",
                            dragging.value ? "pg-dropzone--drag" : "",
                            error.value ? "pg-dropzone--error" : "",
                            disabled.value ? "pg-dropzone--disabled" : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        disabled={disabled.value}
                        aria-disabled={disabled.value ? "true" : undefined}
                        aria-busy={props.loading ? "true" : undefined}
                        onClick={openPicker}
                        onDragenter={dragEnter}
                        onDragover={dragOver}
                        onDragleave={dragLeave}
                        onDrop={drop}
                    >
                        {slots.default ? (
                            slots.default()
                        ) : (
                            <>
                                <span class="pg-dropzone__icon" aria-hidden="true">
                                    {props.loading ? (
                                        <PgSpinner size={24} />
                                    ) : (
                                        <PgIcon icon={props.prependIcon || "mdi-file-upload-outline"} size={24} />
                                    )}
                                </span>
                                <span class="pg-dropzone__title">
                                    {props.loading ? t("Uploading…") : t("Click to upload or drag and drop")}
                                </span>
                                <span class="pg-dropzone__hint">{acceptHint.value}</span>
                                {slots.hint ? slots.hint() : null}
                            </>
                        )}
                    </button>
                    {files.value.length > 0 && (
                        <div class="pg-file-list">
                            {files.value.map((file, index) => {
                                const progress = progressFor(file, index);
                                return (
                                    <div class="pg-file-row" key={`${file.name}-${index}`}>
                                        <span class="pg-file-row__icon" aria-hidden="true">
                                            <PgIcon icon={fileIcon(file)} size={18} />
                                        </span>
                                        <span class="pg-file-row__body">
                                            <span class="pg-file-row__name" title={file.name}>
                                                {file.name}
                                            </span>
                                            <span class="pg-file-row__size pg-tabular">{formatSize(file.size)}</span>
                                            {progress !== null && (
                                                <PgProgressBar
                                                    class="pg-file-row__progress"
                                                    modelValue={Math.max(0, Math.min(100, progress))}
                                                    height={4}
                                                />
                                            )}
                                        </span>
                                        <button
                                            type="button"
                                            class="pg-file-row__remove"
                                            aria-label={`${t("Remove")} ${file.name}`}
                                            disabled={disabled.value}
                                            onClick={(event: MouseEvent) => removeAt(event, index)}
                                        >
                                            <PgIcon icon="mdi-close" size={16} />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </PgFieldShell>
            </div>
        );
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
            maxSizeMb: { type: Number, default: 10 },
            maxSize: { type: Number, default: undefined },
            maximumSizeInBytes: { type: Number, default: undefined },
            maxFiles: { type: Number, default: 0 },
            multiple: { type: Boolean, default: true },
            disabled: { type: Boolean, default: false },
            loading: { type: Boolean, default: false },
            required: { type: Boolean, default: false },
            hideDetails: { type: Boolean, default: false },
            density: { type: String, default: "" },
            prependIcon: { type: String, default: "" },
            progress: { type: [Number, Object, Function], default: undefined },
            rules: { type: Array as () => Array<(value: any) => any>, default: () => [] },
            name: { type: String, default: "" },
            id: { type: String, default: "" },
        },
        emits: ["update:modelValue", "update:files", "reject"],
        inheritAttrs: true,
    },
);

export const VFileInput = PgFileUpload;
