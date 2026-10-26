import { ApiError } from "../../lib/error";

export type UrlDestination = "URL" | "QUERY" | "JSON" | "XML" | "FORM" | "HEADER";
export type QueryArrayFormat = "indices" | "brackets" | "repeat";

export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | QueryValue[]
  | { [key: string]: QueryValue };

export interface CompileUrlOptions {
  arrayFormat?: QueryArrayFormat;
  encodeBrackets?: boolean;
  allowedHosts?: readonly string[];
  requireHttps?: boolean;
  destination?: UrlDestination;
  parameters?: Record<string, unknown>;
  allowFragment?: boolean;
}

function urlError(code: string, message: string, statusCode = 400): ApiError {
  return new ApiError(statusCode, code, message);
}

export function assertNoControlCharacters(value: string, label = "value"): void {
  if (/[\r\n\0]/.test(value)) {
    throw urlError("HEADER_INJECTION_BLOCKED", `CR, LF, or NUL is forbidden in ${label}`);
  }
}

export function encodeForDestination(value: unknown, destination: UrlDestination = "URL"): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (destination === "JSON") {
    return JSON.stringify(value);
  }
  if (destination === "XML") {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }
  if (destination === "FORM") {
    return encodeURIComponent(String(value));
  }
  if (destination === "HEADER") {
    const text = String(value);
    assertNoControlCharacters(text, "header");
    return text;
  }
  return encodeURIComponent(String(value));
}

function encodePathSegment(value: unknown): string {
  const text = String(value ?? "");
  assertNoControlCharacters(text, "path parameter");
  if (/[/\\]/.test(text)) {
    throw urlError("INVALID_URL_PATH", "Path parameters cannot contain path separators");
  }
  return encodeURIComponent(text);
}

function substitutePathParameters(
  template: string,
  parameters: Record<string, unknown>,
): string {
  return template.replace(/\{\{([A-Za-z0-9_.-]+)\}\}|\{([A-Za-z0-9_.-]+)\}/g, (_match, doubleKey, singleKey) => {
    const key = String(doubleKey ?? singleKey);
    if (!Object.hasOwn(parameters, key)) {
      throw urlError("MISSING_URL_PARAMETER", `URL parameter '${key}' is missing`);
    }
    return encodePathSegment(parameters[key]);
  });
}

function normalizeAllowedHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function assertPathIntegrity(value: string): void {
  if (value.includes("\\")) {
    throw urlError("INVALID_URL_PATH", "URL path contains an unencoded backslash");
  }
  if (/%2f|%5c/i.test(value)) {
    throw urlError("INVALID_URL_PATH", "URL path contains an encoded path separator");
  }
  const pathPart = value.split(/[?#]/, 1)[0] ?? "";
  const pathOnly = pathPart.slice(pathPart.indexOf("/") >= 0 ? pathPart.indexOf("/") : 0);
  const segments = pathOnly.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw urlError("INVALID_URL_PATH", "URL path contains a traversal segment");
  }
}

export function validateFinalUrl(
  value: string,
  options: Pick<CompileUrlOptions, "allowedHosts" | "requireHttps" | "allowFragment"> = {},
): URL {
  assertNoControlCharacters(value, "URL");
  assertPathIntegrity(value);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw urlError("INVALID_FINAL_URL", "Final URL is invalid");
  }
  const requireHttps = options.requireHttps ?? true;
  if (requireHttps && parsed.protocol !== "https:") {
    throw urlError("INSECURE_URL_BLOCKED", "Only HTTPS URLs are allowed");
  }
  if (!requireHttps && parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw urlError("INVALID_URL_PROTOCOL", "Only HTTP and HTTPS URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw urlError("URL_USERINFO_BLOCKED", "URL userinfo is forbidden");
  }
  if (parsed.hash && !(options.allowFragment ?? false)) {
    throw urlError("URL_FRAGMENT_BLOCKED", "URL fragments are forbidden");
  }
  const allowedHosts = (options.allowedHosts ?? []).map(normalizeAllowedHost).filter(Boolean);
  if (allowedHosts.length > 0) {
    const hostname = normalizeAllowedHost(parsed.hostname);
    const host = normalizeAllowedHost(parsed.host);
    if (!allowedHosts.includes(hostname) && !allowedHosts.includes(host)) {
      throw urlError("HOST_NOT_ALLOWED", `URL host '${parsed.host}' is not allowed`);
    }
  }
  return parsed;
}

function appendQuery(url: URL, query: Record<string, QueryValue>, options: CompileUrlOptions): void {
  const arrayFormat = options.arrayFormat ?? "indices";
  const open = options.encodeBrackets ? "%5B" : "[";
  const close = options.encodeBrackets ? "%5D" : "]";
  const parts: string[] = [];
  const encode = (value: unknown): string => encodeForDestination(value, "QUERY");
  const walk = (prefix: string, value: QueryValue): void => {
    if (value === undefined || value === null) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const key = arrayFormat === "indices"
          ? `${prefix}${open}${index}${close}`
          : arrayFormat === "brackets"
            ? `${prefix}${open}${close}`
            : prefix;
        walk(key, item);
      });
      return;
    }
    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        walk(`${prefix}${open}${encode(key)}${close}`, item);
      }
      return;
    }
    const text = String(value);
    assertNoControlCharacters(text, "query value");
    parts.push(`${prefix}=${encode(value)}`);
  };
  for (const [key, value] of Object.entries(query)) {
    assertNoControlCharacters(key, "query key");
    walk(encode(key), value);
  }
  if (parts.length === 0) {
    return;
  }
  const separator = url.search.length > 0 ? "&" : "?";
  url.search = `${url.search}${separator}${parts.join("&")}`;
}

export function compileUrl(
  url: string,
  query?: Record<string, QueryValue>,
  options: CompileUrlOptions = {},
): string {
  assertNoControlCharacters(url, "URL");
  const substituted = options.parameters
    ? substitutePathParameters(url, options.parameters)
    : url;
  assertNoControlCharacters(substituted, "URL");
  assertPathIntegrity(substituted);
  let parsed: URL;
  try {
    parsed = new URL(substituted);
  } catch {
    throw urlError("INVALID_URL", "URL is invalid");
  }
  if (query) {
    appendQuery(parsed, query, options);
  }
  const finalValue = parsed.toString();
  validateFinalUrl(finalValue, options);
  return finalValue;
}
