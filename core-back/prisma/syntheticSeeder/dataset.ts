/**
 * The in-memory chronological graph.
 *
 * Phase 1 builds these arrays deterministically; phase 2 writes them in
 * topological FK order with chunked `createMany` calls. Using plain records
 * (rather than live Prisma calls) is what lets the STANDARD profile compile in
 * tens of seconds instead of hours.
 */
export interface SyntheticDataset {
  users: any[];
  userIdentities: any[];
  merchants: any[];
  joinRequests: any[];
  kybDocuments: any[];
  beneficialOwners: any[];
  wallets: any[];
  glAccounts: any[];
  applications: any[];
  accessTokens: any[];
  accessTokenIps: any[];
  posTerminals: any[];
  posScreens: any[];
  commissionProfiles: any[];
  credentialSets: any[];
  gatewayVersions: any[];
  gatewayVersionEvidence: any[];
  gatewayEnvironments: any[];
  gatewayAuths: any[];
  gatewaySettings: any[];
  rails: any[];
  railFields: any[];
  railRoutes: any[];
  widgets: any[];
  redirects: any[];
  pollPolicies: any[];
  statementSources: any[];
  paymentLinks: any[];
  attemptGroups: any[];
  paymentAttempts: any[];
  attemptStepLogs: any[];
  inboundEvents: any[];
  journalEntries: any[];
  journalLines: any[];
  gatewayHealthSamples: any[];
  reconciliationRuns: any[];
  reconciliationItems: any[];
  disputes: any[];
  adjustments: any[];
  cashoutRequests: any[];
  amlScreenings: any[];
  amlScreeningMatches: any[];
  amlCases: any[];
  regulatoryReports: any[];
  operatorCases: any[];
  approvalRequests: any[];
  notifications: any[];
  notificationTemplates: any[];
  auditLogs: any[];
  detailChangeLogs: any[];
  velocityRules: any[];
  amlRules: any[];
  reportingRules: any[];
  platformSettings: any[];
}

export const emptyDataset = (): SyntheticDataset => ({
  users: [],
  userIdentities: [],
  merchants: [],
  joinRequests: [],
  kybDocuments: [],
  beneficialOwners: [],
  wallets: [],
  glAccounts: [],
  applications: [],
  accessTokens: [],
  accessTokenIps: [],
  posTerminals: [],
  posScreens: [],
  commissionProfiles: [],
  credentialSets: [],
  gatewayVersions: [],
  gatewayVersionEvidence: [],
  gatewayEnvironments: [],
  gatewayAuths: [],
  gatewaySettings: [],
  rails: [],
  railFields: [],
  railRoutes: [],
  widgets: [],
  redirects: [],
  pollPolicies: [],
  statementSources: [],
  paymentLinks: [],
  attemptGroups: [],
  paymentAttempts: [],
  attemptStepLogs: [],
  inboundEvents: [],
  journalEntries: [],
  journalLines: [],
  gatewayHealthSamples: [],
  reconciliationRuns: [],
  reconciliationItems: [],
  disputes: [],
  adjustments: [],
  cashoutRequests: [],
  amlScreenings: [],
  amlScreeningMatches: [],
  amlCases: [],
  regulatoryReports: [],
  operatorCases: [],
  approvalRequests: [],
  notifications: [],
  notificationTemplates: [],
  auditLogs: [],
  detailChangeLogs: [],
  velocityRules: [],
  amlRules: [],
  reportingRules: [],
  platformSettings: [],
});

export interface SeederTotals {
  merchants: number;
  joinRequests: number;
  kybDocuments: number;
  beneficialOwners: number;
  users: number;
  wallets: number;
  applications: number;
  paymentLinks: number;
  paymentAttempts: number;
  journalEntries: number;
  journalLines: number;
  reconciliationRuns: number;
  reconciliationItems: number;
  disputes: number;
  adjustments: number;
  cashouts: number;
  amlScreenings: number;
  amlCases: number;
  operatorCases: number;
  approvalRequests: number;
}
