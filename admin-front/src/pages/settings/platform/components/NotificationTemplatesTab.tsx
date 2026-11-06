import { computed, defineComponent, ref, type VNodeChild } from "vue";
import { VAlert, VBtn, VSelect, VSwitch, VTextField, VTextarea } from "vuetify/components";
import { useLocale } from "vuetify";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { hasOneOfAuthorities } from "@/state/user";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { StateView } from "@/components/StateView";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MetaPill } from "@/components/ui/MetaPill";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import {
    detailList,
    groupTemplatesByCode,
    insertPlaceholder,
    placeholderText,
    previewTemplate,
    readApiErrorInfo,
    uniqueTemplateVariables,
    unknownTemplateVariables,
} from "@/components/builders/model";

type TemplateRow = {
    id: string;
    code: string;
    channel: string;
    lang: string;
    subjectTemplate: string | null;
    bodyTemplate: string;
    confidentialityClass: string;
    version: number;
    active: boolean;
    variables: string[];
    updatedAt: string;
};

const CLASS_TONE = { PUBLIC: "success", MERCHANT: "info", INTERNAL: "warning" } as const;
const CLASS_LABEL: Record<string, string> = { PUBLIC: "Public", MERCHANT: "Merchant", INTERNAL: "Internal" };
const CHANNEL_LABEL: Record<string, string> = { SMS: "SMS", EMAIL: "Email", IN_APP: "In-app" };
const LANG_LABEL: Record<string, string> = { AR: "Arabic", EN: "English" };

const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
};

