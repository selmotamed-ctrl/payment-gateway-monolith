import { createHash } from "node:crypto";
import type { WatchlistEntry } from "../db/ports";

export type ScreeningListType = "SANCTIONS" | "PEP" | "ADVERSE_MEDIA" | "INTERNAL_WATCHLIST";
export type ScreeningResultCode = "CLEAR" | "POTENTIAL_MATCH" | "CONFIRMED_MATCH" | "ERROR";
export type ScreeningSubjectType = "MERCHANT" | "BENEFICIAL_OWNER" | "END_CLIENT" | "PAYMENT_ATTEMPT";

export interface ScreeningSubject {
  subjectType: ScreeningSubjectType;
  subjectId: string;
  names: string[];
  dateOfBirth?: string | null;
  nationality?: string | null;
  identifier?: string | null;
  aliases?: string[];
}

export interface ScreeningOptions {
  timeoutMs?: number;
  listTypes?: ScreeningListType[];
  purpose?: string;
  requestId?: string;
}

export interface ScreeningMatch {
  listType: ScreeningListType;
  listName: string;
  listEntryRef: string;
  matchedName: string;
  score: number;
  attributes?: Record<string, unknown>;
}

export interface ScreeningResult {
  result: ScreeningResultCode;
  matches: ScreeningMatch[];
  highestScore: number | null;
  providerCode: string;
  providerRequestRef: string | null;
  listVersions: Record<string, string>;
  inputHash: string;
  error?: string;
}

export interface ScreeningCapabilities {
  lists: ScreeningListType[];
  arabicNameMatching: boolean;
  batchRescreen: boolean;
}

export interface ScreeningProvider {
  readonly code: string;
  screenSubject(subject: ScreeningSubject, options?: ScreeningOptions): Promise<ScreeningResult>;
  getResult(providerRequestRef: string): Promise<ScreeningResult>;
  listVersions(): Promise<Record<string, string>>;
  subscribeListUpdates?(callbackUrl: string): Promise<void>;
  capabilities(): ScreeningCapabilities;
  screenLocal?(subject: ScreeningSubject): ScreeningResult;
}

const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const ARABIC_TATWEEL = /\u0640/g;
const ZERO_WIDTH = /[\u200B-\u200F\uFEFF]/g;
const ARABIC_DIGITS = /[\u0660-\u0669]/g;
const EXTENDED_ARABIC_DIGITS = /[\u06F0-\u06F9]/g;
const LETTERS_AND_SPACES = /[^\p{L}\p{N}\s]/gu;

export const arabicDigitsToAscii = (input: string): string =>
  input.replace(ARABIC_DIGITS, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(
    EXTENDED_ARABIC_DIGITS,
    (digit) => String(digit.charCodeAt(0) - 0x06F0),
  );

export const normalizeArabicText = (input: string): string => {
  if (!input) return "";
  return arabicDigitsToAscii(input)
    .replace(ZERO_WIDTH, "")
    .replace(ARABIC_DIACRITICS, "")
    .replace(ARABIC_TATWEEL, "")
    .replace(/\u0622/g, "\u0627")
    .replace(/\u0623/g, "\u0627")
    .replace(/\u0625/g, "\u0627")
    .replace(/\u0671/g, "\u0627")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064A")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0629/g, "\u0647")
    .replace(LETTERS_AND_SPACES, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
};

export const normalizeArabicName = (input: string): string => {
  const normalized = normalizeArabicText(input);
  return normalized
    .split(" ")
    .filter((token) => token.length > 0)
    .join(" ");
};

export const normalizeIdentifier = (input: string): string => arabicDigitsToAscii(input ?? "").replace(/[\s\-().]/g, "").trim().toLowerCase();

export const tokenizeName = (input: string): string[] => {
  const normalized = normalizeArabicName(input);
  return normalized.length === 0 ? [] : normalized.split(" ");
};

const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] ?? Math.abs(a.length - b.length);
};

