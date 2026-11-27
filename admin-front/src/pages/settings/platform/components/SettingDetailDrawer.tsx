import { defineComponent } from "@/utils/dc";
import { computed, ref, watch, type PropType, type VNodeChild } from "vue";
import {VAlert, PgButton, PgDivider, PgTextarea, PgTextField} from "@pg/ui";
import { useLocale } from "@/utils/vael-compat";
import {SlideOverDrawer} from "@pg/ui";
import {SegmentedTabs} from "@pg/ui";
import {StatusBadge} from "@pg/ui";
import {MetaPill} from "@pg/ui";
import {DescriptionList} from "@pg/ui";
import {FormField} from "@pg/ui";
import {FormChecklist} from "@pg/ui";
import {JsonDiffViewer} from "@pg/ui";
import { SettingValueView } from "@/components/builders/SettingValueView";
import { PlatformSettingTypedEditor } from "@/components/builders/PlatformSettingTypedEditor";
import { showSnackBar } from "@/utils/snackBar";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import {
    SETTING_SECTION_BY_ID,
    SETTING_STATUS_META,
    buildSettingValue,
    isSettingUnchanged,
    parseSettingForm,
    resolveSettingNamespace,
    settingTitle,
    validateSettingForm,
    type PlatformSettingRow,
    type SettingEntry,
    type SettingForm,
} from "@/components/builders/model";

const RISK_LABEL: Record<string, string> = {
    low: "Low risk",
    medium: "Medium risk",
    high: "High risk",
    critical: "Critical risk",
};

const SETTING_EDIT_CHECKS = [
    { key: "KEY_SCOPE_VERIFIED", label: "Key and scope verified" },
    { key: "VALUE_SCHEMA_REVIEWED", label: "Value schema reviewed" },
    { key: "EFFECTIVE_DATE_REVIEWED", label: "Effective date reviewed" },
    { key: "IMMUTABLE_VERSION_ACKNOWLEDGED", label: "Immutable-version impact acknowledged" },
] as const;

const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
};

const versionStatus = (row: PlatformSettingRow, entry: SettingEntry): "CURRENT" | "SCHEDULED" | "SUPERSEDED" => {
    if (entry.effective?.id === row.id) return "CURRENT";
    if (new Date(row.effectiveFrom).getTime() > Date.now()) return "SCHEDULED";
    return "SUPERSEDED";
};

