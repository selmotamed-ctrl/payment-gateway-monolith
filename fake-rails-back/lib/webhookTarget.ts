import { env } from "./env";

/**
 * Where the emulator may send a webhook.
 *
 * `webhook_url` used to be copied from the request body and fetched as given (with redirects followed, and the
 * response status and body stored where testers can read them), so any caller of a rails initiate endpoint could
 * make the emulator probe any host it can reach: an internal service or a cloud metadata endpoint. A webhook may
 * now only go to an allowed host: by default the host of `CORE_INBOUND_BASE_URL` (the system under test), plus any
 * host listed in `FAKE_RAILS_WEBHOOK_ALLOWED_HOSTS` (hostnames, or `host:port` to pin the port). Credentials in
 * the URL and non-HTTP schemes are never allowed.
 */
export const allowedWebhookHosts = (): string[] => {
  const hosts = new Set<string>();
  try {
    hosts.add(new URL(env.CORE_INBOUND_BASE_URL).host.toLowerCase());
  } catch {
    // an unparsable base URL allows nothing by default
  }
  for (const entry of env.FAKE_RAILS_WEBHOOK_ALLOWED_HOSTS.split(",")) {
    const host = entry.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return [...hosts];
};

export const webhookTargetAllowed = (value: string, allowed: readonly string[] = allowedWebhookHosts()): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  return allowed.some((entry) => entry === host || (!entry.includes(":") && entry === hostname));
};
