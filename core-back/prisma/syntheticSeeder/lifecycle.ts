/**
 * The attempt state machine the synthetic history must respect.
 *
 * `ATTEMPT_TRANSITIONS` mirrors `ALLOWED_TRANSITIONS` of
 * `engine/flow/DynamicRailEngine.ts` (not exported there).
 * `test/synthetic-seeder-realism.test.ts` parses the engine source and fails
 * when the two drift apart.
 *
 * `GOVERNANCE_TRANSITIONS` are the edges the engine takes OUTSIDE the
 * dynamic rail engine: the guard pipeline creates an attempt directly as
 * `BLOCKED`, and the AML case resolution (`finalizeAmlAttempt`,
 * engine/governance/GovernanceExecution.ts) moves a held `CREATED` attempt
 * straight to `SUCCEEDED` (release) or `FAILED` (void).
 */
export const ATTEMPT_TRANSITIONS: Record<string, readonly string[]> = {
  CREATED: ["INITIATING", "AWAITING_CUSTOMER", "VERIFYING", "BLOCKED", "CANCELLED", "EXPIRED", "FAILED"],
  INITIATING: ["AWAITING_CUSTOMER", "VERIFYING", "FAILED", "BLOCKED", "CANCELLED", "EXPIRED", "UNKNOWN"],
  AWAITING_CUSTOMER: ["AUTHORIZING", "AWAITING_CUSTOMER", "VERIFYING", "FAILED", "CANCELLED", "EXPIRED", "BLOCKED", "UNKNOWN"],
  AUTHORIZING: ["VERIFYING", "SUCCEEDED", "FAILED", "UNKNOWN", "AWAITING_CUSTOMER"],
  VERIFYING: ["VERIFYING", "SUCCEEDED", "FAILED", "UNKNOWN", "AWAITING_CUSTOMER"],
  UNKNOWN: ["VERIFYING", "SUCCEEDED", "FAILED", "UNKNOWN"],
  SUCCEEDED: ["PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"],
  FAILED: ["SUCCEEDED"],
  EXPIRED: ["SUCCEEDED"],
  CANCELLED: [],
  BLOCKED: [],
  PARTIALLY_REFUNDED: ["PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"],
  REFUNDED: [],
  DISPUTED: ["PARTIALLY_REFUNDED", "REFUNDED"],
};

export const GOVERNANCE_TRANSITIONS: Record<string, readonly string[]> = {
  CREATED: ["SUCCEEDED", "FAILED"],
};

/** The statuses an attempt can be created in. */
export const INITIAL_STATUSES = new Set(["CREATED", "BLOCKED"]);

export const IN_FLIGHT_STATUSES = new Set(["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING", "UNKNOWN"]);
export const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED", "REFUNDED", "PARTIALLY_REFUNDED", "DISPUTED"]);
/** Statuses that hold money: the attempt reached SUCCEEDED at some point. */
export const SETTLED_STATUSES = new Set(["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED", "DISPUTED"]);
/** Statuses that release the reserved link slot (`TERMINAL_RELEASING_STATES`). */
export const SLOT_RELEASING_STATUSES = new Set(["FAILED", "EXPIRED", "CANCELLED", "BLOCKED"]);

export const isAllowedTransition = (from: string, to: string): boolean =>
  (ATTEMPT_TRANSITIONS[from] ?? []).includes(to) || (GOVERNANCE_TRANSITIONS[from] ?? []).includes(to);

/** Returns the first invalid step of a status path, or null when every step is reachable. */
export const invalidPathStep = (path: readonly string[]): string | null => {
  if (path.length === 0) return "empty path";
  if (!INITIAL_STATUSES.has(path[0]!)) return `starts at ${path[0]}`;
  for (let index = 1; index < path.length; index += 1) {
    if (!isAllowedTransition(path[index - 1]!, path[index]!)) {
      return `${path[index - 1]} -> ${path[index]}`;
    }
  }
  return null;
};
