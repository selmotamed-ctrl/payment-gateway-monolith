import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VSelect, VSwitch, VTextField, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type RailField = {
    id?: string;
    key?: string;
    fieldKey?: string;
    labelAr: string;
    labelEn: string;
    type?: string;
    inputType?: string;
    required: boolean;
    regex: string | null;
    minLength: number | null;
    maxLength: number | null;
    normalizer: unknown;
    sensitivity: string;
};

type Rail = {
    id: string;
    code: string;
    nameAr: string;
    nameEn: string;
    collectionMode: string;
    currency: string;
    minAmount: string;
    maxAmount: string;
    capabilities: unknown;
    blocked?: boolean;
    displayOrder?: number;
    instructionsAr?: string;
    instructionsEn?: string;
    fields: RailField[];
};

/** The public field shape the admin edge accepts on PUT /rails/:id/fields. */
type PublicField = {
    code: string;
    label: string;
    type: string;
    required: boolean;
    pattern: string;
    minLength: string;
    maxLength: string;
    sensitive: boolean;
};

const PUBLIC_TYPES = ["TEXT", "NUMBER", "PHONE", "NATIONAL_ID", "PASSPORT", "DATE", "OTP", "HIDDEN"];

const CORE_TO_PUBLIC: Record<string, string> = {
    string: "TEXT",
    number: "NUMBER",
    phone: "PHONE",
    otp: "OTP",
    birth_year: "DATE",
    card_number: "TEXT",
    pan: "TEXT",
    wallet_id: "TEXT",
    from_list: "TEXT",
};

const blankField = (): PublicField => ({
    code: "",
    label: "",
    type: "TEXT",
    required: true,
    pattern: "",
    minLength: "",
    maxLength: "",
    sensitive: false,
});

const formatCapabilities = (value: unknown): string => {
    if (Array.isArray(value)) {
        return value.join(", ");
    }
    if (value && typeof value === "object") {
        return Object.entries(value as Record<string, unknown>)
            .filter(([, enabled]) => enabled === true)
            .map(([key]) => key)
            .join(", ");
    }
    return "";
};

const toPublicField = (field: RailField): PublicField => {
    const code = field.key ?? field.fieldKey ?? "";
    const rawType = String(field.type ?? field.inputType ?? "").toUpperCase();
    const type = PUBLIC_TYPES.includes(rawType)
        ? rawType
        : (CORE_TO_PUBLIC[rawType.toLowerCase()] ?? "TEXT");
    return {
        code,
        label: field.labelEn || field.labelAr || code,
        type,
        required: field.required !== false,
        pattern: field.regex ?? "",
        minLength: field.minLength === null || field.minLength === undefined ? "" : String(field.minLength),
        maxLength: field.maxLength === null || field.maxLength === undefined ? "" : String(field.maxLength),
        sensitive: (field.sensitivity ?? "NORMAL") !== "NORMAL",
    };
};

const RailsPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<Rail[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    // Create rail
    const createOpen = ref(false);
    const creating = ref(false);
    const railForm = ref({ code: "", name: "", collectionMode: "REDIRECT" });

    // Update rail
    const editOpen = ref(false);
    const savingRail = ref(false);
    const editingRail = ref<Rail | null>(null);
    const railEditForm = ref({
        nameEn: "",
        nameAr: "",
        active: true,
        minAmount: "",
        maxAmount: "",
        displayOrder: "",
        instructionsEn: "",
        instructionsAr: "",
    });

    // Customer catalog (rail fields)
    const dialogOpen = ref(false);
    const selected = ref<Rail | null>(null);
    const fields = ref<PublicField[]>([]);
    const fieldForm = ref<PublicField>(blankField());
    const editingFieldIndex = ref<number | null>(null);
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.railsList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.rails ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const openCreateRail = () => {
        railForm.value = { code: "", name: "", collectionMode: "REDIRECT" };
        createOpen.value = true;
    };

    const createRail = async () => {
        if (creating.value) {
            return;
        }
        creating.value = true;
        try {
            await api.post(urlsMap.railsList, {
                code: railForm.value.code.trim().toLowerCase(),
                name: railForm.value.name.trim(),
                collectionMode: railForm.value.collectionMode,
                active: true,
            });
            createOpen.value = false;
            showSnackBar({ type: "success", message: t("Saved") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            creating.value = false;
        }
    };

    const openEditRail = (rail: Rail) => {
        editingRail.value = rail;
        railEditForm.value = {
            nameEn: rail.nameEn ?? "",
            nameAr: rail.nameAr ?? "",
            active: rail.blocked !== true,
            minAmount: rail.minAmount ?? "",
            maxAmount: rail.maxAmount ?? "",
            displayOrder: rail.displayOrder === undefined || rail.displayOrder === null ? "" : String(rail.displayOrder),
            instructionsEn: rail.instructionsEn ?? "",
            instructionsAr: rail.instructionsAr ?? "",
        };
        editOpen.value = true;
    };

    const saveRail = async () => {
        if (!editingRail.value || savingRail.value) {
            return;
        }
        const form = railEditForm.value;
        const payload: Record<string, unknown> = { active: form.active };
        if (form.nameEn.trim()) payload.nameEn = form.nameEn.trim();
        if (form.nameAr.trim()) payload.nameAr = form.nameAr.trim();
        if (form.minAmount.trim()) payload.minAmount = form.minAmount.trim();
        if (form.maxAmount.trim()) payload.maxAmount = form.maxAmount.trim();
        if (form.displayOrder.trim()) payload.displayOrder = Number(form.displayOrder);
        if (form.instructionsEn.trim()) payload.instructionsEn = form.instructionsEn.trim();
        if (form.instructionsAr.trim()) payload.instructionsAr = form.instructionsAr.trim();
        savingRail.value = true;
        try {
            await api.patch(urlsMap.railDetail(editingRail.value.id), payload);
            editOpen.value = false;
            showSnackBar({ type: "success", message: t("Update") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            savingRail.value = false;
        }
    };

    const resetFieldForm = () => {
        fieldForm.value = blankField();
        editingFieldIndex.value = null;
    };

    const openRail = async (rail: Rail) => {
        selected.value = rail;
        fields.value = [];
        resetFieldForm();
        dialogOpen.value = true;
        try {
            const response = await api.get(urlsMap.railDetail(rail.id));
            const payload = response.data?.data ?? response.data ?? {};
            const detail = payload.rail ?? payload;
            fields.value = (detail.fields ?? []).map(toPublicField);
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const editField = (index: number) => {
        const field = fields.value[index];
        if (!field) {
            return;
        }
        fieldForm.value = { ...field };
        editingFieldIndex.value = index;
    };

    const persistFields = async (next: PublicField[]): Promise<void> => {
        if (!selected.value) {
            return;
        }
        actionLoading.value = true;
        try {
            await api.put(urlsMap.railFields(selected.value.id), {
                fields: next.map((field) => ({
                    code: field.code.trim().toLowerCase(),
                    label: field.label.trim(),
                    type: field.type,
                    required: !!field.required,
                    sensitive: !!field.sensitive,
                    ...(field.pattern.trim() ? { pattern: field.pattern.trim() } : {}),
                    ...(field.minLength.trim() ? { minLength: Number(field.minLength) } : {}),
                    ...(field.maxLength.trim() ? { maxLength: Number(field.maxLength) } : {}),
                })),
            });
            fields.value = next;
            resetFieldForm();
            showSnackBar({ type: "success", message: t("Save") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const saveField = async () => {
        if (!fieldForm.value.code.trim() || !fieldForm.value.label.trim()) {
            return;
        }
        const next = [...fields.value];
        if (editingFieldIndex.value === null) {
            next.push({ ...fieldForm.value });
        } else {
            next[editingFieldIndex.value] = { ...fieldForm.value };
        }
        await persistFields(next);
    };

    const removeField = async (index: number) => {
        if (fields.value.length <= 1) {
            showSnackBar({ type: "error", message: t("A rail needs at least one field") });
            return;
        }
        const next = fields.value.filter((_, position) => position !== index);
        if (editingFieldIndex.value === index) {
            resetFieldForm();
        }
        await persistFields(next);
    };

    const headers: TableHeader<Rail>[] = [
        { key: "code", label: "Rail Code", value: (row) => row.code },
        { key: "nameEn", label: "Label (English)", value: (row) => row.nameEn },
        { key: "nameAr", label: "Label (Arabic)", value: (row) => row.nameAr },
        { key: "collectionMode", label: "Type", value: (row) => row.collectionMode },
        { key: "currency", label: "Currency", value: (row) => row.currency },
        { key: "limits", label: "Amount", value: (row) => `${row.minAmount ?? ""} - ${row.maxAmount ?? ""}` },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: Rail }) => (
                <StatusChip label={row.blocked ? "Blocked" : "Active"} tone={row.blocked ? "error" : "success"} />
            ),
        },
        { key: "capabilities", label: "Capabilities", value: (row) => formatCapabilities(row.capabilities) },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Rail }) => (
                <ThemedView style={{ flexDirection: "row", gap: "8px" }}>
                    <VBtn size="small" variant="text" prependIcon="mdi-pencil" onClick={() => openEditRail(row)}>
                        {t("Edit")}
                    </VBtn>
                    <VBtn size="small" variant="tonal" onClick={() => void openRail(row)}>
                        {t("Customer Catalog")}
                    </VBtn>
                </ThemedView>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Rails")}
                    end={() => (
                        <VBtn color="primary" variant="flat" prependIcon={"mdi-plus"} onClick={() => openCreateRail()}>
                            {t("Add Rail")}
                        </VBtn>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
                            <DataTable
                                title={t("Rails")}
                                data={rows.value}
                                headers={headers}
                                loading={loading.value}
                                showNumber={true}
                                xlsx={false}
                                noElevation={true}
                                searchValue={search.value}
                                setSearchValue={(value) => (search.value = value)}
                            />
                        </VCardText>
                    </VCard>
                )}
            </ThemedView>

            {/* Customer catalog: list + add/edit/delete fields */}
            <VDialog modelValue={dialogOpen.value} onUpdate:modelValue={(v: any) => (dialogOpen.value = v)} maxWidth="760px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedView style={{ flexDirection: "row", gap: "10px", alignItems: "center" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                {selected.value?.nameEn} ({selected.value?.code})
                            </ThemedText>
                            <StatusChip label={selected.value?.collectionMode ?? "-"} tone="info" />
                        </ThemedView>

                        <ThemedText type="defaultSemiBold">{t("Customer Catalog")}</ThemedText>
                        <ThemedView style={{ flexDirection: "column", gap: "8px" }}>
                            {fields.value.length === 0 && (
                                <ThemedText style={{ opacity: 0.6, fontSize: "13px" }}>
                                    {t("No Data Found")}
                                </ThemedText>
                            )}
                            {fields.value.map((field, index) => (
                                <ThemedView
                                    key={`${field.code}-${index}`}
                                    style={{
                                        flexDirection: "row",
                                        gap: "10px",
                                        alignItems: "center",
                                        borderBottom: "1px solid rgba(100,116,139,0.18)",
                                        paddingBottom: "8px",
                                        fontSize: "13px",
                                    }}
                                >
                                    <span style={{ width: "150px", fontWeight: 700 }}>{field.code}</span>
                                    <span style={{ flex: 1 }}>{field.label}</span>
                                    <StatusChip label={field.type} tone="neutral" />
                                    {field.required && <StatusChip label="Required" tone="warning" />}
                                    {field.sensitive && <StatusChip label="Sensitive" tone="error" />}
                                    <VBtn size="small" variant="text" icon="mdi-pencil" onClick={() => editField(index)} />
                                    <VBtn
                                        size="small"
                                        variant="text"
                                        icon="mdi-delete-outline"
                                        color="error"
                                        onClick={() => void removeField(index)}
                                    />
                                </ThemedView>
                            ))}
                        </ThemedView>

                        <ThemedText type="defaultSemiBold">
                            {editingFieldIndex.value === null ? t("Add") : t("Edit")}
                        </ThemedText>
                        <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                            <VTextField
                                style={{ flex: "1 1 180px" }}
                                label={t("Field Key")}
                                modelValue={fieldForm.value.code}
                                onUpdate:modelValue={(v: string) => (fieldForm.value.code = v)}
                            />
                            <VTextField
                                style={{ flex: "1 1 200px" }}
                                label={t("Label (English)")}
                                modelValue={fieldForm.value.label}
                                onUpdate:modelValue={(v: string) => (fieldForm.value.label = v)}
                            />
                            <VSelect
                                style={{ flex: "1 1 160px" }}
                                label={t("Input Type")}
                                items={PUBLIC_TYPES}
                                modelValue={fieldForm.value.type}
                                onUpdate:modelValue={(v: string) => (fieldForm.value.type = v)}
                            />
                        </ThemedView>
                        <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
                            <VTextField
                                style={{ flex: "1 1 200px" }}
                                label={t("Regex")}
                                modelValue={fieldForm.value.pattern}
                                onUpdate:modelValue={(v: string) => (fieldForm.value.pattern = v)}
                            />
                            <VTextField
                                style={{ flex: "0 1 120px" }}
                                label={t("Min")}
                                type="number"
                                modelValue={fieldForm.value.minLength}
                                onUpdate:modelValue={(v: string) => (fieldForm.value.minLength = v)}
                            />
                            <VTextField
                                style={{ flex: "0 1 120px" }}
                                label={t("Max")}
                                type="number"
                                modelValue={fieldForm.value.maxLength}
                                onUpdate:modelValue={(v: string) => (fieldForm.value.maxLength = v)}
                            />
                            <VSwitch
                                label={t("Required")}
                                modelValue={fieldForm.value.required}
                                onUpdate:modelValue={(v: any) => (fieldForm.value.required = !!v)}
                            />
                            <VSwitch
                                label={t("Sensitive")}
                                modelValue={fieldForm.value.sensitive}
                                onUpdate:modelValue={(v: any) => (fieldForm.value.sensitive = !!v)}
                            />
                        </ThemedView>
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                            {editingFieldIndex.value !== null && (
                                <VBtn variant="text" onClick={() => resetFieldForm()}>
                                    {t("Cancel")}
                                </VBtn>
                            )}
                            <VBtn
                                color="primary"
                                loading={actionLoading.value}
                                disabled={!fieldForm.value.code.trim() || !fieldForm.value.label.trim()}
                                onClick={() => void saveField()}
                            >
                                {editingFieldIndex.value === null ? t("Add") : t("Save")}
                            </VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>

            {/* Update rail */}
            <VDialog modelValue={editOpen.value} onUpdate:modelValue={(v: any) => (editOpen.value = v)} maxWidth="640px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                            {t("Edit")} {editingRail.value?.code}
                        </ThemedText>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 14px" }}>
                            <VTextField
                                label={t("Label (English)")}
                                modelValue={railEditForm.value.nameEn}
                                onUpdate:modelValue={(v: string) => (railEditForm.value.nameEn = v)}
                            />
                            <VTextField
                                label={t("Label (Arabic)")}
                                modelValue={railEditForm.value.nameAr}
                                onUpdate:modelValue={(v: string) => (railEditForm.value.nameAr = v)}
                            />
                            <VTextField
                                label={t("Minimum amount")}
                                modelValue={railEditForm.value.minAmount}
                                onUpdate:modelValue={(v: string) => (railEditForm.value.minAmount = v)}
                            />
                            <VTextField
                                label={t("Maximum amount")}
                                modelValue={railEditForm.value.maxAmount}
                                onUpdate:modelValue={(v: string) => (railEditForm.value.maxAmount = v)}
                            />
                            <VTextField
                                label={t("Display order")}
                                type="number"
                                modelValue={railEditForm.value.displayOrder}
                                onUpdate:modelValue={(v: string) => (railEditForm.value.displayOrder = v)}
                            />
                            <div style={{ display: "flex", alignItems: "center" }}>
                                <VSwitch
                                    label={t("Active")}
                                    modelValue={railEditForm.value.active}
                                    onUpdate:modelValue={(v: any) => (railEditForm.value.active = !!v)}
                                />
                            </div>
                            <div style={{ gridColumn: "span 2" }}>
                                <VTextarea
                                    label={t("Instructions (English)")}
                                    rows={2}
                                    modelValue={railEditForm.value.instructionsEn}
                                    onUpdate:modelValue={(v: string) => (railEditForm.value.instructionsEn = v)}
                                />
                            </div>
                            <div style={{ gridColumn: "span 2" }}>
                                <VTextarea
                                    label={t("Instructions (Arabic)")}
                                    rows={2}
                                    modelValue={railEditForm.value.instructionsAr}
                                    onUpdate:modelValue={(v: string) => (railEditForm.value.instructionsAr = v)}
                                />
                            </div>
                        </div>
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                            <VBtn variant="text" onClick={() => (editOpen.value = false)}>
                                {t("Cancel")}
                            </VBtn>
                            <VBtn
                                color="primary"
                                loading={savingRail.value}
                                disabled={!railEditForm.value.nameEn.trim() && !railEditForm.value.nameAr.trim()}
                                onClick={() => void saveRail()}
                            >
                                {t("Save")}
                            </VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>

            {/* Add rail */}
            <VDialog modelValue={createOpen.value} onUpdate:modelValue={(v: any) => (createOpen.value = v)} maxWidth="520px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                            {t("Add Rail")}
                        </ThemedText>
                        <VTextField
                            label={t("Rail Code")}
                            hint="lowercase letters, digits, - and _"
                            modelValue={railForm.value.code}
                            onUpdate:modelValue={(v: string) => (railForm.value.code = v)}
                        />
                        <VTextField
                            label={t("Label (English)")}
                            modelValue={railForm.value.name}
                            onUpdate:modelValue={(v: string) => (railForm.value.name = v)}
                        />
                        <VSelect
                            label={t("Type")}
                            items={["REDIRECT", "EMBEDDED", "QR", "PUSH", "TRANSFER", "CASH"]}
                            modelValue={railForm.value.collectionMode}
                            onUpdate:modelValue={(v: string) => (railForm.value.collectionMode = v)}
                        />
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                            <VBtn variant="text" onClick={() => (createOpen.value = false)}>
                                {t("Cancel")}
                            </VBtn>
                            <VBtn
                                color="primary"
                                loading={creating.value}
                                disabled={!railForm.value.code.trim() || !railForm.value.name.trim()}
                                onClick={() => void createRail()}
                            >
                                {t("Create")}
                            </VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default RailsPage;
