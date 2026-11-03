/**
 * Audit writes are split into a narrow append-only parent and a cold payload
 * child. Keeping the split here means every domain writer gets the same
 * transaction-local behaviour and no caller can accidentally keep the large
 * before/after JSON in the hot audit index.
 */
type AnyPrisma = {
  auditLog: { create: (args: any) => Promise<any>; findMany?: (args: any) => Promise<any[]> };
  auditLogPayload?: {
    create?: (args: any) => Promise<any>;
    findMany?: (args: any) => Promise<any[]>;
  };
  $transaction?: <T>(callback: (tx: any) => Promise<T>) => Promise<T>;
};

export interface AuditLogCreateArgs {
  data: Record<string, any>;
  select?: Record<string, unknown>;
}

export function parseAuditLogId(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return null;
}

export function auditPayloadOf(data: Record<string, any>): {
  beforeJson: unknown;
  afterJson: unknown;
  parentData: Record<string, any>;
} {
  const { beforeJson, afterJson, ...parentData } = data;
  return {
    beforeJson: beforeJson ?? {},
    afterJson: afterJson ?? {},
    parentData,
  };
}

export async function createAuditLog(db: any, args: AuditLogCreateArgs): Promise<any> {
  const { beforeJson, afterJson, parentData } = auditPayloadOf(args.data ?? {});
  const parent = await db.auditLog.create({
    data: parentData,
    ...(args.select ? { select: args.select } : {}),
  });
  if (db.auditLogPayload?.create) {
    await db.auditLogPayload.create({
      data: {
        auditLogId: parent.id,
        beforeJson,
        afterJson,
      },
    });
  }
  return { ...parent, beforeJson, afterJson };
}

/** Attaches cold payloads to a page of audit rows in one indexed lookup. */
export async function attachAuditPayloads<T extends { id: bigint | string }>(
  db: AnyPrisma,
  rows: T[],
): Promise<Array<T & { beforeJson: unknown; afterJson: unknown }>> {
  if (rows.length === 0 || !db.auditLogPayload?.findMany) {
    return rows.map((row) => ({ ...row, beforeJson: {}, afterJson: {} }));
  }
  const ids = rows
    .map((row) => parseAuditLogId(row.id))
    .filter((id): id is bigint => id !== null);
  const payloads = ids.length
    ? await db.auditLogPayload.findMany({
        where: { auditLogId: { in: ids } },
        select: { auditLogId: true, beforeJson: true, afterJson: true },
      })
    : [];
  const byId = new Map(payloads.map((payload) => [String(payload.auditLogId), payload]));
  return rows.map((row) => {
    const payload = byId.get(String(row.id));
    return {
      ...row,
      beforeJson: payload?.beforeJson ?? {},
      afterJson: payload?.afterJson ?? {},
    };
  });
}

export async function attachAuditPayloadsToTransaction(
  db: AnyPrisma,
  rows: Array<{ id: bigint | string }>,
): Promise<Array<Record<string, unknown>>> {
  return attachAuditPayloads(db, rows as Array<{ id: bigint | string }>);
}


/** Fetches audit rows and attaches their cold payload in one place. */
export async function findAuditLogs<T = any>(db: any, args: Record<string, unknown>): Promise<Array<T & { beforeJson: unknown; afterJson: unknown }>> {
  const rows = await db.auditLog.findMany(args);
  return attachAuditPayloads(db, rows as Array<{ id: bigint | string }>) as unknown as Promise<Array<T & { beforeJson: unknown; afterJson: unknown }>>;
}
