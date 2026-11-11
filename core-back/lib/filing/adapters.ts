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

export const assertFilingEndpoint = (value: string): URL => {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("A filing endpoint must use HTTPS");
  if (!url.hostname || url.username || url.password) throw new Error("A filing endpoint must have a host and no embedded credentials");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local") || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)) {
    throw new Error("A filing endpoint must be a public HTTPS address");
  }
  return url;
};

export const dispatchFiling = async (input: {
  kind: "MANUAL" | "HTTP";
  endpointUrl: string | null;
  authHeaderName: string | null;
  secret: string | null;
  timeoutSeconds: number;
  request: FilingRequest;
  fetchImpl?: typeof fetch;
}): Promise<FilingResult> => {
  if (input.kind === "MANUAL") {
    return { status: "FAILED", externalRef: null, responseCode: null, responseBody: null, errorMessage: "The manual adapter does not dispatch; record the authority reference" };
  }
  if (!input.endpointUrl) {
    return { status: "FAILED", externalRef: null, responseCode: null, responseBody: null, errorMessage: "The adapter has no endpoint" };
  }
  const endpoint = assertFilingEndpoint(input.endpointUrl);
  const fetcher = input.fetchImpl ?? fetch;
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(5, Math.min(120, input.timeoutSeconds)) * 1000),
      headers: {
        "Content-Type": "application/json",
        ...(input.authHeaderName && input.secret ? { [input.authHeaderName]: input.secret } : {}),
      },
      body: JSON.stringify(input.request),
    });
    const text = (await response.text()).slice(0, 4000);
    let externalRef: string | null = null;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      externalRef = typeof parsed.reference === "string" ? parsed.reference : typeof parsed.submissionRef === "string" ? parsed.submissionRef : typeof parsed.id === "string" ? parsed.id : null;
    } catch {
      externalRef = null;
    }
    if (!response.ok || response.status < 200 || response.status >= 300) {
      return { status: "FAILED", externalRef, responseCode: response.status, responseBody: text, errorMessage: `The filing endpoint returned HTTP ${response.status}` };
    }
    return { status: "SUBMITTED", externalRef: externalRef ?? `HTTP-${Date.now()}`, responseCode: response.status, responseBody: text, errorMessage: null };
  } catch (error) {
    return { status: "FAILED", externalRef: null, responseCode: null, responseBody: null, errorMessage: (error as Error).message };
  }
};
