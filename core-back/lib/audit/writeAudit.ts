import { env } from "../env";
import { uuidv7 } from "../storageEngine/uuid";

export interface AuditLogWriteData {
  id?: string;
  actorId: string;
  actorEmail?: string | null;
  role: string;
  action: string;
  entityType: string;
  entityId: string;
  merchantId?: string | null;
  approvalRequestId?: string | null;
  requestId?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  createdAt?: Date;
  [key: string]: unknown;
}

export interface AuditLogCreateArgs {
  data: AuditLogWriteData;
  [key: string]: unknown;
}

type AuditCreateResult = { id: string } & Record<string, unknown>;

export interface AuditWriteClient {
  auditLog: {
    create(args: AuditLogCreateArgs): Promise<AuditCreateResult>;
  };
  auditOutbox?: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  $transaction?: (...args: any[]) => Promise<any>;
}

const isTransactionClient = (db: any): boolean =>
  typeof db.$transaction !== "function";

const writeInTransaction = async (
  db: any,
  args: AuditLogCreateArgs,
): Promise<AuditCreateResult> => {
  const data = args.data;
  const id = data.id ?? uuidv7();
  const createdAt = data.createdAt ?? new Date();
  const created = await db.auditLog.create({
    ...args,
    data: { ...data, id, createdAt },
  });

  // The audit outbox is only populated when a dedicated audit database is
  // configured. Without it the compatibility audit_log row is the only sink,
  // so development deployments do not accumulate unshippable rows.
  if (env.AUDIT_DATABASE_URL && db.auditOutbox) {
    await db.auditOutbox.create({
      data: {
        id,
        actorId: data.actorId,
        actorEmail: data.actorEmail ?? null,
        role: data.role,
        action: data.action,
        entityType: data.entityType,
        entityId: data.entityId,
        merchantId: data.merchantId ?? null,
        approvalRequestId: data.approvalRequestId ?? null,
        requestId: data.requestId ?? null,
        clientIp: data.clientIp ?? null,
        userAgent: data.userAgent ?? null,
        beforeJson: data.beforeJson,
        afterJson: data.afterJson,
        createdAt,
      },
    });
  }

  return created;
};

/**
 * Writes the permanent audit row and, when a dedicated audit database is
 * configured, the same row into the transactional audit outbox.
 *
 * The helper joins an existing transaction when the caller passes a Prisma
 * transaction client. A plain client opens a short transaction so the two
 * inserts are atomic.
 */
export const writeAudit = async (
  db: any,
  args: AuditLogCreateArgs,
): Promise<AuditCreateResult> => {
  if (
    env.AUDIT_DATABASE_URL &&
    db.auditOutbox &&
    !isTransactionClient(db) &&
    typeof db.$transaction === "function"
  ) {
    return db.$transaction((tx: any) => writeInTransaction(tx, args));
  }
  return writeInTransaction(db, args);
};

export const writeAuditLog = writeAudit;
