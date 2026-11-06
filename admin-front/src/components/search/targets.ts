import type { RouteLocationRaw } from "vue-router";
import type {
    LocalizedSearchLabel,
    SearchResultGroup,
    SearchResultItem,
    SearchType,
} from "./types";

export interface FrontendAccessContext {
    role: string;
    authorities: ReadonlySet<string>;
    visibleRouteNames: ReadonlySet<string>;
    routesAuthorities?: Record<string, readonly string[] | null | undefined>;
    routesRoles?: Record<string, readonly string[] | null | undefined>;
}

export interface SearchTargetPlugin {
    readonly type: SearchType;
    readonly order: number;
    readonly icon: string;
    readonly groupLabel: LocalizedSearchLabel;
    readonly kindLabel: LocalizedSearchLabel;
    readonly primaryRouteName: string;
    readonly additionalRouteNames?: readonly string[];
    readonly resolveTarget: (
        item: SearchResultItem,
        rawQuery: string,
    ) => RouteLocationRaw | null;
}

export function defineSearchTargetPlugin<T extends SearchTargetPlugin>(plugin: T): T {
    return Object.freeze(plugin);
}

export const openDrawerTarget =
    (routeName: string, queryKey = "open") =>
    (item: SearchResultItem): RouteLocationRaw => ({
        name: routeName,
        query: { [queryKey]: item.id },
    });

export const routeParamTarget =
    (routeName: string, paramName = "id") =>
    (item: SearchResultItem): RouteLocationRaw => ({
        name: routeName,
        params: { [paramName]: item.id },
    });

export const searchPrefillTarget =
    (routeName: string, queryKey = "search") =>
    (item: SearchResultItem, rawQuery: string): RouteLocationRaw => ({
        name: routeName,
        query: { [queryKey]: item.reference || rawQuery.trim() },
    });

export class ClientSearchTargetRegistry {
    private readonly plugins = new Map<SearchType, SearchTargetPlugin>();

    public register(plugin: SearchTargetPlugin): this {
        this.plugins.set(plugin.type, plugin);
        return this;
    }

    public unregister(type: SearchType): boolean {
        return this.plugins.delete(type);
    }

    public get(type: SearchType): SearchTargetPlugin | undefined {
        return this.plugins.get(type);
    }

    public getAllOrdered(): SearchTargetPlugin[] {
        return Array.from(this.plugins.values()).sort((left, right) => left.order - right.order);
    }

    public getRegisteredTypes(): Set<string> {
        return new Set(this.plugins.keys());
    }
}

export const clientSearchRegistry = new ClientSearchTargetRegistry();

