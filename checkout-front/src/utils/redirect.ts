/**
 * Host allow-listing for payer redirect actions (3DS / bank pages).
 *
 * Kept free of Vue so it can be unit-tested directly. A redirect target must
 * resolve to an absolute host and match an allow-list entry (or a subdomain of
 * one); `javascript:`/`data:` URLs never resolve to a host and are rejected.
 */
const baseOrigin = (): string => (typeof location !== "undefined" ? location.origin : "http://localhost");

export const hostOf = (url: string): string => {
  try {
    return new URL(url, baseOrigin()).hostname.toLowerCase();
  } catch {
    return "";
  }
};

export const isAllowedRedirect = (url: string, allowlist?: string[]): boolean => {
  if (!allowlist?.length) {
    return false;
  }
  const host = hostOf(url);
  if (!host) {
    return false;
  }
  return allowlist.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (normalized === "*") {
      return true;
    }
    return host === normalized || host.endsWith(`.${normalized}`);
  });
};
