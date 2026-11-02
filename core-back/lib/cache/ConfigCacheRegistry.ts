import {
  invalidationBus,
  invalidationTopicPatterns,
  invalidationTopics,
  topicMatchesPattern,
  type InvalidationBus,
} from "../invalidationBus";

type Any = Record<string, any>;

export interface ConfigCacheDatabase {
  [model: string]: any;
}

export interface ConfigCacheOptions {
  ttlMs: number;
  topics: readonly string[];
  bus?: InvalidationBus;
  now?: () => number;
  onLoadError?: (error: unknown) => void;
}

export interface ConfigCacheStats {
  name: string;
  ttlMs: number;
  topics: readonly string[];
  expiresAt: number | null;
  hasValue: boolean;
  loading: boolean;
}

const modelFor = (db: ConfigCacheDatabase, name: string): Any | undefined => {
  const pascal = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  return (db[name] ?? db[pascal]) as Any | undefined;
};

const rows = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const nowDefault = (): number => Date.now();

/**
 * A whole-collection configuration cache with TTL, single-flight loading and
 * invalidation-topic subscriptions. A load that is invalidated mid-flight is
 * never stored, so a stale snapshot cannot win a race with its invalidation.
 */
export class ConfigCache<T> {
  private readonly name: string;
  private readonly ttlMs: number;
  private readonly topics: readonly string[];
  private readonly onLoadError?: (error: unknown) => void;
  private readonly now: () => number;
  private readonly unsubscribers: Array<() => void> = [];
  private entry: { value: T; expiresAt: number } | undefined;
  private inflight: Promise<T> | undefined;
  private generation = 0;

  constructor(
    name: string,
    private readonly loader: () => Promise<T>,
    options: ConfigCacheOptions,
  ) {
    this.name = name;
    this.ttlMs = options.ttlMs;
    this.topics = options.topics;
    this.onLoadError = options.onLoadError;
    this.now = options.now ?? nowDefault;
    const bus = options.bus ?? invalidationBus;
    for (const topic of this.topics) {
      this.unsubscribers.push(
        bus.subscribe(topic, () => {
          this.invalidate();
        }),
      );
    }
  }

  async get(): Promise<T> {
    const currentTime = this.now();
    if (this.entry && this.entry.expiresAt > currentTime) {
      return this.entry.value;
    }
    if (this.inflight) {
      return this.inflight;
    }
    const generation = this.generation;
    const promise = this.loader()
      .then((value) => {
        if (generation === this.generation) {
          this.entry = { value, expiresAt: this.now() + this.ttlMs };
        }
        return value;
      })
      .catch((error: unknown) => {
        this.onLoadError?.(error);
        throw error;
      });
    this.inflight = promise;
    const settle = (): void => {
      if (this.inflight === promise) {
        this.inflight = undefined;
      }
    };
    void promise.then(settle, settle);
    return promise;
  }

  set(value: T): void {
    this.generation += 1;
    this.entry = { value, expiresAt: this.now() + this.ttlMs };
    this.inflight = undefined;
  }

  invalidate(): void {
    this.generation += 1;
    this.entry = undefined;
    this.inflight = undefined;
  }

  peek(): T | undefined {
    return this.entry?.value;
  }

  matches(topic: string): boolean {
    return this.topics.some((pattern) => topicMatchesPattern(topic, pattern));
  }

  stats(): ConfigCacheStats {
    return {
      name: this.name,
      ttlMs: this.ttlMs,
      topics: this.topics,
      expiresAt: this.entry?.expiresAt ?? null,
      hasValue: this.entry !== undefined,
      loading: this.inflight !== undefined,
    };
  }

  close(): void {
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
    this.invalidate();
  }
}

export interface ActiveRulesSnapshot {
  velocityRules: Any[];
  amlRules: Any[];
  reportingRules: Any[];
}

export interface SystemGlAccountSelector {
  accountType: string;
  ownerId?: string | null;
  gatewayId?: string | null;
  credentialSetId?: string | null;
  env?: string | null;
  currency?: string | null;
}

