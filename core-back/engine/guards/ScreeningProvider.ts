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
  /**
   * Re-reads the list versions of the upstream provider. A provider that
   * caches a watch list uses it to drop the entries that were screened
   * against a stale list.
   */
  refreshListVersions?(): Promise<boolean>;
  capabilities(): ScreeningCapabilities;
  screenLocal?(subject: ScreeningSubject): ScreeningResult;
  /**
   * Publishes a new revision of the watch list.
   *
   * A provider that screens against a locally held list (the internal
   * watch list of the platform) uses it to make a new list effective without
   * a restart. The cached provider forwards the publication to its delegate
   * and drops every cached result that was screened against the old list.
   */
  setEntries?(entries: readonly WatchlistEntry[]): void;
  /**
   * Publishes the version of the published lists. The version is what
   * invalidates the cached screening results.
   */
  setListVersions?(versions: Record<string, string>): void;
}

export interface ScreeningSubjectInput {
  subjectType: ScreeningSubjectType;
  subjectId: string;
  names: readonly (string | null | undefined)[];
  dateOfBirth?: string | null;
  nationality?: string | null;
  identifier?: string | null;
  aliases?: readonly (string | null | undefined)[];
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
  let previous: number[] = Array.from({ length: b.length + 1 }, () => 0);
  let current: number[] = Array.from({ length: b.length + 1 }, () => 0);
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

const compactNames = (values: readonly (string | null | undefined)[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const key = normalizeArabicName(trimmed);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(trimmed);
  }
  return output;
};

/**
 * Builds the canonical screening subject.
 *
 * Every screening layer (L1 onboarding, L2 periodic, L3 transaction time)
 * funnels through this helper, so the names, the aliases and the identifiers
 * are folded exactly once and in exactly one way. The normalisation logic is
 * never re-implemented by a caller.
 */
export const buildScreeningSubject = (input: ScreeningSubjectInput): ScreeningSubject => {
  const names = compactNames(input.names);
  const nameKeys = new Set(names.map((name) => normalizeArabicName(name)));
  const aliases = compactNames(input.aliases ?? []).filter(
    (alias) => !nameKeys.has(normalizeArabicName(alias)),
  );
  const identifier = typeof input.identifier === "string" ? input.identifier.trim() : "";
  return {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    names,
    dateOfBirth: input.dateOfBirth ?? null,
    nationality: input.nationality ?? null,
    identifier: identifier.length > 0 ? identifier : null,
    aliases,
  };
};

/**
 * The fingerprint of a set of list versions. Two fingerprints are equal when
 * the same lists are published at the same version.
 */
export const listVersionsFingerprint = (versions: Record<string, string> | null | undefined): string =>
  Object.keys(versions ?? {})
    .sort()
    .map((listName) => `${listName}=${(versions ?? {})[listName] ?? ""}`)
    .join("&");

export interface WatchlistProviderOptions {
  providerCode?: string;
  entries?: WatchlistEntry[];
  potentialScoreThreshold?: number;
  confirmedScoreThreshold?: number;
  listVersions?: Record<string, string>;
}

/**
 * The watch list of the platform, as it is published in the platform
 * settings.
 *
 * The internal watch list is maintained by the compliance team, so it is a
 * versioned platform setting: `{ version, entries }`. The version is what
 * invalidates the cached screening results, so a published list that changes
 * without changing its version would keep serving stale results.
 */
export interface PublishedWatchlist {
  version: string;
  entries: WatchlistEntry[];
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const toWatchlistEntry = (value: unknown): WatchlistEntry | null => {
  const record = asRecord(value);
  const entryRef = typeof record.entryRef === "string" ? record.entryRef : null;
  const listType = typeof record.listType === "string" ? record.listType : null;
  if (!entryRef || !listType) {
    return null;
  }
  const names = Array.isArray(record.names)
    ? record.names.filter((name): name is string => typeof name === "string" && name.length > 0)
    : [];
  const identifiers = Array.isArray(record.identifiers)
    ? record.identifiers.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (names.length === 0 && identifiers.length === 0) {
    return null;
  }
  return {
    entryRef,
    listType: listType as WatchlistEntry["listType"],
    listName: typeof record.listName === "string" ? record.listName : listType,
    names,
    ...(identifiers.length > 0 ? { identifiers } : {}),
    ...(record.attributes && typeof record.attributes === "object"
      ? { attributes: record.attributes as Record<string, unknown> }
      : {}),
  };
};

/**
 * Parses the published watch list of a platform setting.
 *
 * A missing or malformed setting yields `null`: the caller then keeps the
 * list the provider already holds instead of publishing an empty one.
 */
export const parsePublishedWatchlist = (value: unknown): PublishedWatchlist | null => {
  if (!value) {
    return null;
  }
  const record = asRecord(value);
  const rawEntries = Array.isArray(record.entries) ? record.entries : [];
  const entries = rawEntries
    .map((entry) => toWatchlistEntry(entry))
    .filter((entry): entry is WatchlistEntry => entry !== null);
  const version = typeof record.version === "string" && record.version.length > 0
    ? record.version
    : "internal-v1";
  return { version, entries };
};

/**
 * Publishes a watch list into a screening provider.
 *
 * The provider that holds the list is the one that caches the results, so
 * the publication invalidates the cache of the results that were screened
 * against the previous revision.
 */
export const publishWatchlist = (
  provider: ScreeningProvider,
  value: unknown,
): PublishedWatchlist | null => {
  const published = parsePublishedWatchlist(value);
  if (!published) {
    return null;
  }
  if (!provider.setEntries) {
    return published;
  }
  provider.setEntries(published.entries);
  provider.setListVersions?.({ INTERNAL_WATCHLIST: published.version });
  return published;
};

export class InternalWatchlistProvider implements ScreeningProvider {
  readonly code: string;
  private entries: WatchlistEntry[];
  private readonly potentialThreshold: number;
  private readonly confirmedThreshold: number;
  private versions: Record<string, string>;

