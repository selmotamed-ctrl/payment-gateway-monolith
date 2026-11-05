import { BlockList, isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../error";

const PLACEHOLDER_MARKERS = ["change-me", "changeme", "change_me", "replace-me", "replaceme", "your-", "example", "placeholder", "password", "admin", "default"];

/** Reason a secret is unacceptable (placeholder / low entropy), or undefined. Mirrors deploy/lib/configSchema weakSecretReason. */
export const weakSecretReason = (value: string): string | undefined => {
  const lower = value.toLowerCase();
  const marker = PLACEHOLDER_MARKERS.find((entry) => lower.includes(entry));
  if (marker) return `contains the placeholder/guessable word '${marker}'`;
  for (let unit = 1; unit <= 16; unit += 1) {
    if (value.length >= unit * 2 && value.length % unit === 0 && value === value.slice(0, unit).repeat(value.length / unit)) {
      return "is a repeated pattern";
    }
  }
  let ascending = 1;
  let descending = 1;
  for (let i = 1; i < value.length; i += 1) {
    const delta = value.charCodeAt(i) - value.charCodeAt(i - 1);
    ascending = delta === 1 ? ascending + 1 : 1;
    descending = delta === -1 ? descending + 1 : 1;
    if (ascending >= 8 || descending >= 8) return "contains a sequential run";
  }
  const distinct = new Set(value).size;
  if ((value.length >= 24 && distinct < 10) || (value.length >= 12 && distinct < 6)) return "has too few distinct characters";
  return undefined;
};

/** Builds a matcher for a comma separated CIDR list (IPv4 and IPv6; IPv4-mapped IPv6 peers are unwrapped). */
export const buildCidrMatcher = (cidrs: string): ((address: string | undefined) => boolean) => {
  const list = new BlockList();
  for (const raw of cidrs.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const [address, bits] = entry.split("/");
    const family = isIP(address ?? "");
    if (!address || family === 0) continue;
    const prefix = bits === undefined ? (family === 4 ? 32 : 128) : Number(bits);
    if (!Number.isInteger(prefix)) continue;
    list.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return (address) => {
    if (!address) return false;
    const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
    const family = isIP(normalized);
    if (family === 0) return false;
    if (family === 6 && normalized === "::1") return list.check("127.0.0.1", "ipv4") || list.check("::1", "ipv6");
    return list.check(normalized, family === 4 ? "ipv4" : "ipv6");
  };
};

/**
 * Enforces FAKE_RAILS_ALLOWED_CIDRS against the REAL TCP peer address
 * (`socket.remoteAddress`), never `req.ip` / X-Forwarded-For, so a client cannot
 * spoof its way past the allowlist. Behind the local nginx the peer is loopback
 * (nginx itself enforces the client allowlist with `allow`/`deny`).
 */
export const peerAllowlist = (cidrs: string) => {
  const allowed = buildCidrMatcher(cidrs);
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (!allowed(request.socket.remoteAddress)) {
      next(new ApiError(403, "FORBIDDEN_NETWORK", "This network is not allowed to reach Fake Rails"));
      return;
    }
    next();
  };
};

/** Express `trust proxy` value from config: "false", a hop count, or a loopback/CIDR list. */
export const parseTrustProxy = (value: string): boolean | number | string => {
  const trimmed = value.trim();
  if (trimmed === "false" || trimmed === "") return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
};
