import { computed, defineComponent, ref, watch, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VCheckbox, VSelect, VTextField } from "vuetify/components";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { TableRowActions } from "@/components/Table/TableRowActions";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { showSnackBar } from "@/utils/snackBar";
import {
    OWNER_IDENTITY_TYPES,
    OWNER_ROLES,
    activeOwnershipTotal,
    buildOwnerBody,
    emptyOwnerForm,
    ownerFormFrom,
    validateOwnerForm,
    type MerchantOwnerRecord,
    type OwnerForm,
    type OwnerFormErrors,
} from "../ownerForm";
import { reportCommerceError } from "../governedRequest";
import { MiniTable, formatDateTime, toBadgeTone } from "./commerceBits";

/**
 * Structured beneficial-owner table with add / edit / deactivate (kyb:write).
 * The identity number is write-only: it is masked while typed and never read
 * back from the server. Any identity change resets the screening status
 * server-side, which the table shows immediately after saving.
 */
export const BeneficialOwnersCard = defineComponent({
    name: "BeneficialOwnersCard",
    props: {
        merchantId: { type: String, required: true },
        initialOwners: { type: Array as PropType<MerchantOwnerRecord[]>, default: () => [] },
        canWrite: { type: Boolean, default: false },
        closed: { type: Boolean, default: false },
    },
    emits: ["changed"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const owners = ref<MerchantOwnerRecord[]>([...props.initialOwners]);
        const showInactive = ref(false);
        const formOpen = ref(false);
        const form = ref<OwnerForm>(emptyOwnerForm());
        const errors = ref<OwnerFormErrors>({});
        const editingId = ref<string | null>(null);
        const revealIdentity = ref(false);
        const saving = ref(false);
        const formError = ref("");
        const deactivating = ref<MerchantOwnerRecord | null>(null);
        const deactivateError = ref("");

        const load = async () => {
            try {
                const response = await api.get(urlsMap.merchantBeneficialOwners(props.merchantId));
                const payload = response.data?.data ?? response.data ?? {};
                owners.value = (payload.beneficialOwners ?? []) as MerchantOwnerRecord[];
            } catch {
                owners.value = [...props.initialOwners];
            }
        };
        watch(() => props.merchantId, () => void load(), { immediate: true });

        const visible = computed(() => (showInactive.value ? owners.value : owners.value.filter((owner) => owner.active)));
        const inactiveCount = computed(() => owners.value.filter((owner) => !owner.active).length);
        const total = computed(() => activeOwnershipTotal(owners.value));

        const openForm = (owner?: MerchantOwnerRecord) => {
            editingId.value = owner?.id ?? null;
            form.value = owner ? ownerFormFrom(owner) : emptyOwnerForm();
            errors.value = {};
            formError.value = "";
            revealIdentity.value = false;
            formOpen.value = true;
        };

        const save = async () => {
            const editing = editingId.value !== null;
            errors.value = validateOwnerForm(form.value, editing);
            if (Object.keys(errors.value).length > 0) return;
            saving.value = true;
            formError.value = "";
            try {
                const body = buildOwnerBody(form.value, editing);
                if (editing) await api.patch(urlsMap.merchantBeneficialOwner(props.merchantId, editingId.value!), body);
                else await api.post(urlsMap.merchantBeneficialOwners(props.merchantId), body);
                // The identity number must not outlive the request.
                form.value = emptyOwnerForm();
                formOpen.value = false;
                showSnackBar({ type: "success", message: "Beneficial owner saved" });
                await load();
                emit("changed");
            } catch (cause) {
                formError.value = reportCommerceError(cause);
            } finally {
                saving.value = false;
            }
        };

        const deactivate = async () => {
            const owner = deactivating.value;
            if (!owner) return;
            saving.value = true;
            deactivateError.value = "";
            try {
                await api.delete(urlsMap.merchantBeneficialOwner(props.merchantId, owner.id));
                deactivating.value = null;
                showSnackBar({ type: "success", message: "Beneficial owner deactivated" });
                await load();
                emit("changed");
            } catch (cause) {
                deactivateError.value = reportCommerceError(cause);
            } finally {
                saving.value = false;
            }
        };

        const field = (key: keyof OwnerFormErrors) => (errors.value[key] ? t(errors.value[key] as string) : "");
        const editable = computed(() => props.canWrite && !props.closed);

        return (): VNodeChild => (
            <SurfaceCard>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
                        <div>
                            <div style={{ fontSize: "16px", fontWeight: 600 }}>{t("Beneficial owners")}</div>
                            <div style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                                {`${t("Total active ownership")}: ${total.value.toFixed(2)}%`}
                            </div>
                        </div>
                        <div style={{ display: "inline-flex", gap: "6px", flexWrap: "wrap" }}>
                            {inactiveCount.value > 0 && (
                                <VBtn size="small" variant="text" onClick={() => (showInactive.value = !showInactive.value)}>
                                    {showInactive.value ? t("Hide deactivated") : `${t("Show deactivated")} (${inactiveCount.value})`}
                                </VBtn>
                            )}
                            {editable.value && (
                                <VBtn size="small" variant="tonal" prependIcon="mdi-account-plus-outline" onClick={() => openForm()}>
                                    {t("Add beneficial owner")}
                                </VBtn>
                            )}
                        </div>
                    </div>
                    <MiniTable
                        ariaLabel={t("Beneficial owners")}
                        emptyLabel={t("No active beneficial owners")}
                        rows={visible.value}
                        rowKey={(row: MerchantOwnerRecord) => row.id}
                        columns={[
                            {
                                key: "name",
                                label: t("Name"),
                                render: (row: MerchantOwnerRecord) => (
                                    <span style={{ display: "flex", flexDirection: "column", gap: "2px", opacity: row.active ? 1 : 0.6 }}>
                                        <strong style={{ fontSize: "12.5px" }}>{row.fullNameAr}</strong>
                                        <span dir="ltr" style={{ fontSize: "11.5px", color: "var(--pg-ink-muted)" }}>{row.fullNameEn || "—"}</span>
                                    </span>
                                ),
                            },
                            { key: "role", label: t("Role"), render: (row: MerchantOwnerRecord) => t(row.role) },
                            { key: "percent", label: t("Ownership"), align: "end", render: (row: MerchantOwnerRecord) => (row.ownershipPercent ? `${row.ownershipPercent}%` : "—") },
                            { key: "nationality", label: t("Nationality"), render: (row: MerchantOwnerRecord) => row.nationality },
                            { key: "pep", label: t("PEP"), render: (row: MerchantOwnerRecord) => (row.pepDeclared ? <StatusBadge status="PEP" label={t("PEP")} toneOverride="danger" /> : <span style={{ color: "var(--pg-ink-faint)" }}>—</span>) },
                            { key: "screening", label: t("Screening"), render: (row: MerchantOwnerRecord) => <StatusBadge status={row.screeningStatus} toneOverride={toBadgeTone(row.screeningStatus)} /> },
                            {
                                key: "status",
                                label: t("Status"),
                                render: (row: MerchantOwnerRecord) =>
                                    row.active ? <StatusBadge status="ACTIVE" label={t("Active")} toneOverride="success" /> : <span title={formatDateTime(row.validTo ?? null)}><StatusBadge status="CLOSED" label={t("Deactivated")} toneOverride="neutral" /></span>,
                            },
                            {
                                key: "actions",
                                label: "",
                                align: "end",
                                render: (row: MerchantOwnerRecord) =>
                                    editable.value && row.active ? (
                                        <TableRowActions
                                            items={[
                                                { key: "edit", label: t("Edit"), icon: "mdi-pencil-outline", onClick: () => openForm(row) },
                                                { key: "deactivate", label: t("Deactivate"), icon: "mdi-account-off-outline", danger: true, dividerBefore: true, onClick: () => { deactivateError.value = ""; deactivating.value = row; } },
                                            ]}
                                        />
                                    ) : (
                                        <span style={{ color: "var(--pg-ink-faint)" }}>—</span>
                                    ),
                            },
                        ]}
                    />
                </SurfaceCardText>

                <FormModal
                    modelValue={formOpen.value}
                    onUpdate:modelValue={(value: boolean) => (formOpen.value = value)}
                    title={editingId.value ? t("Edit beneficial owner") : t("Add beneficial owner")}
                    size="md"
                    loading={saving.value}
                    errorMessage={formError.value}
                    submitLabel={t("Save")}
                    cancelLabel={t("Cancel")}
                    onSubmit={() => void save()}
                >
                    <VAlert type="info" variant="tonal" density="compact">
                        {t("The identity number is encrypted at rest, never shown again, and only its hash is used for duplicate detection. Changing identity details resets the screening status.")}
                    </VAlert>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
                        <FormField label={t("Full name (Arabic)")} required error={field("fullName")}>
                            <VTextField modelValue={form.value.fullName} onUpdate:modelValue={(value: string) => (form.value.fullName = value)} hideDetails />
                        </FormField>
                        <FormField label={t("Full name (English)")} error={field("fullNameEn")}>
                            <VTextField modelValue={form.value.fullNameEn} onUpdate:modelValue={(value: string) => (form.value.fullNameEn = value)} {...{ dir: "ltr" }} hideDetails />
                        </FormField>
                        <FormField label={t("Identity type")}>
                            <VSelect
                                modelValue={form.value.identityType}
                                onUpdate:modelValue={(value: OwnerForm["identityType"]) => (form.value.identityType = value)}
                                items={OWNER_IDENTITY_TYPES.map((type) => ({ title: t(type), value: type }))}
                                hideDetails
                            />
                        </FormField>
                        <FormField
                            label={editingId.value ? t("New identity number (optional)") : t("Identity number")}
                            required={!editingId.value}
                            error={field("identityNumber")}
                        >
                            <VTextField
                                modelValue={form.value.identityNumber}
                                onUpdate:modelValue={(value: string) => (form.value.identityNumber = value)}
                                type={revealIdentity.value ? "text" : "password"}
                                {...{ autocomplete: "off" }}
                                {...{ dir: "ltr" }}
                                appendInnerIcon={revealIdentity.value ? "mdi-eye-off-outline" : "mdi-eye-outline"}
                                onClick:appendInner={() => (revealIdentity.value = !revealIdentity.value)}
                                hideDetails
                            />
                        </FormField>
                        <FormField label={t("Nationality")} hint={t("Two-letter country code")} error={field("nationality")}>
                            <VTextField modelValue={form.value.nationality} onUpdate:modelValue={(value: string) => (form.value.nationality = value)} {...{ maxlength: 2 }} {...{ dir: "ltr" }} hideDetails />
                        </FormField>
                        <FormField label={t("Date of birth (YYYY-MM-DD)")} error={field("dateOfBirth")}>
                            <VTextField modelValue={form.value.dateOfBirth} onUpdate:modelValue={(value: string) => (form.value.dateOfBirth = value)} placeholder="1980-01-31" {...{ dir: "ltr" }} hideDetails />
                        </FormField>
                        <FormField label={t("Ownership percent")} error={field("ownershipPercent")}>
                            <VTextField modelValue={form.value.ownershipPercent} onUpdate:modelValue={(value: string) => (form.value.ownershipPercent = value)} {...{ dir: "ltr" }} hideDetails />
                        </FormField>
                        <FormField label={t("Role")}>
                            <VSelect
                                modelValue={form.value.role}
                                onUpdate:modelValue={(value: OwnerForm["role"]) => (form.value.role = value)}
                                items={OWNER_ROLES.map((role) => ({ title: t(role), value: role }))}
                                hideDetails
                            />
                        </FormField>
                    </div>
                    <VCheckbox
                        modelValue={form.value.pepDeclared}
                        onUpdate:modelValue={(value: boolean | null) => (form.value.pepDeclared = value === true)}
                        label={t("Declared PEP")}
                        density="compact"
                        hideDetails
                    />
                </FormModal>

                <FormModal
                    modelValue={deactivating.value !== null}
                    onUpdate:modelValue={(value: boolean) => {
                        if (!value) deactivating.value = null;
                    }}
                    title={t("Deactivate beneficial owner")}
                    size="sm"
                    danger
                    loading={saving.value}
                    errorMessage={deactivateError.value}
                    submitLabel={t("Deactivate")}
                    cancelLabel={t("Cancel")}
                    onSubmit={() => void deactivate()}
                >
                    <p style={{ margin: 0, fontSize: "13px", lineHeight: 1.5 }}>
                        {t("The owner is kept for the audit trail but no longer counts toward the ownership total. This cannot be undone from this screen.")}
                    </p>
                    {deactivating.value && <strong style={{ fontSize: "13px" }}>{deactivating.value.fullNameAr}</strong>}
                </FormModal>
            </SurfaceCard>
        );
    },
});

export default BeneficialOwnersCard;
