import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { VAlert, VBtn, VCard, VCardText, VChip, VDivider } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import FieldsSections from "@/components/FieldsSections";
import type { FieldProps } from "@/components/Field";
import { statusTone } from "@/components/Table/statusTone";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";

type UserDetail = {
    id: string;
    createdAt: string;
    updatedAt: string;
    merchantId: string | null;
    email: string;
    phone: string | null;
    role: string;
    authoritiesMap: unknown;
    appScopeIds: unknown;
    isMaker: boolean;
    isChecker: boolean;
    mfaRequired: boolean;
    status: string;
    invitedById: string | null;
    invitationExpiresAt: string | null;
    academyProgressJson: unknown;
};

type ApprovalHistoryRow = {
    id: string;
    subjectType: string;
    subjectId: string;
    state: string;
    mode: string;
    makerUserId: string;
    checkerUserId: string | null;
    makerReason: string | null;
    rejectionReason: string | null;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    maker: { id: string; email: string } | null;
    checker: { id: string; email: string } | null;
};

type AuditRow = {
    id: string;
    createdAt: string;
    action: string;
    role: string;
    entityType: string;
    entityId: string;
    beforeJson: Record<string, unknown> | null;
    afterJson: Record<string, unknown> | null;
    approvalRequestId: string | null;
};

type AcademyProgress = {
    completedLessonIds?: string[];
    completedLabIds?: Record<string, unknown>;
    earnedBadges?: string[];
    quizScores?: Record<string, unknown>;
    lastModuleId?: string;
    updatedAt?: string;
};

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

const authorityKeys = (map: unknown): string[] => {
    if (Array.isArray(map)) return map.filter((value): value is string => typeof value === "string");
    if (!map || typeof map !== "object") return [];
    const keys: string[] = [];
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
        if (value === true) keys.push(key);
        else if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === "string") keys.push(key.includes(":") ? key : `${key}:${item}`);
            }
        } else if (typeof value === "string") {
            keys.push(key.includes(":") ? key : `${key}:${value}`);
        }
    }
    return keys;
};