export const systemGlAccountCacheKey = (account: SystemGlAccountSelector): string =>
  [
    account.accountType,
    account.ownerId ?? "*",
    account.gatewayId ?? "*",
    account.credentialSetId ?? "*",
    account.env ?? "*",
    account.currency ?? "*",
  ].join("|");

export const notificationTemplateCacheKey = (
  code: string,
  channel: string,
  lang: string,
): string => `${code}:${channel}:${lang}`;

const loadPlatformSettings = async (db: ConfigCacheDatabase): Promise<Map<string, unknown>> => {
  const delegate = modelFor(db, "platformSetting");
  if (!delegate?.findMany) {
    return new Map();
  }
  const settings = rows<Any>(
    await delegate.findMany({ orderBy: { version: "desc" } }),
  );
  const map = new Map<string, unknown>();
  for (const setting of settings) {
    const key = String(setting.key);
    if (!map.has(key)) {
      map.set(key, setting.valueJson ?? setting.value_json ?? null);
    }
  }
  return map;
};

const loadActiveRules = async (db: ConfigCacheDatabase): Promise<ActiveRulesSnapshot> => {
  const velocity = modelFor(db, "velocityRule");
  const aml = modelFor(db, "amlRule");
  const reporting = modelFor(db, "reportingRule");
  const [velocityRules, amlRules, reportingRules] = await Promise.all([
    velocity?.findMany ? velocity.findMany({ where: { active: true } }) : Promise.resolve([]),
    aml?.findMany ? aml.findMany({ where: { active: true } }) : Promise.resolve([]),
    reporting?.findMany ? reporting.findMany() : Promise.resolve([]),
  ]);
  return {
    velocityRules: rows<Any>(velocityRules),
    amlRules: rows<Any>(amlRules),
    reportingRules: rows<Any>(reportingRules),
  };
};

const firstPresent = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return String(value);
    }
  }
  return null;
};

const loadSystemGlAccounts = async (db: ConfigCacheDatabase): Promise<Map<string, string>> => {
  const delegate = modelFor(db, "glAccount");
  if (!delegate?.findMany) {
    return new Map();
  }
  const accounts = rows<Any>(
    await delegate.findMany({
      where: { ownerId: null },
      select: {
        id: true,
        accountType: true,
        ownerId: true,
        gatewayId: true,
        credentialSetId: true,
        env: true,
        currency: true,
      },
    }),
  );
  const map = new Map<string, string>();
  for (const account of accounts) {
    map.set(
      systemGlAccountCacheKey({
        accountType: String(account.accountType ?? account.account_type),
        ownerId: firstPresent(account.ownerId, account.owner_id),
        gatewayId: firstPresent(account.gatewayId, account.gateway_id),
        credentialSetId: firstPresent(account.credentialSetId, account.credential_set_id),
        env: firstPresent(account.env),
        currency: firstPresent(account.currency),
      }),
      String(account.id),
    );
  }
  return map;
};

const loadNotificationTemplates = async (
  db: ConfigCacheDatabase,
): Promise<Map<string, Any>> => {
  const delegate = modelFor(db, "notificationTemplate");
  if (!delegate?.findMany) {
    return new Map();
  }
  const templates = rows<Any>(
    await delegate.findMany({
      where: { active: true },
      orderBy: { version: "desc" },
    }),
  );
  const map = new Map<string, Any>();
  for (const template of templates) {
    const key = notificationTemplateCacheKey(
      String(template.code),
      String(template.channel),
      String(template.lang),
    );
    if (!map.has(key)) {
      map.set(key, template);
    }
  }
  return map;
};

export interface ConfigCacheRegistryOptions {
  bus?: InvalidationBus;
  now?: () => number;
  onLoadError?: (error: unknown) => void;
  ttlMs?: Partial<{
    platformSettings: number;
    activeRules: number;
    systemGlAccounts: number;
    notificationTemplates: number;
  }>;
}

