import { BaseWorker, sanitizeWorkerError, type WorkerOptions, type WorkerTickResult } from "./workerRuntime";
import { toCamelRows } from "../db/rawRows";
import { writeSystemAudit } from "../ledger/ledgerAlerts";
import { bilingualNotice, queueNotice, type NoticeDefinition } from "../../lib/automationNotices";
import { openKeyedOperatorCase } from "./automationCases";
import { claimStage, notifyStaff, staffByRole, type DeadlineContext } from "./deadlines/common";

type Any = Record<string, any>;

export const API_TOKEN_EXPIRING_NOTICE: NoticeDefinition = bilingualNotice({
  code: "API_TOKEN_EXPIRING",
  en: {
    subject: "Your API token expires in {{days}} day(s)",
    body: "The API token \"{{name}}\" (ending {{lastFour}}) expires in about {{days}} day(s). Create a new token and switch your integration to it before then, or your requests will be refused.",
  },
  ar: {
    subject: "ينتهي رمز واجهة البرمجة خلال {{days}} يوم",
    body: "ينتهي رمز واجهة البرمجة \"{{name}}\" (المنتهي بـ {{lastFour}}) خلال نحو {{days}} يوم. أنشئ رمزا جديدا وحوّل تكاملك إليه قبل ذلك، وإلا سترفض طلباتك.",
  },
});

export const CREDENTIAL_EXPIRING_NOTICE: NoticeDefinition = bilingualNotice({
  code: "CREDENTIAL_SET_EXPIRING",
  audience: "INTERNAL",
  en: {
    subject: "Gateway credentials expire in {{days}} day(s): {{gateway}}",
    body: "The {{env}} credential set of gateway {{gateway}} expires in about {{days}} day(s). Replace it before then, or the rail stops accepting payments.",
  },
  ar: {
    subject: "تنتهي صلاحية بيانات اعتماد البوابة خلال {{days}} يوم: {{gateway}}",
    body: "تنتهي صلاحية بيانات اعتماد البيئة {{env}} للبوابة {{gateway}} خلال نحو {{days}} يوم. استبدلها قبل ذلك وإلا ستتوقف السكة عن قبول المدفوعات.",
  },
});

export const CREDENTIAL_EXPIRED_NOTICE: NoticeDefinition = bilingualNotice({
  code: "CREDENTIAL_SET_EXPIRED",
  audience: "INTERNAL",
  en: {
    subject: "Gateway credentials expired: {{gateway}}",
    body: "The {{env}} credential set of gateway {{gateway}} has expired and was taken out of use. Routes that depend on it are no longer offered to payers until a verified credential set exists.",
  },
  ar: {
    subject: "انتهت صلاحية بيانات اعتماد البوابة: {{gateway}}",
    body: "انتهت صلاحية بيانات اعتماد البيئة {{env}} للبوابة {{gateway}} وتم إيقاف استخدامها. لن تُعرض المسارات المعتمدة عليها للدافعين إلى أن توجد بيانات اعتماد موثقة.",
  },
});

export const CREDENTIAL_FAILING_NOTICE: NoticeDefinition = bilingualNotice({
  code: "CREDENTIAL_SET_FAILING",
  audience: "INTERNAL",
  en: {
    subject: "Gateway credentials failed verification: {{gateway}}",
    body: "The scheduled re-verification of the {{env}} credential set of gateway {{gateway}} failed and the set was taken out of use. Check the credentials with the provider and verify them again.",
  },
  ar: {
    subject: "فشل التحقق من بيانات اعتماد البوابة: {{gateway}}",
    body: "فشل التحقق الدوري من بيانات اعتماد البيئة {{env}} للبوابة {{gateway}} وتم إيقاف استخدامها. راجع البيانات مع المزوّد ثم أعد التحقق منها.",
  },
});

export interface CredentialVerifierPort {
  verify(credentialSetId: string): Promise<{ status: string; reason?: string }>;
}

