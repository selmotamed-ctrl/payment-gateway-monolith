import { Vault } from "../crypto/Vault";

export type DetailChangeSource = "PORTAL" | "ADMIN" | "API" | "SYSTEM";

export interface DetailChangeRecord {
  id: string;
  actorId: string;
  merchantId?: string | null;
  entityType: string;
  entityId: string;
  fieldName: string;
  oldValue?: string | null;
  newValue?: string | null;
  approvalRequestId?: string | null;
  source: DetailChangeSource;
  requestId: string;
  clientIp?: string | null;
  createdAt?: Date;
}

export interface DetailChangePrismaClient {
  detailChangeLog: {
    create(args: { data: Record<string, unknown> }): Promise<DetailChangeRecord>;
    findMany(args: { where: Record<string, unknown>; orderBy?: Record<string, unknown> }): Promise<DetailChangeRecord[]>;
  };
}

export interface RecordDetailChangeInput {
  entityType: string;
  entityId: string;
  merchantId?: string;
  before: unknown;
  after: unknown;
  actorId: string;
  source: DetailChangeSource;
  approvalRequestId?: string;
  requestId: string;
  clientIp?: string;
}

export interface DetailChangeServiceOptions {
  redactor?: (payload: unknown) => unknown;
  literalSecrets?: readonly string[];
}

export class DetailChangeService {
  private readonly client: DetailChangePrismaClient;
  private readonly options: DetailChangeServiceOptions;
  private readonly vault: Vault;

  constructor(
    client: DetailChangePrismaClient,
    options: DetailChangeServiceOptions = {},
    vault = new Vault(),
  ) {
    this.client = client;
    this.options = options;
    this.vault = vault;
  }

  async recordChange(input: RecordDetailChangeInput): Promise<DetailChangeRecord[]> {
    const differences = diffValues(input.before, input.after);
    if (differences.length === 0) {
      return [];
    }
    const records: DetailChangeRecord[] = [];
    for (const difference of differences) {
      const record = await this.client.detailChangeLog.create({
        data: {
          actorId: input.actorId,
          merchantId: input.merchantId ?? null,
          entityType: input.entityType,
          entityId: input.entityId,
          fieldName: difference.path,
          oldValue: this.serialize(difference.oldValue),
          newValue: this.serialize(difference.newValue),
          approvalRequestId: input.approvalRequestId ?? null,
          source: input.source,
          requestId: input.requestId,
          clientIp: input.clientIp ?? null,
        },
      });
      records.push(record);
    }
    return records;
  }

  async record(input: RecordDetailChangeInput): Promise<DetailChangeRecord[]> {
    return this.recordChange(input);
  }

  async listForSubject(entityType: string, entityId: string): Promise<DetailChangeRecord[]> {
    return this.client.detailChangeLog.findMany({
      where: { entityType: entityType, entityId: entityId },
      orderBy: { createdAt: "desc" },
    });
  }

  private serialize(value: unknown): string {
    const redacted = this.options.redactor
      ? this.options.redactor(value)
      : this.vault.redactPayload(value, this.options.literalSecrets ?? []);
    if (typeof redacted === "string") {
      return redacted;
    }
    if (redacted === undefined || redacted === null) {
      return "";
    }
    return JSON.stringify(redacted);
  }
}

export interface ValueDifference {
  path: string;
  oldValue: unknown;
  newValue: unknown;
}

export function diffValues(before: unknown, after: unknown, path = ""): ValueDifference[] {
  if (Object.is(before, after)) {
    return [];
  }
  const beforeObject = isRecord(before);
  const afterObject = isRecord(after);
  if (beforeObject && afterObject) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const differences: ValueDifference[] = [];
    for (const key of [...keys].sort()) {
      const childPath = path ? `${path}.${key}` : key;
      differences.push(...diffValues(before[key], after[key], childPath));
    }
    return differences;
  }
  return [{ path: path || "$", oldValue: before, newValue: after }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
