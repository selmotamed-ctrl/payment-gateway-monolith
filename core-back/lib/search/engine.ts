import type { PrismaClient } from "../../generated/prisma/client";
import type { AuthenticatedAdminActor } from "../auth/confidentialAccess";
import type { SearchResultItem, SearchType } from "./types";
import type { AuditStorePort } from "../storageEngine/ports";

export type QueryTokenKind =
  | "SHA256_HEX"
  | "EMAIL"
  | "PHONE"
  | "ID_OR_REF"
  | "FREE_TEXT";

export interface ParsedSearchQuery {
  raw: string;
  term: string;
  termLower: string;
  phoneVariants: string[];
  tokenKind: QueryTokenKind;
  scopedTypeAliases: string[];
  scopedStatus?: string;
  scopedMerchantId?: string;
}

const SHA256_REGEX = /^[a-fA-F0-9]{16,64}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_CHARS_REGEX = /^[+\d][\d\s()-]{5,18}$/;
const ID_OR_REF_REGEX = /^[A-Za-z0-9_.:-]{4,64}$/;

const buildPhoneVariants = (term: string): string[] => {
  if (!PHONE_CHARS_REGEX.test(term)) {
    return [];
  }

  const compact = term.replace(/[\s()-]/g, "");
  const digits = compact.replace(/[^\d]/g, "");
  if (!digits) {
    return [];
  }

  const variants = new Set<string>();
  variants.add(compact);
  variants.add(digits);
  if (compact.startsWith("+")) {
    variants.add(`+${digits}`);
  }

  let normalized = digits;
  if (normalized.startsWith("00")) {
    normalized = normalized.slice(2);
  }

  if (normalized.startsWith("218")) {
    const national = normalized.slice(3);
    variants.add(normalized);
    variants.add(`+${normalized}`);
    if (national.startsWith("0")) {
      const withoutZero = national.slice(1);
      if (withoutZero) {
        variants.add(`0${withoutZero}`);
        variants.add(withoutZero);
      }
    } else if (national) {
      variants.add(`0${national}`);
    }
  } else if (normalized.startsWith("0")) {
    const withoutZero = normalized.slice(1);
    if (withoutZero) {
      variants.add(`218${withoutZero}`);
      variants.add(`+218${withoutZero}`);
    }
  } else if (normalized.startsWith("9") && normalized.length === 9) {
    variants.add(`0${normalized}`);
    variants.add(`218${normalized}`);
    variants.add(`+218${normalized}`);
  }

  return Array.from(variants).filter((variant) => variant.length > 0);
};

export function parseSearchQuery(rawInput: string): ParsedSearchQuery {
  const raw = rawInput.trim().slice(0, 120);
  const tokens = raw.split(/\s+/);
  const scopedTypeAliases: string[] = [];
  let scopedStatus: string | undefined;
  let scopedMerchantId: string | undefined;
  const remainingTokens: string[] = [];

  for (const token of tokens) {
    const match = /^([a-zA-Z]+):(.+)$/.exec(token);
    if (match && tokens.length > 1) {
      const key = (match[1] ?? "").toLowerCase();
      const value = (match[2] ?? "").trim();
      if ((key === "type" || key === "is" || key === "kind") && value) {
        const alias = value.toLowerCase();
        if (!scopedTypeAliases.includes(alias)) {
          scopedTypeAliases.push(alias);
        }
        continue;
      }
      if (key === "status" && value) {
        scopedStatus = value.toUpperCase();
        continue;
      }
      if (key === "merchant" && value) {
        scopedMerchantId = value;
        continue;
      }
    }
    remainingTokens.push(token);
  }

  const term = (remainingTokens.join(" ").trim() || raw).slice(0, 120);
  const termLower = term.toLowerCase();
  const phoneVariants = buildPhoneVariants(term);

  let tokenKind: QueryTokenKind = "FREE_TEXT";
  if (SHA256_REGEX.test(term) && term.length >= 16) {
    tokenKind = "SHA256_HEX";
  } else if (EMAIL_REGEX.test(term)) {
    tokenKind = "EMAIL";
  } else if (phoneVariants.length > 0) {
    tokenKind = "PHONE";
  } else if (ID_OR_REF_REGEX.test(term) && !term.includes(" ")) {
    tokenKind = "ID_OR_REF";
  }

  return {
    raw,
    term,
    termLower,
    phoneVariants,
    tokenKind,
    scopedTypeAliases,
    scopedStatus,
    scopedMerchantId,
  };
}

export interface SearchMatchSignals {
  exactFields: Array<string | null | undefined>;
  primaryTextFields?: Array<string | null | undefined>;
  secondaryTextFields?: Array<string | null | undefined>;
  timestamp?: Date | string | number | null;
}

export function computeMatchScore(
  signals: SearchMatchSignals,
  parsed: ParsedSearchQuery,
): number {
  const query = parsed.termLower;
  const phoneSet = new Set(
    parsed.phoneVariants.map((variant) => variant.toLowerCase()),
  );
  let bestScore = 0;

  const scoreField = (
    rawValue: string | null | undefined,
    weights: { exact: number; prefix: number; substring: number },
  ): void => {
    if (!rawValue) {
      return;
    }
    const value = rawValue.trim().toLowerCase();
    if (!value) {
      return;
    }

    const compactValue = value.replace(/[\s()-]/g, "");
    if (
      value === query ||
      (phoneSet.size > 0 &&
        (phoneSet.has(value) || phoneSet.has(compactValue)))
    ) {
      bestScore = Math.max(bestScore, weights.exact);
      return;
    }
    if (value.startsWith(query)) {
      bestScore = Math.max(bestScore, weights.prefix);
      return;
    }
    if (value.includes(query)) {
      bestScore = Math.max(bestScore, weights.substring);
    }
  };

  for (const field of signals.exactFields) {
    scoreField(field, { exact: 1000, prefix: 750, substring: 450 });
  }
  for (const field of signals.primaryTextFields ?? []) {
    scoreField(field, { exact: 900, prefix: 650, substring: 350 });
  }
  for (const field of signals.secondaryTextFields ?? []) {
    scoreField(field, { exact: 250, prefix: 200, substring: 150 });
  }

  return bestScore > 0 ? bestScore : 100;
}

