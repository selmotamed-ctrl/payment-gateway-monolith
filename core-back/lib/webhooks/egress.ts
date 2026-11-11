import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { isPublicIpAddress } from "../../engine/apiConsumer/ApiConsumer";

/**
 * Egress rules of the merchant webhook sender (AUTO-34), the same posture as the API consumer: HTTPS only (HTTP only
 * where `allowInsecure`, development), no credentials or fragments in the URL, no literal private, loopback or
 * link-local host, every address the name resolves to must be public, DNS is resolved ONCE and the connection is PINNED
 * to that address (a name that re-resolves to a private address between the check and the connect cannot redirect the
 * request), redirects are never followed, and the response is read only up to a small cap.
 */
export class WebhookEgressError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code: string) {
    super(message);
    this.name = "WebhookEgressError";
  }
}

export interface WebhookUrlOptions {
  allowInsecure?: boolean;
}

/** Validates the syntax and the literal host of a destination URL; throws a non-retryable {@link WebhookEgressError}. */
export const validateWebhookUrl = (value: string, options: WebhookUrlOptions = {}): URL => {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) throw new WebhookEgressError("The URL is empty or too long", false, "INVALID_URL");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(value)) throw new WebhookEgressError("The URL contains whitespace or control characters", false, "INVALID_URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WebhookEgressError("The URL is not valid", false, "INVALID_URL");
  }
  if (parsed.protocol !== "https:" && !(options.allowInsecure && parsed.protocol === "http:")) {
    throw new WebhookEgressError("Only HTTPS endpoints are allowed", false, "INSECURE_URL");
  }
  if (parsed.username || parsed.password) throw new WebhookEgressError("URL credentials are not allowed", false, "URL_USERINFO");
  if (parsed.hash) throw new WebhookEgressError("URL fragments are not allowed", false, "URL_FRAGMENT");
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    if (!options.allowInsecure) throw new WebhookEgressError("Local host names are not allowed", false, "PRIVATE_HOST");
  }
  if (isIP(host) && !isPublicIpAddress(host) && !options.allowInsecure) {
    throw new WebhookEgressError("Private, loopback and link-local addresses are not allowed", false, "PRIVATE_HOST");
  }
  return parsed;
};

export type DnsResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: DnsResolver = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/** Resolves once; every address must be public (outside `allowInsecure`). Returns the address to pin. */
export const resolvePinnedAddress = async (
  hostname: string,
  options: { resolver?: DnsResolver; allowInsecure?: boolean } = {},
): Promise<{ address: string; family: 4 | 6 }> => {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await (options.resolver ?? defaultResolver)(host).catch(() => {
    throw new WebhookEgressError(`The host ${hostname} did not resolve`, true, "DNS_FAILURE");
  });
  if (addresses.length === 0) throw new WebhookEgressError(`The host ${hostname} did not resolve`, true, "DNS_FAILURE");
  if (!options.allowInsecure) {
    const blocked = addresses.find((address) => !isPublicIpAddress(address));
    if (blocked) throw new WebhookEgressError(`The host ${hostname} resolves to a non-public address`, false, "PRIVATE_HOST");
  }
  const address = addresses[0]!;
  return { address, family: isIP(address) === 6 ? 6 : 4 };
};

export interface PinnedPostInput {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  /** Response bytes read at most (the body is discarded anyway). Default 4 KiB. */
  maxResponseBytes?: number;
  allowInsecure?: boolean;
  resolver?: DnsResolver;
  /** Keep the first `maxResponseBytes` of the answer in `PinnedPostResult.body` (the webhook sender discards it). */
  captureBody?: boolean;
  /** Hard deadline for the whole exchange, including a slow response body; `timeoutMs` is only the idle timeout. */
  deadlineMs?: number;
  /** Overrides the default `PaymentGateway-Webhooks/1` agent. */
  userAgent?: string;
}

export interface PinnedPostResult {
  status: number;
  latencyMs: number;
  /** The captured answer (UTF-8, at most `maxResponseBytes` bytes), only when `captureBody` was set. */
  body?: string;
}

/** POSTs `body` to the pinned address of `url`. Resolves with the status of any HTTP answer; rejects for network failures. */
export const postPinned = async (input: PinnedPostInput): Promise<PinnedPostResult> => {
  const url = validateWebhookUrl(input.url, { allowInsecure: input.allowInsecure });
  const pinned = await resolvePinnedAddress(url.hostname, { resolver: input.resolver, allowInsecure: input.allowInsecure });
  const started = Date.now();
  const secure = url.protocol === "https:";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const payload = Buffer.from(input.body, "utf8");
  const maxBytes = input.maxResponseBytes ?? 4096;
  return new Promise<PinnedPostResult>((resolve, reject) => {
    const request = (secure ? https : http).request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        // The pin: whatever the name resolves to later, this connection goes to the address that passed the check.
        lookup: (_hostname: string, lookupOptions: { all?: boolean } | undefined, callback: (error: Error | null, address: unknown, family?: number) => void) =>
          // The runtime may ask for every address (`all: true`, which wants an array) or for one.
          lookupOptions?.all ? callback(null, [{ address: pinned.address, family: pinned.family }]) : callback(null, pinned.address, pinned.family),
        // Certificate validation and SNI use the real host name.
        ...(secure && !isIP(host) ? { servername: host } : {}),
        headers: {
          ...input.headers,
          "content-type": "application/json",
          "content-length": String(payload.length),
          "user-agent": input.userAgent ?? "PaymentGateway-Webhooks/1",
        },
        timeout: input.timeoutMs ?? 10_000,
        agent: false,
      } as never,
      (response) => {
        let received = 0;
        const kept: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          if (input.captureBody && received < maxBytes) kept.push(chunk.subarray(0, maxBytes - received));
          received += chunk.length;
          if (received > maxBytes) response.destroy(); // the cap is reached: stop reading
        });
        const done = () => {
          if (deadline) clearTimeout(deadline);
          resolve({
            status: response.statusCode ?? 0,
            latencyMs: Date.now() - started,
            ...(input.captureBody ? { body: Buffer.concat(kept).toString("utf8") } : {}),
          });
        };
        response.on("end", done);
        response.on("close", done);
        response.on("error", done);
      },
    );
    // A slow-drip answer never trips the idle timeout above, so a total deadline bounds the whole exchange.
    const deadline = input.deadlineMs
      ? setTimeout(() => request.destroy(new WebhookEgressError("The endpoint did not complete the exchange in time", true, "TIMEOUT")), input.deadlineMs)
      : undefined;
    request.on("timeout", () => request.destroy(new WebhookEgressError("The endpoint did not answer in time", true, "TIMEOUT")));
    request.on("error", (error) => {
      if (deadline) clearTimeout(deadline);
      reject(error instanceof WebhookEgressError ? error : new WebhookEgressError(`Connection failed: ${error.message}`.slice(0, 300), true, "NETWORK"));
    });
    request.write(payload);
    request.end();
  });
};