export interface CacheableRepositories {
  governance: {
    getPlatformSetting: (tx: any, key: string) => Promise<unknown>;
  };
  risk: {
    listActiveVelocityRules: (tx: any) => Promise<any[]>;
    listActiveAmlRules: (tx: any) => Promise<any[]>;
  };
  notifications: {
    findTemplate: (tx: any, code: string, channel: string, lang: string) => Promise<any | null>;
  };
}

export const applyConfigCachesToRepositories = <T extends CacheableRepositories>(
  repositories: T,
  registry: ConfigCacheRegistry,
): T => {
  const governance = repositories.governance;
  const risk = repositories.risk;
  const notifications = repositories.notifications;
  const originalGetPlatformSetting = governance.getPlatformSetting.bind(governance);
  const originalVelocityRules = risk.listActiveVelocityRules.bind(risk);
  const originalAmlRules = risk.listActiveAmlRules.bind(risk);
  const originalFindTemplate = notifications.findTemplate.bind(notifications);

  governance.getPlatformSetting = async (tx, key) => {
    try {
      const settings = await registry.platformSettingsCache.get();
      if (settings.has(key)) {
        return settings.get(key);
      }
    } catch {
      // The cache is an optimisation; the database remains authoritative.
    }
    return originalGetPlatformSetting(tx, key);
  };

  risk.listActiveVelocityRules = async (tx) => {
    try {
      return [...(await registry.activeRulesCache.get()).velocityRules];
    } catch {
      return originalVelocityRules(tx);
    }
  };

  risk.listActiveAmlRules = async (tx) => {
    try {
      return [...(await registry.activeRulesCache.get()).amlRules];
    } catch {
      return originalAmlRules(tx);
    }
  };

  notifications.findTemplate = async (tx, code, channel, lang) => {
    try {
      const templates = await registry.notificationTemplateCache.get();
      const template = templates.get(notificationTemplateCacheKey(code, channel, lang));
      if (template) {
        return template;
      }
    } catch {
      // Fall through to the authoritative query.
    }
    return originalFindTemplate(tx, code, channel, lang);
  };

  return repositories;
};

const toEventSeq = (value: unknown): bigint | undefined => {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
};

export interface InvalidationEventPollingOptions {
  intervalMs?: number;
  batchSize?: number;
  onError?: (error: unknown) => void;
}

/**
 * Polls `cache_invalidation_events` and invalidates the local caches. It is
 * deliberately opt-in: callers that run on the background pool can start it
 * without touching the checkout pool.
 */
export class ConfigCacheRegistry {
  readonly platformSettingsCache: ConfigCache<Map<string, unknown>>;
  readonly activeRulesCache: ConfigCache<ActiveRulesSnapshot>;
  readonly systemGlAccountsCache: ConfigCache<Map<string, string>>;
  readonly notificationTemplateCache: ConfigCache<Map<string, Any>>;
  readonly bus: InvalidationBus;
  private readonly caches: Array<ConfigCache<any>>;
  private readonly stopPollers = new Set<() => void>();

  constructor(
    private readonly db: ConfigCacheDatabase,
    options: ConfigCacheRegistryOptions = {},
  ) {
    this.bus = options.bus ?? invalidationBus;
    const common = {
      bus: this.bus,
      ...(options.now ? { now: options.now } : {}),
      ...(options.onLoadError ? { onLoadError: options.onLoadError } : {}),
    };
    this.platformSettingsCache = new ConfigCache(
      "platformSettings",
      () => loadPlatformSettings(this.db),
      {
        ...common,
        ttlMs: options.ttlMs?.platformSettings ?? 30_000,
        topics: [invalidationTopics.platformSettings(), invalidationTopicPatterns.platformSettings],
      },
    );
    this.activeRulesCache = new ConfigCache(
      "activeRules",
      () => loadActiveRules(this.db),
      {
        ...common,
        ttlMs: options.ttlMs?.activeRules ?? 30_000,
        topics: [invalidationTopics.activeRules(), invalidationTopicPatterns.activeRules],
      },
    );
    this.systemGlAccountsCache = new ConfigCache(
      "systemGlAccounts",
      () => loadSystemGlAccounts(this.db),
      {
        ...common,
        ttlMs: options.ttlMs?.systemGlAccounts ?? 300_000,
        topics: [invalidationTopics.systemGlAccounts(), invalidationTopicPatterns.systemGlAccounts],
      },
    );
    this.notificationTemplateCache = new ConfigCache(
      "notificationTemplates",
      () => loadNotificationTemplates(this.db),
      {
        ...common,
        ttlMs: options.ttlMs?.notificationTemplates ?? 300_000,
        topics: [
          invalidationTopics.notificationTemplates(),
          invalidationTopicPatterns.notificationTemplates,
        ],
      },
    );
    this.caches = [
      this.platformSettingsCache,
      this.activeRulesCache,
      this.systemGlAccountsCache,
      this.notificationTemplateCache,
    ];
  }

