import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ApiError } from "../../lib/error";
import { compileUrl, assertNoControlCharacters, validateFinalUrl, type QueryValue } from "./compileUrl";
import { recursiveSelect } from "./recursiveSelect";

export type GatewayAuthMethod =
  | "NONE"
  | "API_KEY"
  | "PERMANENT_TOKEN"
  | "TOKEN_ENDPOINT"
  | "REFRESH_TOKEN"
  | "USERNAME_PASSWORD"
  | "BASIC"
  | "REQUEST_SIGNATURE"
  | "OAUTH2_CLIENT_CREDENTIALS"
  | "MUTUAL_TLS";

export type AuthApply = "HEADER" | "QUERY" | "BODY";
export type ConsumerSideEffect = "READ_ONLY" | "SENDS_NOTIFICATION" | "MOVES_MONEY";
export type ConsumerRetryPolicy = "NEVER" | "SAFE" | "SAFE_WITH_COOLDOWN";

export interface CredentialEntry {
  key: string;
  value: string;
  type?: string;
  is_secret?: boolean;
  secret_version?: number;
  valid_from?: Date | string;
  valid_to?: Date | string;
}

export interface GatewayAuthConfig {
  method: GatewayAuthMethod;
  apply?: AuthApply;
  header_name?: string;
  query_name?: string;
  body_name?: string;
  token_endpoint?: string;
  refresh_url?: string;
  refresh_period_ms?: number;
  access_token_selector?: string;
  refresh_token_selector?: string;
  new_refresh_token_selector?: string;
  expires_in_selector?: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  username_field?: string;
  password_field?: string;
  refresh_token_field?: string;
  signature_header?: string;
  timestamp_header?: string;
  signature_algorithm?: "HMAC_SHA256" | "HMAC_SHA512";
}

export interface RotatingRefreshTokenPersistenceInput {
  newRefreshToken: string;
  gatewayId: string;
  env: string;
  credentialSetId: string;
  selector: string;
}

export interface DnsLookupHook {
  (hostname: string): Promise<string[]>;
}

export interface ApiConsumerLogger {
  info(payload: Record<string, unknown>): void;
  warn(payload: Record<string, unknown>): void;
  error(payload: Record<string, unknown>): void;
}

type FetchBody = string | Uint8Array | ArrayBuffer | URLSearchParams | FormData | Blob;
type FetchTlsOptions = { cert: string; key: string; ca?: string[] };

export interface ApiConsumerConfig {
  gatewayId: string;
  env: string;
  credentialSetId: string;
  allowedHosts: readonly string[];
  auth: GatewayAuthConfig;
  credentials?: Record<string, string | Buffer> | readonly CredentialEntry[];
  baseUrl?: string;
  fetch?: typeof fetch;
  dnsLookup?: DnsLookupHook;
  dnsGuard?: (hostname: string) => Promise<void>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxJsonDepth?: number;
  rotatingRefreshTokenPersistence?: (
    input: RotatingRefreshTokenPersistenceInput,
  ) => Promise<void> | void;
  logger?: ApiConsumerLogger;
}

export interface ApiConsumerRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  sideEffect?: ConsumerSideEffect;
  retryPolicy?: ConsumerRetryPolicy;
  pointOfNoReturn?: boolean;
  maxRetries?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
}

export interface ApiConsumerResponse<T = unknown> {
  ok: boolean;
  status: number;
  headers: Headers;
  rawText: string;
  data: T;
  url: string;
}

export interface ConsumerAuthState {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  kind: GatewayAuthMethod;
  credentials: Record<string, string>;
}

export class ApiConsumerError extends Error {
  readonly status?: number;
  readonly rawText?: string;
  readonly data?: unknown;
  readonly retryable: boolean;
  readonly moneyUncertain: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      rawText?: string;
      data?: unknown;
      retryable?: boolean;
      moneyUncertain?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "ApiConsumerError";
    this.status = options.status;
    this.rawText = options.rawText;
    this.data = options.data;
    this.retryable = options.retryable ?? false;
    this.moneyUncertain = options.moneyUncertain ?? false;
  }
}

export function isAuthenticationError(error: unknown): boolean {
  return error instanceof ApiConsumerError && (error.status === 401 || error.status === 403);
}

