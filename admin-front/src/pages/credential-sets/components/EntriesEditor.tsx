import { defineComponent, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VSelect, VSwitch, VTextField } from "vuetify/components";
import {
    ENTRY_TYPES,
    MAX_ENTRIES,
    MAX_KEY_LENGTH,
    MAX_VALUE_LENGTH,
    newEntry,
    type EntryDraft,
    type EntryError,
    type EntryValidation,
} from "../model";

const ERROR_TEXT: Record<EntryError, string> = {
    KEY_REQUIRED: "A key is required",
    KEY_TOO_LONG: "The key is too long",
    KEY_DUPLICATE: "This key is already used with the same type",
    VALUE_REQUIRED: "Enter the value again; stored values are never shown",
    VALUE_TOO_LONG: "The value is too long",
};

/**
 * Editable key / type / value rows of a credential set. Secret values render as password inputs
 * and are never pre-filled: the vault is write-only, so a rotation re-enters every value.
 */
export const EntriesEditor = defineComponent({
    name: "CredentialEntriesEditor",
    props: {
        modelValue: { type: Array as PropType<EntryDraft[]>, required: true },
        validation: { type: Object as PropType<EntryValidation | null>, default: null },
        showErrors: { type: Boolean, default: false },
        /** Rotation keeps the key list stable-ish but still allows adding and removing rows. */
        disabled: { type: Boolean, default: false },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { t } = useLocale();

        const update = (uid: number, patch: Partial<EntryDraft>) =>
            emit(
                "update:modelValue",
                props.modelValue.map((entry) => (entry.uid === uid ? { ...entry, ...patch } : entry)),
            );
        const remove = (uid: number) =>
            emit(
                "update:modelValue",
                props.modelValue.filter((entry) => entry.uid !== uid),
            );
        const add = () => emit("update:modelValue", [...props.modelValue, newEntry()]);

        return (): VNodeChild => (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {props.modelValue.map((entry) => {
                    const error = props.showErrors ? props.validation?.errors[entry.uid] : undefined;
                    return (
                        <div
                            key={entry.uid}
                            style={{
                                display: "grid",
                                gridTemplateColumns: "minmax(120px, 1fr) 128px minmax(140px, 1.4fr) auto auto",
                                gap: "8px",
                                alignItems: "start",
                                padding: "10px",
                                border: "1px solid var(--pg-border-subtle)",
                                borderRadius: "var(--pg-radius-sm)",
                                backgroundColor: "var(--pg-bg-surface-subtle)",
                            }}
                        >
                            <VTextField
                                label={t("Key")}
                                density="compact"
                                variant="outlined"
                                hideDetails={!error}
                                disabled={props.disabled}
                                modelValue={entry.key}
                                onUpdate:modelValue={(value: string) => update(entry.uid, { key: value })}
                                errorMessages={error === "KEY_REQUIRED" || error === "KEY_TOO_LONG" || error === "KEY_DUPLICATE" ? [t(ERROR_TEXT[error])] : []}
                                {...{ maxlength: MAX_KEY_LENGTH, autocomplete: "off" }}
                            />
                            <VSelect
                                label={t("Type")}
                                density="compact"
                                variant="outlined"
                                hideDetails
                                disabled={props.disabled}
                                items={[...ENTRY_TYPES]}
                                modelValue={entry.type}
                                onUpdate:modelValue={(value: string) => update(entry.uid, { type: value as EntryDraft["type"] })}
                            />
                            <VTextField
                                label={entry.isSecret ? t("Secret value") : t("Value")}
                                density="compact"
                                variant="outlined"
                                hideDetails={!error}
                                disabled={props.disabled}
                                type={entry.isSecret ? "password" : "text"}
                                modelValue={entry.value}
                                onUpdate:modelValue={(value: string) => update(entry.uid, { value })}
                                errorMessages={error === "VALUE_REQUIRED" || error === "VALUE_TOO_LONG" ? [t(ERROR_TEXT[error])] : []}
                                {...{ maxlength: MAX_VALUE_LENGTH, autocomplete: "new-password" }}
                            />
                            <VSwitch
                                label={t("Secret")}
                                density="compact"
                                hideDetails
                                color="primary"
                                disabled={props.disabled}
                                modelValue={entry.isSecret}
                                onUpdate:modelValue={(value: unknown) => update(entry.uid, { isSecret: value === true })}
                            />
                            <VBtn
                                icon="mdi-delete-outline"
                                variant="text"
                                size="small"
                                color="error"
                                disabled={props.disabled}
                                aria-label={t("Remove entry")}
                                onClick={() => remove(entry.uid)}
                            />
                        </div>
                    );
                })}
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                    <VBtn
                        variant="tonal"
                        size="small"
                        prependIcon="mdi-plus"
                        disabled={props.disabled || props.modelValue.length >= MAX_ENTRIES}
                        onClick={add}
                    >
                        {t("Add entry")}
                    </VBtn>
                    {props.showErrors && props.validation?.empty && (
                        <span role="alert" style={{ fontSize: "12px", color: "var(--pg-status-danger-text)" }}>
                            {t("Add at least one entry")}
                        </span>
                    )}
                    {props.validation?.tooMany && (
                        <span role="alert" style={{ fontSize: "12px", color: "var(--pg-status-danger-text)" }}>
                            {t("Too many entries")}
                        </span>
                    )}
                </div>
            </div>
        );
    },
});

export default EntriesEditor;
