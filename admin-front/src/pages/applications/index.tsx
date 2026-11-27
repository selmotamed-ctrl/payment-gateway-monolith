import { dc } from "@/utils/dc";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLocale } from "@/utils/vael-compat";
import {PgButton} from "@pg/ui";
import { areChecklistsVisible } from "@/constants/env";
import {PgPage as ScreenContainer} from "@pg/ui";
import {PageHeader} from "@pg/ui";
import {ThemedView} from "@pg/ui";
import {ThemedText} from "@pg/ui";
import {ApiTable} from "@pg/ui";
import {TableRowActions, type RowActionItem} from "@pg/ui";
import {TableFilters} from "@pg/ui";
import {buildFilterQuery, type FilterValues} from "@pg/ui";
import { tableRegistry } from "@/tables/tableRegistry";
import type { TableHeader } from "@pg/ui";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { useOpenQuery } from "@/composables/useOpenQuery";
import { urlsMap } from "@/constants/urlsMap";
import {MetricStrip, type MetricItem} from "@pg/ui";
import {MonoRef} from "@pg/ui";
import {MoneyDisplay} from "@pg/ui";
import {SegmentedTabs} from "@pg/ui";
import {StatusBadge} from "@pg/ui";
import { ApplicationDetailDrawer, type ApplicationTab } from "@/pages/merchants/components/ApplicationDetailDrawer";
import ApplicationPolicyModal, { type PolicyApplication } from "@/pages/merchants/components/ApplicationPolicyModal";
import ReasonModal from "@/pages/merchants/components/ReasonModal";
import {FormChecklist} from "@pg/ui";
import { showSnackBar } from "@/utils/snackBar";
import {
    ApprovalSubmittedNotice,
    MoneyOrRestricted,
    PillList,
    RestrictedValue,
    formatDateTime,
    toBadgeTone,
} from "@/pages/merchants/components/commerceBits";
import { isRestricted } from "@/pages/merchants/commerceGovernance";
import { notifyOutcome, reportCommerceError, runGoverned } from "@/pages/merchants/governedRequest";
import {
    applicationActionsFor,
    paymentLinkActionsFor,
    posActionsFor,
    railWhitelistModeOf,
    tokenActionsFor,
    tokenAllowlistState,
    type EntityAction,
} from "./applicationActions";

type MerchantRef = { id: string; legalName: string; tradeName: string };

type ApplicationRow = {
    id: string;
    name: string;
    merchantId: string;
    merchant: MerchantRef;
    status: string;
    assignedWalletId: string;
    assignedWallet: { id: string; currency: string; status: string };
    expectedMonthlyVolume: string | null;
    railWhitelist: string[] | null;
    railWhitelistMode: "ALL" | "NONE" | "LIST";
    railWhitelistCount: number;
    redirectDomains: string[];
    accessTokenCount: number;
    tokenActiveCount: number;
    tokenRevokedCount: number;
    tokenExpiredCount: number;
    tokenIpRestrictedCount: number;
    tokenCidrCount: number;
    paymentLinkCount: number;
    posTerminalCount: number;
    createdAt: string;
    redactedFields: string[];
};

type ApplicationTokenRow = {
    id: string;
    name: string;
    lastFour: string;
    scopes: string[];
    env: "LIVE" | "SANDBOX";
    ipWhitelistEnabled: boolean;
    cidrs: string[];
    ipCount: number;
    merchantId: string;
    applicationId: string;
    application: { id: string; name: string } | null;
    merchant: MerchantRef | null;
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    status: "ACTIVE" | "REVOKED" | "EXPIRED";
    createdAt: string;
};

type TokenSummary = {
    total: number;
    active: number;
    revoked: number;
    expired: number;
    ipRestricted: number;
    ipCidrs: number;
};