const FORBIDDEN_RESULT_KEYS = new Set([
  "ciphertext",
  "nationalidciphertext",
  "secret",
  "secretciphertext",
  "password",
  "passwordhash",
  "payoutaccount",
  "payoutaccounthash",
  "payoutbankdetailsjson",
  "destinationbankjson",
  "ibanciphertext",
  "matchlistname",
  "listname",
  "listentryref",
  "matchedname",
  "beforejson",
  "afterjson",
  "rawpayload",
  "payloadciphertext",
  "contentciphertext",
  "contextciphertext",
  "mfasecretciphertext",
  "invitationtokenhash",
  "tokenhash",
  "taxid",
  "taxnumber",
  "registrationno",
  "commercialregistrynumber",
]);

const FORBIDDEN_KEY_FRAGMENTS = [
  "cipher",
  "secret",
  "password",
  "payout",
  "bank",
  "matchlist",
  "beforejson",
  "afterjson",
  "rawpayload",
  "taxid",
  "taxnumber",
  "registrationno",
  "commercialregistry",
];

const isForbiddenKey = (key: string): boolean => {
  const normalized = key.toLowerCase();
  return (
    FORBIDDEN_RESULT_KEYS.has(normalized) ||
    FORBIDDEN_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))
  );
};

export function sanitizeResultItem(item: SearchResultItem): SearchResultItem {
  const clean: SearchResultItem = {
    id: String(item.id),
    title:
      item.title === undefined || item.title === null || item.title === ""
        ? String(item.id)
        : String(item.title),
  };

  if (item.subtitle !== undefined && item.subtitle !== null && item.subtitle !== "") {
    clean.subtitle = String(item.subtitle);
  }
  if (item.reference !== undefined && item.reference !== null && item.reference !== "") {
    clean.reference = String(item.reference);
  }
  if (item.status !== undefined && item.status !== null && item.status !== "") {
    clean.status = String(item.status);
  }
  if (item.merchantId) {
    clean.merchantId = String(item.merchantId);
  }
  if (item.operatorCaseId) {
    clean.operatorCaseId = String(item.operatorCaseId);
  }

  if (item.meta) {
    const safeMeta: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(item.meta)) {
      if (isForbiddenKey(key)) {
        continue;
      }
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        safeMeta[key] = value;
      }
    }
    if (Object.keys(safeMeta).length > 0) {
      clean.meta = safeMeta;
    }
  }

  return clean;
}

export interface SearchProviderContext {
  prisma: PrismaClient;
  parsed: ParsedSearchQuery;
  actor: AuthenticatedAdminActor;
  take: number;
  auditStore?: AuditStorePort | null;
}

export interface SearchProviderPlugin<TRow = unknown> {
  readonly type: SearchType;
  readonly aliases?: readonly string[];
  readonly order: number;
  readonly canAccess: (actor: AuthenticatedAdminActor) => boolean;
  readonly supportsTokenKind?: (parsed: ParsedSearchQuery) => boolean;
  readonly fetchCandidates: (ctx: SearchProviderContext) => Promise<TRow[]>;
  readonly extractMatchSignals: (
    row: TRow,
    actor: AuthenticatedAdminActor,
  ) => SearchMatchSignals;
  readonly toResultItem: (
    row: TRow,
    actor: AuthenticatedAdminActor,
  ) => SearchResultItem;
}

export function defineSearchProvider<TRow>(
  plugin: SearchProviderPlugin<TRow>,
): SearchProviderPlugin<TRow> {
  return Object.freeze(plugin);
}

export function rankAndSliceCandidates<TRow>(
  rows: TRow[],
  plugin: SearchProviderPlugin<TRow>,
  parsed: ParsedSearchQuery,
  actor: AuthenticatedAdminActor,
  limit: number,
): { items: SearchResultItem[]; truncated: boolean } {
  const safeLimit = Math.max(0, Math.trunc(limit));
  const seenIds = new Set<string>();
  const scored: Array<{
    item: SearchResultItem;
    score: number;
    timeMs: number;
  }> = [];

  for (const row of rows) {
    const rawItem = plugin.toResultItem(row, actor);
    const itemId = rawItem ? String(rawItem.id) : "";
    if (!rawItem || !itemId || seenIds.has(itemId)) {
      continue;
    }
    seenIds.add(itemId);

    const signals = plugin.extractMatchSignals(row, actor);
    const score = computeMatchScore(signals, parsed);
    const timestamp = signals.timestamp;
    const timeMs =
      timestamp instanceof Date
        ? timestamp.getTime()
        : timestamp === null || timestamp === undefined
          ? 0
          : typeof timestamp === "number"
            ? timestamp
            : new Date(timestamp).getTime();

    scored.push({
      item: sanitizeResultItem(rawItem),
      score,
      timeMs: Number.isFinite(timeMs) ? timeMs : 0,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.timeMs !== a.timeMs) {
      return b.timeMs - a.timeMs;
    }
    return a.item.id.localeCompare(b.item.id);
  });

  return {
    items: scored.slice(0, safeLimit).map((entry) => entry.item),
    truncated: scored.length > safeLimit,
  };
}