function ipv4Number(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (octet > 255) {
      return undefined;
    }
    result = result * 256 + octet;
  }
  return result;
}

function inIpv4Range(address: string, cidr: string): boolean {
  const [network, bitsText] = cidr.split("/");
  const addressValue = ipv4Number(address);
  const networkValue = ipv4Number(network ?? "");
  const bits = Number(bitsText);
  if (addressValue === undefined || networkValue === undefined || !Number.isInteger(bits)) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((addressValue & mask) >>> 0) === ((networkValue & mask) >>> 0);
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = ipv4Number(normalized);
  if (ipv4 !== undefined) {
    const blocked = [
      "0.0.0.0/8",
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.0.0.0/24",
      "192.0.2.0/24",
      "192.168.0.0/16",
      "198.18.0.0/15",
      "198.51.100.0/24",
      "203.0.113.0/24",
      "224.0.0.0/4",
      "240.0.0.0/4",
    ];
    return !blocked.some((cidr) => inIpv4Range(normalized, cidr));
  }
  if (isIP(normalized) !== 6) {
    return false;
  }
  if (normalized === "::" || normalized === "::1") {
    return false;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return false;
  }
  if (/^fe[89ab]/.test(normalized)) {
    return false;
  }
  if (normalized.startsWith("ff")) {
    return false;
  }
  if (normalized.startsWith("2001:db8")) {
    return false;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1]) {
    return isPublicIpAddress(mapped[1]);
  }
  return true;
}

function defaultDnsLookup(hostname: string): Promise<string[]> {
  return lookup(hostname, { all: true, verbatim: true }).then((addresses) => addresses.map((entry) => entry.address));
}

function credentialMap(
  credentials: ApiConsumerConfig["credentials"],
): Record<string, string> {
  const output: Record<string, string> = {};
  if (!credentials) {
    return output;
  }
  if (Array.isArray(credentials)) {
    for (const entry of credentials) {
      output[entry.key] = entry.value;
    }
    return output;
  }
  for (const [key, value] of Object.entries(credentials)) {
    output[key] = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  }
  return output;
}

function firstCredential(credentials: Record<string, string>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = credentials[name];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

function selectString(payload: unknown, selector: string | undefined, fallback: readonly string[]): string | undefined {
  if (selector) {
    const value = recursiveSelect(payload, selector);
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
  }
  for (const path of fallback) {
    const value = recursiveSelect(payload, path);
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
  }
  return undefined;
}

function parseJsonDepth(text: string, maximumDepth: number): unknown {
  const value = JSON.parse(text) as unknown;
  const visit = (item: unknown, depth: number): void => {
    if (depth > maximumDepth) {
      throw new ApiConsumerError(`Gateway JSON response exceeds depth ${maximumDepth}`);
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child, depth + 1);
      }
      return;
    }
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  return value;
}

function assertSafeResponseContent(rawText: string, contentType: string | null): void {
  if (contentType?.includes("xml") && /<!DOCTYPE|<!ENTITY/i.test(rawText)) {
    throw new ApiConsumerError("XML DTD and external entities are forbidden");
  }
}

function combineSignals(controller: AbortController, external: AbortSignal | undefined): () => void {
  if (!external) {
    return () => undefined;
  }
  if (external.aborted) {
    controller.abort(external.reason);
    return () => undefined;
  }
  const abort = (): void => controller.abort(external.reason);
  external.addEventListener("abort", abort, { once: true });
  return () => external.removeEventListener("abort", abort);
}

export class ApiConsumer {
  private readonly config: ApiConsumerConfig;
  private readonly credentials: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly dnsLookup: DnsLookupHook;
  private readonly logger?: ApiConsumerLogger;
  private authState: ConsumerAuthState | null = null;
  private refreshPromise: Promise<ConsumerAuthState> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private tlsOptions: FetchTlsOptions | undefined;
  private stopped = false;

  constructor(config: ApiConsumerConfig) {
    this.config = config;
    this.credentials = credentialMap(config.credentials);
    this.fetchImpl = config.fetch ?? fetch;
    this.dnsLookup = config.dnsLookup ?? defaultDnsLookup;
    this.logger = config.logger;
  }

  get auth(): ConsumerAuthState | null {
    return this.authState;
  }

  async getAuth(): Promise<ConsumerAuthState> {
    if (this.authState) {
      return this.authState;
    }
    return this.refreshAuth();
  }

