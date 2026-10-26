export const urlsMap = {
    payLink: (linkKey: string) => `v1/pay/${linkKey}`,
    payInitiate: (linkKey: string) => `v1/pay/${linkKey}/initiate`,
    payLogs: (linkKey: string, attemptId: string) => `v1/pay/${linkKey}/logs/${attemptId}`,
    payStatusStream: (linkKey: string, attemptId: string) => `v1/pay/${linkKey}/logs/${attemptId}/status`,
    payConfirm: (linkKey: string, attemptId: string) => `v1/pay/${linkKey}/logs/${attemptId}/confirm`,
    payResend: (linkKey: string, attemptId: string) => `v1/pay/${linkKey}/logs/${attemptId}/resend`,
    payCancel: (linkKey: string, attemptId: string) => `v1/pay/${linkKey}/logs/${attemptId}/cancel`,
    payClientEvent: (linkKey: string, attemptId: string) => `v1/pay/${linkKey}/logs/${attemptId}/client-event`,
} as const;

export type UrlsMap = typeof urlsMap;