/** The "Notification templates" tab of platform settings: latest versions, edit creates a new version. */
export const NotificationTemplatesTab = defineComponent({
    name: "NotificationTemplatesTab",
    setup() {
        const { t } = useLocale();
        const canWrite = computed(() => hasOneOfAuthorities(["settings:write", "settings.write"]));
        const templates = ref<TemplateRow[]>([]);
        const loading = ref(true);
        const loadError = ref<string | null>(null);
        const search = ref("");
        const channelFilter = ref<string | null>(null);
        const langFilter = ref<string | null>(null);
        const includeHistory = ref(false);

        const editing = ref<TemplateRow | null>(null);
        const subject = ref("");
        const body = ref("");
        const confidentiality = ref("INTERNAL");
        const allowed = ref<string[]>([]);
        const saving = ref(false);
        const saveError = ref("");
        const unknownFromServer = ref<{ unknown: string[]; allowed: string[] } | null>(null);
        const showPreview = ref(false);
        const bodyField = ref<{ $el?: HTMLElement } | null>(null);

        const load = async () => {
            loading.value = true;
            loadError.value = null;
            try {
                const response = await api.get(urlsMap.notificationTemplatesList, {
                    params: {
                        pageSize: 200,
                        ...(search.value.trim() ? { search: search.value.trim() } : {}),
                        ...(channelFilter.value ? { channel: channelFilter.value } : {}),
                        ...(langFilter.value ? { lang: langFilter.value } : {}),
                        ...(includeHistory.value ? { history: true } : {}),
                    },
                });
                const payload = response.data?.data ?? response.data ?? {};
                templates.value = (payload.templates ?? []) as TemplateRow[];
            } catch (error) {
                loadError.value = extractApiErrorMessage(error);
            } finally {
                loading.value = false;
            }
        };
        void load();

        const groups = computed(() =>
            groupTemplatesByCode(templates.value).map((group) => ({
                code: group.code,
                rows: [...group.rows].sort((left, right) => `${left.channel}:${left.lang}`.localeCompare(`${right.channel}:${right.lang}`) || right.version - left.version),
            })),
        );

        const openEdit = async (row: TemplateRow) => {
            editing.value = row;
            subject.value = row.subjectTemplate ?? "";
            body.value = row.bodyTemplate;
            confidentiality.value = row.confidentialityClass;
            saveError.value = "";
            unknownFromServer.value = null;
            showPreview.value = false;
            // The server accepts every placeholder any version / language / channel of this code already uses.
            const known = new Set<string>(templates.value.filter((entry) => entry.code === row.code).flatMap((entry) => entry.variables));
            allowed.value = [...known].sort();
            try {
                const response = await api.get(urlsMap.notificationTemplatesList, { params: { history: true, code: row.code, pageSize: 200 } });
                const payload = response.data?.data ?? response.data ?? {};
                for (const entry of (payload.templates ?? []) as TemplateRow[]) if (entry.code === row.code) for (const name of entry.variables ?? []) known.add(name);
                allowed.value = [...known].sort();
            } catch {
                // The variables of the visible rows are still a valid (smaller) allowed set.
            }
        };

        const closeEdit = () => {
            editing.value = null;
        };

        const insertVariable = (name: string) => {
            const element = bodyField.value?.$el?.querySelector?.("textarea") as HTMLTextAreaElement | null | undefined;
            const result = insertPlaceholder(body.value, name, element?.selectionStart ?? null, element?.selectionEnd ?? null);
            body.value = result.value;
            requestAnimationFrame(() => {
                element?.focus();
                element?.setSelectionRange(result.caret, result.caret);
            });
        };

        const unknownNow = computed(() => unknownTemplateVariables([subject.value, body.value], allowed.value));
        const usedNow = computed(() => uniqueTemplateVariables(subject.value, body.value));
        const unchanged = computed(() => {
            const row = editing.value;
            if (!row) return true;
            return subject.value === (row.subjectTemplate ?? "") && body.value === row.bodyTemplate && confidentiality.value === row.confidentialityClass;
        });

        const save = async () => {
            const row = editing.value;
            if (!row || saving.value) return;
            saveError.value = "";
            unknownFromServer.value = null;
            if (body.value.trim() === "") {
                saveError.value = t("The message body is required.");
                return;
            }
            if (unknownNow.value.length > 0) {
                saveError.value = t("Remove the unknown placeholders before saving.");
                return;
            }
            if (unchanged.value) {
                saveError.value = t("The template is identical to the active version. Change something to create a new version.");
                return;
            }
            saving.value = true;
            try {
                await api.put(urlsMap.notificationTemplateDetail(row.id), {
                    ...(subject.value !== (row.subjectTemplate ?? "") ? { subjectTemplate: subject.value } : {}),
                    bodyTemplate: body.value,
                    ...(confidentiality.value !== row.confidentialityClass ? { confidentialityClass: confidentiality.value } : {}),
                });
                showSnackBar({ type: "success", message: t("A new template version was saved") });
                closeEdit();
                await load();
            } catch (error) {
                const info = readApiErrorInfo(error);
                if (info.code === "TEMPLATE_UNKNOWN_PLACEHOLDERS") {
                    unknownFromServer.value = { unknown: detailList(info.details, "unknown"), allowed: detailList(info.details, "allowed") };
                    if (unknownFromServer.value.allowed.length > 0) allowed.value = unknownFromServer.value.allowed;
                    saveError.value = t("The template uses placeholders that are not known for this template code.");
                } else if (info.code === "TEMPLATE_UNCHANGED") {
                    saveError.value = t("The template is identical to the active version. Change something to create a new version.");
                } else if (info.code === "TEMPLATE_VERSION_CONFLICT") {
                    saveError.value = t("The template was edited by someone else at the same time. Reload and try again.");
                    void load();
                } else if (info.code === "TEMPLATE_VERSION_NOT_ACTIVE") {
                    saveError.value = t("This version is no longer the active one. Reload and edit the latest version.");
                    void load();
                } else if (info.code === "TIPPING_OFF_TEMPLATE_REJECTED") {
                    saveError.value = t("This confidentiality class may not reference anti-money-laundering variables.");
                } else {
                    saveError.value = extractApiErrorMessage(error);
                }
            } finally {
                saving.value = false;
            }
        };

        const chip = (text: string, tone: "normal" | "danger" = "normal", onClick?: () => void): VNodeChild => {
            const danger = tone === "danger";
            return (
                <button
                    type="button"
                    key={`${text}-${tone}`}
                    disabled={!onClick}
                    onClick={onClick}
                    aria-label={onClick ? `${t("Insert placeholder")} ${text}` : undefined}
                    style={{
                        padding: "1px 8px",
                        blockSize: "22px",
                        borderRadius: "var(--pg-radius-xs)",
                        border: `1px solid ${danger ? "var(--pg-status-danger-border)" : "var(--pg-border-subtle)"}`,
                        backgroundColor: danger ? "var(--pg-status-danger-bg)" : "var(--pg-bg-surface-subtle)",
                        color: danger ? "var(--pg-status-danger-text)" : "var(--pg-ink-secondary)",
                        fontSize: "11.5px",
                        fontFamily: "ui-monospace, monospace",
                        cursor: onClick ? "pointer" : "default",
                    }}
                >
                    {text}
                </button>
            );
        };

        const sampleValues = computed(() => Object.fromEntries(usedNow.value.map((name) => [name, `‹${name}›`])));

        return (): VNodeChild => (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                <VAlert type="info" variant="tonal">
                    {t("Editing a template never changes it in place: saving creates a new version and retires the previous one. Only placeholders already used by the same template code are accepted.")}
                </VAlert>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "flex-end" }}>
                    <div style={{ flex: "1 1 220px" }}>
                        <FormField label={t("Search templates")}>
                            <VTextField
                                modelValue={search.value}
                                onUpdate:modelValue={(value: string) => (search.value = value)}
                                onKeydown={(event: KeyboardEvent) => {
                                    if (event.key === "Enter") void load();
                                }}
                                prependInnerIcon="mdi-magnify"
                                clearable
                                density="compact"
                                hideDetails
                            />
                        </FormField>
                    </div>
                    <div style={{ flex: "0 0 150px" }}>
                        <FormField label={t("Channel")}>
                            <VSelect
                                modelValue={channelFilter.value}
                                onUpdate:modelValue={(value: string | null) => {
                                    channelFilter.value = value;
                                    void load();
                                }}
                                items={Object.keys(CHANNEL_LABEL).map((value) => ({ title: t(CHANNEL_LABEL[value]!), value }))}
                                clearable
                                density="compact"
                                hideDetails
                            />
                        </FormField>
                    </div>
                    <div style={{ flex: "0 0 150px" }}>
                        <FormField label={t("Language")}>
                            <VSelect
                                modelValue={langFilter.value}
                                onUpdate:modelValue={(value: string | null) => {
                                    langFilter.value = value;
                                    void load();
                                }}
                                items={Object.keys(LANG_LABEL).map((value) => ({ title: t(LANG_LABEL[value]!), value }))}
                                clearable
                                density="compact"
                                hideDetails
                            />
                        </FormField>
                    </div>
                    <VSwitch
                        modelValue={includeHistory.value}
                        onUpdate:modelValue={(value: boolean | null) => {
                            includeHistory.value = value === true;
                            void load();
                        }}
                        label={t("Include previous versions")}
                        color="primary"
                        density="compact"
                        hideDetails
                    />
                    <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>{t("Refresh")}</VBtn>
                </div>

                {loadError.value ? (
                    <StateView error={loadError.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : groups.value.length === 0 ? (
                    <SurfaceCard>
                        <SurfaceCardText>
                            <StateView empty={true} emptyTitle={t("No notification templates found")} emptyDescription={t("Adjust the filters to see more templates.")} minHeight="160px" />
                        </SurfaceCardText>
                    </SurfaceCard>
                ) : (
                    groups.value.map((group) => (
                        <SurfaceCard key={group.code}>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <strong dir="ltr" style={{ fontSize: "14px", fontFamily: "ui-monospace, monospace" }}>{group.code}</strong>
                                {group.rows.map((row) => (
                                    <div
                                        key={row.id}
                                        style={{
                                            display: "flex",
                                            flexDirection: "column",
                                            gap: "8px",
                                            padding: "10px 12px",
                                            borderRadius: "var(--pg-radius-sm)",
                                            border: "1px solid var(--pg-border-subtle)",
                                            opacity: row.active ? 1 : 0.7,
                                        }}
                                    >
                                        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
                                            <MetaPill size="x-small" variant="tonal" color="primary">{t(CHANNEL_LABEL[row.channel] ?? row.channel)}</MetaPill>
                                            <MetaPill size="x-small" variant="tonal">{t(LANG_LABEL[row.lang] ?? row.lang)}</MetaPill>
                                            <MetaPill size="x-small" variant="tonal">v{row.version}</MetaPill>
                                            <StatusBadge
                                                status={row.confidentialityClass}
                                                label={t(CLASS_LABEL[row.confidentialityClass] ?? row.confidentialityClass)}
                                                toneOverride={CLASS_TONE[row.confidentialityClass as keyof typeof CLASS_TONE] ?? "neutral"}
                                                showDot={false}
                                            />
                                            {!row.active && <StatusBadge status="SUPERSEDED" label={t("Superseded")} toneOverride="neutral" showDot={false} />}
                                            <div style={{ flex: 1 }} />
                                            <span style={{ fontSize: "11px", color: "var(--pg-ink-faint)" }}>{t("Updated")}: {formatDateTime(row.updatedAt)}</span>
                                            {canWrite.value && row.active && (
                                                <VBtn size="small" variant="tonal" prependIcon="mdi-pencil-outline" onClick={() => void openEdit(row)}>
                                                    {t("Edit")}
                                                </VBtn>
                                            )}
                                        </div>
                                        {row.subjectTemplate && (
                                            <div style={{ fontSize: "12.5px" }}>
                                                <span style={{ color: "var(--pg-ink-muted)" }}>{t("Subject")}: </span>
                                                <span dir="auto">{row.subjectTemplate}</span>
                                            </div>
                                        )}
                                        <div dir="auto" style={{ fontSize: "12.5px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--pg-ink-secondary)" }}>
                                            {row.bodyTemplate}
                                        </div>
                                        {row.variables.length > 0 && (
                                            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" }}>
                                                <span style={{ fontSize: "11.5px", color: "var(--pg-ink-muted)" }}>{t("Variables")}:</span>
                                                {row.variables.map((name) => chip(placeholderText(name)))}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </SurfaceCardText>
                        </SurfaceCard>
                    ))
                )}

                <FormModal
                    modelValue={editing.value !== null}
                    onUpdate:modelValue={(value: boolean) => {
                        if (!value) closeEdit();
                    }}
                    title={editing.value ? `${t("Edit template")} · ${editing.value.code}` : t("Edit template")}
                    subtitle={editing.value ? `${t(CHANNEL_LABEL[editing.value.channel] ?? editing.value.channel)} · ${t(LANG_LABEL[editing.value.lang] ?? editing.value.lang)} · v${editing.value.version} → v${editing.value.version + 1}` : ""}
                    size="lg"
                    onSubmit={() => void save()}
                    submitLabel={t("Save new version")}
                    loading={saving.value}
                    errorMessage={saveError.value}
                >
                    {unknownFromServer.value && (
                        <VAlert type="error" variant="tonal" density="compact">
                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <span>{t("Unknown placeholders")}:</span>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>{unknownFromServer.value.unknown.map((name) => chip(placeholderText(name), "danger"))}</div>
                                <span>{t("Allowed placeholders")}:</span>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>{unknownFromServer.value.allowed.map((name) => chip(placeholderText(name)))}</div>
                            </div>
                        </VAlert>
                    )}
                    {editing.value && editing.value.channel === "EMAIL" && (
                        <FormField label={t("Subject")}>
                            <VTextField modelValue={subject.value} onUpdate:modelValue={(value: string) => (subject.value = value)} />
                        </FormField>
                    )}
                    {editing.value && editing.value.channel !== "EMAIL" && editing.value.subjectTemplate !== null && (
                        <FormField label={t("Subject")}>
                            <VTextField modelValue={subject.value} onUpdate:modelValue={(value: string) => (subject.value = value)} />
                        </FormField>
                    )}
                    <FormField label={t("Message body")} required>
                        <VTextarea ref={bodyField as never} modelValue={body.value} onUpdate:modelValue={(value: string) => (body.value = value)} rows={6} autoGrow />
                    </FormField>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        <span style={{ fontSize: "13px", fontWeight: 500 }}>{t("Insert variable")}</span>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                            {allowed.value.length === 0 && <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>{t("This template code uses no variables.")}</span>}
                            {allowed.value.map((name) => chip(placeholderText(name), "normal", () => insertVariable(name)))}
                        </div>
                        {unknownNow.value.length > 0 && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" }}>
                                <span role="alert" style={{ fontSize: "12px", color: "var(--pg-status-danger-text)" }}>{t("Unknown placeholders")}:</span>
                                {unknownNow.value.map((name) => chip(placeholderText(name), "danger"))}
                            </div>
                        )}
                    </div>
                    <FormField label={t("Confidentiality class")} hint={t("Internal and merchant classes may not reference anti-money-laundering variables.")}>
                        <VSelect
                            modelValue={confidentiality.value}
                            onUpdate:modelValue={(value: string) => (confidentiality.value = value)}
                            items={Object.keys(CLASS_LABEL).map((value) => ({ title: t(CLASS_LABEL[value]!), value }))}
                        />
                    </FormField>
                    <VSwitch modelValue={showPreview.value} onUpdate:modelValue={(value: boolean | null) => (showPreview.value = value === true)} label={t("Preview with sample values")} color="primary" density="compact" hideDetails />
                    {showPreview.value && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "10px 12px", borderRadius: "var(--pg-radius-sm)", backgroundColor: "var(--pg-bg-surface-subtle)", border: "1px solid var(--pg-border-subtle)" }}>
                            {subject.value && <strong dir="auto" style={{ fontSize: "13px" }}>{previewTemplate(subject.value, sampleValues.value)}</strong>}
                            <div dir="auto" style={{ fontSize: "12.5px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{previewTemplate(body.value, sampleValues.value)}</div>
                        </div>
                    )}
                </FormModal>
            </div>
        );
    },
});
