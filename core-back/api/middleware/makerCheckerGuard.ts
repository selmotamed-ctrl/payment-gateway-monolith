import type { Request } from "express";
import { ApiError } from "../../lib/error";
import { principalOf } from "./authDoubleCheck";

export const SYSTEM_AUTOMATION_PRINCIPAL = "SYSTEM_AUTOMATION";

export interface ApprovalActor {
  userId: string;
  role: string;
  isChecker: boolean;
}

export const actorFromRequest = (request: Request): ApprovalActor => {
  const principal = principalOf(request);
  if (!principal.userId) {
    throw new ApiError(403, "APPROVAL_PRINCIPAL_REQUIRED", "A human user principal is required for maker-checker operations");
  }
  if (principal.role === SYSTEM_AUTOMATION_PRINCIPAL) {
    throw new ApiError(403, "AUTOMATION_CANNOT_ACT_AS_CHECKER", "System automation can never act as a checker");
  }
  return {
    userId: principal.userId,
    role: principal.role ?? "SUPPORT",
    isChecker: principal.authorities.includes("approval:check"),
  };
};

export const assertCheckerIsNotMaker = (
  makerUserId: string | null | undefined,
  checkerUserId: string | null | undefined,
): void => {
  if (!makerUserId) {
    throw new ApiError(400, "APPROVAL_MAKER_MISSING", "The approval request has no maker");
  }
  if (!checkerUserId) {
    throw new ApiError(400, "APPROVAL_CHECKER_MISSING", "A checker is required before execution");
  }
  if (makerUserId === checkerUserId) {
    throw new ApiError(409, "APPROVAL_MAKER_EQUALS_CHECKER", "The maker and the checker must be different users");
  }
};

export const assertCheckerAuthority = (actor: ApprovalActor): void => {
  if (!actor.isChecker) {
    throw new ApiError(403, "APPROVAL_CHECKER_AUTHORITY_REQUIRED", "The principal is not authorised to check approvals");
  }
};

export const assertValidJsonPatch = (patch: unknown): void => {
  if (!Array.isArray(patch) || patch.length === 0) {
    throw new ApiError(400, "APPROVAL_PATCH_INVALID", "The approval payload diff must be a non-empty JSON Patch array");
  }
  for (const operation of patch) {
    if (!operation || typeof operation !== "object") {
      throw new ApiError(400, "APPROVAL_PATCH_INVALID", "Each JSON Patch operation must be an object");
    }
    const candidate = operation as Record<string, unknown>;
    const op = candidate.op;
    if (typeof op !== "string" || !["add", "remove", "replace", "move", "copy", "test"].includes(op)) {
      throw new ApiError(400, "APPROVAL_PATCH_INVALID", "Unsupported JSON Patch operation");
    }
    if (typeof candidate.path !== "string" || !candidate.path.startsWith("/")) {
      throw new ApiError(400, "APPROVAL_PATCH_INVALID", "JSON Patch operations require an absolute path");
    }
    if (op !== "remove" && op !== "test" && candidate.value === undefined) {
      throw new ApiError(400, "APPROVAL_PATCH_INVALID", "JSON Patch operations require a value");
    }
  }
};

export const applyJsonPatch = (document: Record<string, unknown>, patch: unknown): Record<string, unknown> => {
  assertValidJsonPatch(patch);
  const output: Record<string, unknown> = structuredClone(document);
  for (const operation of patch as Array<Record<string, unknown>>) {
    const op = String(operation.op);
    const path = String(operation.path);
    const segments = path.split("/").slice(1).map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (segments.length === 0) {
      throw new ApiError(400, "APPROVAL_PATCH_INVALID", "JSON Patch cannot target the document root");
    }
    let cursor: Record<string, unknown> = output;
    for (const segment of segments.slice(0, -1)) {
      const next = cursor[segment];
      if (!next || typeof next !== "object") {
        if (op === "add" || op === "replace") {
          const created: Record<string, unknown> = {};
          cursor[segment] = created;
          cursor = created;
          continue;
        }
        throw new ApiError(400, "APPROVAL_PATCH_PATH_INVALID", `JSON Patch path '${path}' does not exist`);
      }
      cursor = next as Record<string, unknown>;
    }
    const last = segments[segments.length - 1] as string;
    if (op === "remove") {
      delete cursor[last];
      continue;
    }
    if (op === "test") {
      if (JSON.stringify(cursor[last]) !== JSON.stringify(operation.value)) {
        throw new ApiError(409, "APPROVAL_PATCH_TEST_FAILED", `JSON Patch test on '${path}' failed`);
      }
      continue;
    }
    cursor[last] = operation.value;
  }
  return output;
};
