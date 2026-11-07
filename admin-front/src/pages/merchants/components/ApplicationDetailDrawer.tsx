import { computed, defineComponent, ref, watch, type PropType, type VNodeChild } from "vue";
import { useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { StateView } from "@/components/StateView";
import { TableRowActions } from "@/components/Table/TableRowActions";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
    applicationActionsFor,
    paymentLinkActionsFor,
    posActionsFor,
    railWhitelistModeOf,
    tokenActionsFor,
    type EntityAction,
} from "@/pages/applications/applicationActions";
import { isRestricted, type GovernanceMode } from "../commerceGovernance";
import { notifyOutcome, reportCommerceError, runGoverned } from "../governedRequest";
import ApplicationPolicyModal, { type PolicyApplication } from "./ApplicationPolicyModal";
import ReasonModal from "./ReasonModal";
import {
    ApprovalSubmittedNotice,
    MiniTable,
    MoneyOrRestricted,
    PendingApprovalsList,
    PillList,
    RestrictedValue,
    formatDateTime,
    toBadgeTone,
    type PendingApprovalRow,
} from "./commerceBits";

export type ApplicationToken = {
    id: string;
    name: string;
    lastFour: string;
    scopes: string[];
    ipWhitelistEnabled: boolean;
    cidrs: string[];
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    status: "ACTIVE" | "REVOKED" | "EXPIRED";
    createdAt: string;
};

export type ApplicationLinkRow = {
    id: string;
    key: string;
    amount: string;
    currency: string;
    feeBearer: string;
    infiniteUse: boolean;
    useCount: number;
    confirmedCount: number;
    activeLockedCount: number;
    state: string;
    expiresAt: string | null;
    createdAt: string;
};

export type ApplicationPosRow = {
    id: string;
    name: string;
    location: string | null;
    status: string;
    screenCount: number;
    lastActiveAt: string | null;
    createdAt: string;
};

export type ApplicationDetail = {
    id: string;
    name: string;
    merchantId: string;
    merchant: { id: string; legalName: string; tradeName: string };
    status: string;
    assignedWalletId: string;
    assignedWallet: { id: string; currency: string; status: string };
    expectedMonthlyVolume: string | null;
    railWhitelist: string[] | null;
    railWhitelistMode: "ALL" | "NONE" | "LIST";
    railWhitelistCount: number;
    redirectDomains: string[];
    accessTokenCount: number;
    paymentLinkCount: number;
    posTerminalCount: number;
    createdAt: string;
    updatedAt: string;
    redactedFields: string[];
    accessTokens: ApplicationToken[];
    paymentLinks: ApplicationLinkRow[];
    posTerminals: ApplicationPosRow[];
    pendingApprovals: PendingApprovalRow[];
};

type ApplicationTab = "config" | "tokens" | "links" | "pos";

type PendingTarget =
    | { kind: "application"; action: EntityAction }
    | { kind: "token"; action: EntityAction; id: string; name: string }
    | { kind: "link"; action: EntityAction; id: string; name: string }
    | { kind: "pos"; action: EntityAction; id: string; name: string };

const APPLIED_MESSAGE: Record<PendingTarget["kind"], string> = {
    application: "Application suspended",
    token: "Access token revoked",
    link: "Payment link cancelled",
    pos: "POS terminal updated",
};

/**
 * Application inspector. Open when `applicationId` is set; emits `close` and
 * `changed`. Restrictive actions (suspend, revoke a token, cancel a link,
 * deactivate/block a terminal) are immediate and need a reason; loosening
 * actions (reactivate, policy edit, POS reactivation) become approval requests.
 */
