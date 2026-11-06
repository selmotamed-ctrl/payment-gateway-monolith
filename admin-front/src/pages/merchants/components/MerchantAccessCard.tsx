import { defineComponent, ref, type PropType, type VNodeChild } from "vue";
import { useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { MonoRef } from "@/components/ui/MonoRef";
import { notifyOutcome, reportCommerceError, runGoverned } from "../governedRequest";
import type { MerchantCredentialSet, MerchantToken, MerchantUser } from "../types";
import ReasonModal from "./ReasonModal";
import { MiniTable, formatDateTime, toBadgeTone } from "./commerceBits";

/**
 * Merchant users, API tokens and credential sets as navigable rows: users open
 * the admin user detail, credential sets open the vault highlighted, active
 * tokens can be revoked (immediate, irreversible, reason required).
 */
export const MerchantAccessCard = defineComponent({
    name: "MerchantAccessCard",
    props: {
        users: { type: Array as PropType<MerchantUser[]>, default: () => [] },
        tokens: { type: Array as PropType<MerchantToken[]>, default: () => [] },
        credentialSets: { type: Array as PropType<MerchantCredentialSet[]>, default: () => [] },
        canWrite: { type: Boolean, default: false },
    },
    emits: ["changed"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const router = useRouter();
        const revoking = ref<MerchantToken | null>(null);
        const submitting = ref(false);
        const modalError = ref("");

        const revoke = async (reason: string) => {
            const token = revoking.value;
            if (!token) return;
            submitting.value = true;
            modalError.value = "";
            try {
                const outcome = await runGoverned(() => api.post(urlsMap.applicationRevokeToken(token.applicationId, token.id), { reason }));
                notifyOutcome(outcome, "Access token revoked");
                revoking.value = null;
                emit("changed");
            } catch (cause) {
                modalError.value = reportCommerceError(cause);
            } finally {
                submitting.value = false;
            }
        };

        const heading = (label: string) => <h3 style={{ margin: 0, fontSize: "13px", fontWeight: 600 }}>{label}</h3>;

        return (): VNodeChild => (
            <SurfaceCard>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                    <div style={{ fontSize: "16px", fontWeight: 600 }}>{t("Merchant users and access")}</div>

                    <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        {heading(t("Users"))}
                        <MiniTable
                            ariaLabel={t("Users")}
                            emptyLabel={t("No merchant users")}
                            rows={props.users}
                            rowKey={(row: MerchantUser) => row.id}
                            columns={[
                                {
                                    key: "email",
                                    label: t("User"),
                                    render: (row: MerchantUser) => (
                                        <VBtn size="small" variant="text" style={{ textTransform: "none", paddingInline: "4px" }} onClick={() => void router.push({ name: "AdminUserDetail", params: { id: row.id } })}>
                                            <span dir="ltr">{row.email}</span>
                                        </VBtn>
                                    ),
                                },
                                { key: "role", label: t("Role"), render: (row: MerchantUser) => row.role },
                                { key: "status", label: t("Status"), render: (row: MerchantUser) => <StatusBadge status={row.status} toneOverride={toBadgeTone(row.status)} /> },
                                { key: "mfa", label: t("MFA"), render: (row: MerchantUser) => (row.mfaRequired ? t("Required") : t("Optional")) },
                            ]}
                        />
                    </section>

                    <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        {heading(t("API tokens"))}
                        <MiniTable
                            ariaLabel={t("API tokens")}
                            emptyLabel={t("No access tokens")}
                            rows={props.tokens}
                            rowKey={(row: MerchantToken) => row.id}
                            columns={[
                                {
                                    key: "name",
                                    label: t("Token"),
                                    render: (row: MerchantToken) => (
                                        <span style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                            <strong style={{ fontSize: "12.5px" }}>{row.name}</strong>
                                            <span dir="ltr" style={{ fontFamily: "var(--pg-font-mono)", fontSize: "11.5px", color: "var(--pg-ink-muted)" }}>{`****${row.lastFour}`}</span>
                                        </span>
                                    ),
                                },
                                { key: "status", label: t("Status"), render: (row: MerchantToken) => <StatusBadge status={row.revokedAt ? "REVOKED" : "ACTIVE"} label={row.revokedAt ? t("Revoked") : t("Active")} toneOverride={row.revokedAt ? "danger" : "success"} /> },
                                { key: "lastUsed", label: t("Last used"), render: (row: MerchantToken) => formatDateTime(row.lastUsedAt) },
                                {
                                    key: "actions",
                                    label: "",
                                    align: "end",
                                    render: (row: MerchantToken) =>
                                        props.canWrite && !row.revokedAt ? (
                                            <VBtn
                                                size="small"
                                                variant="tonal"
                                                color="error"
                                                prependIcon="mdi-key-remove"
                                                onClick={() => {
                                                    modalError.value = "";
                                                    revoking.value = row;
                                                }}
                                            >
                                                {t("Revoke token")}
                                            </VBtn>
                                        ) : (
                                            <span style={{ color: "var(--pg-ink-faint)" }}>—</span>
                                        ),
                                },
                            ]}
                        />
                    </section>

                    <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        {heading(t("Credential sets"))}
                        <MiniTable
                            ariaLabel={t("Credential sets")}
                            emptyLabel={t("No credential sets")}
                            rows={props.credentialSets}
                            rowKey={(row: MerchantCredentialSet) => row.id}
                            columns={[
                                { key: "id", label: t("Credential set"), render: (row: MerchantCredentialSet) => <MonoRef value={row.id} truncate={12} /> },
                                { key: "env", label: t("Environment"), render: (row: MerchantCredentialSet) => row.env },
                                { key: "status", label: t("Status"), render: (row: MerchantCredentialSet) => <StatusBadge status={row.status} toneOverride={toBadgeTone(row.status)} /> },
                                {
                                    key: "actions",
                                    label: "",
                                    align: "end",
                                    render: (row: MerchantCredentialSet) => (
                                        <VBtn
                                            size="small"
                                            variant="text"
                                            prependIcon="mdi-open-in-new"
                                            onClick={() => void router.push({ name: "CredentialSets", query: { highlight: row.id } })}
                                        >
                                            {t("Open in vault")}
                                        </VBtn>
                                    ),
                                },
                            ]}
                        />
                    </section>
                </SurfaceCardText>

                <ReasonModal
                    modelValue={revoking.value !== null}
                    onUpdate:modelValue={(value: boolean) => {
                        if (!value) revoking.value = null;
                    }}
                    title={revoking.value ? `${t("Revoke token")} · ${revoking.value.name}` : ""}
                    description={t("A revoked token stops working at once and cannot be restored. The merchant must create a new one.")}
                    mode="immediate"
                    danger
                    submitLabel={t("Revoke token")}
                    loading={submitting.value}
                    errorMessage={modalError.value}
                    onSubmit={(reason: string) => void revoke(reason)}
                />
            </SurfaceCard>
        );
    },
});

export default MerchantAccessCard;