  async getPlatformSettings(): Promise<Map<string, unknown>> {
    return this.platformSettingsCache.get();
  }

  async getPlatformSetting(key: string): Promise<unknown> {
    return (await this.platformSettingsCache.get()).get(key) ?? null;
  }

  async getActiveRules(): Promise<ActiveRulesSnapshot> {
    return this.activeRulesCache.get();
  }

  async getSystemGlAccounts(): Promise<Map<string, string>> {
    return this.systemGlAccountsCache.get();
  }

  async getSystemGlAccountId(selector: SystemGlAccountSelector): Promise<string | undefined> {
    return (await this.systemGlAccountsCache.get()).get(systemGlAccountCacheKey(selector));
  }

  async getNotificationTemplates(): Promise<Map<string, Any>> {
    return this.notificationTemplateCache.get();
  }

  async getNotificationTemplate(
    code: string,
    channel: string,
    lang: string,
  ): Promise<Any | null> {
    return (await this.notificationTemplateCache.get()).get(
      notificationTemplateCacheKey(code, channel, lang),
    ) ?? null;
  }

  invalidateTopic(topic: string): void {
    for (const cache of this.caches) {
      if (cache.matches(topic)) {
        cache.invalidate();
      }
    }
  }

  stats(): ConfigCacheStats[] {
    return this.caches.map((cache) => cache.stats());
  }

  startEventPolling(options: InvalidationEventPollingOptions = {}): () => void {
    const delegate = modelFor(this.db, "cacheInvalidationEvent");
    if (!delegate?.findMany) {
      return () => undefined;
    }
    const intervalMs = options.intervalMs ?? 2_000;
    const batchSize = options.batchSize ?? 200;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastEventSeq: bigint | undefined;

    const tick = async (): Promise<void> => {
      try {
        if (lastEventSeq === undefined) {
          const newest = delegate.findFirst
            ? await delegate.findFirst({
                orderBy: { eventSeq: "desc" },
                select: { eventSeq: true },
              })
            : null;
          lastEventSeq = toEventSeq(newest?.eventSeq) ?? 0n;
        }
        const events = rows<Any>(
          await delegate.findMany({
            where: { eventSeq: { gt: lastEventSeq } },
            orderBy: { eventSeq: "asc" },
            take: batchSize,
            select: { eventSeq: true, topic: true, payloadKey: true },
          }),
        );
        for (const event of events) {
          const sequence = toEventSeq(event.eventSeq);
          if (sequence !== undefined) {
            lastEventSeq = sequence;
          }
          this.invalidateTopic(String(event.topic));
        }
      } catch (error) {
        options.onError?.(error);
      } finally {
        if (!stopped) {
          timer = setTimeout(() => {
            void tick();
          }, intervalMs);
          if (typeof timer === "object" && timer && "unref" in timer) {
            (timer as { unref: () => void }).unref();
          }
        }
      }
    };

    void tick();
    const stop = (): void => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      this.stopPollers.delete(stop);
    };
    this.stopPollers.add(stop);
    return stop;
  }

  close(): void {
    for (const stop of [...this.stopPollers]) {
      stop();
    }
    for (const cache of this.caches) {
      cache.close();
    }
  }
}