export const nameSimilarity = (left: string, right: string): number => {
  const a = normalizeArabicName(left);
  const b = normalizeArabicName(right);
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 100;
  const tokensA = a.split(" ");
  const tokensB = b.split(" ");
  const setB = new Set(tokensB);
  const overlap = tokensA.filter((token) => setB.has(token)).length;
  if (overlap === tokensA.length || overlap === tokensB.length) {
    return 92;
  }
  const setA = new Set(tokensA);
  const shared = tokensB.filter((token) => setA.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = union === 0 ? 0 : shared / union;
  if (jaccard >= 0.6) {
    return 88;
  }
  const distance = levenshtein(a, b);
  const similarity = 1 - distance / Math.max(a.length, b.length);
  return Math.max(0, Math.round(similarity * 100));
};

export const sha256Hex = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex");

export const computeScreeningInputHash = (subject: ScreeningSubject): string => {
  const canonical = JSON.stringify({
    subjectType: subject.subjectType,
    names: subject.names.map(normalizeArabicName).sort(),
    dateOfBirth: subject.dateOfBirth ?? null,
    nationality: subject.nationality ?? null,
    identifier: subject.identifier ? normalizeIdentifier(subject.identifier) : null,
  });
  return sha256Hex(canonical);
};

export interface WatchlistProviderOptions {
  providerCode?: string;
  entries?: WatchlistEntry[];
  potentialScoreThreshold?: number;
  confirmedScoreThreshold?: number;
  listVersions?: Record<string, string>;
}

export class InternalWatchlistProvider implements ScreeningProvider {
  readonly code: string;
  private readonly entries: WatchlistEntry[];
  private readonly potentialThreshold: number;
  private readonly confirmedThreshold: number;
  private readonly versions: Record<string, string>;

  constructor(options: WatchlistProviderOptions = {}) {
    this.code = options.providerCode ?? "INTERNAL_WATCHLIST";
    this.entries = options.entries ?? [];
    this.potentialThreshold = options.potentialScoreThreshold ?? 75;
    this.confirmedThreshold = options.confirmedScoreThreshold ?? 90;
    this.versions = options.listVersions ?? { INTERNAL_WATCHLIST: "internal-v1" };
  }

  capabilities(): ScreeningCapabilities {
    return { lists: ["SANCTIONS", "PEP", "ADVERSE_MEDIA", "INTERNAL_WATCHLIST"], arabicNameMatching: true, batchRescreen: true };
  }

  listVersions(): Promise<Record<string, string>> {
    return Promise.resolve({ ...this.versions });
  }

  subscribeListUpdates(callbackUrl: string): Promise<void> {
    return Promise.resolve(void callbackUrl);
  }

  async getResult(providerRequestRef: string): Promise<ScreeningResult> {
    const subject = this.pending.get(providerRequestRef);
    if (!subject) {
      return this.errorResult(`Unknown provider request reference: ${providerRequestRef}`);
    }
    this.pending.delete(providerRequestRef);
    return this.screenSubject(subject);
  }

  private readonly pending = new Map<string, ScreeningSubject>();

  screenLocal(subject: ScreeningSubject): ScreeningResult {
    const matches: ScreeningMatch[] = [];
    const subjectNames = [...subject.names, ...(subject.aliases ?? [])];
    const subjectIdentifier = subject.identifier ? normalizeIdentifier(subject.identifier) : null;
    for (const entry of this.entries) {
      let best = 0;
      let bestName = "";
      for (const candidate of entry.names) {
        for (const name of subjectNames) {
          const score = nameSimilarity(candidate, name);
          if (score > best) {
            best = score;
            bestName = candidate;
          }
        }
      }
      if (subjectIdentifier && (entry.identifiers ?? []).some((id) => normalizeIdentifier(id) === subjectIdentifier)) {
        best = 100;
        bestName = bestName || subjectIdentifier;
      }
      if (best >= this.potentialThreshold) {
        matches.push({
          listType: entry.listType,
          listName: entry.listName,
          listEntryRef: entry.entryRef,
          matchedName: bestName,
          score: best,
          attributes: entry.attributes ?? {},
        });
      }
    }
    const highestScore = matches.length === 0 ? null : matches.reduce((acc, match) => Math.max(acc, match.score), 0);
    const confirmed = matches.some((match) => match.score >= this.confirmedThreshold);
    const result: ScreeningResultCode = confirmed ? "CONFIRMED_MATCH" : matches.length > 0 ? "POTENTIAL_MATCH" : "CLEAR";
    return {
      result,
      matches,
      highestScore,
      providerCode: this.code,
      providerRequestRef: null,
      listVersions: { ...this.versions },
      inputHash: computeScreeningInputHash(subject),
    };
  }

  async screenSubject(subject: ScreeningSubject, options?: ScreeningOptions): Promise<ScreeningResult> {
    const requestRef = sha256Hex(`${this.code}:${subject.subjectType}:${subject.subjectId}:${Date.now()}:${Math.random()}`);
    this.pending.set(requestRef, subject);
    if (this.pending.size > 1000) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    void options;
    return this.screenLocal(subject);
  }

  private errorResult(message: string): ScreeningResult {
    return {
      result: "ERROR",
      matches: [],
      highestScore: null,
      providerCode: this.code,
      providerRequestRef: null,
      listVersions: { ...this.versions },
      inputHash: sha256Hex(message),
      error: message,
    };
  }
}

export interface MockScreeningProviderOptions {
  providerCode?: string;
  result?: ScreeningResultCode;
  matches?: ScreeningMatch[];
  listVersions?: Record<string, string>;
  errorMessage?: string;
}

export class MockScreeningProvider implements ScreeningProvider {
  readonly code: string;
  private readonly result: ScreeningResultCode;
  private readonly matches: ScreeningMatch[];
  private readonly versions: Record<string, string>;
  private readonly errorMessage: string | undefined;

  constructor(options: MockScreeningProviderOptions = {}) {
    this.code = options.providerCode ?? "MOCK";
    this.result = options.result ?? "CLEAR";
    this.matches = options.matches ?? [];
    this.versions = options.listVersions ?? { MOCK: "mock-v1" };
    this.errorMessage = options.errorMessage;
  }

  capabilities(): ScreeningCapabilities {
    return { lists: ["SANCTIONS", "PEP", "ADVERSE_MEDIA", "INTERNAL_WATCHLIST"], arabicNameMatching: true, batchRescreen: false };
  }

  listVersions(): Promise<Record<string, string>> {
    return Promise.resolve({ ...this.versions });
  }

  subscribeListUpdates(callbackUrl: string): Promise<void> {
    return Promise.resolve(void callbackUrl);
  }

  async getResult(providerRequestRef: string): Promise<ScreeningResult> {
    return {
      result: this.result,
      matches: this.matches,
      highestScore: this.matches.length > 0 ? this.matches.reduce((acc, match) => Math.max(acc, match.score), 0) : null,
      providerCode: this.code,
      providerRequestRef,
      listVersions: { ...this.versions },
      inputHash: sha256Hex(providerRequestRef),
    };
  }

  async screenSubject(subject: ScreeningSubject, options?: ScreeningOptions): Promise<ScreeningResult> {
    void options;
    if (this.errorMessage) {
      return {
        result: "ERROR",
        matches: [],
        highestScore: null,
        providerCode: this.code,
        providerRequestRef: null,
        listVersions: { ...this.versions },
        inputHash: computeScreeningInputHash(subject),
        error: this.errorMessage,
      };
    }
    return {
      result: this.result,
      matches: this.matches,
      highestScore: this.matches.length > 0 ? this.matches.reduce((acc, match) => Math.max(acc, match.score), 0) : null,
      providerCode: this.code,
      providerRequestRef: null,
      listVersions: { ...this.versions },
      inputHash: computeScreeningInputHash(subject),
    };
  }
}

export interface CachedScreeningProviderOptions {
  ttlMs?: number;
  maxEntries?: number;
}

export class CachedScreeningProvider implements ScreeningProvider {
  readonly code: string;
  private readonly delegate: ScreeningProvider;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, { expiresAt: number; value: ScreeningResult }>();

  constructor(delegate: ScreeningProvider, options: CachedScreeningProviderOptions = {}) {
    this.delegate = delegate;
    this.code = delegate.code;
    this.ttlMs = options.ttlMs ?? 300_000;
    this.maxEntries = options.maxEntries ?? 5000;
  }

  capabilities(): ScreeningCapabilities {
    return this.delegate.capabilities();
  }

  listVersions(): Promise<Record<string, string>> {
    return this.delegate.listVersions();
  }

  subscribeListUpdates(callbackUrl: string): Promise<void> {
    if (!this.delegate.subscribeListUpdates) return Promise.resolve();
    return this.delegate.subscribeListUpdates(callbackUrl);
  }

  screenLocal(subject: ScreeningSubject): ScreeningResult {
    if (this.delegate.screenLocal) return this.delegate.screenLocal(subject);
    return {
      result: "CLEAR",
      matches: [],
      highestScore: null,
      providerCode: this.delegate.code,
      providerRequestRef: null,
      listVersions: {},
      inputHash: computeScreeningInputHash(subject),
    };
  }

  async screenSubject(subject: ScreeningSubject, options?: ScreeningOptions): Promise<ScreeningResult> {
    const key = `${this.delegate.code}:${computeScreeningInputHash(subject)}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const value = await this.delegate.screenSubject(subject, options);
    this.cache.set(key, { expiresAt: Date.now() + this.ttlMs, value });
    if (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    return value;
  }

  async getResult(providerRequestRef: string): Promise<ScreeningResult> {
    return this.delegate.getResult(providerRequestRef);
  }

  invalidate(): void {
    this.cache.clear();
  }
}
