const TOKEN_KEY = "fake-rails-token";
const USER_KEY = "fake-rails-user";

export interface TesterUser {
  username: string;
  environment?: string;
  allowInProduction?: boolean;
}

export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token);
export const getUser = (): TesterUser | null => {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TesterUser;
  } catch {
    return null;
  }
};
export const setUser = (user: TesterUser): void => localStorage.setItem(USER_KEY, JSON.stringify(user));
export const clearSession = (): void => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
};
export const isAuthenticated = (): boolean => Boolean(getToken());

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const api = async <T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> => {
  const token = getToken();
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  if (response.status === 401) {
    clearSession();
    if (!location.pathname.startsWith("/hosted")) {
      location.assign("/login");
    }
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new ApiRequestError(response.status, payload.code ?? "REQUEST_FAILED", payload.message ?? response.statusText);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as T;
  }
  return (await response.text()) as unknown as T;
};

/** The stream URL carries a 30s single-use ticket, never the session token (GAP-024). */
export const streamUrl = async (): Promise<string> => {
  const { ticket } = await api<{ ticket: string }>("/portal-api/transactions/stream-ticket", { method: "POST", body: {} });
  return `/portal-api/transactions/stream?ticket=${encodeURIComponent(ticket)}`;
};

export const HOSTED_ACTION_HEADER = "x-hosted-action-token";

/** Loads a hosted session and posts one tester action with the session-bound action token. */
export const postHostedAction = async <T = unknown>(reference: string, action: string): Promise<T> => {
  const session = await api<{ action_token?: string }>(`/portal-api/hosted/session/${encodeURIComponent(reference)}`);
  return api<T>(`/portal-api/hosted/session/${encodeURIComponent(reference)}/action`, {
    method: "POST",
    body: { action },
    headers: session.action_token ? { [HOSTED_ACTION_HEADER]: session.action_token } : {},
  });
};

export const download = async (path: string, body: unknown, filename: string): Promise<void> => {
  const token = getToken();
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ApiRequestError(response.status, "DOWNLOAD_FAILED", "Statement generation failed");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};
