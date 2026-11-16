import { WebhookEgressError, postPinned, validateWebhookUrl, type DnsResolver, type PinnedPostInput, type PinnedPostResult } from "../webhooks/egress";

export interface FilingArtifact {
  format: string;
  filename: string;
  contentType: string;
  base64: string;
}

export interface FilingRequest {
  report: {
    id: string;
    reportCode: string | null;
    reportType: string;
    authority: string;
    periodKey: string | null;
    payloadSha256: string;
  };
  artifacts: FilingArtifact[];
}

export interface FilingResult {
  status: "SUBMITTED" | "FAILED";
  externalRef: string | null;
  responseCode: number | null;
  responseBody: string | null;
  errorMessage: string | null;
}

/**
 * Egress posture of a filing adapter: the same as the merchant webhook sender (`lib/webhooks/egress.ts`). HTTPS only,
 * no credentials or fragments, no literal private, loopback, link-local or local-name host (every IPv4 and IPv6 form,
 * bracketed or mapped), DNS is resolved ONCE at dispatch, every address must be public, and the connection is PINNED to
 * the address that passed the check, so a name that re-resolves to an internal address (DNS rebinding) cannot redirect
 * the filing. Redirects are never followed and the response is read only up to a small cap.
 *
 * A regulatory filing carries the adapter secret and the confidential report: an endpoint that resolved to an internal
 * service would receive both, and the stored response body would read that service back to the UI.
 */
const toFilingError = (error: unknown): Error => {
  if (error instanceof WebhookEgressError) {
    return new Error(error.code === "INSECURE_URL" ? "A filing endpoint must use HTTPS"
      : error.code === "URL_USERINFO" ? "A filing endpoint must have a host and no embedded credentials"
      : error.code === "PRIVATE_HOST" ? "A filing endpoint must be a public HTTPS address"
      : `A filing endpoint is not acceptable: ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
};

/** Syntax and literal-host check (used when an adapter is proposed); dispatch also resolves and pins the address. */
export const assertFilingEndpoint = (value: string): URL => {
  try {
    const url = validateWebhookUrl(value);
    if (!url.hostname) throw new Error("A filing endpoint must have a host and no embedded credentials");
    return url;
  } catch (error) {
    throw toFilingError(error);
  }
};

export type FilingPoster = (input: PinnedPostInput) => Promise<PinnedPostResult>;

/** The answer of a filing endpoint is kept to this many characters. */
const RESPONSE_TEXT_CHARS = 4000;

export const dispatchFiling = async (input: {
  kind: "MANUAL" | "HTTP";
  endpointUrl: string | null;
  authHeaderName: string | null;
  secret: string | null;
  timeoutSeconds: number;
  request: FilingRequest;
  /** Test seam; production uses the pinned transport. */
  post?: FilingPoster;
  /** Test seam: the DNS resolver of the pinned transport. */
  resolver?: DnsResolver;
}): Promise<FilingResult> => {
  if (input.kind === "MANUAL") {
    return { status: "FAILED", externalRef: null, responseCode: null, responseBody: null, errorMessage: "The manual adapter does not dispatch; record the authority reference" };
  }
  if (!input.endpointUrl) {
    return { status: "FAILED", externalRef: null, responseCode: null, responseBody: null, errorMessage: "The adapter has no endpoint" };
  }
  const endpoint = assertFilingEndpoint(input.endpointUrl);
  const timeoutMs = Math.max(5, Math.min(120, input.timeoutSeconds)) * 1000;
  try {
    const response = await (input.post ?? postPinned)({
      url: endpoint.toString(),
      body: JSON.stringify(input.request),
      headers: input.authHeaderName && input.secret ? { [input.authHeaderName]: input.secret } : {},
      timeoutMs,
      deadlineMs: timeoutMs,
      // Enough bytes for RESPONSE_TEXT_CHARS characters of multi-byte text.
      maxResponseBytes: RESPONSE_TEXT_CHARS * 4,
      captureBody: true,
      userAgent: "PaymentGateway-Filing/1",
      resolver: input.resolver,
    });
    const text = (response.body ?? "").slice(0, RESPONSE_TEXT_CHARS);
    let externalRef: string | null = null;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      externalRef = typeof parsed.reference === "string" ? parsed.reference : typeof parsed.submissionRef === "string" ? parsed.submissionRef : typeof parsed.id === "string" ? parsed.id : null;
    } catch {
      externalRef = null;
    }
    if (response.status < 200 || response.status >= 300) {
      return { status: "FAILED", externalRef, responseCode: response.status, responseBody: text, errorMessage: `The filing endpoint returned HTTP ${response.status}` };
    }
    return { status: "SUBMITTED", externalRef: externalRef ?? `HTTP-${Date.now()}`, responseCode: response.status, responseBody: text, errorMessage: null };
  } catch (error) {
    // A blocked address is reported like any other failed dispatch: the report stays unfiled and nothing was sent.
    return { status: "FAILED", externalRef: null, responseCode: null, responseBody: null, errorMessage: toFilingError(error).message };
  }
};
