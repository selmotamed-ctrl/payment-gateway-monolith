import type { Request } from "express";

export const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
};

const intToIpv4 = (value: number): string =>
  [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");

export const ipv6ToBigInt = (ip: string): bigint | null => {
  let address = ip.trim().split("%")[0] ?? "";
  const embedded = address.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embedded) {
    const value = ipv4ToInt(embedded[1] ?? "");
    if (value === null) return null;
    address = `${address.slice(0, embedded.index ?? 0)}${value >>> 16}.${value & 65535}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  if (halves.length === 1 && missing !== 0) return null;
  const groups = [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    result = (result << 16n) | BigInt(parseInt(group, 16));
  }
  return result;
};

export const normalizeIp = (ip: string | undefined | null): string => {
  if (!ip) return "";
  let value = ip.trim();
  if (value.startsWith("::ffff:")) value = value.slice(7);
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  return value;
};

export const isValidIp = (ip: string): boolean => {
  const value = normalizeIp(ip);
  if (!value) return false;
  return ipv4ToInt(value) !== null || ipv6ToBigInt(value) !== null;
};

export interface ParsedCidr {
  address: string;
  prefix: number;
  version: 4 | 6;
}

export const parseCidr = (cidr: string): ParsedCidr | null => {
  const raw = cidr.trim();
  if (!raw) return null;
  const [addressPart, prefixPart] = raw.split("/");
  if (!addressPart) return null;
  const address = normalizeIp(addressPart);
  if (ipv4ToInt(address) !== null) {
    const prefix = prefixPart === undefined ? 32 : Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    return { address, prefix, version: 4 };
  }
  const big = ipv6ToBigInt(address);
  if (big === null) return null;
  const prefix = prefixPart === undefined ? 128 : Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
  return { address, prefix, version: 6 };
};

export const cidrContains = (cidr: string, ip: string): boolean => {
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  const candidate = normalizeIp(ip);
  if (parsed.version === 4) {
    const base = ipv4ToInt(parsed.address);
    const target = ipv4ToInt(candidate);
    if (base === null || target === null) return false;
    if (parsed.prefix === 0) return true;
    const mask = (0xffffffff << (32 - parsed.prefix)) >>> 0;
    return ((base & mask) >>> 0) === ((target & mask) >>> 0);
  }
  const baseBig = ipv6ToBigInt(parsed.address);
  const targetBig = ipv6ToBigInt(candidate);
  if (baseBig === null || targetBig === null) return false;
  if (parsed.prefix === 0) return true;
  const shift = BigInt(128 - parsed.prefix);
  return baseBig >> shift === targetBig >> shift;
};

export const parseCidrList = (value: string | undefined | null): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

export const isInCidrList = (cidrs: string[], ip: string): boolean => {
  const candidate = normalizeIp(ip);
  if (!candidate) return false;
  return cidrs.some((cidr) => cidrContains(cidr, candidate));
};

export const parseIpList = (value: string | undefined | null): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => normalizeIp(entry))
    .filter((entry) => entry.length > 0);
};

export const remoteAddressOf = (req: Request): string => normalizeIp(req.socket?.remoteAddress ?? "");

export const resolveClientIp = (req: Request, trustedProxyCidrs: string[]): string => {
  const remote = remoteAddressOf(req);
  const forwarded = req.headers["x-real-client-ip"];
  const forwardedIp = typeof forwarded === "string" ? normalizeIp(forwarded) : "";
  if (forwardedIp && isInCidrList(trustedProxyCidrs, remote)) return forwardedIp;
  const realIp = req.headers["x-real-ip"];
  const realIpValue = typeof realIp === "string" ? normalizeIp(realIp) : "";
  if (realIpValue && isInCidrList(trustedProxyCidrs, remote)) return realIpValue;
  return remote;
};