  constructor(options: WatchlistProviderOptions = {}) {
    this.code = options.providerCode ?? "INTERNAL_WATCHLIST";
    this.entries = [...(options.entries ?? [])];
    this.potentialThreshold = options.potentialScoreThreshold ?? 75;
    this.confirmedThreshold = options.confirmedScoreThreshold ?? 90;
    this.versions = options.listVersions ?? { INTERNAL_WATCHLIST: "internal-v1" };
  }

  /**
   * Publishes a new revision of the watch list. The list version is what
   * invalidates the cached screening results of `CachedScreeningProvider`.
   */
  setListVersions(versions: Record<string, string>): void {
    this.versions = { ...versions };
  }

  /**
   * Replaces the published entries. A list update callback uses it to make the
   * new entries effective without a restart.
   */
  setEntries(entries: readonly WatchlistEntry[]): void {
    this.entries = [...entries];
  }

  listEntries(): WatchlistEntry[] {
    return [...this.entries];
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
  private publishedListVersions: string | null = null;

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

  /**
   * Publishes a new revision of the watch list into the delegate and drops
   * every result that was screened against the previous revision.
   */
  setEntries(entries: readonly WatchlistEntry[]): void {
    this.delegate.setEntries?.(entries);
    this.invalidate();
  }

  /**
   * Publishes the version of the published lists and drops every result that
   * was screened against a different version.
   */
  setListVersions(versions: Record<string, string>): void {
    this.delegate.setListVersions?.(versions);
    this.invalidate();
  }

  /**
   * Registers the list update callback with the upstream provider and then
   * re-reads the published list versions.
   *
   * A cached screening result is only valid for the list version it was
   * produced against, so a version change drops the whole cache. Without this
   * the cache would keep serving results that were screened against a
   * superseded watch list.
   */
  async subscribeListUpdates(callbackUrl: string): Promise<void> {
    if (this.delegate.subscribeListUpdates) {
      await this.delegate.subscribeListUpdates(callbackUrl);
    }
    await this.refreshListVersions();
  }

  /**
   * Drops every cached result that was screened against a list version that
   * is no longer published. Returns true when the cache was invalidated.
   */
  async refreshListVersions(): Promise<boolean> {
    const versions = await this.delegate.listVersions();
    const fingerprint = listVersionsFingerprint(versions);
    const versionChanged =
      this.publishedListVersions !== null && this.publishedListVersions !== fingerprint;
    const stale = [...this.cache.values()].some(
      (entry) => listVersionsFingerprint(entry.value.listVersions) !== fingerprint,
    );
    this.publishedListVersions = fingerprint;
    if (stale || versionChanged) {
      this.invalidate();
      return true;
    }
    return false;
  }

  /**
   * The hot path screening.
   *
   * The local screening is the one the transaction hot path uses, so it is
   * cached exactly like the deferred one: the cache key is the hash of the
   * screened input and a cached result is only reused while the watch list
   * version it was produced against is still published.
   */
  screenLocal(subject: ScreeningSubject): ScreeningResult {
    const key = this.cacheKey(subject);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now() && this.isCacheEntryFresh(cached.value)) {
      return cached.value;
    }
    if (!this.delegate.screenLocal) {
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
    const value = this.delegate.screenLocal(subject);
    this.remember(key, value);
    return value;
  }

  async screenSubject(subject: ScreeningSubject, options?: ScreeningOptions): Promise<ScreeningResult> {
    const key = this.cacheKey(subject);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now() && this.isCacheEntryFresh(cached.value)) {
      return cached.value;
    }
    const value = await this.delegate.screenSubject(subject, options);
    this.remember(key, value);
    return value;
  }

  async getResult(providerRequestRef: string): Promise<ScreeningResult> {
    return this.delegate.getResult(providerRequestRef);
  }

  invalidate(): void {
    this.cache.clear();
  }

  private cacheKey(subject: ScreeningSubject): string {
    return `${this.delegate.code}:${computeScreeningInputHash(subject)}`;
  }

  /**
   * A cached result is only valid for the list version it was screened
   * against. As long as the published version is unknown, the entry is
   * trusted: the version is published with the first list update.
   */
  private isCacheEntryFresh(value: ScreeningResult): boolean {
    if (this.publishedListVersions === null) {
      return true;
    }
    return listVersionsFingerprint(value.listVersions) === this.publishedListVersions;
  }

  private remember(key: string, value: ScreeningResult): void {
    this.cache.set(key, { expiresAt: Date.now() + this.ttlMs, value });
    if (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
  }
}