export interface ExpiryNoticeWorkerDeps extends WorkerOptions {
  /** Days before expiry at which the merchant is told about an API token. Default [30, 7, 1]. */
  tokenNoticeDays?: readonly number[];
  /** Days before expiry at which staff are told about a credential set. Default [30, 7, 1]. */
  credentialNoticeDays?: readonly number[];
  /** A credential set that expires within this many days opens a P1 case. Default 7. */
  credentialCaseDays?: number;
  /** Only deadlines of the last N hours are acted on for notices. Default 72. */
  catchupHours?: number;
  caseSlaHours?: number;
  /** Re-verify VERIFIED credential sets older than this many hours (0 = never). Default 24. */
  reverifyAfterHours?: number;
  /** Sets re-verified per tick. Default 5. */
  reverifyBatchSize?: number;
  /** Audit what would be re-verified without calling any gateway. Default true. */
  reverifyDryRun?: boolean;
  verifier?: CredentialVerifierPort;
  audit?: DeadlineContext["audit"];
  notify?: DeadlineContext["notify"];
}

export interface ExpiryNoticeSummary extends WorkerTickResult {
  counts: { tokens: number; credentials: number; expired: number; reverified: number };
  failed: string[];
}

const DAY = 86_400_000;

/**
 * API token and credential expiry (AUTO-08) and scheduled credential re-verification (AUTO-26). Cluster singleton,
 * hourly (each stage is exactly-once through `deadline_stages`, so the cadence only sets how soon a stage is noticed).
 *
 *  - API tokens: the merchant is told 30, 7 and 1 days before `expires_at` (the highest stage reached acts; the lower
 *    ones are claimed silently), so a token is never a surprise at authentication time.
 *  - Credential sets: staff are told at the same stages; at `credentialCaseDays` a P1 case `credential.expiring:<id>`
 *    opens; at `expires_at` the set is taken out of use (status FAILING, audit `CREDENTIAL_SET_EXPIRED`, P1 case
 *    `credential.expired:<id>`, staff told). The payer-facing effect needs no route change: the visible-rails resolver
 *    only offers a route that has a VERIFIED credential set, so a rail without one is hidden before payment instead of
 *    failing in the middle of it, and it comes back by itself when a verified set exists (deviation from the plan's
 *    OPEN_BREAKER, which nothing would ever reset).
 *  - Re-verification: VERIFIED sets not verified for `reverifyAfterHours` are verified again through the credential
 *    check service (a real call to the gateway), a few per tick; a failing verdict (the service records FAILING) opens
 *    `credential.failing:<id>` and tells staff. Dry run by default: it only audits what it would verify.
 */
export class ExpiryNoticeWorker extends BaseWorker {
  protected override get singleton(): boolean {
    return true;
  }

  private readonly deps: ExpiryNoticeWorkerDeps;
  private readonly audit: DeadlineContext["audit"];
  private readonly notify: DeadlineContext["notify"];
  lastSummary: ExpiryNoticeSummary | null = null;

  constructor(deps: ExpiryNoticeWorkerDeps) {
    super({ ...deps, intervalMs: deps.intervalMs ?? 60 * 60 * 1000, batchSize: deps.batchSize ?? 100 });
    this.deps = deps;
    this.audit = deps.audit ?? writeSystemAudit;
    this.notify = deps.notify ?? queueNotice;
  }

  private context(now: Date): DeadlineContext {
    return {
      db: this.db as Any,
      now,
      batchSize: this.batchSize,
      catchupMs: Math.max(1, this.deps.catchupHours ?? 72) * 3_600_000,
      logger: this.logger,
      inTransaction: (fn) => this.inTransaction((tx) => fn(tx as Any)),
      audit: this.audit,
      notify: this.notify,
    };
  }

  protected async tick(): Promise<ExpiryNoticeSummary> {
    const ctx = this.context(this.clock());
    const counts = { tokens: 0, credentials: 0, expired: 0, reverified: 0 };
    const failed: string[] = [];
    const errors: string[] = [];
    const passes: Array<[keyof typeof counts, () => Promise<number>]> = [
      ["tokens", () => this.tokenNotices(ctx)],
      ["credentials", () => this.credentialNotices(ctx)],
      ["expired", () => this.expireCredentials(ctx)],
      ["reverified", () => this.reverify(ctx)],
    ];
    for (const [name, run] of passes) {
      try {
        counts[name] = await run();
      } catch (error) {
        failed.push(name);
        errors.push(`${name}: ${sanitizeWorkerError(error)}`);
        this.logger.error("ExpiryNoticeWorker: pass failed", { pass: name, error: sanitizeWorkerError(error) });
      }
    }
    const processed = counts.tokens + counts.credentials + counts.expired + counts.reverified;
    const summary: ExpiryNoticeSummary = { processed, counts, failed };
    this.lastSummary = summary;
    if (failed.length > 0) throw new Error(`expiry passes failed (${errors.join("; ")})`);
    return summary;
  }