[
    defineSearchTargetPlugin({
        type: "merchant",
        order: 10,
        icon: "mdi-storefront-outline",
        groupLabel: { en: "Merchants", ar: "التجار" },
        kindLabel: { en: "Merchant", ar: "تاجر" },
        primaryRouteName: "MerchantDetail",
        resolveTarget: routeParamTarget("MerchantDetail", "id"),
    }),
    defineSearchTargetPlugin({
        type: "payment_attempt",
        order: 20,
        icon: "mdi-credit-card-check-outline",
        groupLabel: { en: "Payment Attempts", ar: "محاولات الدفع" },
        kindLabel: { en: "Attempt", ar: "محاولة دفع" },
        primaryRouteName: "MerchantDetail",
        resolveTarget: (item, rawQuery) => {
            const merchantId = String(item.merchantId ?? "").trim();
            if (!merchantId) {
                return null;
            }
            return {
                name: "MerchantDetail",
                params: { id: merchantId },
                query: {
                    tab: "transactions",
                    reference: item.reference || rawQuery.trim(),
                },
            };
        },
    }),
    defineSearchTargetPlugin({
        type: "operator_case",
        order: 30,
        icon: "mdi-briefcase-search-outline",
        groupLabel: { en: "Operator Cases", ar: "حالات العمليات" },
        kindLabel: { en: "Case", ar: "حالة عمليات" },
        primaryRouteName: "OperatorCaseDetail",
        resolveTarget: routeParamTarget("OperatorCaseDetail", "id"),
    }),
    defineSearchTargetPlugin({
        type: "gateway_inquiry",
        order: 40,
        icon: "mdi-radar",
        groupLabel: { en: "Gateway Inquiries", ar: "استعلامات البوابات" },
        kindLabel: { en: "Inquiry", ar: "استعلام بوابة" },
        primaryRouteName: "GatewayInquirySchedules",
        additionalRouteNames: ["OperatorCaseDetail"],
        resolveTarget: (item, rawQuery) => {
            if (item.operatorCaseId) {
                return {
                    name: "OperatorCaseDetail",
                    params: { id: item.operatorCaseId },
                };
            }
            return {
                name: "GatewayInquirySchedules",
                query: { search: item.reference || rawQuery.trim() },
            };
        },
    }),
    defineSearchTargetPlugin({
        type: "approval",
        order: 50,
        icon: "mdi-shield-check-outline",
        groupLabel: { en: "Approvals (Four-Eyes)", ar: "الموافقات الثنائية" },
        kindLabel: { en: "Approval", ar: "طلب موافقة" },
        primaryRouteName: "Approvals",
        resolveTarget: openDrawerTarget("Approvals", "open"),
    }),
    defineSearchTargetPlugin({
        type: "join_request",
        order: 60,
        icon: "mdi-domain-plus",
        groupLabel: { en: "Join Requests (KYB)", ar: "طلبات الانضمام" },
        kindLabel: { en: "Join Request", ar: "طلب انضمام" },
        primaryRouteName: "JoinRequestDetail",
        resolveTarget: routeParamTarget("JoinRequestDetail", "id"),
    }),
    defineSearchTargetPlugin({
        type: "kyb_document",
        order: 70,
        icon: "mdi-file-certificate-outline",
        groupLabel: { en: "KYB Documents", ar: "مستندات التحقق KYB" },
        kindLabel: { en: "KYB Doc", ar: "مستند KYB" },
        primaryRouteName: "KybReviewDetail",
        resolveTarget: routeParamTarget("KybReviewDetail", "id"),
    }),
    defineSearchTargetPlugin({
        type: "dispute",
        order: 80,
        icon: "mdi-scale-balance",
        groupLabel: { en: "Disputes & Chargebacks", ar: "النزاعات وطلبات الاسترداد" },
        kindLabel: { en: "Dispute", ar: "نزاع" },
        primaryRouteName: "Disputes",
        resolveTarget: openDrawerTarget("Disputes", "open"),
    }),
    defineSearchTargetPlugin({
        type: "adjustment",
        order: 90,
        icon: "mdi-cash-sync",
        groupLabel: { en: "Adjustments & Refunds", ar: "التسويات والمرتجعات" },
        kindLabel: { en: "Adjustment", ar: "تسوية مالية" },
        primaryRouteName: "Adjustments",
        resolveTarget: openDrawerTarget("Adjustments", "open"),
    }),
    defineSearchTargetPlugin({
        type: "cashout",
        order: 100,
        icon: "mdi-bank-transfer-out",
        groupLabel: { en: "Cash-outs", ar: "السحوبات البنكية" },
        kindLabel: { en: "Cash-out", ar: "سحب بنكي" },
        primaryRouteName: "CashOuts",
        resolveTarget: openDrawerTarget("CashOuts", "open"),
    }),
    defineSearchTargetPlugin({
        type: "reconciliation_run",
        order: 110,
        icon: "mdi-file-compare",
        groupLabel: { en: "Reconciliation Runs", ar: "دورات المطابقة المالية" },
        kindLabel: { en: "Recon Run", ar: "مطابقة" },
        primaryRouteName: "Reconciliation",
        resolveTarget: openDrawerTarget("Reconciliation", "open"),
    }),
    defineSearchTargetPlugin({
        type: "aml_case",
        order: 120,
        icon: "mdi-shield-alert-outline",
        groupLabel: { en: "AML Cases", ar: "حالات مكافحة غسل الأموال" },
        kindLabel: { en: "AML Case", ar: "حالة AML" },
        primaryRouteName: "AmlCases",
        resolveTarget: openDrawerTarget("AmlCases", "open"),
    }),
    defineSearchTargetPlugin({
        type: "aml_screening",
        order: 130,
        icon: "mdi-account-search-outline",
        groupLabel: { en: "AML Screenings", ar: "فحوصات القوائم الرقابية" },
        kindLabel: { en: "Screening", ar: "فحص AML" },
        primaryRouteName: "AmlScreenings",
        resolveTarget: openDrawerTarget("AmlScreenings", "open"),
    }),
    defineSearchTargetPlugin({
        type: "aml_rule",
        order: 140,
        icon: "mdi-tune-variant",
        groupLabel: { en: "AML Rules", ar: "قواعد مكافحة غسل الأموال" },
        kindLabel: { en: "AML Rule", ar: "قاعدة AML" },
        primaryRouteName: "AmlRules",
        resolveTarget: openDrawerTarget("AmlRules", "open"),
    }),
    defineSearchTargetPlugin({
        type: "aml_report",
        order: 150,
        icon: "mdi-file-send-outline",
        groupLabel: { en: "Regulatory Reports (STR/LTR)", ar: "التقارير الرقابية" },
        kindLabel: { en: "AML Report", ar: "تقرير رقابي" },
        primaryRouteName: "AmlReports",
        resolveTarget: openDrawerTarget("AmlReports", "open"),
    }),
    defineSearchTargetPlugin({
        type: "gateway",
        order: 160,
        icon: "mdi-server-network",
        groupLabel: { en: "Gateways", ar: "بوابات الدفع" },
        kindLabel: { en: "Gateway", ar: "بوابة دفع" },
        primaryRouteName: "GatewayWizard",
        resolveTarget: routeParamTarget("GatewayWizard", "id"),
    }),
    defineSearchTargetPlugin({
        type: "rail",
        order: 170,
        icon: "mdi-contactless-payment-circle-outline",
        groupLabel: { en: "Payment Rails", ar: "قنوات الدفع" },
        kindLabel: { en: "Rail", ar: "قناة دفع" },
        primaryRouteName: "Rails",
        resolveTarget: openDrawerTarget("Rails", "open"),
    }),
    defineSearchTargetPlugin({
        type: "route",
        order: 180,
        icon: "mdi-transit-connection-variant",
        groupLabel: { en: "Rail Routes", ar: "مسارات التوجيه" },
        kindLabel: { en: "Route", ar: "مسار توجيه" },
        primaryRouteName: "GatewayRoutes",
        resolveTarget: openDrawerTarget("GatewayRoutes", "open"),
    }),
    defineSearchTargetPlugin({
        type: "credential_set",
        order: 185,
        icon: "mdi-key-chain-variant",
        groupLabel: { en: "Credential Sets", ar: "مجموعات بيانات الاعتماد" },
        kindLabel: { en: "Credential Set", ar: "مجموعة اعتماد" },
        primaryRouteName: "CredentialSets",
        // The vault page opens the matching set highlighted (and its drawer); secrets are never searched.
        resolveTarget: openDrawerTarget("CredentialSets", "highlight"),
    }),
    defineSearchTargetPlugin({
        type: "user",
        order: 190,
        icon: "mdi-account-badge-outline",
        groupLabel: { en: "Users & Staff", ar: "المستخدمون والموظفون" },
        kindLabel: { en: "User", ar: "مستخدم" },
        primaryRouteName: "AdminUserDetail",
        resolveTarget: routeParamTarget("AdminUserDetail", "id"),
    }),
    defineSearchTargetPlugin({
        type: "audit_log",
        order: 200,
        icon: "mdi-history",
        groupLabel: { en: "Audit Logs", ar: "سجل التدقيق الأمني" },
        kindLabel: { en: "Audit Log", ar: "سجل تدقيق" },
        primaryRouteName: "AuditLog",
        resolveTarget: openDrawerTarget("AuditLog", "open"),
    }),
].forEach((plugin) => clientSearchRegistry.register(plugin));