export const SettingDetailDrawer = defineComponent({
    name: "SettingDetailDrawer",
    props: {
        modelValue: { type: Boolean, required: true },
        entry: { type: Object as PropType<SettingEntry | null>, default: null },
        canWrite: { type: Boolean, default: false },
        showChecklists: { type: Boolean, default: true },
    },
    emits: ["update:modelValue", "saved", "openKey"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const tab = ref<"overview" | "value" | "history">("overview");
        const form = ref<SettingForm>(parseSettingForm(null, {}));
        const editError = ref("");
        const checklist = ref<Record<string, boolean>>({});
        const reason = ref("");
        const saving = ref(false);
        const fieldQuery = ref("");
        const compareRow = ref<PlatformSettingRow | null>(null);

        const definition = computed(() => props.entry?.definition ?? null);
        const namespace = computed(() => (props.entry ? resolveSettingNamespace(props.entry.definition.namespaceId) : null));
        const status = computed(() => (props.entry ? SETTING_STATUS_META[props.entry.displayStatus] : SETTING_STATUS_META.UNREGISTERED));
        const title = computed(() => (props.entry ? t(settingTitle(props.entry)) : t("Setting")));
        const canEdit = computed(() => Boolean(props.entry && props.canWrite && !props.entry.readOnly && props.entry.definition.lifecycle !== "DEPRECATED"));
        const checklistComplete = computed(() => !props.showChecklists || SETTING_EDIT_CHECKS.every((check) => checklist.value[check.key] === true));
        const currentRow = computed(() => props.entry?.effective ?? props.entry?.latest ?? null);
        const isUnchanged = computed(() => {
            if (!props.entry?.configured) return false;
            return isSettingUnchanged(namespace.value, form.value, currentRow.value?.valueJson ?? {});
        });
        const warnings = computed<string[]>(() => {
            const entry = props.entry;
            if (!entry) return [];
            const list: string[] = [];
            if (entry.displayStatus === "DECISION") list.push(t("This is a recorded decision. The platform does not read it at runtime; changing it does not change behaviour."));
            if (entry.displayStatus === "FALLBACK") list.push(t("The platform reads the canonical key first. Editing this fallback has no effect while the canonical key exists."));
            if (entry.displayStatus === "DEPRECATED") list.push(t("This key is retired and read-only. It is kept for history."));
            if (entry.displayStatus === "MANAGED") list.push(t("This value is managed on Checkout Help. Use the link below to edit it."));
            if (entry.displayStatus === "SYSTEM") list.push(t("This key is system-managed. Editing it here is disabled."));
            if (entry.displayStatus === "UNREGISTERED") list.push(t("This key is not in the settings catalog. The screen cannot explain its effect until it is registered in the catalog and the developer documentation."));
            if (entry.displayStatus === "UNCONFIGURED") list.push(t("No value is stored yet. The platform is using the built-in default shown below; saving creates the first version."));
            if (entry.scheduled.length > 0) {
                const next = entry.scheduled[0]!;
                list.push(t("A version is scheduled for {date}. Saving a new version now creates a newer version that becomes effective immediately and supersedes the scheduled one.", { date: formatDateTime(next.effectiveFrom) }));
            }
            if (entry.definition.legacyNote) list.push(t(entry.definition.legacyNote));
            return list;
        });

        const reset = () => {
            const entry = props.entry;
            if (!entry) return;
            tab.value = "overview";
            form.value = parseSettingForm(namespace.value, entry.effective?.valueJson ?? entry.latest?.valueJson ?? entry.definition.defaults);
            editError.value = "";
            checklist.value = {};
            reason.value = "";
            fieldQuery.value = "";
            compareRow.value = null;
        };

        watch(
            () => [props.modelValue, props.entry?.key, props.entry?.latest?.id] as const,
            () => {
                if (props.modelValue) reset();
            },
            { immediate: true },
        );

        const save = async () => {
            const entry = props.entry;
            if (!entry || saving.value || !canEdit.value) return;
            const def = namespace.value;
            const key = entry.key.trim();
            if (!/^[A-Za-z0-9._:-]{2,120}$/.test(key)) {
                editError.value = t("Use 2-120 letters, digits, dots, colons, underscores or hyphens.");
                return;
            }
            if (validateSettingForm(def, form.value).length > 0) {
                editError.value = t("Fix the highlighted fields before saving.");
                return;
            }
            const parsed = buildSettingValue(def, form.value);
            if (entry.configured && isSettingUnchanged(def, form.value, currentRow.value?.valueJson ?? {})) {
                editError.value = t("Nothing changed: the value is identical to the current version.");
                return;
            }
            if (!entry.configured && Object.keys(parsed).length === 0) {
                editError.value = t("Enter at least one value.");
                return;
            }
            if (reason.value.trim().length < 3) {
                editError.value = t("Enter a change note of at least 3 characters.");
                return;
            }
            if (!checklistComplete.value) {
                editError.value = t("Complete all setting checklist items before saving.");
                return;
            }
            saving.value = true;
            editError.value = "";
            try {
                await api.put(urlsMap.settings, {
                    settings: { [key]: parsed },
                    checklist: SETTING_EDIT_CHECKS.filter((check) => checklist.value[check.key]).map((check) => check.key),
                    reason: reason.value.trim(),
                });
                showSnackBar({ type: "success", message: t("A new setting version was saved") });
                emit("saved");
                emit("update:modelValue", false);
            } catch (error) {
                editError.value = extractApiErrorMessage(error);
            } finally {
                saving.value = false;
            }
        };

        const copyKey = async () => {
            if (!props.entry) return;
            try {
                await navigator.clipboard.writeText(props.entry.key);
                showSnackBar({ type: "success", message: t("Setting key copied") });
            } catch {
                showSnackBar({ type: "error", message: t("Could not copy to the clipboard") });
            }
        };

        const loadVersion = (row: PlatformSettingRow) => {
            form.value = parseSettingForm(namespace.value, row.valueJson ?? {});
            tab.value = "value";
            editError.value = "";
        };

        const resetToDefault = () => {
            if (!props.entry) return;
            form.value = parseSettingForm(namespace.value, props.entry.definition.defaults);
            editError.value = "";
        };

        const overviewItems = computed(() => {
            const entry = props.entry;
            if (!entry) return [];
            const section = SETTING_SECTION_BY_ID[entry.definition.section];
            const items = [
                { label: t("Status"), value: t(status.value.label) },
                { label: t("Section"), value: t(section.title) },
                { label: t("Risk"), value: t(RISK_LABEL[entry.definition.risk] ?? entry.definition.risk) },
                { label: t("Read by"), value: t(entry.definition.readBy) },
                { label: t("Takes effect"), value: t(entry.definition.effect) },
                { label: t("Scope"), value: entry.scope },
                { label: t("Current version"), value: entry.effective ? `v${entry.effective.version}` : entry.configured ? t("No effective version yet") : t("Not configured") },
                { label: t("Effective"), value: entry.effective ? formatDateTime(entry.effective.effectiveFrom) : "—" },
                { label: t("Updated"), value: entry.latest ? formatDateTime(entry.latest.updatedAt) : "—" },
            ];
            if (entry.scheduled.length > 0) items.push({ label: t("Scheduled"), value: formatDateTime(entry.scheduled[0]?.effectiveFrom) });
            return items;
        });

        const relatedKeys = computed(() => props.entry?.definition.relatedKeys ?? []);

        const currentValue = computed(() => currentRow.value?.valueJson ?? (props.entry?.configured ? {} : props.entry?.definition.defaults ?? {}));

        return (): VNodeChild => {
            const entry = props.entry;
            return (
                <SlideOverDrawer
                    modelValue={props.modelValue && Boolean(entry)}
                    onUpdate:modelValue={(value: boolean) => emit("update:modelValue", value)}
                    title={entry ? title.value : t("Setting")}
                    subtitle={entry?.key ?? ""}
                    width={780}
                    v-slots={{
                        default: () => entry ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "16px", minInlineSize: 0 }}>
                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                            <StatusBadge status={entry.displayStatus} label={t(status.value.label)} toneOverride={status.value.tone} showDot={false} />
                            <MetaPill size="small" variant="tonal" color="primary">{t(SETTING_SECTION_BY_ID[entry.definition.section].title)}</MetaPill>
                            <MetaPill size="small" variant="text">{t(RISK_LABEL[entry.definition.risk] ?? entry.definition.risk)}</MetaPill>
                            {entry.latest && <MetaPill size="small" variant="tonal">v{entry.effective?.version ?? entry.latest.version}</MetaPill>}
                            {entry.scheduled.length > 0 && <MetaPill size="small" variant="tonal" color="info">{t("Scheduled")}</MetaPill>}
                            <div style={{ flex: 1 }} />
                            <PgButton size="small" variant="text" prependIcon="mdi-content-copy" onClick={() => void copyKey()}>{t("Copy key")}</PgButton>
                        </div>

                        <div style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)", lineHeight: 1.5 }}>{t(status.value.description)}</div>

                        {warnings.value.map((warning) => (
                            <VAlert key={warning} type={entry.displayStatus === "DECISION" || entry.displayStatus === "FALLBACK" ? "warning" : entry.displayStatus === "UNREGISTERED" || entry.displayStatus === "DEPRECATED" ? "error" : "info"} variant="tonal" density="compact">
                                {warning}
                            </VAlert>
                        ))}

                        <SegmentedTabs
                            modelValue={tab.value}
                            onUpdate:modelValue={(value: string) => (tab.value = value === "value" || value === "history" ? value : "overview")}
                            tabs={[
                                { value: "overview", label: t("Overview") },
                                { value: "value", label: t("Value") },
                                { value: "history", label: t("History") },
                            ]}
                            ariaLabel={t("Setting details")}
                        />

                        {tab.value === "overview" && (
                            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                                <p style={{ fontSize: "13px", color: "var(--pg-ink-secondary)", lineHeight: 1.6, margin: 0 }}>{t(entry.definition.description)}</p>
                                <div style={{ padding: "10px 12px", borderRadius: "var(--pg-radius-sm)", backgroundColor: "var(--pg-bg-surface-subtle)", border: "1px solid var(--pg-border-subtle)", fontSize: "12.5px", lineHeight: 1.5 }}>
                                    <strong>{t("Risk")}:</strong> {t(entry.definition.riskReason)}
                                </div>
                                <DescriptionList columns={2} items={overviewItems.value} />
                                {relatedKeys.value.length > 0 && (
                                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                                        <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>{t("Related settings")}:</span>
                                        {relatedKeys.value.map((key) => (
                                            <PgButton key={key} size="x-small" variant="tonal" onClick={() => emit("openKey", key)}>{key}</PgButton>
                                        ))}
                                    </div>
                                )}
                                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                    {entry.definition.managePath && (
                                        <PgButton size="small" variant="tonal" prependIcon="mdi-open-in-new" to={entry.definition.managePath}>{t("Open the owning screen")}</PgButton>
                                    )}
                                    {entry.definition.guideArticleId && (
                                        <PgButton size="small" variant="tonal" prependIcon="mdi-book-open-page-variant-outline" to={{ name: "AdminGuideArticle", params: { articleId: entry.definition.guideArticleId } }}>{t("Read the guide")}</PgButton>
                                    )}
                                    {entry.definition.unregistered && (
                                        <span style={{ fontSize: "11.5px", color: "var(--pg-ink-muted)", lineHeight: 1.5 }}>
                                            {t("Register it in admin-front/src/components/builders/model/settingsCatalog.ts and docs/developer/platform-settings.md.")}
                                        </span>
                                    )}
                                </div>
                            </div>
                        )}

                        {tab.value === "value" && (
                            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                {!entry.readOnly && namespace.value && namespace.value.fields.length > 8 && (
                                    <PgTextField
                                        modelValue={fieldQuery.value}
                                        onUpdate:modelValue={(value: string) => (fieldQuery.value = value)}
                                        prependInnerIcon="mdi-filter-outline"
                                        label={t("Filter fields")}
                                        density="compact"
                                        hideDetails
                                        clearable
                                    />
                                )}
                                {!entry.readOnly && (
                                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                                        <PgButton size="x-small" variant="text" onClick={resetToDefault}>{t("Reset form to default")}</PgButton>
                                    </div>
                                )}
                                {entry.readOnly ? (
                                    <SettingValueView settingKey={entry.key} value={currentValue.value} maxRows={0} compact={false} />
                                ) : (
                                    <PlatformSettingTypedEditor
                                        def={namespace.value}
                                        modelValue={form.value}
                                        onUpdate:modelValue={(value: SettingForm) => (form.value = value)}
                                        query={fieldQuery.value}
                                        readOnly={!canEdit.value}
                                    />
                                )}
                            </div>
                        )}

                        {tab.value === "history" && (
                            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                {entry.rows.length === 0 && <span style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)" }}>{t("No versions yet. Saving creates the first version.")}</span>}
                                {entry.rows.map((row) => {
                                    const state = versionStatus(row, entry);
                                    return (
                                        <div key={row.id} style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "10px 12px", borderRadius: "var(--pg-radius-sm)", border: "1px solid var(--pg-border-subtle)" }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                                <MetaPill size="x-small" variant="tonal" color="primary">v{row.version}</MetaPill>
                                                <StatusBadge status={state} toneOverride={state === "CURRENT" ? "success" : state === "SCHEDULED" ? "info" : "neutral"} showDot={false} />
                                                <div style={{ flex: 1 }} />
                                                {state !== "CURRENT" && <PgButton size="x-small" variant="text" onClick={() => (compareRow.value = row)}>{t("Compare with current")}</PgButton>}
                                                <PgButton size="x-small" variant="text" onClick={() => loadVersion(row)}>{t("Load into editor")}</PgButton>
                                            </div>
                                            <DescriptionList
                                                columns={2}
                                                items={[
                                                    { label: t("Effective"), value: formatDateTime(row.effectiveFrom) },
                                                    { label: t("Updated"), value: formatDateTime(row.updatedAt) },
                                                ]}
                                            />
                                        </div>
                                    );
                                })}
                                {compareRow.value && (
                                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "10px 12px", borderRadius: "var(--pg-radius-sm)", border: "1px solid var(--pg-border-subtle)", backgroundColor: "var(--pg-bg-surface-subtle)" }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                            <span style={{ fontSize: "12.5px", fontWeight: 600, flex: 1 }}>{t("Comparing")} v{compareRow.value.version} → v{entry.effective?.version ?? entry.latest?.version ?? "—"}</span>
                                            <PgButton size="x-small" variant="text" onClick={() => (compareRow.value = null)}>{t("Clear comparison")}</PgButton>
                                        </div>
                                        <JsonDiffViewer diff={{ before: compareRow.value.valueJson ?? {}, after: currentValue.value }} />
                                    </div>
                                )}
                            </div>
                        )}

                        {canEdit.value && (
                            <>
                                <PgDivider />
                                <FormField label={t("Change note")} hint={t("Required. Recorded in the audit log with this version.")} required>
                                    <PgTextarea
                                        modelValue={reason.value}
                                        onUpdate:modelValue={(value: string) => (reason.value = value)}
                                        rows={2}
                                        autoGrow
                                        density="compact"
                                        hideDetails
                                    />
                                </FormField>
                                <FormChecklist
                                    checks={[...SETTING_EDIT_CHECKS]}
                                    modelValue={checklist.value}
                                    onUpdate:modelValue={(value: Record<string, boolean>) => (checklist.value = value)}
                                    show={props.showChecklists}
                                    title={t("Setting checklist")}
                                    complete={checklistComplete.value}
                                    incompleteMessage={t("Complete all setting checklist items before saving.")}
                                />
                                {editError.value && <VAlert type="error" variant="tonal" density="compact">{editError.value}</VAlert>}
                                {isUnchanged.value && <span style={{ fontSize: "11.5px", color: "var(--pg-ink-muted)" }}>{t("Nothing changed: the value is identical to the current version.")}</span>}
                            </>
                        )}
                    </div>
                        ) : null,
                        footer: () => entry ? (
                            <>
                                {entry.definition.managePath && (
                                    <PgButton variant="tonal" to={entry.definition.managePath}>{t("Open the owning screen")}</PgButton>
                                )}
                                <div style={{ flex: 1 }} />
                                <PgButton variant="outlined" onClick={() => emit("update:modelValue", false)}>{canEdit.value ? t("Cancel") : t("Close")}</PgButton>
                                {canEdit.value && (
                                    <PgButton
                                        color="primary"
                                        variant="flat"
                                        loading={saving.value}
                                        disabled={!checklistComplete.value || isUnchanged.value || saving.value}
                                        onClick={() => void save()}
                                    >
                                        {t("Save new version")}
                                    </PgButton>
                                )}
                            </>
                        ) : null,
                    }}
                />
            );
        };
    },
});

export default SettingDetailDrawer;