  /** `[30, 7, 1]` -> windows (7, 30], (1, 7], (0, 1] days with stage names `D30`, `D7`, `D1`. */
  private windows(days: readonly number[]): Array<{ stage: string; lowerDays: number; upperDays: number }> {
    const sorted = [...days].sort((left, right) => right - left);
    return sorted.map((upper, index) => ({ stage: `D${upper}`, upperDays: upper, lowerDays: sorted[index + 1] ?? 0 }));
  }

  // ---- API tokens ---------------------------------------------------------------------------------------------

  private async tokenNotices(ctx: DeadlineContext): Promise<number> {
    let processed = 0;
    for (const window of this.windows(this.deps.tokenNoticeDays ?? [30, 7, 1])) {
      const rows = toCamelRows<Any>(
        await ctx.db.$queryRawUnsafe(
          `SELECT t.id::text AS id, t.merchant_id::text AS merchant_id, t.name, t.last_four, t.expires_at
           FROM access_tokens t
           WHERE t.revoked_at IS NULL AND t.expires_at > $1 AND t.expires_at <= $2
             AND NOT EXISTS (SELECT 1 FROM deadline_stages s WHERE s.subject_type = 'ACCESS_TOKEN' AND s.subject_id = t.id::text AND s.stage = $4)
           ORDER BY t.expires_at ASC LIMIT $3`,
          new Date(ctx.now.getTime() + window.lowerDays * DAY),
          new Date(ctx.now.getTime() + window.upperDays * DAY),
          ctx.batchSize,
          window.stage,
        ),
      );
      for (const row of rows) {
        processed += await ctx.inTransaction(async (tx) => {
          // Reaching a lower stage first (a token created with a short life) claims the higher ones silently.
          const higher = this.windows(this.deps.tokenNoticeDays ?? [30, 7, 1]).filter((entry) => entry.upperDays > window.upperDays);
          for (const entry of higher) await claimStage(tx, "ACCESS_TOKEN", String(row.id), entry.stage, { silent: true });
          if (!(await claimStage(tx, "ACCESS_TOKEN", String(row.id), window.stage))) return 0;
          const expiresAt = row.expiresAt instanceof Date ? row.expiresAt : new Date(String(row.expiresAt));
          const days = Math.max(1, Math.round((expiresAt.getTime() - ctx.now.getTime()) / DAY));
          await ctx.notify(tx, {
            definition: API_TOKEN_EXPIRING_NOTICE,
            eventKey: `token-expiring:${row.id}:${window.stage}`,
            payload: { name: String(row.name), lastFour: String(row.lastFour), days },
            merchantId: String(row.merchantId),
          });
          await ctx.audit(tx, {
            action: "API_TOKEN_EXPIRY_NOTICE_SENT",
            entityType: "ACCESS_TOKEN",
            entityId: String(row.id),
            after: { stage: window.stage, expiresAt: expiresAt.toISOString() },
          });
          return 1;
        });
      }
    }
    return processed;
  }

  // ---- credential sets: notices and the P1 case ---------------------------------------------------------------

