import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute } from "vue-router";
import { VAlert, VBtn, VFileInput, VSelect, VTextarea, VTextField } from "vuetify/components";
import { fileToBase64 } from "@/utils/FileToB64";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { MonoRef } from "@/components/ui/MonoRef";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { showConfirm } from "@/utils/confirm";

type Schema = {
    id: string;
    authority: string;
    reportType: string;
    reportCode: string;
    format: "XML" | "XLSX" | "DOCX";
    schemaCode: string;
    name: string;
    version: number;
    revision: number;
    status: string;
    definitionSha256: string | null;
    mappingSha256: string | null;
    templateSha256: string | null;
    paths: number | null;
    codeLists: number | null;
};

type PathInfo = { path: string; kind: "simple" | "complex"; minOccurs: number; maxOccurs: number | "unbounded"; facets?: { enumeration?: string[]; baseType?: string } };
type FieldBinding = {
    xsdPath: string;
    sourceKind: "CONTEXT_PATH" | "CONSTANT" | "CODE_MAP" | "TEMPLATE";
    contextPath?: string;
    constantValue?: string;
    codeMapKey?: string;
};
type MappingBlueprint = {
    schemaVersion: 1;
    repeatingNodes: Array<{ xsdPath: string; repeatOverContextPath: string; itemAlias: string }>;
    fieldBindings: FieldBinding[];
    codeMaps: Record<string, { description: string; mappings: Record<string, string>; defaultFallback?: string }>;
    assertions: Array<{ id: string; description: string; when: unknown; requirePaths: string[] }>;
};
type WorkbookColumn = { key: string; header: string; type: "string" | "number" | "date" | "boolean" | "list"; required?: boolean; list?: string[] };
type WorkbookSheet = { name: string; order: number; columns: WorkbookColumn[]; rows: { repeatOver: string }; totals?: Array<{ column: string; function: "sum" }> };
type WorkbookSchema = { schemaVersion: 1; mode: "TEMPLATE" | "GENERATED"; sheets: WorkbookSheet[]; narrativeSections?: Array<{ key: string; title: string; required?: boolean }> };
type TemplateAnalysis = {
    sheets: Array<{ name: string; rowCount: number; columnCount: number; mergedCells: number; formulaCount: number }>;
    namedRanges: Array<{ name: string; ranges: string[] }>;
    cellCount: number;
    formulaCount: number;
    security: { macros: boolean; externalLinks: boolean; oleObjects: boolean; zipBomb: boolean; forbidden: string[] };
    issues: Array<{ severity?: string; rule: string; message: string }>;
};
type TemplateBinding = {
    mode: "TEMPLATE";
    sheets: Array<{
        name: string;
        rangeName?: string;
        dataStartRow?: number;
        prototypeRow?: number;
        headerRow?: number;
        columns: Array<{ key: string; namedRange?: string; type?: string }>;
        totals?: Array<{ column: string; function: "sum"; namedRange?: string; row?: number }>;
    }>;
    narrative?: Array<{ key: string; namedRange?: string }>;
};
type SchemaDetail = {
    schema: Schema;
    definition: string | null;
    sampleContext: Record<string, unknown> | null;
    notes: string | null;
    compiled: { paths?: Record<string, PathInfo>; codeLists?: Record<string, { allowedValues: string[]; usedByPaths: string[] }> };
    mapping: MappingBlueprint;
    template: { present: boolean; sha256: string | null; binding?: TemplateBinding | null };
    approval: { id: string; state: string; expiresAt: string | null } | null;
    usage: { defaultBindings: number; ruleBindings: number; outputs: number };
    capabilities: { edit: boolean; clone: boolean; promote: boolean; setDefault: boolean };
};
type DefaultBinding = { id: string; authority: string; reportType: string; reportCode: string; format: "XML" | "XLSX" | "DOCX"; schemaId: string; schema?: Schema };
type Issue = { severity: "error" | "warning"; path: string; message: string };

const REPORT_TYPES = ["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN", "INCIDENT"];
const FORMATS = ["XML", "XLSX", "DOCX"] as const;
const SOURCE_KINDS = ["CONTEXT_PATH", "CONSTANT", "CODE_MAP", "TEMPLATE"] as const;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const emptyMapping = (): MappingBlueprint => ({ schemaVersion: 1, repeatingNodes: [], fieldBindings: [], codeMaps: {}, assertions: [] });

const AmlReportingStudioPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const schemas = ref<Schema[]>([]);
    const bindings = ref<DefaultBinding[]>([]);
    const loading = ref(false);
    const error = ref("");
    const createOpen = ref(false);
    const cloneOpen = ref(false);
    const cloneName = ref("");
    const cloneVersion = ref<number | null>(null);
    const actionLoading = ref(false);
    const studioOpen = ref(false);
    const detail = ref<SchemaDetail | null>(null);
    const detailLoading = ref(false);
    const activeTab = ref("overview");
    const definitionDraft = ref("");
    const mappingDraft = ref<MappingBlueprint>(emptyMapping());
    const sampleContextDraft = ref("{}");
    const contextCatalog = ref<Record<string, unknown>>({});
    const issues = ref<Issue[]>([]);
    const simulationContext = ref("{}");
    const simulationResult = ref("");
    const selectedPath = ref("");
    const pathSearch = ref("");
    const workbookDraft = ref<WorkbookSchema | null>(null);
    const templateAnalysis = ref<TemplateAnalysis | null>(null);
    const templateBindingDraft = ref<TemplateBinding | null>(null);
    const templateLoading = ref(false);
    const rules = ref<Array<{ id: string; reportType: string; authority: string; sourceReference: string | null; status: string }>>([]);
    const ruleBindings = ref<Record<string, Array<{ format: "XML" | "XLSX" | "DOCX"; schemaId: string; schema?: Schema }>>>({});
    const ruleBindingDraft = ref<Record<string, { XML?: string; XLSX?: string; DOCX?: string }>>({});
    const ruleBindingsLoading = ref(false);
    const form = ref({
        authority: "CBL",
        reportType: "SUSPICIOUS_ACTIVITY",
        reportCode: "STR",
        format: "XML" as "XML" | "XLSX" | "DOCX",
        schemaCode: "",
        name: "",
        version: 1,
        definitionText: "",
        mappingBlueprint: "{}",
        notes: "",
    });

    const load = async () => {
        loading.value = true;
        error.value = "";
        try {
            const [schemaResponse, bindingResponse, catalogResponse] = await Promise.all([
                api.get(urlsMap.amlReportSchemas),
                api.get(urlsMap.amlReportSchemaDefaults),
                api.get(urlsMap.amlReportContextCatalog),
            ]);
            const schemaPayload = schemaResponse.data?.data ?? schemaResponse.data ?? {};
            const bindingPayload = bindingResponse.data?.data ?? bindingResponse.data ?? {};
            const catalogPayload = catalogResponse.data?.data ?? catalogResponse.data ?? {};
            schemas.value = (schemaPayload.schemas ?? []) as Schema[];
            bindings.value = (bindingPayload.bindings ?? []) as DefaultBinding[];
            contextCatalog.value = (catalogPayload.catalog ?? {}) as Record<string, unknown>;
        } catch (loadError) {
            error.value = extractApiErrorMessage(loadError);
        } finally {
            loading.value = false;
        }
    };
    void load();

    const defaultFor = (reportType: string, reportCode: string, format: string) =>
        bindings.value.find((binding) => binding.reportType === reportType && binding.reportCode === reportCode && binding.format === format);

    const defaultRows = computed(() => {
        const rows = new Map<string, { reportType: string; reportCode: string; format: string; binding?: DefaultBinding }>();
        for (const binding of bindings.value) {
            rows.set(`${binding.reportType}|${binding.reportCode}|${binding.format}`, { reportType: binding.reportType, reportCode: binding.reportCode, format: binding.format, binding });
        }
        for (const reportType of REPORT_TYPES) {
            for (const format of FORMATS) {
                const code = format === "XML" ? (reportType === "SUSPICIOUS_ACTIVITY" ? "STR" : reportType === "LARGE_TRANSACTION" ? "LTR" : "PSP-M") : (reportType === "SUSPICIOUS_ACTIVITY" ? "STR" : reportType === "LARGE_TRANSACTION" ? "LTR" : "PSP-M");
                const key = `${reportType}|${code}|${format}`;
                if (!rows.has(key)) rows.set(key, { reportType, reportCode: code, format, binding: defaultFor(reportType, code, format) });
            }
        }
        return [...rows.values()];
    });

    const contextPathGroups = computed(() => {
        const catalog = contextCatalog.value as Record<string, unknown>;
        const groups: Array<{ title: string; values: string[] }> = [];
        for (const [group, values] of Object.entries(catalog)) {
            if (group === "arrays" || group === "sourceKinds" || group === "transformOperations" || group === "conditionOperators") continue;
            if (Array.isArray(values)) {
                groups.push({
                    title: group,
                    values: values.map((field) => `${group}.${String(field)}`),
                });
            }
        }
        return groups;
    });

    const leafPaths = computed(() => {
        const paths = detail.value?.compiled.paths ?? {};
        return Object.values(paths)
            .filter((path) => path.kind === "simple")
            .filter((path) => !pathSearch.value || path.path.toLowerCase().includes(pathSearch.value.toLowerCase()))
            .sort((left, right) => left.path.localeCompare(right.path));
    });

    const bindingFor = (path: string): FieldBinding | undefined =>
        mappingDraft.value.fieldBindings.find((binding) => binding.xsdPath === path);

    const ensureBinding = (path: string): FieldBinding => {
        const existing = bindingFor(path);
        if (existing) return existing;
        const created: FieldBinding = { xsdPath: path, sourceKind: "CONTEXT_PATH", contextPath: "" };
        mappingDraft.value.fieldBindings = [...mappingDraft.value.fieldBindings, created];
        return created;
    };

    const updateBinding = (path: string, patch: Partial<FieldBinding>) => {
        const binding = ensureBinding(path);
        Object.assign(binding, patch);
        mappingDraft.value = { ...mappingDraft.value, fieldBindings: [...mappingDraft.value.fieldBindings] };
    };

    const removeBinding = (path: string) => {
        mappingDraft.value = { ...mappingDraft.value, fieldBindings: mappingDraft.value.fieldBindings.filter((binding) => binding.xsdPath !== path) };
    };

    const codeListEntries = computed(() => Object.entries(detail.value?.compiled.codeLists ?? {}));
    const codeMapFor = (key: string): { description: string; mappings: Record<string, string>; defaultFallback?: string } => {
        const current = mappingDraft.value.codeMaps[key];
        if (current) return current;
        const created = { description: key, mappings: {}, defaultFallback: "" };
        mappingDraft.value.codeMaps = { ...mappingDraft.value.codeMaps, [key]: created };
        return created;
    };
    const setCodeMapValue = (key: string, from: string, to: string) => {
        const map = codeMapFor(key);
        map.mappings = { ...map.mappings, [from]: to };
        mappingDraft.value = { ...mappingDraft.value, codeMaps: { ...mappingDraft.value.codeMaps, [key]: { ...map } } };
    };
    const setCodeMapFallback = (key: string, value: string) => {
        const map = codeMapFor(key);
        map.defaultFallback = value;
        mappingDraft.value = { ...mappingDraft.value, codeMaps: { ...mappingDraft.value.codeMaps, [key]: { ...map } } };
    };

    const workbookSheets = computed(() => workbookDraft.value?.sheets ?? []);
    const syncWorkbookDefinition = () => {
        if (workbookDraft.value) definitionDraft.value = JSON.stringify(workbookDraft.value, null, 2);
    };
    const addSheet = () => {
        if (!workbookDraft.value) return;
        workbookDraft.value.sheets.push({ name: `Sheet ${workbookDraft.value.sheets.length + 1}`, order: workbookDraft.value.sheets.length, columns: [], rows: { repeatOver: "" }, totals: [] });
        syncWorkbookDefinition();
    };
    const removeSheet = (index: number) => {
        if (!workbookDraft.value) return;
        workbookDraft.value.sheets.splice(index, 1);
        workbookDraft.value.sheets.forEach((sheet, order) => (sheet.order = order));
        syncWorkbookDefinition();
    };
    const addColumn = (sheet: WorkbookSheet) => {
        sheet.columns.push({ key: `column${sheet.columns.length + 1}`, header: `Column ${sheet.columns.length + 1}`, type: "string" });
        syncWorkbookDefinition();
    };
    const removeColumn = (sheet: WorkbookSheet, index: number) => {
        sheet.columns.splice(index, 1);
        syncWorkbookDefinition();
    };

    const templateNamedRanges = computed(() => templateAnalysis.value?.namedRanges ?? []);
    const templateColumnsFor = (sheetName: string) => {
        const sheet = workbookDraft.value?.sheets.find((entry) => entry.name === sheetName);
        return sheet?.columns ?? [];
    };
    const ensureTemplateBinding = (sheetName: string): TemplateBinding["sheets"][number] => {
        if (!templateBindingDraft.value) {
            templateBindingDraft.value = { mode: "TEMPLATE", sheets: [], narrative: [] };
        }
        const existing = templateBindingDraft.value.sheets.find((entry) => entry.name === sheetName);
        if (existing) return existing;
        const created: TemplateBinding["sheets"][number] = { name: sheetName, rangeName: "", dataStartRow: 2, prototypeRow: 2, columns: templateColumnsFor(sheetName).map((column) => ({ key: column.key, namedRange: "", type: column.type })) };
        templateBindingDraft.value.sheets.push(created);
        return created;
    };
    const initializeTemplateDraft = (analysis: TemplateAnalysis, existing: TemplateBinding | null): TemplateBinding => ({
        mode: "TEMPLATE",
        sheets: analysis.sheets.map((sheet) => {
            const previous = existing?.sheets.find((entry) => entry.name === sheet.name);
            return previous
                ? {
                    ...previous,
                    columns: previous.columns.length > 0
                        ? previous.columns
                        : templateColumnsFor(sheet.name).map((column) => ({ key: column.key, namedRange: "", type: column.type })),
                }
                : {
                    name: sheet.name,
                    rangeName: "",
                    dataStartRow: 2,
                    prototypeRow: 2,
                    columns: templateColumnsFor(sheet.name).map((column) => ({ key: column.key, namedRange: "", type: column.type })),
                };
        }),
        narrative: existing?.narrative?.length
            ? existing.narrative
            : (detail.value?.compiled as unknown as { narrativeSections?: Array<{ key: string }> }).narrativeSections?.map((section) => ({ key: section.key, namedRange: "" })) ?? [],
    });
    const uploadTemplate = async (file: File | File[] | null) => {
        const selectedFile = Array.isArray(file) ? file[0] : file;
        if (!selectedFile || !detail.value) return;
        templateLoading.value = true;
        try {
            const base64 = await fileToBase64(selectedFile);
            const response = await api.post(urlsMap.amlReportSchemaTemplateUpload(detail.value.schema.id), { templateBase64: base64 });
            const payload = response.data?.data ?? response.data ?? {};
            const analysis = (payload.analysis ?? null) as TemplateAnalysis | null;
            if (analysis) {
                templateAnalysis.value = analysis;
                templateBindingDraft.value = initializeTemplateDraft(analysis, templateBindingDraft.value);
            }
            showSnackBar({ type: "success", message: t("Template uploaded and analysed") });
            await load();
            if (detail.value) await openStudio(detail.value.schema, true);
        } catch (templateError) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(templateError) });
        } finally {
            templateLoading.value = false;
        }
    };
    const analyzeTemplate = async () => {
        if (!detail.value) return;
        templateLoading.value = true;
        try {
            const response = await api.post(urlsMap.amlReportSchemaTemplateAnalyze(detail.value.schema.id), {});
            const payload = response.data?.data ?? response.data ?? {};
            const analysis = (payload.analysis ?? null) as TemplateAnalysis | null;
            if (analysis) {
                templateAnalysis.value = analysis;
                templateBindingDraft.value = initializeTemplateDraft(analysis, templateBindingDraft.value);
                showSnackBar({ type: "success", message: t("Template analysed") });
            }
        } catch (templateError) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(templateError) });
        } finally {
            templateLoading.value = false;
        }
    };
    const downloadTemplate = async () => {
        if (!detail.value) return;
        try {
            const response = await api.get(urlsMap.amlReportSchemaTemplate(detail.value.schema.id));
            const payload = response.data?.data ?? response.data ?? {};
            if (!payload.templateBase64) return;
            const binary = atob(String(payload.templateBase64));
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `${detail.value.schema.schemaCode}-v${detail.value.schema.version}.xlsx`;
            anchor.click();
            URL.revokeObjectURL(url);
        } catch (templateError) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(templateError) });
        }
    };
    const deleteTemplate = async () => {
        if (!detail.value || !(await showConfirm({ title: t("Remove template"), message: t("The uploaded template and its mapping will be removed."), type: "error" }))) return;
        templateLoading.value = true;
        try {
            await api.delete(urlsMap.amlReportSchemaTemplate(detail.value.schema.id));
            templateAnalysis.value = null;
            templateBindingDraft.value = null;
            showSnackBar({ type: "success", message: t("Template removed") });
            await load();
            if (detail.value) await openStudio(detail.value.schema, true);
        } catch (templateError) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(templateError) });
        } finally {
            templateLoading.value = false;
        }
    };
    const saveTemplateBinding = async () => {
        if (!detail.value || !templateBindingDraft.value) return;
        templateLoading.value = true;
        try {
            const response = await api.get(urlsMap.amlReportSchemaTemplate(detail.value.schema.id));
            const payload = response.data?.data ?? response.data ?? {};
            await api.put(urlsMap.amlReportSchemaTemplate(detail.value.schema.id), {
                templateBase64: payload.templateBase64,
                templateBinding: templateBindingDraft.value,
            });
            showSnackBar({ type: "success", message: t("Template mapping saved") });
            if (detail.value) await openStudio(detail.value.schema, true);
        } catch (templateError) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(templateError) });
        } finally {
            templateLoading.value = false;
        }
    };
    const canSave = computed(() => !!detail.value?.capabilities.edit && definitionDraft.value.trim().length > 0);

    const loadRuleBindings = async () => {
        ruleBindingsLoading.value = true;
        try {
            const response = await api.get(urlsMap.amlReportingRules);
            const payload = response.data?.data ?? response.data ?? {};
            rules.value = (payload.rules ?? []) as Array<{ id: string; reportType: string; authority: string; sourceReference: string | null; status: string }>;
            const pairs = await Promise.all(rules.value.map(async (rule) => {
                const bindingResponse = await api.get(urlsMap.amlReportingRuleSchemaBindings(rule.id));
                const bindingPayload = bindingResponse.data?.data ?? bindingResponse.data ?? {};
                return [rule.id, (bindingPayload.bindings ?? []) as Array<{ format: "XML" | "XLSX" | "DOCX"; schemaId: string; schema?: Schema }>] as const;
            }));
            ruleBindings.value = Object.fromEntries(pairs);
            ruleBindingDraft.value = Object.fromEntries(pairs.map(([id, entries]) => [id, Object.fromEntries(entries.map((entry) => [entry.format, entry.schemaId]))]));
        } catch (loadError) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(loadError) });
        } finally {
            ruleBindingsLoading.value = false;
        }
    };
    watch(activeTab, (tab) => {
        if (tab === "bindings") void loadRuleBindings();
    });
    const schemasForRule = (rule: { authority: string; reportType: string }, format: string) =>
        schemas.value.filter((schema) => schema.status === "CONFIRMED" && schema.authority === rule.authority && schema.reportType === rule.reportType && schema.format === format);
    const saveRuleBindings = async (rule: { id: string; authority: string; reportType: string }) => {
        const draft = ruleBindingDraft.value[rule.id] ?? {};
        try {
            await api.put(urlsMap.amlReportingRuleSchemaBindings(rule.id), {
                bindings: (["XML", "XLSX", "DOCX"] as const)
                    .filter((format) => draft[format])
                    .map((format) => ({ format, schemaId: draft[format]! })),
            });
            showSnackBar({ type: "success", message: t("Rule schema binding submitted for approval") });
            await loadRuleBindings();
        } catch (saveError) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(saveError) });
        }
    };
    const openStudio = async (schema: Schema, preserveTemplate = false) => {
        studioOpen.value = true;
        detailLoading.value = true;
        detail.value = null;
        if (!preserveTemplate) activeTab.value = "overview";
        selectedPath.value = "";
        pathSearch.value = "";
        issues.value = [];
        simulationResult.value = "";
        try {
            const response = await api.get(urlsMap.amlReportSchema(schema.id));
            const payload = response.data?.data ?? response.data ?? {};
            const loaded = payload as SchemaDetail;
            detail.value = loaded;
            definitionDraft.value = loaded.definition ?? "";
            mappingDraft.value = clone(loaded.mapping ?? emptyMapping());
            sampleContextDraft.value = JSON.stringify(loaded.sampleContext ?? {}, null, 2);
            workbookDraft.value = loaded.schema.format === "XLSX" && loaded.definition
                ? JSON.parse(loaded.definition) as WorkbookSchema
                : null;
            if (!preserveTemplate) {
                templateAnalysis.value = null;
                templateBindingDraft.value = (loaded.template?.binding ?? null) as TemplateBinding | null;
            }
            selectedPath.value = Object.values(loaded.compiled.paths ?? {}).find((path) => path.kind === "simple")?.path ?? "";
            if (loaded.schema.format === "XLSX" && loaded.template?.present) void analyzeTemplate();
        } catch (openError) {
            studioOpen.value = false;
            showSnackBar({ type: "error", message: extractApiErrorMessage(openError) });
        } finally {
            detailLoading.value = false;
        }
    };

    watch(schemas, (list) => {
        const openId = typeof route.query.open === "string" ? route.query.open : "";
        const schema = openId ? list.find((candidate) => candidate.id === openId) : null;
        if (schema && !studioOpen.value) void openStudio(schema);
    });

    const save = async () => {
        if (!detail.value || !canSave.value) return;
        actionLoading.value = true;
        try {
            if (workbookDraft.value) syncWorkbookDefinition();
            await api.put(urlsMap.amlReportSchemaUpdate(detail.value.schema.id), {
                definitionText: definitionDraft.value,
                mappingBlueprint: mappingDraft.value,
                sampleContext: JSON.parse(sampleContextDraft.value || "{}") as Record<string, unknown>,
                baseRevision: detail.value.schema.revision,
            });
            showSnackBar({ type: "success", message: t("Schema saved") });
            await load();
            await openStudio(detail.value.schema);
        } catch (saveError) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(saveError) });
        } finally {
            actionLoading.value = false;
        }
    };

    const validate = async () => {
        if (!detail.value) return;
        actionLoading.value = true;
        try {
            const response = await api.post(urlsMap.amlReportSchemaValidateId(detail.value.schema.id), {
                definitionText: definitionDraft.value,
                mappingBlueprint: mappingDraft.value,
                context: JSON.parse(simulationContext.value || "{}") as Record<string, unknown>,
            });
            const payload = response.data?.data ?? response.data ?? {};
            issues.value = (payload.issues ?? []) as Issue[];
            showSnackBar({ type: "success", message: t("Validation complete") });
        } catch (validationError) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(validationError) });
        } finally {
            actionLoading.value = false;
        }
    };

    const simulate = async () => {
        if (!detail.value) return;
        actionLoading.value = true;
        try {
            const response = await api.post(urlsMap.amlReportSchemaSimulate(detail.value.schema.id), {
                context: JSON.parse(simulationContext.value || "{}") as Record<string, unknown>,
            });
            const payload = response.data?.data ?? response.data ?? {};
            simulationResult.value = payload.content ?? (payload.contentBase64 ? (payload.format === "DOCX" ? t("DOCX generated (base64 preview omitted)") : t("XLSX generated (base64 preview omitted)")) : JSON.stringify(payload, null, 2));
            issues.value = (payload.validation?.issues ?? []) as Issue[];
        } catch (simulationError) {
            simulationResult.value = extractApiErrorMessage(simulationError);
        } finally {
            actionLoading.value = false;
        }
    };

    const suggestContext = async () => {
        if (!detail.value) return;
        actionLoading.value = true;
        try {
            const response = await api.post(urlsMap.amlReportSchemaSampleContext(detail.value.schema.id), { sourceType: "SCHEMA" });
            const payload = response.data?.data ?? response.data ?? {};
            simulationContext.value = JSON.stringify(payload.context ?? {}, null, 2);
            showSnackBar({ type: "success", message: t("Sample context loaded") });
        } catch (contextError) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(contextError) });
        } finally {
            actionLoading.value = false;
        }
    };

    const promote = async (schema: Schema) => {
        actionLoading.value = true;
        try {
            await api.post(urlsMap.amlReportSchemaPromote(schema.id), { setAsDefault: true });
            showSnackBar({ type: "success", message: t("Promotion submitted for four-eyes approval") });
            await load();
        } catch (promoteError) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(promoteError) });
        } finally {
            actionLoading.value = false;
        }
    };

    const cloneSchema = async () => {
        if (!detail.value) return;
        actionLoading.value = true;
        try {
            await api.post(urlsMap.amlReportSchemaClone(detail.value.schema.id), {
                ...(cloneName.value.trim() ? { name: cloneName.value.trim() } : {}),
                ...(cloneVersion.value ? { version: cloneVersion.value } : {}),
                copySample: false,
            });
            cloneOpen.value = false;
            studioOpen.value = false;
            showSnackBar({ type: "success", message: t("Schema cloned as a new draft") });
            await load();
        } catch (cloneError) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(cloneError) });
        } finally {
            actionLoading.value = false;
        }
    };

    const setDefault = async (schema: Schema, binding?: DefaultBinding) => {
        actionLoading.value = true;
        try {
            await api.put(urlsMap.amlReportSchemaDefaults, {
                authority: schema.authority,
                reportType: schema.reportType,
                reportCode: schema.reportCode,
                format: schema.format,
                schemaId: schema.id,
            });
            showSnackBar({ type: "success", message: t("Default binding submitted for approval") });
            await load();
        } catch (defaultError) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(defaultError) });
        } finally {
            actionLoading.value = false;
        }
    };

    const openCreate = () => {
        form.value = { authority: "CBL", reportType: "SUSPICIOUS_ACTIVITY", reportCode: "STR", format: "XML", schemaCode: "", name: "", version: 1, definitionText: "", mappingBlueprint: "{}", notes: "" };
        createOpen.value = true;
    };

    const createSchema = async () => {
        if (form.value.schemaCode.trim().length < 2 || form.value.name.trim().length < 2 || !form.value.definitionText.trim()) {
            showSnackBar({ type: "warning", message: t("Schema code, name and definition are required") });
            return;
        }
        actionLoading.value = true;
        try {
            let mappingBlueprint: Record<string, unknown>;
            try {
                mappingBlueprint = JSON.parse(form.value.mappingBlueprint) as Record<string, unknown>;
            } catch {
                throw new Error(t("Mapping blueprint must be valid JSON"));
            }
            await api.post(urlsMap.amlReportSchemas, {
                authority: form.value.authority,
                reportType: form.value.reportType,
                reportCode: form.value.reportCode,
                format: form.value.format,
                schemaCode: form.value.schemaCode,
                name: form.value.name,
                version: form.value.version,
                definitionText: form.value.definitionText,
                mappingBlueprint,
                notes: form.value.notes || undefined,
            });
            createOpen.value = false;
            showSnackBar({ type: "success", message: t("Schema saved as draft") });
            await load();
        } catch (createError) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(createError) });
        } finally {
            actionLoading.value = false;
        }
    };

    const tabs = computed(() => [
        { value: "overview", label: t("Overview") },
        { value: "definition", label: t("Definition") },
        { value: "structure", label: t("Structure") },
        { value: "simulate", label: t("Simulate") },
        { value: "bindings", label: t("Bindings") },
    ]);

    return () => (
        <ScreenContainer>
            <PageHeader
                title={t("Reporting Studio")}
                subtitle={t("Declarative XML/XLSX/DOCX schemas, mapping, validation and filing gates")}
                end={() => <VBtn color="primary" onClick={openCreate}>{t("New schema")}</VBtn>}
            />
            {error.value && <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert>}
            <ThemedView style={{ display: "grid", gap: "12px" }}>
                {loading.value && <ThemedText>{t("Loading schemas")}</ThemedText>}
                {defaultRows.value.map((row) => (
                    <SurfaceCard key={`${row.reportType}-${row.reportCode}-${row.format}`}>
                        <ThemedView style={{ display: "flex", flexDirection: "row", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                            <StatusBadge status={row.format} toneOverride="info" />
                            <ThemedText type="defaultSemiBold">{row.reportType}</ThemedText>
                            <ThemedText style={{ opacity: 0.7 }}>{row.reportCode}</ThemedText>
                            <ThemedText style={{ opacity: 0.65 }}>
                                {row.binding?.schema ? `${row.binding.schema.name} · v${row.binding.schema.version}` : t("No confirmed default")}
                            </ThemedText>
                            {row.binding?.schema && <StatusBadge status={row.binding.schema.status} toneOverride={row.binding.schema.status === "CONFIRMED" ? "success" : "warning"} />}
                        </ThemedView>
                    </SurfaceCard>
                ))}
                {schemas.value.map((schema) => (
                    <SurfaceCard key={schema.id}>
                        <ThemedView style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <ThemedView style={{ display: "flex", flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                <StatusBadge status={schema.format} toneOverride="info" />
                                <ThemedText type="defaultSemiBold">{schema.name}</ThemedText>
                                <ThemedText style={{ opacity: 0.65 }}>{schema.schemaCode} · v{schema.version} · {schema.reportCode || schema.reportType}</ThemedText>
                                <StatusBadge status={schema.status} toneOverride={schema.status === "CONFIRMED" ? "success" : schema.status === "PROVISIONAL" ? "warning" : "neutral"} />
                            </ThemedView>
                            <SurfaceCardText>
                                {schema.format === "XML" ? `${schema.paths ?? 0} ${t("elements")} · ${schema.codeLists ?? 0} ${t("code lists")}` : schema.format === "XLSX" ? t("Declarative XLSX workbook") : t("Narrative DOCX document")}
                                {" · "}
                                <MonoRef value={schema.definitionSha256 ?? schema.templateSha256 ?? ""} />
                            </SurfaceCardText>
                            <ThemedView style={{ display: "flex", flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                <VBtn size="small" variant="tonal" onClick={() => void openStudio(schema)}>{t("Open studio")}</VBtn>
                                {schema.status === "CONFIRMED" && <VBtn size="small" variant="text" onClick={() => void setDefault(schema)}>{t("Set default")}</VBtn>}
                                {schema.status === "DRAFT" && <VBtn size="small" variant="text" onClick={() => void promote(schema)}>{t("Promote")}</VBtn>}
                            </ThemedView>
                        </ThemedView>
                    </SurfaceCard>
                ))}
            </ThemedView>

            <SlideOverDrawer
                modelValue={studioOpen.value}
                onUpdate:modelValue={(value: boolean) => (studioOpen.value = value)}
                title={detail.value?.schema.name ?? t("Reporting Studio")}
                subtitle={detail.value ? `${detail.value.schema.schemaCode} · v${detail.value.schema.version} · ${detail.value.schema.status}` : ""}
                width={1120}
                v-slots={{
                    footer: () => (
                        <ThemedView style={{ display: "flex", flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            {detail.value?.capabilities.edit && <VBtn color="primary" loading={actionLoading.value} onClick={() => void save()}>{t("Save draft")}</VBtn>}
                            <VBtn variant="tonal" loading={actionLoading.value} onClick={() => void validate()}>{t("Validate")}</VBtn>
                            <VBtn variant="text" onClick={() => { cloneOpen.value = true; cloneName.value = `${detail.value?.schema.name ?? ""} copy`; cloneVersion.value = (detail.value?.schema.version ?? 1) + 1; }}>{t("Clone as new version")}</VBtn>
                            <VBtn variant="text" onClick={() => (studioOpen.value = false)}>{t("Close")}</VBtn>
                        </ThemedView>
                    ),
                }}
            >
                {detailLoading.value || !detail.value ? (
                    <ThemedText>{t("Loading schema")}</ThemedText>
                ) : (
                    <ThemedView style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        <SegmentedTabs modelValue={activeTab.value} onUpdate:modelValue={(value: string) => (activeTab.value = value)} tabs={tabs.value} />
                        {issues.value.length > 0 && (
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                {issues.value.slice(0, 12).map((issue, index) => (
                                    <VAlert key={`${issue.path}-${index}`} type={issue.severity === "error" ? "error" : "warning"} variant="tonal" density="compact">
                                        <MonoRef value={issue.path} /> {issue.message}
                                    </VAlert>
                                ))}
                            </ThemedView>
                        )}
                        {activeTab.value === "overview" && (
                            <SurfaceCard>
                                <SurfaceCardText>
                                    <ThemedText>{t("Authority")}: {detail.value.schema.authority}</ThemedText>
                                    <ThemedText>{t("Report type")}: {detail.value.schema.reportType} · {detail.value.schema.reportCode}</ThemedText>
                                    <ThemedText>{t("Revision")}: {detail.value.schema.revision} · {t("Version")}: {detail.value.schema.version}</ThemedText>
                                    <ThemedText>{t("Definition hash")}: <MonoRef value={detail.value.schema.definitionSha256 ?? ""} /></ThemedText>
                                    <ThemedText>{t("Mapping hash")}: <MonoRef value={detail.value.schema.mappingSha256 ?? ""} /></ThemedText>
                                    <ThemedText>{t("Usage")}: {detail.value.usage.defaultBindings} {t("default bindings")} · {detail.value.usage.outputs} {t("outputs")}</ThemedText>
                                    {detail.value.approval && <VAlert type="info" variant="tonal">{t("Approval")}: {detail.value.approval.state}</VAlert>}
                                </SurfaceCardText>
                            </SurfaceCard>
                        )}
                        {activeTab.value === "definition" && (
                            <FormField label={detail.value.schema.format === "XML" ? t("XSD XML") : t("Workbook JSON")} required>
                                <VTextarea modelValue={definitionDraft.value} onUpdate:modelValue={(value: string) => (definitionDraft.value = value)} rows={18} hideDetails />
                            </FormField>
                        )}
                        {activeTab.value === "structure" && detail.value.schema.format === "XML" && (
                            <ThemedView style={{ display: "grid", gridTemplateColumns: "minmax(280px, 0.8fr) minmax(320px, 1.2fr)", gap: "16px" }}>
                                <ThemedView style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                    <VTextField modelValue={pathSearch.value} onUpdate:modelValue={(value: string) => (pathSearch.value = value)} label={t("Search paths")} hideDetails />
                                    <ThemedView style={{ maxHeight: "520px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "3px" }}>
                                        {leafPaths.value.map((path) => (
                                            <button
                                                key={path.path}
                                                type="button"
                                                onClick={() => (selectedPath.value = path.path)}
                                                style={{
                                                    textAlign: "left",
                                                    padding: "6px 8px",
                                                    borderRadius: "4px",
                                                    border: "1px solid var(--pg-border-subtle)",
                                                    background: selectedPath.value === path.path ? "var(--pg-bg-surface-subtle)" : "transparent",
                                                    color: "var(--pg-ink-primary)",
                                                    fontFamily: "var(--pg-font-mono)",
                                                    fontSize: "11px",
                                                    direction: "ltr",
                                                }}
                                            >{path.path}</button>
                                        ))}
                                    </ThemedView>
                                </ThemedView>
                                <ThemedView style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{selectedPath.value || t("Select an element")}</ThemedText>
                                    {selectedPath.value && (() => {
                                        const binding = bindingFor(selectedPath.value);
                                        return (
                                            <>
                                                <FormField label={t("Source")}>
                                                    <VSelect
                                                        items={SOURCE_KINDS.map((value) => ({ title: value, value }))}
                                                        modelValue={binding?.sourceKind ?? "CONTEXT_PATH"}
                                                        onUpdate:modelValue={(value: "CONTEXT_PATH" | "CONSTANT" | "CODE_MAP" | "TEMPLATE") => updateBinding(selectedPath.value, { sourceKind: value })}
                                                        hideDetails
                                                    />
                                                </FormField>
                                                {(binding?.sourceKind ?? "CONTEXT_PATH") === "CONTEXT_PATH" && (
                                                    <FormField label={t("Context path")}>
                                                        <VSelect
                                                            items={contextPathGroups.value.flatMap((group) => group.values.map((value) => ({ title: value, value })))}
                                                            modelValue={binding?.contextPath ?? ""}
                                                            onUpdate:modelValue={(value: string) => updateBinding(selectedPath.value, { contextPath: value })}
                                                            hideDetails
                                                        />
                                                    </FormField>
                                                )}
                                                {(binding?.sourceKind ?? "CONTEXT_PATH") === "CONSTANT" && (
                                                    <FormField label={t("Constant")}>
                                                        <VTextField modelValue={binding?.constantValue ?? ""} onUpdate:modelValue={(value: string) => updateBinding(selectedPath.value, { constantValue: value })} hideDetails />
                                                    </FormField>
                                                )}
                                                {(binding?.sourceKind ?? "CONTEXT_PATH") === "CODE_MAP" && (
                                                    <FormField label={t("Code map key")}>
                                                        <VSelect items={Object.keys(mappingDraft.value.codeMaps).map((value) => ({ title: value, value }))} modelValue={binding?.codeMapKey ?? ""} onUpdate:modelValue={(value: string) => updateBinding(selectedPath.value, { codeMapKey: value })} hideDetails />
                                                    </FormField>
                                                )}
                                                <VBtn size="small" color="error" variant="text" onClick={() => removeBinding(selectedPath.value)}>{t("Remove binding")}</VBtn>
                                            </>
                                        );
                                    })()}
                                </ThemedView>
                            </ThemedView>
                        )}
                        {activeTab.value === "structure" && detail.value.schema.format === "XML" && (
                            <SurfaceCard title={t("Code lists")}>
                                <SurfaceCardText>
                                    <ThemedView style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                        {codeListEntries.value.map(([key, codeList]) => {
                                            const map = codeMapFor(key);
                                            return (
                                                <ThemedView key={key} style={{ display: "flex", flexDirection: "column", gap: "6px", border: "1px solid var(--pg-border-subtle)", borderRadius: "6px", padding: "10px" }}>
                                                    <ThemedText type="defaultSemiBold">{key}</ThemedText>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.7 }}>{codeList.usedByPaths.join(", ")}</ThemedText>
                                                    {codeList.allowedValues.map((allowed) => (
                                                        <ThemedView key={allowed} style={{ display: "grid", gridTemplateColumns: "minmax(120px, 1fr) minmax(120px, 1fr)", gap: "8px", alignItems: "center" }}>
                                                            <MonoRef value={allowed} />
                                                            <VTextField modelValue={map.mappings[allowed] ?? ""} onUpdate:modelValue={(value: string) => setCodeMapValue(key, allowed, value)} placeholder={t("Internal value")} hideDetails density="compact" />
                                                        </ThemedView>
                                                    ))}
                                                    <VTextField modelValue={map.defaultFallback ?? ""} onUpdate:modelValue={(value: string) => setCodeMapFallback(key, value)} label={t("Fallback value")} hideDetails density="compact" />
                                                </ThemedView>
                                            );
                                        })}
                                    </ThemedView>
                                </SurfaceCardText>
                            </SurfaceCard>
                        )}
                        {activeTab.value === "structure" && detail.value.schema.format === "XLSX" && workbookDraft.value && (
                            <SurfaceCard title={t("Workbook")}>
                                <SurfaceCardText>
                                    <ThemedView style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                        {workbookSheets.value.map((sheet, index) => (
                                            <ThemedView key={`${sheet.name}-${index}`} style={{ display: "flex", flexDirection: "column", gap: "8px", border: "1px solid var(--pg-border-subtle)", borderRadius: "6px", padding: "10px" }}>
                                                <ThemedView style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                                    <VTextField modelValue={sheet.name} onUpdate:modelValue={(value: string) => { sheet.name = value; syncWorkbookDefinition(); }} label={t("Sheet name")} hideDetails density="compact" style={{ maxWidth: "220px" }} />
                                                    <VTextField modelValue={sheet.rows.repeatOver} onUpdate:modelValue={(value: string) => { sheet.rows.repeatOver = value; syncWorkbookDefinition(); }} label={t("Rows path")} hideDetails density="compact" style={{ maxWidth: "260px" }} />
                                                    <VBtn size="small" variant="text" color="error" onClick={() => removeSheet(index)}>{t("Remove sheet")}</VBtn>
                                                </ThemedView>
                                                {sheet.columns.map((column, columnIndex) => (
                                                    <ThemedView key={`${column.key}-${columnIndex}`} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 120px 100px auto", gap: "6px", alignItems: "center" }}>
                                                        <VTextField modelValue={column.key} onUpdate:modelValue={(value: string) => { column.key = value; syncWorkbookDefinition(); }} label={t("Key/path")} hideDetails density="compact" />
                                                        <VTextField modelValue={column.header} onUpdate:modelValue={(value: string) => { column.header = value; syncWorkbookDefinition(); }} label={t("Header")} hideDetails density="compact" />
                                                        <VSelect items={["string", "number", "date", "boolean", "list"].map((value) => ({ title: value, value }))} modelValue={column.type} onUpdate:modelValue={(value: string) => { column.type = value as WorkbookColumn["type"]; syncWorkbookDefinition(); }} hideDetails density="compact" />
                                                        <VBtn size="small" variant="text" color="error" onClick={() => removeColumn(sheet, columnIndex)}>{t("Remove")}</VBtn>
                                                    </ThemedView>
                                                ))}
                                                <VBtn size="small" variant="tonal" onClick={() => addColumn(sheet)}>{t("Add column")}</VBtn>
                                            </ThemedView>
                                        ))}
                                        <VBtn size="small" variant="tonal" onClick={addSheet}>{t("Add sheet")}</VBtn>
                                    </ThemedView>
                                </SurfaceCardText>
                            </SurfaceCard>
                        )}
                        {activeTab.value === "structure" && detail.value.schema.format === "XLSX" && (
                            <SurfaceCard title={t("Workbook template")}>
                                <SurfaceCardText>
                                    <ThemedView style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                        {detail.value.capabilities.edit && (
                                            <VFileInput
                                                label={t("Upload .xlsx template")}
                                                {...{ accept: ".xlsx" }}
                                                modelValue={null}
                                                onUpdate:modelValue={(value: File | File[] | null) => void uploadTemplate(value)}
                                                hideDetails
                                                density="compact"
                                            />
                                        )}
                                        <ThemedView style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                            <VBtn size="small" variant="tonal" loading={templateLoading.value} onClick={() => void analyzeTemplate()}>{t("Analyze existing template")}</VBtn>
                                            <VBtn size="small" variant="text" onClick={() => void downloadTemplate()}>{t("Download template")}</VBtn>
                                            {detail.value.capabilities.edit && <VBtn size="small" variant="text" color="error" onClick={() => void deleteTemplate()}>{t("Remove template")}</VBtn>}
                                        </ThemedView>
                                        {(templateAnalysis.value || templateBindingDraft.value) && (
                                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                                {templateAnalysis.value && <ThemedText>{t("Sheets")}: {templateAnalysis.value.sheets.length} · {t("Named ranges")}: {templateAnalysis.value.namedRanges.length} · {t("Formulas")}: {templateAnalysis.value.formulaCount} · {t("Cells")}: {templateAnalysis.value.cellCount}</ThemedText>}
                                                {templateAnalysis.value && templateAnalysis.value.issues.length > 0 && <VAlert type="warning" variant="tonal">{templateAnalysis.value.issues.map((issue) => issue.message).join(" · ")}</VAlert>}
                                                {(templateAnalysis.value?.sheets ?? templateBindingDraft.value?.sheets ?? []).map((sheet) => {
                                                    const binding = ensureTemplateBinding(sheet.name);
                                                    return (
                                                        <ThemedView key={sheet.name} style={{ border: "1px solid var(--pg-border-subtle)", borderRadius: "var(--pg-radius-md)", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                                                            <ThemedText type="defaultSemiBold">{sheet.name}</ThemedText>
                                                            <VSelect
                                                                items={(templateNamedRanges.value.length > 0 ? templateNamedRanges.value : binding.rangeName ? [{ name: binding.rangeName, ranges: [] }] : []).map((range) => ({ title: `${range.name} (${range.ranges[0] ?? ""})`, value: range.name }))}
                                                                modelValue={binding.rangeName ?? ""}
                                                                onUpdate:modelValue={(value: string) => { binding.rangeName = value; }}
                                                                label={t("Table / range")}
                                                                hideDetails
                                                                density="compact"
                                                            />
                                                            <ThemedView style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                                                                <VTextField type="number" modelValue={binding.dataStartRow ?? 2} onUpdate:modelValue={(value: string) => { binding.dataStartRow = Number(value) || 2; }} label={t("Data start row")} hideDetails density="compact" />
                                                                <VTextField type="number" modelValue={binding.prototypeRow ?? binding.dataStartRow ?? 2} onUpdate:modelValue={(value: string) => { binding.prototypeRow = Number(value) || 2; }} label={t("Prototype row")} hideDetails density="compact" />
                                                            </ThemedView>
                                                            {binding.columns.map((column) => (
                                                                <ThemedView key={column.key} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                                                                    <ThemedText style={{ fontSize: "11px", alignSelf: "center" }}>{column.key}</ThemedText>
                                                                    <VSelect
                                                                        items={(templateNamedRanges.value.length > 0 ? templateNamedRanges.value : column.namedRange ? [{ name: column.namedRange, ranges: [] }] : []).map((range) => ({ title: range.name, value: range.name }))}
                                                                        modelValue={column.namedRange ?? ""}
                                                                        onUpdate:modelValue={(value: string) => { column.namedRange = value; }}
                                                                        label={t("Named range")}
                                                                        hideDetails
                                                                        density="compact"
                                                                    />
                                                                </ThemedView>
                                                            ))}
                                                            {binding.columns.filter((column) => column.type === "number").map((column) => {
                                                                const total = binding.totals?.find((entry) => entry.column === column.key);
                                                                return (
                                                                    <VSelect
                                                                        key={`total-${column.key}`}
                                                                        items={[{ title: t("No total cell"), value: "" }].concat(templateNamedRanges.value.map((range) => ({ title: range.name, value: range.name })))}
                                                                        modelValue={total?.namedRange ?? ""}
                                                                        onUpdate:modelValue={(value: string) => {
                                                                            const totals = (binding.totals ?? []).filter((entry) => entry.column !== column.key);
                                                                            if (value) totals.push({ column: column.key, function: "sum", namedRange: value });
                                                                            binding.totals = totals;
                                                                        }}
                                                                        label={`${t("Total range")} · ${column.key}`}
                                                                        hideDetails
                                                                        density="compact"
                                                                    />
                                                                );
                                                            })}
                                                        </ThemedView>
                                                    );
                                                })}
                                                {(templateBindingDraft.value?.narrative ?? []).length > 0 && (
                                                    <ThemedView style={{ border: "1px solid var(--pg-border-subtle)", borderRadius: "var(--pg-radius-md)", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                                                        <ThemedText type="defaultSemiBold">{t("Narrative sections")}</ThemedText>
                                                        {(templateBindingDraft.value?.narrative ?? []).map((section) => (
                                                            <ThemedView key={section.key} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", alignItems: "center" }}>
                                                                <ThemedText style={{ fontSize: "11px" }}>{section.key}</ThemedText>
                                                                <VSelect items={templateNamedRanges.value.map((range) => ({ title: range.name, value: range.name }))} modelValue={section.namedRange ?? ""} onUpdate:modelValue={(value: string) => { section.namedRange = value; }} label={t("Named range")} hideDetails density="compact" />
                                                            </ThemedView>
                                                        ))}
                                                    </ThemedView>
                                                )}
                                                {detail.value.capabilities.edit && <VBtn size="small" variant="tonal" loading={templateLoading.value} onClick={() => void saveTemplateBinding()}>{t("Save template mapping")}</VBtn>}
                                            </ThemedView>
                                        )}
                                    </ThemedView>
                                </SurfaceCardText>
                            </SurfaceCard>
                        )}
                        {activeTab.value === "simulate" && (
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <VBtn size="small" variant="tonal" onClick={() => void suggestContext()}>{t("Load saved sample context")}</VBtn>
                                <FormField label={t("Canonical context JSON")} required>
                                    <VTextarea modelValue={simulationContext.value} onUpdate:modelValue={(value: string) => (simulationContext.value = value)} rows={10} hideDetails />
                                </FormField>
                                <VBtn color="primary" variant="tonal" loading={actionLoading.value} onClick={() => void simulate()}>{t("Run simulation")}</VBtn>
                                {simulationResult.value && <VTextarea modelValue={simulationResult.value} readonly rows={16} hideDetails />}
                            </ThemedView>
                        )}
                        {activeTab.value === "bindings" && (
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText>{t("Default binding key")}: {detail.value.schema.authority} / {detail.value.schema.reportType} / {detail.value.schema.reportCode} / {detail.value.schema.format}</ThemedText>
                                {detail.value.capabilities.setDefault && <VBtn size="small" color="primary" onClick={() => void setDefault(detail.value!.schema)}>{t("Set as default")}</VBtn>}
                                <VBtn size="small" variant="tonal" onClick={() => void promote(detail.value!.schema)} disabled={!detail.value.capabilities.promote}>{t("Promote")}</VBtn>
                                <ThemedText style={{ opacity: 0.7 }}>{t("Schema versions")}: {schemas.value.filter((schema) => schema.schemaCode === detail.value?.schema.schemaCode).map((schema) => `v${schema.version} (${schema.status})`).join(", ")}</ThemedText>
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "10px", borderTop: "1px solid var(--pg-border-subtle)", paddingTop: "12px" }}>
                                <ThemedText type="defaultSemiBold">{t("Rule schema overrides")}</ThemedText>
                                {ruleBindingsLoading.value && <ThemedText>{t("Loading rules")}</ThemedText>}
                                {rules.value.map((rule) => (
                                    <ThemedView key={rule.id} style={{ display: "flex", flexDirection: "column", gap: "6px", border: "1px solid var(--pg-border-subtle)", borderRadius: "6px", padding: "10px" }}>
                                        <ThemedView style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                            <MonoRef value={rule.sourceReference ?? rule.id} />
                                            <StatusBadge status={rule.status} toneOverride={rule.status === "CONFIRMED" ? "success" : "warning"} />
                                            <ThemedText style={{ opacity: 0.65 }}>{rule.reportType}</ThemedText>
                                        </ThemedView>
                                        {(["XML", "XLSX", "DOCX"] as const).map((format) => (
                                            <ThemedView key={format} style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: "8px", alignItems: "center" }}>
                                                <ThemedText>{format}</ThemedText>
                                                <VSelect
                                                    items={[{ title: t("Use default binding"), value: "" }].concat(schemasForRule(rule, format).map((schema) => ({ title: `${schema.name} · v${schema.version}`, value: schema.id })))}
                                                    modelValue={ruleBindingDraft.value[rule.id]?.[format] ?? ""}
                                                    onUpdate:modelValue={(value: string) => {
                                                        ruleBindingDraft.value = { ...ruleBindingDraft.value, [rule.id]: { ...ruleBindingDraft.value[rule.id], [format]: value } };
                                                    }}
                                                    hideDetails
                                                    density="compact"
                                                />
                                            </ThemedView>
                                        ))}
                                        <VBtn size="small" variant="tonal" onClick={() => void saveRuleBindings(rule)}>{t("Save rule binding for approval")}</VBtn>
                                    </ThemedView>
                                ))}
                            </ThemedView>
                            </ThemedView>
                        )}
                    </ThemedView>
                )}
            </SlideOverDrawer>

            <FormModal modelValue={createOpen.value} onUpdate:modelValue={(value: boolean) => (createOpen.value = value)} title={t("New reporting schema")} size="lg" loading={actionLoading.value} submitLabel={t("Save draft")} onSubmit={() => void createSchema()}>
                <FormField label={t("Authority")} required><VTextField modelValue={form.value.authority} onUpdate:modelValue={(value: string) => (form.value.authority = value)} hideDetails /></FormField>
                <FormField label={t("Report type")} required><VSelect items={REPORT_TYPES.map((value) => ({ title: value, value }))} modelValue={form.value.reportType} onUpdate:modelValue={(value: string) => (form.value.reportType = value)} hideDetails /></FormField>
                <FormField label={t("Return code")} required><VTextField modelValue={form.value.reportCode} onUpdate:modelValue={(value: string) => (form.value.reportCode = value)} hideDetails /></FormField>
                <FormField label={t("Format")} required><VSelect items={FORMATS.map((value) => ({ title: value, value }))} modelValue={form.value.format} onUpdate:modelValue={(value: "XML" | "XLSX" | "DOCX") => (form.value.format = value)} hideDetails /></FormField>
                <FormField label={t("Schema code")} required><VTextField modelValue={form.value.schemaCode} onUpdate:modelValue={(value: string) => (form.value.schemaCode = value)} hideDetails /></FormField>
                <FormField label={t("Name")} required><VTextField modelValue={form.value.name} onUpdate:modelValue={(value: string) => (form.value.name = value)} hideDetails /></FormField>
                <FormField label={t("Version")} required><VTextField type="number" modelValue={form.value.version} onUpdate:modelValue={(value: string) => (form.value.version = Number(value) || 1)} hideDetails /></FormField>
                <FormField label={form.value.format === "XML" ? t("XSD XML") : form.value.format === "DOCX" ? t("DOCX narrative JSON") : t("Workbook JSON")} required><VTextarea modelValue={form.value.definitionText} onUpdate:modelValue={(value: string) => (form.value.definitionText = value)} rows={10} hideDetails /></FormField>
                <FormField label={t("Mapping blueprint JSON")} required><VTextarea modelValue={form.value.mappingBlueprint} onUpdate:modelValue={(value: string) => (form.value.mappingBlueprint = value)} rows={6} hideDetails /></FormField>
            </FormModal>
            <FormModal modelValue={cloneOpen.value} onUpdate:modelValue={(value: boolean) => (cloneOpen.value = value)} title={t("Clone schema as new version")} size="sm" loading={actionLoading.value} submitLabel={t("Clone")} onSubmit={() => void cloneSchema()}>
                <FormField label={t("Name")}><VTextField modelValue={cloneName.value} onUpdate:modelValue={(value: string) => (cloneName.value = value)} hideDetails /></FormField>
                <FormField label={t("Version")}><VTextField type="number" modelValue={cloneVersion.value ?? ""} onUpdate:modelValue={(value: string) => (cloneVersion.value = Number(value) || null)} hideDetails /></FormField>
                <VAlert type="info" variant="tonal">{t("The clone copies the definition, mapping and template but not approvals, defaults or sample PII.")}</VAlert>
            </FormModal>
        </ScreenContainer>
    );
});

export default AmlReportingStudioPage;
