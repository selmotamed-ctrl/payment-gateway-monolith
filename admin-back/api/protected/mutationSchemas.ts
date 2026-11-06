import { z } from "zod";
import { zUuid } from "../../lib/zReady";

/**
 * Governance rule: every containment or compliance mutation carries a human readable reason
 * (at least 10 characters) that core writes into the audit record.
 */
export const zMutationReason = z.string().trim().min(10).max(500);

export const reasonOnlySchema = z.object({ reason: zMutationReason }).strict();

export const uuidParamsSchema = z.object({ id: zUuid }).strict();

export const encode = (value: string | undefined): string => encodeURIComponent(value ?? "");