  private async credentialNotices(ctx: DeadlineContext): Promise<number> {
    let processed = 0;
    const days = this.deps.credentialNoticeDays ?? [30, 7, 1];
    for (const window of this.windows(days)) {
      const rows = toCamelRows<Any>(
        await ctx.db.$queryRawUnsafe(
          `SELECT c.id::text AS id, c.env::text AS env, c.expires_at, g.code AS gateway
           FROM credential_sets c JOIN gateways g ON g.id = c.gateway_id
           WHERE c.status::text <> 'REVOKED' AND c.expires_at > $1 AND c.expires_at <= $2
             AND NOT EXISTS (SELECT 1 FROM deadline_stages s WHERE s.subject_type = 'CREDENTIAL_SET' AND s.subject_id = c.id::text AND s.stage = $4)
           ORDER BY c.expires_at ASC LIMIT $3`,
          new Date(ctx.now.getTime() + window.lowerDays * DAY),
          new Date(ctx.now.getTime() + window.upperDays * DAY),
          ctx.batchSize,
          window.stage,
        ),
      );
      for (const row of rows) {
        processed += await ctx.inTransaction(async (tx) => {
          for (const entry of this.windows(days).filter((item) => item.upperDays > window.upperDays)) {
            await claimStage(tx, "CREDENTIAL_SET", String(row.id), entry.stage, { silent: true });
          }
          if (!(await claimStage(tx, "CREDENTIAL_SET", String(row.id), window.stage))) return 0;
          const expiresAt = row.expiresAt instanceof Date ? row.expiresAt : new Date(String(row.expiresAt));
          const remaining = Math.max(1, Math.round((expiresAt.getTime() - ctx.now.getTime()) / DAY));
          await notifyStaff(ctx, tx, {
            definition: CREDENTIAL_EXPIRING_NOTICE,
            eventKey: `credential-expiring:${row.id}:${window.stage}`,
            payload: { gateway: String(row.gateway), env: String(row.env), days: remaining },
            recipients: await staffByRole(tx, ["GATEWAY_ADMIN", "SECURITY_ADMIN"]),
          });
          if (remaining <= (this.deps.credentialCaseDays ?? 7)) {
            await openKeyedOperatorCase(tx as never, {
              kind: "MANUAL_REVIEW",
              priority: "P1",
              subjectKey: `credential.expiring:${row.id}`,
              slaHours: this.deps.caseSlaHours ?? 24,
              now: ctx.now,
              notes: `The ${row.env} credential set ${row.id} of gateway ${row.gateway} expires at ${expiresAt.toISOString()}. Replace it before then.`,
            });
          }
          await ctx.audit(tx, {
            action: "CREDENTIAL_EXPIRY_NOTICE_SENT",
            entityType: "CREDENTIAL_SET",
            entityId: String(row.id),
            after: { stage: window.stage, expiresAt: expiresAt.toISOString() },
          });
          return 1;
        });
      }
    }
    return processed;
  }

  // ---- credential sets: the expiry itself -----------------------------------------------------------------------

  private async expireCredentials(ctx: DeadlineContext): Promise<number> {
    const rows = toCamelRows<Any>(
      await ctx.db.$queryRawUnsafe(
        `SELECT c.id::text AS id, c.env::text AS env, c.expires_at, g.code AS gateway
         FROM credential_sets c JOIN gateways g ON g.id = c.gateway_id
         WHERE c.status::text IN ('VERIFIED', 'UNTESTED') AND c.expires_at IS NOT NULL AND c.expires_at <= $1
         ORDER BY c.expires_at ASC LIMIT $2`,
        ctx.now,
        ctx.batchSize,
      ),
    );
    let processed = 0;
    for (const row of rows) {
      processed += await ctx.inTransaction(async (tx) => {
        const changed = await tx.$executeRawUnsafe(
          `UPDATE credential_sets SET status = 'FAILING', updated_at = $2 WHERE id = $1::uuid AND status::text IN ('VERIFIED', 'UNTESTED')`,
          String(row.id),
          ctx.now,
        );
        if (Number(changed) === 0) return 0;
        const expiresAt = row.expiresAt instanceof Date ? row.expiresAt : new Date(String(row.expiresAt));
        const recent = ctx.now.getTime() - expiresAt.getTime() <= ctx.catchupMs;
        await ctx.audit(tx, {
          action: "CREDENTIAL_SET_EXPIRED",
          entityType: "CREDENTIAL_SET",
          entityId: String(row.id),
          before: { status: "VERIFIED" },
          after: { status: "FAILING", expiresAt: expiresAt.toISOString(), gateway: String(row.gateway), env: String(row.env) },
        });
        if (recent && (await claimStage(tx, "CREDENTIAL_SET", String(row.id), "EXPIRED"))) {
          await openKeyedOperatorCase(tx as never, {
            kind: "MANUAL_REVIEW",
            priority: "P1",
            subjectKey: `credential.expired:${row.id}`,
            slaHours: this.deps.caseSlaHours ?? 24,
            now: ctx.now,
            notes: `The ${row.env} credential set ${row.id} of gateway ${row.gateway} expired at ${expiresAt.toISOString()} and was taken out of use. Rails that depend on it are hidden from payers until a verified credential set exists.`,
          });
          await notifyStaff(ctx, tx, {
            definition: CREDENTIAL_EXPIRED_NOTICE,
            eventKey: `credential-expired:${row.id}`,
            payload: { gateway: String(row.gateway), env: String(row.env) },
            recipients: await staffByRole(tx, ["GATEWAY_ADMIN", "SECURITY_ADMIN"]),
          });
        }
        return 1;
      });
    }
    return processed;
  }