const ROUTE_PARENT_MAP: Record<string, string> = {
    JoinRequestNew: "JoinRequests",
    JoinRequestDetail: "JoinRequests",
    KybReviewDetail: "KybReview",
    MerchantDetail: "Merchants",
    AdminUserDetail: "AdminUsers",
    OperatorCaseDetail: "OperatorCases",
    GatewayInquirySchedules: "OperatorCases",
    GatewayWizard: "Gateways",
    GatewayAiImport: "Gateways",
};

function getRouteLineage(routeName: string): string[] {
    const lineage = [routeName];
    const seen = new Set(lineage);
    let current = routeName;

    while (true) {
        const parent = ROUTE_PARENT_MAP[current];
        if (!parent || seen.has(parent)) {
            break;
        }
        lineage.push(parent);
        seen.add(parent);
        current = parent;
    }

    return lineage;
}

export function isRouteAccessibleToUser(
    routeName: string,
    access: FrontendAccessContext,
): boolean {
    if (!routeName) {
        return false;
    }

    const allowedRoles = access.routesRoles?.[routeName];
    if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(access.role)) {
        return false;
    }

    const requiredAuthorities = access.routesAuthorities?.[routeName];
    if (requiredAuthorities && requiredAuthorities.length > 0) {
        const authorized = requiredAuthorities.some(
            (required) => access.authorities.has("*") || access.authorities.has(required),
        );
        if (!authorized) {
            return false;
        }
    }

    if (access.visibleRouteNames.size > 0) {
        const lineage = getRouteLineage(routeName);
        const visible = lineage.some((name) => access.visibleRouteNames.has(name));
        if (!visible) {
            return false;
        }
    }

    return true;
}

