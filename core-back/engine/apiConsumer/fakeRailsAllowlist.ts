import { env } from "../../lib/env";

/**
 * Scoped SSRF allowlist for the Fake Payment Rails tier.
 *
 * The relaxation is deliberately narrow:
 *
 *   - `ALLOW_FAKE_RAILS_HOSTS` must be explicitly `true`;
 *   - the target host must be listed in `FAKE_RAILS_ALLOWED_HOSTS`;
 *   - the target host must ALSO be declared in the gateway version's own
 *     `allowed_hosts` (the caller passes it in).
 *
 * Only then is the private-IP rejection skipped for that exact host. The
 * metadata address (169.254.169.254), the database port, the admin ports and
 * every other private/loopback address remain blocked.
 */
export const parseAllowedFakeHosts = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

export const isFakeRailsHostAllowed = (
  hostname: string,
  gatewayAllowedHosts: readonly string[] | undefined,
): boolean => {
  if (!env.ALLOW_FAKE_RAILS_HOSTS) {
    return false;
  }
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  const environmentAllowed = parseAllowedFakeHosts(env.FAKE_RAILS_ALLOWED_HOSTS);
  if (!environmentAllowed.includes(normalized)) {
    return false;
  }
  if (!gatewayAllowedHosts || gatewayAllowedHosts.length === 0) {
    return false;
  }
  return gatewayAllowedHosts
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ""))
    .includes(normalized);
};