  // ---- AUTO-26: scheduled re-verification --------------------------------------------------------------------------

  private async reverify(ctx: DeadlineContext): Promise<number> {
    const hours = this.deps.reverifyAfterHours ?? 24;
    if (!(hours > 0)) return 0;
    const dryRun = this.deps.reverifyDryRun ?? true;
    if (!dryRun && !this.deps.verifier) return 0;
    const rows = toCamelRows<Any>(
      await ctx.db.$queryRawUnsafe(
        `SELECT c.id::text AS id, c.env::text AS env, c.last_verified_at, g.code AS gateway
         FROM credential_sets c JOIN gateways g ON g.id = c.gateway_id
         WHERE c.status::text = 'VERIFIED' AND (c.last_verified_at IS NULL OR c.last_verified_at < $1)
           AND (c.expires_at IS NULL OR c.expires_at > $2)
         ORDER BY c.last_verified_at ASC NULLS FIRST LIMIT $3`,
        new Date(ctx.now.getTime() - hours * 3_600_000),
        ctx.now,
        this.deps.reverifyBatchSize ?? 5,
      ),
    );
    let processed = 0;
    for (const row of rows) {
      if (dryRun) {
        await ctx.audit(ctx.db, {
          action: "CREDENTIAL_REVERIFY_PROPOSED",
          entityType: "CREDENTIAL_SET",
          entityId: String(row.id),
          after: { gateway: String(row.gateway), env: String(row.env), dryRun: true },
        });
        processed += 1;
        continue;
      }
      let verdict: { status: string; reason?: string };
      try {
        verdict = await this.deps.verifier!.verify(String(row.id));
      } catch (error) {
        verdict = { status: "UNREACHABLE", reason: sanitizeWorkerError(error) };
      }
      processed += 1;
      if (verdict.status === "VERIFIED") continue;
      // UNREACHABLE (our side or the network) never takes a set out of use; only the service's own FAILING verdict did.
      if (verdict.status !== "FAILING") {
        this.logger.warn("ExpiryNoticeWorker: re-verification inconclusive", { credentialSetId: row.id, reason: verdict.reason ?? null });
        continue;
      }
      await ctx.inTransaction(async (tx) => {
        await openKeyedOperatorCase(tx as never, {
          kind: "MANUAL_REVIEW",
          priority: "P1",
          subjectKey: `credential.failing:${row.id}`,
          slaHours: this.deps.caseSlaHours ?? 24,
          now: ctx.now,
          notes: `The scheduled re-verification of the ${row.env} credential set ${row.id} of gateway ${row.gateway} failed${verdict.reason ? `: ${verdict.reason}` : ""}. The set is out of use until it verifies again.`,
        });
        await notifyStaff(ctx, tx, {
          definition: CREDENTIAL_FAILING_NOTICE,
          eventKey: `credential-failing:${row.id}:${ctx.now.toISOString().slice(0, 10)}`,
          payload: { gateway: String(row.gateway), env: String(row.env) },
          recipients: await staffByRole(tx, ["GATEWAY_ADMIN", "SECURITY_ADMIN"]),
        });
        await ctx.audit(tx, {
          action: "CREDENTIAL_REVERIFY_FAILED",
          entityType: "CREDENTIAL_SET",
          entityId: String(row.id),
          after: { gateway: String(row.gateway), env: String(row.env), reason: verdict.reason ?? null },
        });
      });
    }
    return processed;
  }
}