const auditValue = (value: unknown): string => {
    if (value === null || value === undefined) return "—";
    if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}…` : value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
        const text = JSON.stringify(value);
        return text.length > 80 ? `${text.slice(0, 77)}…` : text;
    } catch {
        return String(value);
    }
};

const auditChangeSummary = (entry: AuditRow): string => {
    const before = (entry.beforeJson ?? {}) as Record<string, unknown>;
    const after = (entry.afterJson ?? {}) as Record<string, unknown>;
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).slice(0, 4);
    if (keys.length === 0) return "";
    return keys.map((key) => `${key}: ${auditValue(before[key])} → ${auditValue(after[key])}`).join(" · ");
};

const field = (text: string, value: unknown, hint?: string, source?: string, copy = false): FieldProps => ({
    text,
    value: value === null || value === undefined ? "" : String(value),
    hint,
    source,
    copyOnClick: copy,
});

const UserDetailPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const user = ref<UserDetail | null>(null);
    const approvals = ref<ApprovalHistoryRow[]>([]);
    const auditTrail = ref<AuditRow[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);

    const userId = computed(() => String(route.params.id ?? ""));

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.userDetail(userId.value));
            const payload = response.data?.data ?? response.data ?? {};
            user.value = (payload.user ?? payload) as UserDetail;
            approvals.value = (payload.approvalHistory ?? []) as ApprovalHistoryRow[];
            auditTrail.value = (payload.auditTrail ?? []) as AuditRow[];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            user.value = null;
        } finally {
            loading.value = false;
        }
    };

    watch(userId, () => void load());
    void load();

    const authorityList = computed(() => (user.value ? authorityKeys(user.value.authoritiesMap) : []));
    const academy = computed<AcademyProgress>(() => {
        const value = user.value?.academyProgressJson;
        return value && typeof value === "object" && !Array.isArray(value) ? (value as AcademyProgress) : {};
    });

    const sections = computed(() => {
        const entry = user.value;
        if (!entry) return [];
        return [
            {
                title: t("Account"),
                fields: [
                    field("User ID", entry.id, "Internal user identifier.", "users.id", true),
                    field("Email", entry.email, "Sign-in identifier.", "users.email", true),
                    field("Phone", entry.phone, "Optional phone number.", "users.phone", true),
                    field("Role", entry.role, "Primary role used by route guards.", "users.role"),
                    field("Status", entry.status, "Account lifecycle state.", "users.status"),
                    field("Maker", entry.isMaker ? t("Yes") : t("No"), "Allowed to create approval proposals.", "users.is_maker"),
                    field("Checker", entry.isChecker ? t("Yes") : t("No"), "Allowed to approve proposals.", "users.is_checker"),
                    field("MFA required", entry.mfaRequired ? t("Yes") : t("No"), "MFA enforcement flag.", "users.mfa_required"),
                ],
            },
            {
                title: t("Lifecycle"),
                fields: [
                    field("Created", formatDateTime(entry.createdAt), "Account creation time.", "users.created_at"),
                    field("Updated", formatDateTime(entry.updatedAt), "Last account update.", "users.updated_at"),
                    field("Invited by", entry.invitedById, "Inviting user identifier.", "users.invited_by", true),
                    field("Invitation expires", formatDateTime(entry.invitationExpiresAt), "Invitation deadline.", "users.invitation_expires_at"),
                    field("Merchant scope", entry.merchantId, "Empty for internal users.", "users.merchant_id", true),
                    field("Application scopes", Array.isArray(entry.appScopeIds) ? entry.appScopeIds.join(", ") : "—", "Restricted application access.", "users.app_scope_ids"),
                ],
            },
        ];
    });

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Admin User")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="text" prependIcon="mdi-arrow-left" onClick={() => void router.push({ name: "AdminUsers" })}>{t("Back to users")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>{t("Refresh")}</VBtn>
                        </ThemedView>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : user.value ? (
                    <>
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>{user.value.email}</ThemedText>
                            <StatusChip label={user.value.status} tone={statusTone(user.value.status)} />
                            <StatusChip label={user.value.role.replaceAll("_", " ")} tone="info" />
                            {user.value.isMaker && <VChip size="small" variant="tonal" color="primary">{t("Maker")}</VChip>}
                            {user.value.isChecker && <VChip size="small" variant="tonal" color="secondary">{t("Checker")}</VChip>}
                        </ThemedView>

                        <VCard variant="flat" style={{ borderRadius: "16px" }}>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Access summary")}</ThemedText>
                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
                                    {[
                                        { label: t("Authorities"), value: String(authorityList.value.length) },
                                        { label: t("Approvals"), value: String(approvals.value.length) },
                                        { label: t("Audit events"), value: String(auditTrail.value.length) },
                                        { label: t("Academy lessons"), value: String(academy.value.completedLessonIds?.length ?? 0) },
                                    ].map((item) => (
                                        <VCard key={item.label} variant="tonal">
                                            <VCardText style={{ padding: "12px" }}>
                                                <ThemedText style={{ fontSize: "11px", opacity: 0.62 }}>{item.label}</ThemedText>
                                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{item.value}</ThemedText>
                                            </VCardText>
                                        </VCard>
                                    ))}
                                </ThemedView>
                            </VCardText>
                        </VCard>

                        <FieldsSections sections={sections.value} />

                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Authorities")}</ThemedText>
                                {authorityList.value.length === 0 && <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No authorities assigned.")}</ThemedText>}
                                <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                    {authorityList.value.map((key) => (
                                        <VChip key={key} size="x-small" variant="tonal" style={{ direction: "ltr" }}>{key}</VChip>
                                    ))}
                                </ThemedView>
                            </VCardText>
                        </VCard>

                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "16px", flex: 1 }}>{t("Recent approvals")}</ThemedText>
                                    <StatusChip label={`${approvals.value.length}`} tone="neutral" size="x-small" />
                                </ThemedView>
                                {approvals.value.length === 0 && <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No approval activity.")}</ThemedText>}
                                {approvals.value.map((approval) => (
                                    <ThemedView key={approval.id} style={{ gap: "3px", padding: "8px 10px", borderRadius: "8px", border: "1px solid rgba(100,116,139,0.2)" }}>
                                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                            <ThemedText style={{ fontSize: "12px", fontWeight: 700, direction: "ltr" }}>{approval.subjectType}</ThemedText>
                                            <StatusChip label={approval.state} tone={statusTone(approval.state)} size="x-small" />
                                            <StatusChip label={approval.mode} tone="neutral" size="x-small" />
                                            <div style={{ flex: 1 }} />
                                            <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{formatDateTime(approval.createdAt)}</ThemedText>
                                        </ThemedView>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>
                                            {approval.maker?.email ?? approval.makerUserId} → {approval.checker?.email ?? approval.checkerUserId ?? "—"}
                                        </ThemedText>
                                    </ThemedView>
                                ))}
                            </VCardText>
                        </VCard>

                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Academy progress")}</ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                    <StatusChip label={`${academy.value.completedLessonIds?.length ?? 0} ${t("lessons")}`} tone="info" size="x-small" />
                                    <StatusChip label={`${Object.keys(academy.value.completedLabIds ?? {}).length} ${t("labs")}`} tone="success" size="x-small" />
                                    <StatusChip label={`${academy.value.earnedBadges?.length ?? 0} ${t("badges")}`} tone="primary" size="x-small" />
                                    <StatusChip label={`${Object.keys(academy.value.quizScores ?? {}).length} ${t("quizzes")}`} tone="warning" size="x-small" />
                                </ThemedView>
                                {(academy.value.earnedBadges ?? []).length > 0 && (
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                        {(academy.value.earnedBadges ?? []).map((badge) => (
                                            <VChip key={badge} size="x-small" variant="tonal" color="primary">{badge}</VChip>
                                        ))}
                                    </ThemedView>
                                )}
                                <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>{t("Last academy update")}: {formatDateTime(academy.value.updatedAt)}</ThemedText>
                            </VCardText>
                        </VCard>

                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Audit trail")}</ThemedText>
                                <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("Last 50 actions performed by this user.")}</ThemedText>
                                {auditTrail.value.length === 0 && <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No audit events recorded yet.")}</ThemedText>}
                                {auditTrail.value.map((event) => {
                                    const change = auditChangeSummary(event);
                                    return (
                                        <ThemedView key={event.id} style={{ gap: "3px", padding: "8px 10px", borderRadius: "8px", border: "1px solid rgba(100,116,139,0.2)" }}>
                                            <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                                <ThemedText style={{ fontSize: "12px", fontWeight: 700, direction: "ltr" }}>{event.action.replaceAll("_", " ")}</ThemedText>
                                                <StatusChip label={event.role} tone="info" size="x-small" />
                                                <div style={{ flex: 1 }} />
                                                <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{formatDateTime(event.createdAt)}</ThemedText>
                                            </ThemedView>
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>
                                                {event.entityType} · {event.entityId}
                                            </ThemedText>
                                            {change && <ThemedText style={{ fontSize: "11px", opacity: 0.75, direction: "ltr" }}>{change}</ThemedText>}
                                        </ThemedView>
                                    );
                                })}
                            </VCardText>
                        </VCard>
                    </>
                ) : null}
            </ThemedView>
        </ScreenContainer>
    );
});

export default UserDetailPage;