export const ApplicationDetailDrawer = defineComponent({
    name: "ApplicationDetailDrawer",
    props: {
        applicationId: { type: String as PropType<string | null>, default: null },
    },
    emits: ["close", "changed"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const router = useRouter();
        const application = ref<ApplicationDetail | null>(null);
        const loading = ref(false);
        const error = ref<string | null>(null);
        const tab = ref<ApplicationTab>("config");
        const notice = ref<{ approvalRequestId: string | null } | null>(null);
        const pendingTarget = ref<PendingTarget | null>(null);
        const policyOpen = ref(false);
        const submitting = ref(false);
        const modalError = ref("");
        let sequence = 0;

        const canWrite = computed(() => hasOneOfAuthorities(["merchant:write"]));

        const load = async (id: string) => {
            const current = ++sequence;
            loading.value = true;
            error.value = null;
            try {
                const response = await api.get(urlsMap.applicationDetail(id));
                if (current !== sequence) return;
                const payload = response.data?.data ?? response.data ?? {};
                application.value = (payload.application ?? payload) as ApplicationDetail;
            } catch (cause) {
                if (current !== sequence) return;
                error.value = extractApiErrorMessage(cause);
                application.value = null;
            } finally {
                if (current === sequence) loading.value = false;
            }
        };

        watch(
            () => props.applicationId,
            (id) => {
                tab.value = "config";
                notice.value = null;
                pendingTarget.value = null;
                policyOpen.value = false;
                if (id) {
                    application.value = null;
                    void load(id);
                } else {
                    sequence += 1;
                    application.value = null;
                    error.value = null;
                }
            },
            { immediate: true },
        );

        const hasPending = computed(() => (application.value?.pendingApprovals.length ?? 0) > 0);
        const actions = computed(() =>
            application.value ? applicationActionsFor(application.value.status, { canWrite: canWrite.value, hasPendingApproval: hasPending.value }) : [],
        );

        const policyApplication = computed<PolicyApplication | null>(() => {
            const current = application.value;
            if (!current) return null;
            return {
                id: current.id,
                merchantId: current.merchantId,
                assignedWalletId: current.assignedWalletId,
                assignedWallet: current.assignedWallet,
                railWhitelist: current.railWhitelist,
                redirectDomains: current.redirectDomains,
                redactedFields: current.redactedFields,
            };
        });

        const runAction = (action: EntityAction) => {
            if (action.key === "editPolicy") {
                policyOpen.value = true;
                return;
            }
            modalError.value = "";
            pendingTarget.value = { kind: "application", action };
        };

        const afterMutation = async (outcome: Awaited<ReturnType<typeof runGoverned>>) => {
            notice.value = outcome.kind === "approval" ? { approvalRequestId: outcome.approvalRequestId } : null;
            if (props.applicationId) await load(props.applicationId);
            emit("changed");
        };

        const submit = async (reason: string) => {
            const target = pendingTarget.value;
            const current = application.value;
            if (!target || !current) return;
            submitting.value = true;
            modalError.value = "";
            try {
                const outcome = await runGoverned(() => {
                    if (target.kind === "application") {
                        return api.patch(urlsMap.applicationDetail(current.id), { status: target.action.target, reason });
                    }
                    if (target.kind === "token") return api.post(urlsMap.applicationRevokeToken(current.id, target.id), { reason });
                    if (target.kind === "link") return api.post(urlsMap.paymentLinkState(target.id), { state: "CANCELLED", reason });
                    return api.post(urlsMap.posTerminalStatus(target.id), { status: target.action.target, reason });
                });
                notifyOutcome(outcome, APPLIED_MESSAGE[target.kind]);
                pendingTarget.value = null;
                await afterMutation(outcome);
            } catch (cause) {
                modalError.value = reportCommerceError(cause);
            } finally {
                submitting.value = false;
            }
        };

        const rowActions = (items: EntityAction[], toTarget: (action: EntityAction) => PendingTarget) =>
            items.length === 0 ? (
                <span style={{ color: "var(--pg-ink-faint)" }}>—</span>
            ) : (
                <TableRowActions
                    items={items.map((action) => ({
                        key: action.key,
                        label: t(action.label),
                        icon: action.icon,
                        danger: action.danger,
                        disabled: action.disabled,
                        onClick: () => {
                            modalError.value = "";
                            pendingTarget.value = toTarget(action);
                        },
                    }))}
                />
            );

        const renderConfig = (current: ApplicationDetail): VNodeChild => {
            const mode = railWhitelistModeOf(current.railWhitelist);
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                    {notice.value && <ApprovalSubmittedNotice approvalRequestId={notice.value.approvalRequestId} onDismiss={() => (notice.value = null)} />}
                    {current.pendingApprovals.length > 0 && (
                        <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <h3 style={{ margin: 0, fontSize: "13px", fontWeight: 600 }}>{t("Pending approvals")}</h3>
                            <PendingApprovalsList approvals={current.pendingApprovals} />
                        </section>
                    )}
                    <DescriptionList
                        items={[
                            { label: t("Application ID"), value: <MonoRef value={current.id} /> },
                            { label: t("Name"), value: current.name },
                            { label: t("Status"), value: <StatusBadge status={current.status} toneOverride={toBadgeTone(current.status)} /> },
                            {
                                label: t("Merchant"),
                                value: (
                                    <VBtn size="small" variant="text" style={{ paddingInline: "4px", textTransform: "none" }} onClick={() => void router.push({ name: "MerchantDetail", params: { id: current.merchantId } })}>
                                        {current.merchant.tradeName || current.merchant.legalName}
                                    </VBtn>
                                ),
                            },
                            {
                                label: t("Settlement wallet"),
                                value: (
                                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                                        <MonoRef value={current.assignedWallet.id} truncate={14} />
                                        <span>{current.assignedWallet.currency}</span>
                                        <StatusBadge status={current.assignedWallet.status} toneOverride={toBadgeTone(current.assignedWallet.status)} />
                                        <VBtn
                                            size="x-small"
                                            variant="text"
                                            icon="mdi-open-in-new"
                                            aria-label={t("Open wallet")}
                                            onClick={() => void router.push({ name: "WalletDetail", params: { id: current.assignedWallet.id } })}
                                        />
                                    </span>
                                ),
                            },
                            {
                                label: t("Expected monthly volume"),
                                value: <MoneyOrRestricted amount={current.expectedMonthlyVolume} currency={current.assignedWallet.currency} restricted={isRestricted(current.redactedFields, "expectedMonthlyVolume", current.expectedMonthlyVolume)} />,
                            },
                            { label: t("Created"), value: formatDateTime(current.createdAt) },
                            { label: t("Last updated"), value: formatDateTime(current.updatedAt) },
                        ]}
                    />
                    <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <h3 style={{ margin: 0, fontSize: "13px", fontWeight: 600 }}>{t("Rail whitelist")}</h3>
                        {mode === "ALL" && <StatusBadge status="ACTIVE" label={t("All active rails allowed")} toneOverride="success" />}
                        {mode === "NONE" && <StatusBadge status="BLOCKED" label={t("No rails allowed")} toneOverride="warning" />}
                        {mode === "LIST" && <PillList items={current.railWhitelist ?? []} />}
                    </section>
                    <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <h3 style={{ margin: 0, fontSize: "13px", fontWeight: 600 }}>{t("Redirect domains")}</h3>
                        {isRestricted(current.redactedFields, "redirectDomains") ? (
                            <RestrictedValue />
                        ) : (
                            <PillList items={current.redirectDomains} emptyLabel={t("No redirect domains")} />
                        )}
                    </section>
                </div>
            );
        };

        const renderTokens = (current: ApplicationDetail): VNodeChild => (
            <MiniTable
                ariaLabel={t("API tokens")}
                emptyLabel={t("This application has no access tokens")}
                rows={current.accessTokens}
                rowKey={(row: ApplicationToken) => row.id}
                columns={[
                    {
                        key: "name",
                        label: t("Token"),
                        render: (row: ApplicationToken) => (
                            <span style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <strong style={{ fontSize: "12.5px" }}>{row.name}</strong>
                                <span dir="ltr" style={{ fontFamily: "var(--pg-font-mono)", fontSize: "11.5px", color: "var(--pg-ink-muted)" }}>{`****${row.lastFour}`}</span>
                            </span>
                        ),
                    },
                    { key: "scopes", label: t("Scopes"), render: (row: ApplicationToken) => <PillList items={row.scopes} max={3} emptyLabel="—" /> },
                    {
                        key: "ip",
                        label: t("IP allowlist"),
                        render: (row: ApplicationToken) =>
                            row.ipWhitelistEnabled ? <PillList items={row.cidrs} max={2} emptyLabel={t("Enabled, no CIDR")} /> : <span style={{ color: "var(--pg-ink-muted)" }}>{t("Not restricted")}</span>,
                    },
                    { key: "lastUsed", label: t("Last used"), render: (row: ApplicationToken) => formatDateTime(row.lastUsedAt) },
                    { key: "expires", label: t("Expires"), render: (row: ApplicationToken) => formatDateTime(row.expiresAt) },
                    { key: "status", label: t("Status"), render: (row: ApplicationToken) => <StatusBadge status={row.status} toneOverride={toBadgeTone(row.status)} /> },
                    {
                        key: "actions",
                        label: "",
                        align: "end",
                        render: (row: ApplicationToken) =>
                            rowActions(tokenActionsFor(row.status, canWrite.value), (action) => ({ kind: "token", action, id: row.id, name: `${row.name} ****${row.lastFour}` })),
                    },
                ]}
            />
        );

        const renderLinks = (current: ApplicationDetail): VNodeChild => (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <MiniTable
                    ariaLabel={t("Payment links")}
                    emptyLabel={t("This application has no payment links")}
                    rows={current.paymentLinks}
                    rowKey={(row: ApplicationLinkRow) => row.id}
                    columns={[
                        { key: "key", label: t("Link"), render: (row: ApplicationLinkRow) => <MonoRef value={row.key} truncate={14} /> },
                        { key: "amount", label: t("Amount"), align: "end", render: (row: ApplicationLinkRow) => <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" /> },
                        {
                            key: "uses",
                            label: t("Uses"),
                            render: (row: ApplicationLinkRow) => (
                                <span title={`${t("Confirmed")} ${row.confirmedCount} · ${t("In flight")} ${row.activeLockedCount}`}>
                                    {row.infiniteUse ? `${row.useCount} / ∞` : String(row.useCount)}
                                </span>
                            ),
                        },
                        { key: "state", label: t("State"), render: (row: ApplicationLinkRow) => <StatusBadge status={row.state} toneOverride={toBadgeTone(row.state)} /> },
                        { key: "expires", label: t("Expires"), render: (row: ApplicationLinkRow) => formatDateTime(row.expiresAt) },
                        {
                            key: "actions",
                            label: "",
                            align: "end",
                            render: (row: ApplicationLinkRow) =>
                                rowActions(paymentLinkActionsFor(row.state, canWrite.value), (action) => ({ kind: "link", action, id: row.id, name: row.key })),
                        },
                    ]}
                />
                {current.paymentLinkCount > current.paymentLinks.length && (
                    <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>{`${t("Showing the latest")} ${current.paymentLinks.length} / ${current.paymentLinkCount}`}</span>
                )}
            </div>
        );

        const renderPos = (current: ApplicationDetail): VNodeChild => (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <MiniTable
                    ariaLabel={t("POS terminals")}
                    emptyLabel={t("This application has no POS terminals")}
                    rows={current.posTerminals}
                    rowKey={(row: ApplicationPosRow) => row.id}
                    columns={[
                        {
                            key: "name",
                            label: t("Terminal"),
                            render: (row: ApplicationPosRow) => (
                                <span style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                    <strong style={{ fontSize: "12.5px" }}>{row.name}</strong>
                                    <span style={{ fontSize: "11.5px", color: "var(--pg-ink-muted)" }}>{row.location || "—"}</span>
                                </span>
                            ),
                        },
                        { key: "status", label: t("Status"), render: (row: ApplicationPosRow) => <StatusBadge status={row.status} toneOverride={toBadgeTone(row.status)} /> },
                        { key: "screens", label: t("Screens"), align: "end", render: (row: ApplicationPosRow) => String(row.screenCount) },
                        { key: "lastActive", label: t("Last active"), render: (row: ApplicationPosRow) => formatDateTime(row.lastActiveAt) },
                        {
                            key: "actions",
                            label: "",
                            align: "end",
                            render: (row: ApplicationPosRow) =>
                                rowActions(posActionsFor(row.status, canWrite.value), (action) => ({ kind: "pos", action, id: row.id, name: row.name })),
                        },
                    ]}
                />
                {current.posTerminalCount > current.posTerminals.length && (
                    <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>{`${t("Showing the latest")} ${current.posTerminals.length} / ${current.posTerminalCount}`}</span>
                )}
            </div>
        );

        const targetMode = (): GovernanceMode => pendingTarget.value?.action.mode ?? "immediate";
        const targetTitle = (): string => {
            const target = pendingTarget.value;
            if (!target) return "";
            return target.kind === "application" ? t(target.action.label) : `${t(target.action.label)} · ${target.name}`;
        };
        const targetDescription = (): string => {
            const target = pendingTarget.value;
            if (!target) return "";
            if (target.kind === "token") return t("A revoked token stops working at once and cannot be restored. The merchant must create a new one.");
            if (target.kind === "link") return t("A cancelled payment link can no longer be paid and cannot be reactivated.");
            if (target.action.mode === "approval") return t("Restoring access needs an independent checker.");
            return t("Restricting access takes effect immediately.");
        };

        return (): VNodeChild => {
            const current = application.value;
            return (
                <>
                    <SlideOverDrawer
                        modelValue={props.applicationId !== null}
                        onUpdate:modelValue={(value: boolean) => {
                            if (!value) emit("close");
                        }}
                        title={current ? current.name : t("Application")}
                        subtitle={current ? current.merchant.tradeName || current.merchant.legalName : ""}
                        width={720}
                        v-slots={{
                            footer: () => (
                                <>
                                    {actions.value.map((action) => (
                                        <VBtn
                                            key={action.key}
                                            variant="tonal"
                                            color={action.danger ? "error" : "primary"}
                                            prependIcon={action.icon}
                                            disabled={action.disabled}
                                            {...{ title: action.disabledReason ? t(action.disabledReason) : undefined }}
                                            onClick={() => runAction(action)}
                                        >
                                            {t(action.label)}
                                        </VBtn>
                                    ))}
                                    <VBtn variant="text" onClick={() => emit("close")}>{t("Close")}</VBtn>
                                </>
                            ),
                        }}
                    >
                        {loading.value && !current ? (
                            <StateView loading />
                        ) : error.value ? (
                            <StateView error={error.value} onRetry={() => props.applicationId && void load(props.applicationId)} />
                        ) : current ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                                <SegmentedTabs
                                    modelValue={tab.value}
                                    ariaLabel={t("Application sections")}
                                    tabs={[
                                        { value: "config", label: t("Configuration and allowlists") },
                                        { value: "tokens", label: t("API tokens"), count: current.accessTokenCount },
                                        { value: "links", label: t("Payment links"), count: current.paymentLinkCount },
                                        { value: "pos", label: t("POS terminals"), count: current.posTerminalCount },
                                    ]}
                                    onUpdate:modelValue={(value: string) => (tab.value = value as ApplicationTab)}
                                />
                                {tab.value === "config" && renderConfig(current)}
                                {tab.value === "tokens" && renderTokens(current)}
                                {tab.value === "links" && renderLinks(current)}
                                {tab.value === "pos" && renderPos(current)}
                            </div>
                        ) : null}
                    </SlideOverDrawer>

                    <ReasonModal
                        modelValue={pendingTarget.value !== null}
                        onUpdate:modelValue={(value: boolean) => {
                            if (!value) pendingTarget.value = null;
                        }}
                        title={targetTitle()}
                        description={targetDescription()}
                        mode={targetMode()}
                        danger={pendingTarget.value?.action.danger ?? false}
                        submitLabel={pendingTarget.value ? t(pendingTarget.value.action.label) : ""}
                        loading={submitting.value}
                        errorMessage={modalError.value}
                        onSubmit={(reason: string) => void submit(reason)}
                    />

                    <ApplicationPolicyModal
                        modelValue={policyOpen.value}
                        application={policyApplication.value}
                        onUpdate:modelValue={(value: boolean) => (policyOpen.value = value)}
                        onSubmitted={(outcome: Awaited<ReturnType<typeof runGoverned>>) => void afterMutation(outcome)}
                    />
                </>
            );
        };
    },
});

export default ApplicationDetailDrawer;