  async refreshAuth(): Promise<ConsumerAuthState> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    const promise = this.performRefresh();
    this.refreshPromise = promise;
    try {
      const state = await promise;
      return state;
    } finally {
      if (this.refreshPromise === promise) {
        this.refreshPromise = null;
      }
    }
  }

  async request<T = unknown>(request: ApiConsumerRequest): Promise<ApiConsumerResponse<T>> {
    const sideEffect = request.sideEffect ?? "READ_ONLY";
    const pointOfNoReturn = request.pointOfNoReturn ?? false;
    const retryPolicy = request.retryPolicy ?? "NEVER";
    const safePreMoney = sideEffect !== "MOVES_MONEY" && !pointOfNoReturn;
    const maximumRetries = safePreMoney && retryPolicy !== "NEVER" ? Math.max(0, request.maxRetries ?? 1) : 0;
    let networkAttempt = 0;

    while (true) {
      try {
        const response = await this.send<T>(request);
        if ((response.status === 401 || response.status === 403) && safePreMoney) {
          await this.refreshAuth();
          const refreshed = await this.send<T>(request);
          if (!refreshed.ok) {
            throw this.responseError(refreshed);
          }
          return refreshed;
        }
        if (!response.ok) {
          throw this.responseError(response);
        }
        return response;
      } catch (error) {
        const canRetry = safePreMoney
          && retryPolicy !== "NEVER"
          && networkAttempt < maximumRetries
          && error instanceof ApiConsumerError
          && error.retryable
          && !(error instanceof ApiConsumerError && error.moneyUncertain);
        if (!canRetry) {
          throw error;
        }
        networkAttempt += 1;
        await new Promise((resolve) => setTimeout(resolve, request.retryDelayMs ?? 100));
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.tlsOptions = undefined;
  }

  private async send<T>(request: ApiConsumerRequest): Promise<ApiConsumerResponse<T>> {
    const url = compileUrl(request.url, request.query, {
      allowedHosts: this.config.allowedHosts,
      requireHttps: true,
    });
    const parsed = new URL(url);
    await this.assertDnsAllowed(parsed.hostname);
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      assertNoControlCharacters(key, "header name");
      assertNoControlCharacters(value, "header");
      headers.set(key, value);
    }
    const auth = await this.getAuth();
    const query = new URL(url);
    let rawBody = request.body;
    if (rawBody !== undefined && rawBody !== null && typeof rawBody === "object"
      && !(rawBody instanceof URLSearchParams) && !(rawBody instanceof ArrayBuffer)
      && !ArrayBuffer.isView(rawBody)) {
      rawBody = { ...(rawBody as Record<string, unknown>) };
    }
    this.applyAuthentication(auth, headers, query, rawBody);
    const body = this.serializeBody(rawBody, headers);
    const finalUrl = query.toString();
    validateFinalUrl(finalUrl, { allowedHosts: this.config.allowedHosts, requireHttps: true });

    const controller = new AbortController();
    const removeExternalAbort = combineSignals(controller, request.signal);
    const timeout = setTimeout(
      () => controller.abort(new Error(`Gateway request timed out after ${request.timeoutMs ?? this.config.timeoutMs ?? 15000}ms`)),
      request.timeoutMs ?? this.config.timeoutMs ?? 15000,
    );
    try {
      const init: RequestInit & { tls?: FetchTlsOptions } = {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      };
      if (request.method !== "GET" && request.method !== "DELETE") {
        init.body = body;
      } else {
        delete init.body;
      }
      if (this.config.auth.method === "MUTUAL_TLS") {
        init.tls = this.getTlsOptions();
      }
      const response = await this.fetchImpl(finalUrl, init);
      if (response.status >= 300 && response.status < 400) {
        throw new ApiConsumerError("Gateway redirects are forbidden", { status: response.status, retryable: false });
      }
      const rawText = await this.readRawText(response);
      const contentType = response.headers.get("content-type");
      assertSafeResponseContent(rawText, contentType);
      let data: unknown = rawText;
      if (rawText && contentType?.includes("json")) {
        try {
          data = parseJsonDepth(rawText, this.config.maxJsonDepth ?? 64);
        } catch (error) {
          throw new ApiConsumerError(error instanceof Error ? error.message : "Invalid JSON response", {
            status: response.status,
            rawText,
          });
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        rawText,
        data: data as T,
        url: finalUrl,
      };
    } catch (error) {
      if (error instanceof ApiConsumerError) {
        throw error;
      }
      const timedOut = controller.signal.aborted;
      throw new ApiConsumerError(
        timedOut ? "Gateway request timed out" : error instanceof Error ? error.message : "Gateway request failed",
        {
          retryable: true,
          moneyUncertain: request.sideEffect === "MOVES_MONEY" || request.pointOfNoReturn,
        },
      );
    } finally {
      clearTimeout(timeout);
      removeExternalAbort();
    }
  }

  private responseError<T>(response: ApiConsumerResponse<T>): ApiConsumerError {
    return new ApiConsumerError(`Gateway returned HTTP ${response.status}`, {
      status: response.status,
      rawText: response.rawText,
      data: response.data,
      retryable: response.status >= 500,
    });
  }

  private serializeBody(body: unknown, headers: Headers): FetchBody | undefined {
    if (body === undefined || body === null) {
      return undefined;
    }
    if (typeof body === "string" || body instanceof URLSearchParams || body instanceof ArrayBuffer) {
      return body as FetchBody;
    }
    if (ArrayBuffer.isView(body)) {
      return body as FetchBody;
    }
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return JSON.stringify(body);
  }

  private applyAuthentication(
    auth: ConsumerAuthState,
    headers: Headers,
    url: URL,
    body: unknown,
  ): void {
    const method = this.config.auth.method;
    const apply = this.config.auth.apply ?? this.defaultApply(method);
    if (method === "NONE") {
      return;
    }
    if (method === "API_KEY") {
      const value = firstCredential(this.credentials, ["apiKey", "api_key", "key"]);
      if (!value) {
        throw new Error("API_KEY credential is missing");
      }
      const header = this.config.auth.header_name ?? "X-API-KEY";
      if (apply === "QUERY") {
        url.searchParams.set(this.config.auth.query_name ?? "api_key", value);
      } else if (apply === "BODY") {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("API_KEY body authentication requires an object body");
        }
        (body as Record<string, unknown>)[this.config.auth.body_name ?? "api_key"] = value;
      } else {
        headers.set(header, value);
      }
      return;
    }
    if (method === "PERMANENT_TOKEN") {
      const token = firstCredential(this.credentials, ["token", "accessToken", "access_token", "permanentToken"])
        ?? auth.accessToken;
      if (!token) {
        throw new Error("Permanent token credential is missing");
      }
      headers.set(this.config.auth.header_name ?? "Authorization", `Bearer ${token}`);
      return;
    }
    if (method === "BASIC") {
      const username = firstCredential(this.credentials, ["username", "user"]);
      const password = firstCredential(this.credentials, ["password", "pass"]);
      if (!username || password === undefined) {
        throw new Error("Basic authentication credentials are missing");
      }
      headers.set(this.config.auth.header_name ?? "Authorization", `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
      return;
    }
    if (method === "REQUEST_SIGNATURE") {
      const secret = firstCredential(this.credentials, ["secret", "signingSecret", "signatureSecret", "apiSecret"]);
      if (!secret) {
        throw new Error("Request signature secret is missing");
      }
      const timestamp = String(Math.floor(Date.now() / 1000));
      const rawBody = typeof body === "string" ? body : "";      const algorithm = this.config.auth.signature_algorithm ?? "HMAC_SHA256";
      const digest = createHmac(algorithm === "HMAC_SHA512" ? "sha512" : "sha256", secret)
        .update(`${timestamp}.${rawBody}`)
        .digest("hex");
      headers.set(this.config.auth.timestamp_header ?? "X-Timestamp", timestamp);
      headers.set(this.config.auth.signature_header ?? "X-Signature", digest);
      const apiKey = firstCredential(this.credentials, ["apiKey", "api_key"]);
      if (apiKey) {
        headers.set("X-API-KEY", apiKey);
      }
      return;
    }
    if (method === "MUTUAL_TLS") {
      return;
    }
    if (auth.accessToken) {
      headers.set(this.config.auth.header_name ?? "Authorization", `Bearer ${auth.accessToken}`);
    }
  }

  private defaultApply(method: GatewayAuthMethod): AuthApply {
    return method === "API_KEY" ? "HEADER" : "HEADER";
  }

  private async performRefresh(): Promise<ConsumerAuthState> {
    const method = this.config.auth.method;
    if (method === "NONE" || method === "API_KEY" || method === "PERMANENT_TOKEN" || method === "BASIC" || method === "REQUEST_SIGNATURE" || method === "MUTUAL_TLS") {
      const state: ConsumerAuthState = { kind: method, credentials: { ...this.credentials } };
      this.authState = state;
      return state;
    }
    const endpoint = method === "REFRESH_TOKEN"
      ? this.config.auth.refresh_url
      : this.config.auth.token_endpoint;
    if (!endpoint) {
      throw new Error(`Authentication method ${method} requires a token endpoint`);
    }
    const token = await this.requestToken(endpoint, method);
    const state: ConsumerAuthState = {
      kind: method,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      credentials: { ...this.credentials },
    };
    if (token.newRefreshToken && this.config.rotatingRefreshTokenPersistence) {
      await this.config.rotatingRefreshTokenPersistence({
        newRefreshToken: token.newRefreshToken,
        gatewayId: this.config.gatewayId,
        env: this.config.env,
        credentialSetId: this.config.credentialSetId,
        selector: this.config.auth.new_refresh_token_selector ?? "refresh_token",
      });
    }
    this.authState = state;
    this.scheduleRefresh(token.refreshAfterMs);
    return state;
  }

  private async requestToken(
    endpoint: string,
    method: GatewayAuthMethod,
  ): Promise<{
    accessToken: string;
    refreshToken?: string;
    newRefreshToken?: string;
    expiresAt?: number;
    refreshAfterMs?: number;
  }> {
    const url = compileUrl(endpoint, undefined, {
      allowedHosts: this.config.allowedHosts,
      requireHttps: true,
    });
    const parsed = new URL(url);
    await this.assertDnsAllowed(parsed.hostname);
    const form = new URLSearchParams();
    if (method === "OAUTH2_CLIENT_CREDENTIALS" || method === "TOKEN_ENDPOINT") {
      form.set("grant_type", "client_credentials");
    } else if (method === "REFRESH_TOKEN") {
      form.set("grant_type", "refresh_token");
    } else if (method === "USERNAME_PASSWORD") {
      form.set("grant_type", "password");
    }
    const clientId = this.config.auth.client_id
      ? this.credentials[this.config.auth.client_id]
      : firstCredential(this.credentials, ["clientId", "client_id"]);
    const clientSecret = this.config.auth.client_secret
      ? this.credentials[this.config.auth.client_secret]
      : firstCredential(this.credentials, ["clientSecret", "client_secret"]);
    if (clientId) {
      form.set(this.config.auth.username_field ?? "client_id", clientId);
    }
    if (clientSecret) {
      form.set(this.config.auth.password_field ?? "client_secret", clientSecret);
    }
    if (method === "USERNAME_PASSWORD") {
      const username = firstCredential(this.credentials, ["username", "user"]);
      const password = firstCredential(this.credentials, ["password", "pass"]);
      if (!username || password === undefined) {
        throw new Error("Username and password credentials are missing");
      }
      form.set(this.config.auth.username_field ?? "username", username);
      form.set(this.config.auth.password_field ?? "password", password);
    }
    if (method === "REFRESH_TOKEN") {
      const refreshToken = firstCredential(this.credentials, ["refreshToken", "refresh_token"])
        ?? this.authState?.refreshToken;
      if (!refreshToken) {
        throw new Error("Refresh token credential is missing");
      }
      form.set(this.config.auth.refresh_token_field ?? "refresh_token", refreshToken);
    }
    if (this.config.auth.scope) {
      form.set("scope", this.config.auth.scope);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 10000);
    try {
      const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
      if (clientId && clientSecret) {
        headers.set("Authorization", `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`);
      }
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: form,
        redirect: "manual",
        signal: controller.signal,
      });
      const rawText = await this.readRawText(response);
      let payload: unknown = rawText;
      if (rawText) {
        try {
          payload = JSON.parse(rawText) as unknown;
        } catch {
          payload = rawText;
        }
      }
      if (!response.ok) {
        throw new ApiConsumerError(`Token endpoint returned HTTP ${response.status}`, {
          status: response.status,
          rawText,
          data: payload,
        });
      }
      const accessToken = selectString(
        payload,
        this.config.auth.access_token_selector,
        ["access_token", "accessToken", "token"],
      );
      if (!accessToken) {
        throw new Error("Token endpoint response does not contain an access token");
      }
      const refreshToken = selectString(
        payload,
        this.config.auth.refresh_token_selector,
        ["refresh_token", "refreshToken"],
      );
      const newRefreshToken = selectString(
        payload,
        this.config.auth.new_refresh_token_selector,
        ["new_refresh_token", "newRefreshToken"],
      );
      const expiresInText = selectString(
        payload,
        this.config.auth.expires_in_selector,
        ["expires_in", "expiresIn"],
      );
      const expiresIn = expiresInText ? Number(expiresInText) : undefined;
      const refreshPeriod = this.config.auth.refresh_period_ms;
      const refreshAfterMs = refreshPeriod ?? (expiresIn ? Math.max(1000, expiresIn * 1000 - 30000) : undefined);
      return {
        accessToken,
        refreshToken,
        newRefreshToken,
        expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
        refreshAfterMs,
      };
    } catch (error) {
      if (error instanceof ApiConsumerError) {
        throw error;
      }
      throw new ApiConsumerError(error instanceof Error ? error.message : "Token refresh failed", { retryable: true });
    } finally {
      clearTimeout(timeout);
    }
  }

  private scheduleRefresh(refreshAfterMs?: number): void {
    if (this.stopped || !refreshAfterMs || refreshAfterMs <= 0) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    const jittered = Math.max(1, Math.round(refreshAfterMs * (0.9 + Math.random() * 0.2)));
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshAuth()
        .catch((error) => {
          this.logger?.warn({
            gatewayId: this.config.gatewayId,
            credentialSetId: this.config.credentialSetId,
            message: error instanceof Error ? error.message : "Authentication refresh failed",
          });
        })
        .finally(() => {
          if (!this.stopped) {
            const accelerated = Math.min(refreshAfterMs, 30000);
            this.scheduleRefresh(accelerated);
          }
        });
    }, jittered);
    this.refreshTimer.unref?.();
  }

  private async assertDnsAllowed(hostname: string): Promise<void> {
    const normalized = hostname.toLowerCase().replace(/\.$/, "");
    if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
      throw new ApiConsumerError(`Hostname '${hostname}' is not allowed`, { retryable: false });
    }
    if (isIP(normalized) && !isPublicIpAddress(normalized)) {
      throw new ApiConsumerError(`IP address '${hostname}' is not public`, { retryable: false });
    }
    if (this.config.dnsGuard) {
      await this.config.dnsGuard(hostname);
      return;
    }
    const addresses = await this.dnsLookup(normalized);
    if (addresses.length === 0) {
      throw new ApiConsumerError(`Hostname '${hostname}' did not resolve`, { retryable: true });
    }
    const blocked = addresses.find((address) => !isPublicIpAddress(address));
    if (blocked) {
      throw new ApiConsumerError(`Hostname '${hostname}' resolved to a non-public address`, { retryable: false });
    }
  }

  private getTlsOptions(): FetchTlsOptions {
    if (this.tlsOptions) {
      return this.tlsOptions;
    }
    const certificate = firstCredential(this.credentials, ["certificate", "cert", "mtlsCert"]);
    const key = firstCredential(this.credentials, ["privateKey", "key", "mtlsKey"]);
    const ca = firstCredential(this.credentials, ["ca", "caCertificate", "mtlsCa"]);
    if (!certificate || !key) {
      throw new Error("Mutual TLS certificate and private key are missing");
    }
    this.tlsOptions = {
      cert: certificate,
      key,
      ...(ca ? { ca: [ca] } : {}),
    };
    return this.tlsOptions;
  }

  private async readRawText(response: Response): Promise<string> {
    const maximum = this.config.maxResponseBytes ?? 2 * 1024 * 1024;
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maximum) {
      throw new ApiConsumerError(`Gateway response exceeds ${maximum} bytes`, { status: response.status });
    }
    if (!response.body) {
      return "";
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new ApiConsumerError(`Gateway response exceeds ${maximum} bytes`, { status: response.status });
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
