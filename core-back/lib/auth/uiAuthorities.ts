/**
 * Projects the backend authority vocabulary (`resource:action`, the names the
 * core and the edge guards enforce) onto the admin portal's UI vocabulary
 * (`resource.action`, the keys the sidebar and the router guards read).
 *
 * The two vocabularies differ: the backend is coarse (`gateway:write` covers
 * every route editor) while the portal gates individual screens
 * (`gateways.edit`). The projection is presentation-only — the core and the
 * edge still authorise every request against the real authority strings — so a
 * missing entry can only hide a screen, never grant access.
 *
 * The raw authorities are always included as `true` as well, so a screen that
 * checks a backend name (or an operator who stored a UI key directly on the
 * user) keeps working.
 */
const UI_PROJECTION: Record<string, readonly string[]> = {
  "merchant:read": ["merchants.read", "support.read_merchant"],
  "merchant:write": ["merchants.read", "merchants.edit_descriptive", "merchants.propose_sensitive"],
  "kyb:read": ["joinrequests.review", "kyb.review"],
  "kyb:write": ["joinrequests.review", "kyb.review"],
  "compliance:read": ["aml.read_confidential", "aml.review", "reports.draft"],
  "compliance:write": ["aml.read_confidential", "aml.review", "aml.propose", "reports.draft"],
  "aml:read": ["aml.review"],
  "aml:write": ["aml.review", "aml.propose"],
  "report:review": ["reports.draft"],
  "report:approve": ["reports.draft"],
  "approval:check": ["approvals.approve", "approvals.reject", "users_admin.propose"],
  "approval:write": ["approvals.approve", "approvals.reject", "users_admin.propose"],
  "finance:read": ["profit.read", "liquidity.read"],
  "finance:write": ["profit.read", "liquidity.read", "adjustments.propose"],
  "cashout:read": ["cashout.read"],
  "cashout:review": ["cashout.read", "cashout.process"],
  "commission:read": ["profit.read"],
  "commission:write": ["commission.propose", "profit.read"],
  "velocity:read": ["liquidity.read"],
  "velocity:write": ["velocity.propose", "liquidity.read"],
  "reconciliation:read": ["reconciliation.run"],
  "reconciliation:write": ["reconciliation.run", "reconciliation.resolve"],
  "gateway:read": ["gateways.edit"],
  "gateway:write": ["gateways.edit"],
  "gateway:test": ["gateways.edit"],
  "operator:read": ["support.read_merchant"],
  "operator:write": ["support.read_merchant"],
  "case:read": ["support.read_merchant"],
  "case:write": ["support.read_merchant"],
  "user:write": ["users_admin.propose"],
  "security:read": ["approvals.approve", "approvals.reject"],
  "security:write": ["approvals.approve", "approvals.reject", "users_admin.propose"],
  "credential:write": ["credentials.manage"],
};

export const buildUiAuthoritiesMap = (authorities: readonly string[]): Record<string, boolean> => {
  const map: Record<string, boolean> = {};
  for (const authority of authorities) {
    map[authority] = true;
    for (const uiAuthority of UI_PROJECTION[authority] ?? []) {
      map[uiAuthority] = true;
    }
  }
  return map;
};

/** The identity the admin portal stores in `userInfo`. */
export interface AdminUserInfo {
  id: string;
  name: string;
  username: string;
  role: string;
  email: string | null;
  phone: string | null;
  isMaker: boolean;
  isChecker: boolean;
  authoritiesMap: Record<string, boolean>;
}

export const buildAdminUserInfo = (user: {
  id: string;
  email: string;
  phone: string | null;
  role: string;
  isMaker: boolean;
  isChecker: boolean;
}, authorities: readonly string[]): AdminUserInfo => ({
  id: user.id,
  name: user.email.split("@")[0] ?? user.email,
  username: user.email,
  role: user.role,
  email: user.email,
  phone: user.phone,
  isMaker: user.isMaker,
  isChecker: user.isChecker,
  authoritiesMap: buildUiAuthoritiesMap(authorities),
});

/**
 * Merchant portal projection. The merchant backend issues the coarse
 * `merchant:read`, `merchant:write`, `link:write` and `payment:read`
 * authorities; the merchant sidebar gates screens with `resource.action` keys.
 */
const MERCHANT_UI_PROJECTION: Record<string, readonly string[]> = {
  "merchant:read": [
    "stats.read",
    "wallets.read",
    "statements.read",
    "applications.read",
    "links.read",
    "payments.read",
    "cashout.read",
  ],
  "merchant:write": [
    "stats.read",
    "wallets.read",
    "statements.read",
    "statements.export",
    "applications.read",
    "applications.edit_descriptive",
    "applications.propose_sensitive",
    "merchants.read",
    "merchants.edit_descriptive",
    "merchants.propose_sensitive",
    "links.read",
    "links.create",
    "links.cancel",
    "payments.read",
    "payments.export",
    "cashout.read",
    "cashout.request",
    "pos.manage",
    "pos.operate",
    "tokens.read",
    "tokens.create",
    "tokens.revoke",
    "credentials.manage",
    "users.manage",
  ],
  "link:write": ["links.read", "links.create", "links.cancel"],
  "payment:read": ["payments.read", "payments.export", "stats.read"],
};

export const buildMerchantUiAuthoritiesMap = (authorities: readonly string[]): Record<string, boolean> => {
  const map: Record<string, boolean> = {};
  for (const authority of authorities) {
    map[authority] = true;
    for (const uiAuthority of MERCHANT_UI_PROJECTION[authority] ?? []) {
      map[uiAuthority] = true;
    }
  }
  return map;
};

export interface MerchantUserInfo {
  id: string;
  name: string;
  username: string;
  role: string;
  email: string | null;
  phone: string | null;
  merchantId: string | null;
  merchantTradeName: string | null;
  isMaker: boolean;
  isChecker: boolean;
  appScopeIds: string[];
  authoritiesMap: Record<string, boolean>;
}

export const buildMerchantUserInfo = (
  user: {
    id: string;
    email: string | null;
    phone: string | null;
    role: string;
    merchantId: string | null;
    merchantTradeName?: string | null;
    isMaker: boolean;
    isChecker: boolean;
  },
  authorities: readonly string[],
  appScopeIds: readonly string[],
): MerchantUserInfo => {
  const identifier = user.email ?? user.phone ?? user.id;
  return {
    id: user.id,
    name: identifier.split("@")[0] ?? identifier,
    username: identifier,
    role: user.role,
    email: user.email,
    phone: user.phone,
    merchantId: user.merchantId,
    merchantTradeName: user.merchantTradeName ?? null,
    isMaker: user.isMaker,
    isChecker: user.isChecker,
    appScopeIds: [...appScopeIds],
    authoritiesMap: buildMerchantUiAuthoritiesMap(authorities),
  };
};
