import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { VBtn } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { DescriptionList, type DescriptionItem } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";
import { statusTone } from "@/components/Table/statusTone";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";

import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { MetaPill } from "@/components/ui/MetaPill";
import { describeAuditChange } from "@/utils/auditSummary";
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

type AcademySummary = {
    lessons: number;
    labs: number;
    exams: number;
    badges: { id: string; track: string; expiresAt: string; expired: boolean }[];
    updatedAt?: string;
};

const isRec = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Reads the new `AcademyProgress` (schema 1); null / legacy rows show zeros. */
const summariseAcademy = (value: unknown): AcademySummary => {
    if (!isRec(value) || value.schema !== 1) return { lessons: 0, labs: 0, exams: 0, badges: [] };
    const labs = isRec(value.labs) ? Object.values(value.labs) : [];
    const exams = isRec(value.exams) ? Object.values(value.exams) : [];
    const badges = Array.isArray(value.badges) ? value.badges : [];
    const now = Date.now();
    return {
        lessons: isRec(value.lessons) ? Object.keys(value.lessons).length : 0,
        labs: labs.filter((lab) => isRec(lab) && Boolean(lab.passedAt)).length,
        exams: exams.filter((exam) => isRec(exam) && Boolean(exam.passedAt)).length,
        badges: badges.filter(isRec).map((badge) => ({
            id: String(badge.id ?? ""),
            track: String(badge.track ?? ""),
            expiresAt: String(badge.expiresAt ?? ""),
            expired: Date.parse(String(badge.expiresAt ?? "")) <= now,
        })),
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
    };
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

const auditChangeSummary = (entry: { beforeJson?: unknown; afterJson?: unknown }): string =>
    describeAuditChange(entry.beforeJson, entry.afterJson);

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
    const academy = computed<AcademySummary>(() => summariseAcademy(user.value?.academyProgressJson));

    const accountItems = computed<DescriptionItem[]>(() => {
        const entry = user.value;
        if (!entry) return [];
        return [
            { label: t("User ID"), value: <MonoRef value={entry.id} /> },
            { label: t("Email"), value: entry.email },
            { label: t("Phone"), value: entry.phone ?? "—" },
            { label: t("Role"), value: entry.role },
            { label: t("Status"), value: entry.status },
            { label: t("Maker"), value: entry.isMaker ? t("Yes") : t("No") },
            { label: t("Checker"), value: entry.isChecker ? t("Yes") : t("No") },
            { label: t("MFA required"), value: entry.mfaRequired ? t("Yes") : t("No") },
        ];
    });

    const lifecycleItems = computed<DescriptionItem[]>(() => {
        const entry = user.value;
        if (!entry) return [];
        return [
            { label: t("Created"), value: formatDateTime(entry.createdAt) },
            { label: t("Updated"), value: formatDateTime(entry.updatedAt) },
            { label: t("Invited by"), value: entry.invitedById ? <MonoRef value={entry.invitedById} /> : "—" },
            { label: t("Invitation expires"), value: formatDateTime(entry.invitationExpiresAt) },
            { label: t("Merchant scope"), value: entry.merchantId ? <MonoRef value={entry.merchantId} /> : "—" },
            { label: t("Application scopes"), value: Array.isArray(entry.appScopeIds) ? entry.appScopeIds.join(", ") : "—" },
        ];
    });

    const metricItems = computed<MetricItem[]>(() => [
        { key: "authorities", label: t("Authorities"), value: String(authorityList.value.length) },
        { key: "approvals", label: t("Approvals"), value: String(approvals.value.length) },
        { key: "audit", label: t("Audit events"), value: String(auditTrail.value.length) },
        { key: "academy", label: t("Academy lessons"), value: String(academy.value.lessons) },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Admin User")}
                    subtitle={t("Operator identity, authorities, and audited access history.")}
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
                            <StatusBadge status={user.value.status} toneOverride={statusTone(user.value.status) === "error" ? "danger" : (statusTone(user.value.status) as any)} />
                            <StatusBadge status={user.value.role} label={user.value.role.replaceAll("_", " ")} toneOverride="info" showDot={false} />
                            {user.value.isMaker && <StatusBadge status="MAKER" label={t("Maker")} toneOverride="info" showDot={false} />}
                            {user.value.isChecker && <StatusBadge status="CHECKER" label={t("Checker")} toneOverride="neutral" showDot={false} />}
                        </ThemedView>

                        <MetricStrip items={metricItems.value} />

                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Account")}</ThemedText>
                                <DescriptionList columns={2} items={accountItems.value} />
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px", marginTop: "8px" }}>{t("Lifecycle")}</ThemedText>
                                <DescriptionList columns={2} items={lifecycleItems.value} />
                            </SurfaceCardText>
                        </SurfaceCard>

                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Authorities")}</ThemedText>
                                {authorityList.value.length === 0 && <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No authorities assigned.")}</ThemedText>}
                                <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                    {authorityList.value.map((key) => (
                                        <MetaPill key={key} size="x-small" variant="tonal" style={{ direction: "ltr" }}>{key}</MetaPill>
                                    ))}
                                </ThemedView>
                            </SurfaceCardText>
                        </SurfaceCard>

                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "16px", flex: 1 }}>{t("Recent approvals")}</ThemedText>
                                    <MetaPill size="x-small" variant="tonal">{approvals.value.length}</MetaPill>
                                </ThemedView>
                                {approvals.value.length === 0 && <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No approval activity.")}</ThemedText>}
                                {approvals.value.map((approval) => (
                                    <ThemedView key={approval.id} style={{ display: "flex", flexDirection: "column", gap: "3px", padding: "8px 10px", borderRadius: "var(--pg-radius-sm)", border: "1px solid var(--pg-border-subtle)" }}>
                                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                            <ThemedText style={{ fontSize: "12px", fontWeight: 600, direction: "ltr" }}>{approval.subjectType}</ThemedText>
                                            <StatusBadge status={approval.state} toneOverride={statusTone(approval.state) === "error" ? "danger" : (statusTone(approval.state) as any)} showDot={false} />
                                            <MetaPill size="x-small" variant="tonal">{approval.mode}</MetaPill>
                                            <div style={{ flex: 1 }} />
                                            <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{formatDateTime(approval.createdAt)}</ThemedText>
                                        </ThemedView>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>
                                            {approval.maker?.email ?? approval.makerUserId} → {approval.checker?.email ?? approval.checkerUserId ?? "—"}
                                        </ThemedText>
                                    </ThemedView>
                                ))}
                            </SurfaceCardText>
                        </SurfaceCard>

                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Academy progress")}</ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                    <MetaPill size="x-small" variant="tonal" color="info">{academy.value.lessons} {t("lessons")}</MetaPill>
                                    <MetaPill size="x-small" variant="tonal" color="success">{academy.value.labs} {t("labs passed")}</MetaPill>
                                    <MetaPill size="x-small" variant="tonal" color="warning">{academy.value.exams} {t("exams passed")}</MetaPill>
                                    <MetaPill size="x-small" variant="tonal" color="primary">{academy.value.badges.length} {t("badges")}</MetaPill>
                                </ThemedView>
                                {academy.value.badges.length > 0 && (
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                        {academy.value.badges.map((badge) => (
                                            <MetaPill key={badge.id} size="x-small" variant="tonal" color={badge.expired ? "error" : "primary"}>
                                                {badge.track} · {badge.expired ? `✕ ${t("expired")}` : t("valid until")} {formatDateTime(badge.expiresAt)}
                                            </MetaPill>
                                        ))}
                                    </ThemedView>
                                )}
                                <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>{t("Last academy update")}: {formatDateTime(academy.value.updatedAt)}</ThemedText>
                            </SurfaceCardText>
                        </SurfaceCard>

                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Audit trail")}</ThemedText>
                                <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("Last 50 actions performed by this user.")}</ThemedText>
                                {auditTrail.value.length === 0 && <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No audit events recorded yet.")}</ThemedText>}
                                {auditTrail.value.map((event) => {
                                    const change = auditChangeSummary(event);
                                    return (
                                        <ThemedView key={event.id} style={{ display: "flex", flexDirection: "column", gap: "3px", padding: "8px 10px", borderRadius: "var(--pg-radius-sm)", border: "1px solid var(--pg-border-subtle)" }}>
                                            <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                                <ThemedText style={{ fontSize: "12px", fontWeight: 600, direction: "ltr" }}>{event.action.replaceAll("_", " ")}</ThemedText>
                                                <StatusBadge status={event.role} toneOverride="info" showDot={false} />
                                                <div style={{ flex: 1 }} />
                                                <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{formatDateTime(event.createdAt)}</ThemedText>
                                            </ThemedView>
                                            <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                                                <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>{event.entityType}</ThemedText>
                                                <MonoRef value={event.entityId} truncate={18} />
                                            </ThemedView>
                                            {change && <ThemedText style={{ fontSize: "11px", opacity: 0.75, direction: "ltr" }}>{change}</ThemedText>}
                                        </ThemedView>
                                    );
                                })}
                            </SurfaceCardText>
                        </SurfaceCard>
                    </>
                ) : null}
            </ThemedView>
        </ScreenContainer>
    );
});

export default UserDetailPage;
