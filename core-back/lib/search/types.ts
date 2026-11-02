export const V1_SEARCH_TYPES = [
  "merchant",
  "payment_attempt",
  "join_request",
  "kyb_document",
  "user",
  "approval",
  "audit_log",
  "aml_case",
  "aml_screening",
  "aml_rule",
  "aml_report",
  "operator_case",
  "gateway_inquiry",
  "dispute",
  "adjustment",
  "cashout",
  "reconciliation_run",
  "gateway",
  "rail",
  "route",
] as const;

export type BuiltinSearchType = (typeof V1_SEARCH_TYPES)[number];

export type SearchType = BuiltinSearchType | (string & {});

export interface GlobalSearchRequest {
  query: string;
  types?: SearchType[];
  limit?: number;
}

export interface SearchResultItem {
  id: string;
  title: string;
  subtitle?: string;
  reference?: string;
  status?: string;
  merchantId?: string;
  operatorCaseId?: string;
  meta?: Record<string, string | number | boolean | null>;
}

export interface SearchResultGroup {
  type: SearchType;
  items: SearchResultItem[];
  truncated: boolean;
}

export interface GlobalSearchResponse {
  query: string;
  groups: SearchResultGroup[];
  total: number;
  tookMs: number;
  partial: boolean;
}
