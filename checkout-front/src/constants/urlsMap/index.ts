import { getBaseUrl } from "../baseUrl";

// Streams are opened with EventSource, which does NOT go through the axios baseURL,
// so the status stream path must be absolute under the API base.
export const urlsMap = {
    payLink: (linkKey: string) => `v1/pay/${linkKey}`,
    payInitiate: (linkKey: string) => `v1/pay/${linkKey}/initiate`,
    payLogs: (linkKey: string, attemptId: string) => `v1/pay/${linkKey}/logs/${attemptId}`,
    payStatusStream: (linkKey: string, attemptId: string) =>
        `${getBaseUrl()}/v1/pay/${encodeURIComponent(linkKey)}/logs/${encodeURIComponent(attemptId)}/status`,
    payConfirm: (linkKey: string, attemptId: string) => `v1/pay/${linkKey}/logs/${attemptId}/confirm`,
    payResend: (linkKey: string, attemptId: string) => `v1/pay/${linkKey}/logs/${attemptId}/resend`,
    payCancel: (linkKey: string, attemptId: string) => `v1/pay/${linkKey}/logs/${attemptId}/cancel`,
    payClientEvent: (linkKey: string, attemptId: string) => `v1/pay/${linkKey}/logs/${attemptId}/client-event`,
    sandboxAccounts: (linkKey: string, railCode?: string | null) =>
        `v1/pay/${linkKey}/sandbox-accounts${railCode ? `?railCode=${encodeURIComponent(railCode)}` : ""}`,
    sandboxAccount: (linkKey: string, accountId: string) =>
        `v1/pay/${linkKey}/sandbox-accounts/${encodeURIComponent(accountId)}`,
    sandboxAccountMovements: (linkKey: string, accountId: string) =>
        `v1/pay/${linkKey}/sandbox-accounts/${encodeURIComponent(accountId)}/movements`,
    sandboxInspector: (linkKey: string, attemptId: string) =>
        `v1/pay/${linkKey}/logs/${attemptId}/sandbox-inspector`,
    sandboxSimulate: (linkKey: string, attemptId: string) =>
        `v1/pay/${linkKey}/logs/${attemptId}/sandbox-simulate`,
} as const;

export type UrlsMap = typeof urlsMap;