type PaymentLinkRow = {
    id: string;
    key: string;
    application: { id: string; name: string };
    merchant: MerchantRef;
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

type PosRow = {
    id: string;
    name: string;
    location: string | null;
    application: { id: string; name: string };
    merchant: MerchantRef;
    status: string;
    screenCount: number;
    lastActiveAt: string | null;
    createdAt: string;
};

type ApplicationSummary = { total: number; active: number; suspended: number; pending: number; withoutWhitelist: number };

type PageTab = "applications" | "tokens" | "links" | "pos";

type MutationTarget =
    | { kind: "application"; id: string; name: string; action: EntityAction }
    | { kind: "token"; id: string; tokenId: string; applicationId: string; name: string; action: EntityAction }
    | { kind: "link"; id: string; name: string; action: EntityAction }
    | { kind: "pos"; id: string; name: string; action: EntityAction };

type RefreshHook = {
    reset: () => void;
    refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
    refreshAsIs: () => void;
};

/** Search, filter and paging state of one table (each tab owns one). */
const createTableState = () => {
    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const total = ref(0);
    const pageSize = ref(25);
    const hook = ref<RefreshHook | null>(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
        search,
        filters,
        total,
        pageSize,
        hook,
        onChange: (key: string, value: unknown) => {
            filters.value = { ...filters.value, [key]: value };
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => hook.value?.reset(), 300);
        },
        onClear: () => {
            filters.value = {};
            hook.value?.reset();
        },
    };
};

const ACCESS_ACTION_CHECKS = [
    { key: "ENTITY_SCOPE_VERIFIED", label: "Application, link or terminal scope verified" },
    { key: "ACCESS_IMPACT_REVIEWED", label: "Payment and token impact reviewed" },
    { key: "REASON_CONFIRMED", label: "Reason confirmed" },
    { key: "AUTHORITY_CONFIRMED", label: "Authority to change access confirmed" },
] as const;

const APPLIED_MESSAGE: Record<MutationTarget["kind"], string> = {
    application: "Application suspended",
    token: "Access token revoked",
    link: "Payment link cancelled",
    pos: "POS terminal updated",
};

const ApplicationsPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const canWrite = computed(() => hasOneOfAuthorities(["merchant:write"]));
    const initialTab = String(route.query.tab ?? "");
    const activeTab = ref<PageTab>(
        initialTab === "tokens" ? "tokens" : initialTab === "links" ? "links" : initialTab === "pos" ? "pos" : "applications",
    );
    const summary = ref<ApplicationSummary | null>(null);
    const tokenSummary = ref<TokenSummary | null>(null);

    const appTable = createTableState();
    const tokenTable = createTableState();
    const linkTable = createTableState();
    const posTable = createTableState();
    if (typeof route.query.search === "string" && route.query.search) {
        posTable.search.value = route.query.search;
    }
    watch(
        () => route.query.tab,
        (tab) => {
            const next = tab === "tokens" ? "tokens" : tab === "links" ? "links" : tab === "pos" ? "pos" : "applications";
            if (next !== activeTab.value) activeTab.value = next;
        },
    );
    watch(
        () => route.query.search,
        (search) => {
            if (typeof search === "string" && search) {
                posTable.search.value = search;
                posTable.hook.value?.reset();
            }
        },
    );

    const openApplicationId = ref<string | null>(null);
    const openApplicationTab = ref<ApplicationTab>("config");
    const policyApplication = ref<PolicyApplication | null>(null);
    const notice = ref<{ approvalRequestId: string | null } | null>(null);
    const target = ref<MutationTarget | null>(null);
    const submitting = ref(false);
    const modalError = ref("");
    const showChecklists = areChecklistsVisible();
    const actionChecklist = ref<Record<string, boolean>>({});
    const actionChecklistComplete = computed(() => !showChecklists || ACCESS_ACTION_CHECKS.every((check) => actionChecklist.value[check.key] === true));

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.applicationsSummary);
            summary.value = (response.data?.data ?? response.data ?? null) as ApplicationSummary | null;
        } catch {
            summary.value = null;
        }
    };
    const loadTokenSummary = async () => {
        try {
            const response = await api.get(urlsMap.accessTokensSummary);
            tokenSummary.value = (response.data?.data ?? response.data ?? null) as TokenSummary | null;
        } catch {
            tokenSummary.value = null;
        }
    };
    void loadSummary();
    void loadTokenSummary();

    const { clearOpenQueryParam } = useOpenQuery<{ id: string }>({
        alwaysFetchDetail: true,
        fetchById: async (id) => ({ id }),
        onOpenRecord: (record) => (openApplicationId.value = record.id),
    });

    const refreshAll = () => {
        appTable.hook.value?.refreshAsIs();
        tokenTable.hook.value?.refreshAsIs();
        linkTable.hook.value?.refreshAsIs();
        posTable.hook.value?.refreshAsIs();
        void loadSummary();
        void loadTokenSummary();
    };

    const submit = async (reason: string) => {
        const current = target.value;
        if (!current) return;
        if (!actionChecklistComplete.value) {
            modalError.value = t("Complete all access action checklist items before submitting");
            return;
        }
        submitting.value = true;
        modalError.value = "";
        try {
            const checklist = ACCESS_ACTION_CHECKS.filter((check) => actionChecklist.value[check.key]).map((check) => check.key);
            const outcome = await runGoverned(() => {
                if (current.kind === "application") return api.patch(urlsMap.applicationDetail(current.id), { status: current.action.target, reason, checklist });
                if (current.kind === "token") return api.post(urlsMap.applicationRevokeToken(current.applicationId, current.tokenId), { reason, checklist });
                if (current.kind === "link") return api.post(urlsMap.paymentLinkState(current.id), { state: "CANCELLED", reason, checklist });
                return api.post(urlsMap.posTerminalStatus(current.id), { status: current.action.target, reason, checklist });
            });
            notifyOutcome(outcome, APPLIED_MESSAGE[current.kind]);
            notice.value = outcome.kind === "approval" ? { approvalRequestId: outcome.approvalRequestId } : null;
            target.value = null;
            refreshAll();
        } catch (cause) {
            modalError.value = reportCommerceError(cause);
        } finally {
            submitting.value = false;
        }
    };

    const actionItems = (actions: EntityAction[], toTarget: (action: EntityAction) => MutationTarget): RowActionItem[] =>
        actions.map((action) => ({
            key: action.key,
            label: t(action.label),
            icon: action.icon,
            danger: action.danger,
            disabled: action.disabled,
            dividerBefore: false,
            onClick: () => {
                modalError.value = "";
                actionChecklist.value = {};
                target.value = toTarget(action);
            },
        }));

    const merchantCell = (merchant: MerchantRef) => (
        <PgButton
            size="small"
            variant="text"
            style={{ paddingInline: "2px", textTransform: "none", justifyContent: "flex-start" }}
            onClick={() => void router.push({ name: "MerchantDetail", params: { id: merchant.id } })}
        >
            {merchant.tradeName || merchant.legalName}
        </PgButton>
    );

    const dateCell = (value: string | null) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(value)}</ThemedText>;

    const copyApplicationSummary = async (row: ApplicationRow) => {
        const summary = {
            id: row.id,
            name: row.name,
            merchantId: row.merchantId,
            merchant: row.merchant,
            status: row.status,
            assignedWalletId: row.assignedWalletId,
            assignedWallet: row.assignedWallet,
            expectedMonthlyVolume: row.expectedMonthlyVolume,
            railWhitelist: row.railWhitelist,
            redirectDomains: row.redactedFields.includes("redirectDomains") ? "[restricted]" : row.redirectDomains,
            accessTokenCount: row.accessTokenCount,
            tokenActiveCount: row.tokenActiveCount,
            tokenRevokedCount: row.tokenRevokedCount,
            tokenExpiredCount: row.tokenExpiredCount,
            tokenIpRestrictedCount: row.tokenIpRestrictedCount,
            tokenCidrCount: row.tokenCidrCount,
            paymentLinkCount: row.paymentLinkCount,
            posTerminalCount: row.posTerminalCount,
            createdAt: row.createdAt,
            url: window.location.href,
        };
        try {
            await navigator.clipboard.writeText(JSON.stringify(summary, null, 2));
            showSnackBar({ type: "success", message: t("Application summary copied") });
        } catch {
            showSnackBar({ type: "error", message: t("Could not copy to the clipboard") });
        }
    };

    const applicationHeaders = computed<TableHeader<ApplicationRow>[]>(() => [
        {
            key: "name",
            label: "Application",
            sortKey: "name",
            value: (row) => row.name,
            Value: ({ row }: { row: ApplicationRow }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12.5px", fontWeight: 600 }}>{row.name}</ThemedText>
                    <MonoRef value={row.id} truncate={12} />
                </ThemedView>
            ),
        },
        { key: "merchant", label: "Merchant", value: (row) => row.merchant.tradeName, Value: ({ row }: { row: ApplicationRow }) => merchantCell(row.merchant) },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            value: (row) => row.status,
            Value: ({ row }: { row: ApplicationRow }) => <StatusBadge status={row.status} toneOverride={toBadgeTone(row.status)} />,
        },
        {
            key: "wallet",
            label: "Settlement wallet",
            value: (row) => row.assignedWallet.id,
            Value: ({ row }: { row: ApplicationRow }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.assignedWallet.currency}</ThemedText>
                    <MonoRef value={row.assignedWallet.id} truncate={10} />
                </ThemedView>
            ),
        },
        {
            key: "volume",
            label: "Monthly volume",
            sortKey: "expectedMonthlyVolume",
            value: (row) => row.expectedMonthlyVolume ?? "",
            Value: ({ row }: { row: ApplicationRow }) => (
                <MoneyOrRestricted amount={row.expectedMonthlyVolume} currency={row.assignedWallet.currency} restricted={isRestricted(row.redactedFields, "expectedMonthlyVolume", row.expectedMonthlyVolume)} />
            ),
        },
        {
            key: "rails",
            label: "Rail whitelist",
            value: (row) => railWhitelistModeOf(row.railWhitelist),
            Value: ({ row }: { row: ApplicationRow }) => {
                const mode = railWhitelistModeOf(row.railWhitelist);
                if (mode === "ALL") return <StatusBadge status="ACTIVE" label={t("All rails")} toneOverride="neutral" />;
                if (mode === "NONE") return <StatusBadge status="BLOCKED" label={t("No rails")} toneOverride="warning" />;
                return <PillList items={row.railWhitelist ?? []} max={3} />;
            },
        },
        {
            key: "domains",
            label: "Redirect domains",
            value: (row) => String(row.redirectDomains.length),
            Value: ({ row }: { row: ApplicationRow }) =>
                isRestricted(row.redactedFields, "redirectDomains") ? <RestrictedValue /> : <ThemedText style={{ fontSize: "12px" }}>{row.redirectDomains.length}</ThemedText>,
        },
        {
            key: "tokens",
            label: "API tokens",
            value: (row) => String(row.accessTokenCount),
            Value: ({ row }: { row: ApplicationRow }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.accessTokenCount}</ThemedText>
                    <ThemedText style={{ fontSize: "10.5px", opacity: 0.65 }}>
                        {row.tokenIpRestrictedCount > 0
                            ? `${row.tokenIpRestrictedCount} ${t("IP-restricted")} · ${row.tokenCidrCount} ${t("CIDRs")}`
                            : t("No IP allowlist")}
                    </ThemedText>
                </ThemedView>
            ),
        },
        { key: "linksPos", label: "Links / POS", value: (row) => `${row.paymentLinkCount} / ${row.posTerminalCount}` },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }: { row: ApplicationRow }) => dateCell(row.createdAt) },
        {
            key: "actions",
            label: "Action",
            sortable: false,
            Value: ({ row }: { row: ApplicationRow }) => (
                <TableRowActions
                    primaryAction={{
                        label: t("Inspect"),
                        icon: "mdi-application-outline",
                        onClick: () => {
                            openApplicationTab.value = "config";
                            openApplicationId.value = row.id;
                        },
                    }}
                    items={[
                        { key: "merchant", label: t("Open merchant"), icon: "mdi-storefront-outline", onClick: () => void router.push({ name: "MerchantDetail", params: { id: row.merchantId } }) },
                        {
                            key: "tokens",
                            label: t("View API tokens"),
                            icon: "mdi-key-outline",
                            onClick: () => {
                                openApplicationTab.value = "tokens";
                                openApplicationId.value = row.id;
                            },
                        },
                        { key: "copy", label: t("Copy summary"), icon: "mdi-content-copy", onClick: () => void copyApplicationSummary(row) },
                        ...applicationActionsFor(row.status, { canWrite: canWrite.value }).map((action): RowActionItem => ({
                            key: action.key,
                            label: t(action.label),
                            icon: action.icon,
                            danger: action.danger,
                            dividerBefore: action.key === "suspend" || action.key === "reactivate",
                            onClick: () => {
                                if (action.key === "editPolicy") {
                                    policyApplication.value = {
                                        id: row.id,
                                        merchantId: row.merchantId,
                                        assignedWalletId: row.assignedWalletId,
                                        assignedWallet: row.assignedWallet,
                                        railWhitelist: row.railWhitelist,
                                        redirectDomains: row.redirectDomains,
                                        redactedFields: row.redactedFields,
                                    };
                                    return;
                                }
                                modalError.value = "";
                                target.value = { kind: "application", id: row.id, name: row.name, action };
                            },
                        })),
                    ]}
                />
            ),
        },
    ]);

    const tokenHeaders = computed<TableHeader<ApplicationTokenRow>[]>(() => [
        {
            key: "name",
            label: "Token",
            sortKey: "name",
            value: (row) => row.name,
            Value: ({ row }: { row: ApplicationTokenRow }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12.5px", fontWeight: 600 }}>{row.name}</ThemedText>
                    <span dir="ltr" style={{ fontFamily: "var(--pg-font-mono)", fontSize: "11px", color: "var(--pg-ink-muted)" }}>{`****${row.lastFour}`}</span>
                </ThemedView>
            ),
        },
        {
            key: "application",
            label: "Application",
            value: (row) => row.application?.name ?? "",
            Value: ({ row }: { row: ApplicationTokenRow }) => (
                <PgButton
                    size="small"
                    variant="text"
                    style={{ paddingInline: "2px", textTransform: "none", justifyContent: "flex-start" }}
                    onClick={() => {
                        openApplicationTab.value = "config";
                        openApplicationId.value = row.applicationId;
                    }}
                >
                    {row.application?.name ?? row.applicationId}
                </PgButton>
            ),
        },
        {
            key: "merchant",
            label: "Merchant",
            value: (row) => row.merchant?.tradeName ?? "",
            Value: ({ row }: { row: ApplicationTokenRow }) => (row.merchant ? merchantCell(row.merchant) : <ThemedText style={{ fontSize: "12px" }}>—</ThemedText>),
        },
        {
            key: "env",
            label: "Environment",
            value: (row) => row.env,
            Value: ({ row }: { row: ApplicationTokenRow }) => (
                <StatusBadge status={row.env} label={row.env} toneOverride={row.env === "SANDBOX" ? "info" : "neutral"} />
            ),
        },
        { key: "scopes", label: "Scopes", value: (row) => row.scopes.join(" "), Value: ({ row }: { row: ApplicationTokenRow }) => <PillList items={row.scopes} max={3} emptyLabel="—" /> },
        {
            key: "ip",
            label: "IP allowlist",
            value: (row) => (row.ipWhitelistEnabled ? row.cidrs.join(" ") : ""),
            Value: ({ row }: { row: ApplicationTokenRow }) => {
                const state = tokenAllowlistState(row);
                if (state === "ACTIVE") return <PillList items={row.cidrs} max={2} />;
                if (state === "ACTIVE_EMPTY") return <StatusBadge status="ACTIVE" label={t("Enabled, no CIDR")} toneOverride="warning" />;
                if (state === "STORED_OFF") {
                    return (
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "4px", flexWrap: "wrap" }}>
                            <StatusBadge status="INACTIVE" label={t("Off")} toneOverride="neutral" />
                            <PillList items={row.cidrs} max={2} />
                        </ThemedView>
                    );
                }
                return <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{t("Not restricted")}</ThemedText>;
            },
        },
        { key: "lastUsed", label: "Last used", sortKey: "lastUsedAt", value: (row) => row.lastUsedAt ?? "", Value: ({ row }: { row: ApplicationTokenRow }) => dateCell(row.lastUsedAt) },
        { key: "expires", label: "Expires", sortKey: "expiresAt", value: (row) => row.expiresAt ?? "", Value: ({ row }: { row: ApplicationTokenRow }) => dateCell(row.expiresAt) },
        {
            key: "status",
            label: "Status",
            value: (row) => row.status,
            Value: ({ row }: { row: ApplicationTokenRow }) => <StatusBadge status={row.status} toneOverride={toBadgeTone(row.status)} />,
        },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }: { row: ApplicationTokenRow }) => dateCell(row.createdAt) },
        {
            key: "actions",
            label: "Action",
            sortable: false,
            Value: ({ row }: { row: ApplicationTokenRow }) => (
                <TableRowActions
                    primaryAction={{
                        label: t("Open application"),
                        icon: "mdi-application-outline",
                        onClick: () => {
                            openApplicationTab.value = "config";
                            openApplicationId.value = row.applicationId;
                        },
                    }}
                    items={actionItems(tokenActionsFor(row.status, canWrite.value), (action) => ({
                        kind: "token",
                        id: row.id,
                        tokenId: row.id,
                        applicationId: row.applicationId,
                        name: `${row.name} ****${row.lastFour}`,
                        action,
                    }))}
                />
            ),
        },
    ]);

    const linkHeaders = computed<TableHeader<PaymentLinkRow>[]>(() => [
        { key: "key", label: "Link", value: (row) => row.key, Value: ({ row }: { row: PaymentLinkRow }) => <MonoRef value={row.key} truncate={16} /> },
        { key: "application", label: "Application", value: (row) => row.application.name },
        { key: "merchant", label: "Merchant", value: (row) => row.merchant.tradeName, Value: ({ row }: { row: PaymentLinkRow }) => merchantCell(row.merchant) },
        {
            key: "amount",
            label: "Amount",
            sortKey: "amount",
            value: (row) => row.amount,
            Value: ({ row }: { row: PaymentLinkRow }) => <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" />,
        },
        { key: "feeBearer", label: "Fee bearer", value: (row) => row.feeBearer },
        {
            key: "uses",
            label: "Uses",
            value: (row) => String(row.useCount),
            Value: ({ row }: { row: PaymentLinkRow }) => (
                <ThemedText style={{ fontSize: "12px" }}>{row.infiniteUse ? `${row.useCount} / ∞` : String(row.useCount)}</ThemedText>
            ),
        },
        {
            key: "state",
            label: "State",
            sortKey: "state",
            value: (row) => row.state,
            Value: ({ row }: { row: PaymentLinkRow }) => <StatusBadge status={row.state} toneOverride={toBadgeTone(row.state)} />,
        },
        { key: "expiresAt", label: "Expires", sortKey: "expiresAt", value: (row) => row.expiresAt ?? "", Value: ({ row }: { row: PaymentLinkRow }) => dateCell(row.expiresAt) },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }: { row: PaymentLinkRow }) => dateCell(row.createdAt) },
        {
            key: "actions",
            label: "Action",
            sortable: false,
            Value: ({ row }: { row: PaymentLinkRow }) => (
                <TableRowActions
                    items={[
                        { key: "application", label: t("Inspect application"), icon: "mdi-application-outline", onClick: () => { openApplicationId.value = row.application.id; } },
                        ...actionItems(paymentLinkActionsFor(row.state, canWrite.value), (action) => ({ kind: "link", id: row.id, name: row.key, action })),
                    ]}
                />
            ),
        },
    ]);

    const posHeaders = computed<TableHeader<PosRow>[]>(() => [
        {
            key: "name",
            label: "Terminal",
            sortKey: "name",
            value: (row) => row.name,
            Value: ({ row }: { row: PosRow }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12.5px", fontWeight: 600 }}>{row.name}</ThemedText>
                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{row.location || "—"}</ThemedText>
                </ThemedView>
            ),
        },
        { key: "application", label: "Application", value: (row) => row.application.name },
        { key: "merchant", label: "Merchant", value: (row) => row.merchant.tradeName, Value: ({ row }: { row: PosRow }) => merchantCell(row.merchant) },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            value: (row) => row.status,
            Value: ({ row }: { row: PosRow }) => <StatusBadge status={row.status} toneOverride={toBadgeTone(row.status)} />,
        },
        { key: "screens", label: "Screens", value: (row) => String(row.screenCount) },
        { key: "lastActive", label: "Last active", value: (row) => row.lastActiveAt ?? "", Value: ({ row }: { row: PosRow }) => dateCell(row.lastActiveAt) },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }: { row: PosRow }) => dateCell(row.createdAt) },
        {
            key: "actions",
            label: "Action",
            sortable: false,
            Value: ({ row }: { row: PosRow }) => (
                <TableRowActions
                    items={[
                        { key: "application", label: t("Inspect application"), icon: "mdi-application-outline", onClick: () => { openApplicationId.value = row.application.id; } },
                        ...actionItems(posActionsFor(row.status, canWrite.value), (action) => ({ kind: "pos", id: row.id, name: row.name, action })),
                    ]}
                />
            ),
        },
    ]);

    const applicationMetrics = computed<MetricItem[]>(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { key: "total", label: t("Applications"), value: String(data.total) },
            { key: "active", label: t("Active"), value: String(data.active), badge: t("Active"), badgeTone: "success" },
            {
                key: "suspended",
                label: t("Suspended"),
                value: String(data.suspended),
                badge: data.suspended > 0 ? t("Contained") : t("Clear"),
                badgeTone: data.suspended > 0 ? "danger" : "success",
            },
            { key: "pending", label: t("Pending activation"), value: String(data.pending), badge: data.pending > 0 ? t("Pending") : t("Clear"), badgeTone: data.pending > 0 ? "warning" : "success" },
            {
                key: "withoutWhitelist",
                label: t("Without rail whitelist"),
                value: String(data.withoutWhitelist),
                subLabel: t("Accept every active rail"),
                badge: data.withoutWhitelist > 0 ? t("Review") : t("Clear"),
                badgeTone: data.withoutWhitelist > 0 ? "warning" : "success",
            },
        ];
    });

    const tokenMetrics = computed<MetricItem[]>(() => {
        const data = tokenSummary.value;
        if (!data) return [];
        return [
            { key: "tokensTotal", label: t("API tokens"), value: String(data.total) },
            { key: "tokensActive", label: t("Active"), value: String(data.active), badge: t("Active"), badgeTone: "success" },
            {
                key: "tokensRevoked",
                label: t("Revoked tokens"),
                value: String(data.revoked),
                badge: data.revoked > 0 ? t("Review") : t("Clear"),
                badgeTone: data.revoked > 0 ? "warning" : "success",
            },
            { key: "tokensExpired", label: t("Expired tokens"), value: String(data.expired), badge: data.expired > 0 ? t("Review") : t("Clear"), badgeTone: data.expired > 0 ? "warning" : "success" },
            {
                key: "tokensIp",
                label: t("IP allowlists"),
                value: String(data.ipRestricted),
                subLabel: `${data.ipCidrs} ${t("CIDRs")}`,
                badge: data.ipRestricted > 0 ? t("Restricted") : t("Open"),
                badgeTone: data.ipRestricted > 0 ? "success" : "warning",
            },
        ];
    });

    const metrics = computed<MetricItem[]>(() => (activeTab.value === "tokens" ? tokenMetrics.value : applicationMetrics.value));

    const renderTable = <T,>(
        state: ReturnType<typeof createTableState>,
        config: { registryKey: string; title: string; url: string; listKey: string; headers: TableHeader<T>[] },
    ) => {
        const definitions = tableRegistry[config.registryKey]?.filters ?? [];
        return (
            <ApiTable<T>
                title={config.title}
                url={config.url}
                localSearch={false}
                xlsx={false}
                showNumber={true}
                numberOfItemsPerPage={state.pageSize.value}
                numberOfItemsPerPageChoices={[
                    { label: "10", value: 10 },
                    { label: "25", value: 25 },
                    { label: "50", value: 50 },
                ]}
                setNumberOfItemsPerPage={(value) => (state.pageSize.value = value)}
                searchValue={state.search.value}
                setSearchValue={(value) => (state.search.value = value)}
                headers={config.headers}
                apiDataExtractor={(data) => ((data as Record<string, unknown>)[config.listKey] ?? []) as T[]}
                apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                onData={(_rows, nextTotal) => {
                    state.total.value = nextTotal;
                }}
                setRefreshHook={(hook) => {
                    state.hook.value = hook as RefreshHook;
                }}
                clearRefreshHook={() => {
                    state.hook.value = null;
                }}
                onRefresh={(table, refresh) => {
                    void refresh({
                        queryParams: {
                            page: table.page,
                            pageSize: state.pageSize.value,
                            ...(state.search.value ? { search: state.search.value } : {}),
                            ...buildFilterQuery(definitions, state.filters.value),
                            ...(table.sortKey ? { sortKey: table.sortKey, sortDirection: table.sortDirection } : {}),
                        },
                    });
                }}
                TopSlot={() => (
                    <TableFilters filters={definitions} values={state.filters.value} total={state.total.value} onChange={state.onChange} onClear={state.onClear} />
                )}
            />
        );
    };

    const targetTitle = () => {
        const current = target.value;
        return current ? `${t(current.action.label)} · ${current.name}` : "";
    };
    const targetDescription = () => {
        const current = target.value;
        if (!current) return "";
        if (current.kind === "token") return t("A revoked token stops working at once and cannot be restored. The merchant must create a new one.");
        if (current.kind === "link") return t("A cancelled payment link can no longer be paid and cannot be reactivated.");
        if (current.action.mode === "approval") return t("Restoring access needs an independent checker.");
        return t("Restricting access takes effect immediately.");
    };

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("Applications")} subtitle={t("Merchant applications, their payment links and POS terminals: allowlists, tokens and containment.")} badge={t("Commerce")} badgeTone="info"><PgButton variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</PgButton></PageHeader>

                {notice.value && <ApprovalSubmittedNotice approvalRequestId={notice.value.approvalRequestId} onDismiss={() => (notice.value = null)} />}

                {metrics.value.length > 0 && <MetricStrip items={metrics.value} />}

                <SegmentedTabs
                    modelValue={activeTab.value}
                    ariaLabel={t("Application views")}
                    tabs={[
                        { value: "applications", label: t("Applications") },
                        { value: "tokens", label: t("API tokens"), count: tokenSummary.value?.total },
                        { value: "links", label: t("Payment links") },
                        { value: "pos", label: t("POS terminals") },
                    ]}
                    onUpdate:modelValue={(value: string) => (activeTab.value = value as PageTab)}
                />

                {activeTab.value === "applications" &&
                    renderTable<ApplicationRow>(appTable, {
                        registryKey: "Applications",
                        title: t("Applications"),
                        url: urlsMap.applicationsList,
                        listKey: "applications",
                        headers: applicationHeaders.value,
                    })}
                {activeTab.value === "tokens" &&
                    renderTable<ApplicationTokenRow>(tokenTable, {
                        registryKey: "ApplicationTokens",
                        title: t("API tokens"),
                        url: urlsMap.accessTokensList,
                        listKey: "accessTokens",
                        headers: tokenHeaders.value,
                    })}
                {activeTab.value === "links" &&
                    renderTable<PaymentLinkRow>(linkTable, {
                        registryKey: "ApplicationPaymentLinks",
                        title: t("Payment links"),
                        url: urlsMap.paymentLinksList,
                        listKey: "paymentLinks",
                        headers: linkHeaders.value,
                    })}
                {activeTab.value === "pos" &&
                    renderTable<PosRow>(posTable, {
                        registryKey: "ApplicationPosTerminals",
                        title: t("POS terminals"),
                        url: urlsMap.posTerminalsList,
                        listKey: "posTerminals",
                        headers: posHeaders.value,
                    })}
            </ThemedView>

            <ApplicationDetailDrawer
                applicationId={openApplicationId.value}
                initialTab={openApplicationTab.value}
                onClose={() => {
                    openApplicationId.value = null;
                    openApplicationTab.value = "config";
                    void clearOpenQueryParam();
                }}
                onChanged={refreshAll}
            />

            <ApplicationPolicyModal
                modelValue={policyApplication.value !== null}
                application={policyApplication.value}
                onUpdate:modelValue={(value: boolean) => {
                    if (!value) policyApplication.value = null;
                }}
                onSubmitted={(outcome: Awaited<ReturnType<typeof runGoverned>>) => {
                    notice.value = outcome.kind === "approval" ? { approvalRequestId: outcome.approvalRequestId } : null;
                    refreshAll();
                }}
            />

            <ReasonModal
                modelValue={target.value !== null}
                onUpdate:modelValue={(value: boolean) => {
                    if (!value) target.value = null;
                }}
                title={targetTitle()}
                description={targetDescription()}
                mode={target.value?.action.mode ?? "immediate"}
                danger={target.value?.action.danger ?? false}
                submitLabel={target.value ? t(target.value.action.label) : ""}
                loading={submitting.value}
                errorMessage={modalError.value}
                onSubmit={(reason: string) => void submit(reason)}
            >
                <FormChecklist
                    checks={[...ACCESS_ACTION_CHECKS]}
                    modelValue={actionChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (actionChecklist.value = value)}
                    show={showChecklists}
                    title={t("Access action checklist")}
                    complete={actionChecklistComplete.value}
                    incompleteMessage={t("Complete all access action checklist items before submitting")}
                />
            </ReasonModal>
        </ScreenContainer>
    );
});

export default ApplicationsPage;