function getTargetRouteName(target: RouteLocationRaw): string | null {
    if (typeof target === "string") {
        return null;
    }
    if ("name" in target && typeof target.name === "string" && target.name) {
        return target.name;
    }
    return null;
}

function isValidTarget(target: RouteLocationRaw | null): target is RouteLocationRaw {
    if (!target) {
        return false;
    }
    if (typeof target === "string") {
        return target.trim().length > 0;
    }
    if ("name" in target) {
        return typeof target.name === "string" && target.name.length > 0;
    }
    if ("path" in target) {
        return typeof target.path === "string" && target.path.length > 0;
    }
    return false;
}

export interface NormalizedSearchGroup {
    plugin: SearchTargetPlugin;
    truncated: boolean;
    items: Array<{ item: SearchResultItem; target: RouteLocationRaw }>;
}

export function filterAndNormalizeServerGroups(
    groups: SearchResultGroup[],
    rawQuery: string,
    access: FrontendAccessContext,
): NormalizedSearchGroup[] {
    const output: NormalizedSearchGroup[] = [];

    for (const group of groups) {
        const plugin = clientSearchRegistry.get(group.type);
        if (!plugin) {
            continue;
        }

        const groupRouteNames = [
            plugin.primaryRouteName,
            ...(plugin.additionalRouteNames ?? []),
        ];
        if (!groupRouteNames.some((name) => isRouteAccessibleToUser(name, access))) {
            continue;
        }

        const validItems: Array<{ item: SearchResultItem; target: RouteLocationRaw }> = [];
        for (const item of group.items) {
            const target = plugin.resolveTarget(item, rawQuery);
            if (!isValidTarget(target)) {
                continue;
            }

            const targetRouteName = getTargetRouteName(target) ?? plugin.primaryRouteName;
            if (!isRouteAccessibleToUser(targetRouteName, access)) {
                continue;
            }

            validItems.push({ item, target });
        }

        if (validItems.length === 0) {
            continue;
        }

        output.push({
            plugin,
            truncated: group.truncated,
            items: validItems,
        });
    }

    return output;
}
