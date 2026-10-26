import { ApiError } from "../../lib/error";

export const SYSTEM_AUTOMATION = "SYSTEM_AUTOMATION";

export type ApprovalState = "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "EXECUTED" | "REJECTED";
export type ApprovalMode = "STANDARD" | "EMERGENCY_RATIFICATION";
export type JsonPatchOperation =
  | { op: "add" | "remove" | "replace" | "test"; path: string; value?: unknown; from?: string }
  | { op: "move" | "copy"; path: string; from: string };

export interface ApprovalRequestRecord {
  id: string;
  subjectType: string;
  subjectId: string;
  payloadDiffJson: unknown;
  mode: ApprovalMode;
  baseVersion?: number | null;
  expiresAt?: Date | null;
  ratifyDueAt?: Date | null;
  makerUserId: string;
  checkerUserId?: string | null;
  state: ApprovalState;
  rejectionReason?: string | null;
  riskAcceptanceNote?: string | null;
  currentVersion?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ApprovalPrismaClient {
  approvalRequest: {
    findUnique(args: { where: { id: string } }): Promise<ApprovalRequestRecord | null>;
    create(args: { data: Record<string, unknown> }): Promise<ApprovalRequestRecord>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<ApprovalRequestRecord>;
  };
  $transaction?<R>(callback: (transaction: ApprovalPrismaClient) => Promise<R>): Promise<R>;
}

export interface ApprovalTransactionRunner {
  <R>(callback: (transaction: ApprovalPrismaClient) => Promise<R>): Promise<R>;
}

export interface ProposeApprovalInput {
  subjectType: string;
  subjectId: string;
  makerUserId: string;
  payloadDiff?: JsonPatchOperation[] | Record<string, unknown>;
  baseVersion?: number;
  mode?: ApprovalMode;
  expiresAt?: Date;
  ratifyDueAt?: Date;
  riskAcceptanceNote?: string;
}

export interface ApprovalExecutionOptions {
  executeImmediately?: boolean;
}

export interface ApprovalServiceOptions {
  transactionRunner?: ApprovalTransactionRunner;
  execute?: (
    transaction: ApprovalPrismaClient,
    request: ApprovalRequestRecord,
    checkerUserId: string,
  ) => Promise<void> | void;
  applyPatch?: (
    transaction: ApprovalPrismaClient,
    request: ApprovalRequestRecord,
  ) => Promise<void> | void;
  getCurrentVersion?: (
    transaction: ApprovalPrismaClient,
    request: ApprovalRequestRecord,
  ) => Promise<number | string | null | undefined> | number | string | null | undefined;
}

export interface EmergencyExecutionInput {
  requestId?: string;
  subjectType?: string;
  subjectId?: string;
  makerUserId?: string;
  payloadDiff?: JsonPatchOperation[] | Record<string, unknown>;
  baseVersion?: number;
  ratifyDueAt?: Date;
  riskAcceptanceNote?: string;
}

function approvalError(code: string, message: string, statusCode = 400): ApiError {
  return new ApiError(statusCode, code, message);
}

function isPatch(value: unknown): value is JsonPatchOperation[] {
  return Array.isArray(value) && value.every((operation) => Boolean(operation) && typeof operation === "object" && "op" in operation);
}

export function validateJsonPatch(patch: unknown): JsonPatchOperation[] {
  if (!isPatch(patch)) {
    throw approvalError("INVALID_JSON_PATCH", "Payload diff must be a JSON Patch operation array");
  }
  for (const operation of patch) {
    if (!["add", "remove", "replace", "move", "copy", "test"].includes(operation.op)) {
      throw approvalError("INVALID_JSON_PATCH", `Unsupported JSON Patch operation '${String(operation.op)}'`);
    }
    if (!isJsonPointer(operation.path)) {
      throw approvalError("INVALID_JSON_PATCH", `Invalid JSON Pointer path '${operation.path}'`);
    }
    if (["move", "copy"].includes(operation.op) && !isJsonPointer(operation.from)) {
      throw approvalError("INVALID_JSON_PATCH", `Invalid JSON Pointer source path '${String(operation.from)}'`);
    }
    if (["add", "replace", "test"].includes(operation.op) && !("value" in operation)) {
      throw approvalError("INVALID_JSON_PATCH", `JSON Patch '${operation.op}' requires a value`);
    }
  }
  return patch;
}

function isJsonPointer(path: unknown): path is string {
  return typeof path === "string" && (path === "" || path.startsWith("/"));
}

function decodePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function pointerSegments(path: string): string[] {
  if (path === "") {
    return [];
  }
  return path.slice(1).split("/").map(decodePointerSegment);
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return structuredClone(value);
}

function getParent(root: unknown, segments: readonly string[]): { parent: Record<string, unknown> | unknown[]; key: string } {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw approvalError("INVALID_JSON_PATCH", "JSON Patch array index is out of range");
      }
      current = current[index];
    } else if (current && typeof current === "object") {
      if (!Object.hasOwn(current, segment)) {
        throw approvalError("INVALID_JSON_PATCH", `JSON Patch path '${segment}' does not exist`);
      }
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw approvalError("INVALID_JSON_PATCH", "JSON Patch path traverses a non-object value");
    }
  }
  const key = segments[segments.length - 1] as string;
  if (!Array.isArray(current) && (!current || typeof current !== "object")) {
    throw approvalError("INVALID_JSON_PATCH", "JSON Patch parent is not an object");
  }
  return { parent: current as Record<string, unknown> | unknown[], key };
}

function readPointer(root: unknown, path: string): unknown {
  const segments = pointerSegments(path);
  if (segments.length === 0) {
    return root;
  }
  const { parent, key } = getParent(root, segments);
  if (Array.isArray(parent)) {
    const index = key === "-" ? parent.length : Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
      throw approvalError("INVALID_JSON_PATCH", "JSON Patch array index is out of range");
    }
    return parent[index];
  }
  if (!Object.hasOwn(parent, key)) {
    throw approvalError("INVALID_JSON_PATCH", `JSON Patch path '${path}' does not exist`);
  }
  return parent[key];
}

function writePointer(root: unknown, path: string, value: unknown, mode: "add" | "replace"): void {
  const segments = pointerSegments(path);
  if (segments.length === 0) {
    throw approvalError("INVALID_JSON_PATCH", "Replacing the document root is not supported");
  }
  const { parent, key } = getParent(root, segments);
  if (Array.isArray(parent)) {
    const index = key === "-" ? parent.length : Number(key);
    if (!Number.isInteger(index) || index < 0 || index > parent.length) {
      throw approvalError("INVALID_JSON_PATCH", "JSON Patch array index is out of range");
    }
    if (mode === "replace") {
      if (index >= parent.length) {
        throw approvalError("INVALID_JSON_PATCH", "JSON Patch array index is out of range");
      }
      parent[index] = value;
    } else if (index === parent.length) {
      parent.push(value);
    } else {
      parent.splice(index, 0, value);
    }
    return;
  }
  if (mode === "replace" && !Object.hasOwn(parent, key)) {
    throw approvalError("INVALID_JSON_PATCH", `JSON Patch path '${path}' does not exist`);
  }
  parent[key] = value;
}

function removePointer(root: unknown, path: string): unknown {
  const segments = pointerSegments(path);
  if (segments.length === 0) {
    throw approvalError("INVALID_JSON_PATCH", "Removing the document root is not supported");
  }
  const { parent, key } = getParent(root, segments);
  if (Array.isArray(parent)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
      throw approvalError("INVALID_JSON_PATCH", "JSON Patch array index is out of range");
    }
    return parent.splice(index, 1)[0];
  }
  if (!Object.hasOwn(parent, key)) {
    throw approvalError("INVALID_JSON_PATCH", `JSON Patch path '${path}' does not exist`);
  }
  const removed = parent[key];
  delete parent[key];
  return removed;
}

export function applyJsonPatch<T>(document: T, patch: JsonPatchOperation[]): T {
  let result = cloneJsonValue(document) as unknown;
  for (const operation of validateJsonPatch(patch)) {
    if (operation.op === "test") {
      const actual = readPointer(result, operation.path);
      if (JSON.stringify(actual) !== JSON.stringify(operation.value)) {
        throw approvalError("JSON_PATCH_TEST_FAILED", `JSON Patch test failed at '${operation.path}'`);
      }
      continue;
    }
    if (operation.op === "add") {
      writePointer(result, operation.path, cloneJsonValue(operation.value), "add");
      continue;
    }
    if (operation.op === "replace") {
      writePointer(result, operation.path, cloneJsonValue(operation.value), "replace");
      continue;
    }
    if (operation.op === "remove") {
      removePointer(result, operation.path);
      continue;
    }
    if (operation.op === "copy") {
      if (!operation.from) {
        throw approvalError("INVALID_JSON_PATCH", "JSON Patch copy requires a source path");
      }
      writePointer(result, operation.path, cloneJsonValue(readPointer(result, operation.from)), "add");
      continue;
    }
    if (!operation.from) {
      throw approvalError("INVALID_JSON_PATCH", "JSON Patch move requires a source path");
    }
    const moved = removePointer(result, operation.from);
    writePointer(result, operation.path, moved, "add");
  }
  return result as T;
}

export class ApprovalService {
  private readonly client: ApprovalPrismaClient;
  private readonly options: ApprovalServiceOptions;
  private readonly transactionRunner: ApprovalTransactionRunner;

  constructor(client: ApprovalPrismaClient, options: ApprovalServiceOptions = {}) {
    this.client = client;
    this.options = options;
    this.transactionRunner = options.transactionRunner
      ?? (client.$transaction
        ? <R>(callback: (transaction: ApprovalPrismaClient) => Promise<R>) => client.$transaction!(callback)
        : async <R>(callback: (transaction: ApprovalPrismaClient) => Promise<R>) => callback(client));
  }

  async proposeApproval(input: ProposeApprovalInput): Promise<ApprovalRequestRecord> {
    if (!input.makerUserId) {
      throw approvalError("INVALID_APPROVAL_MAKER", "Maker user ID is required");
    }
    if (isPatch(input.payloadDiff)) {
      validateJsonPatch(input.payloadDiff);
    }
    if (input.baseVersion !== undefined && !Number.isSafeInteger(input.baseVersion)) {
      throw approvalError("INVALID_BASE_VERSION", "Base version must be an integer");
    }
    return this.client.approvalRequest.create({
      data: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        payloadDiffJson: input.payloadDiff ?? [],
        mode: input.mode ?? "STANDARD",
        baseVersion: input.baseVersion ?? null,
        expiresAt: input.expiresAt ?? null,
        ratifyDueAt: input.ratifyDueAt ?? null,
        makerUserId: input.makerUserId,
        checkerUserId: null,
        state: "PENDING_REVIEW",
        riskAcceptanceNote: input.riskAcceptanceNote ?? null,
      },
    });
  }

  async approveRequest(
    requestId: string,
    checkerUserId: string,
    options: ApprovalExecutionOptions = {},
  ): Promise<ApprovalRequestRecord> {
    this.assertChecker(checkerUserId);
    return this.transactionRunner(async (transaction) => {
      const request = await this.getRequest(transaction, requestId);
      this.assertPending(request);
      if (request.makerUserId === checkerUserId) {
        throw approvalError("MAKER_CHECKER_SEPARATION", "Checker must differ from maker", 403);
      }
      await this.assertBaseVersion(transaction, request);
      if (this.options.applyPatch && isPatch(request.payloadDiffJson)) {
        await this.options.applyPatch(transaction, request);
      }
      if (this.options.execute) {
        await this.options.execute(transaction, request, checkerUserId);
      }
      const state: ApprovalState = options.executeImmediately === false ? "APPROVED" : "EXECUTED";
      return transaction.approvalRequest.update({
        where: { id: requestId },
        data: {
          checkerUserId: checkerUserId,
          state,
        },
      });
    });
  }

  async rejectRequest(
    requestId: string,
    checkerUserId: string,
    reason: string,
  ): Promise<ApprovalRequestRecord> {
    this.assertChecker(checkerUserId);
    if (!reason) {
      throw approvalError("REJECTION_REASON_REQUIRED", "Rejection reason is required");
    }
    return this.transactionRunner(async (transaction) => {
      const request = await this.getRequest(transaction, requestId);
      this.assertPending(request);
      if (request.makerUserId === checkerUserId) {
        throw approvalError("MAKER_CHECKER_SEPARATION", "Checker must differ from maker", 403);
      }
      return transaction.approvalRequest.update({
        where: { id: requestId },
        data: {
          checkerUserId: checkerUserId,
          state: "REJECTED",
          rejectionReason: reason,
        },
      });
    });
  }

  async emergencyExecuteWithRatification(
    requestOrInput: string | EmergencyExecutionInput,
    actorUserId?: string,
    ratifyDueAt?: Date,
  ): Promise<ApprovalRequestRecord> {
    if (typeof requestOrInput === "string") {
      if (!actorUserId) {
        throw approvalError("INVALID_EMERGENCY_ACTOR", "Emergency actor is required");
      }
      return this.transactionRunner(async (transaction) => {
        const request = await this.getRequest(transaction, requestOrInput);
        this.assertHumanActor(actorUserId);
        await this.assertBaseVersion(transaction, request);
        if (this.options.applyPatch && isPatch(request.payloadDiffJson)) {
          await this.options.applyPatch(transaction, request);
        }
        if (this.options.execute) {
          await this.options.execute(transaction, request, actorUserId);
        }
        return transaction.approvalRequest.update({
          where: { id: request.id },
          data: {
            mode: "EMERGENCY_RATIFICATION",
            ratifyDueAt: ratifyDueAt ?? request.ratifyDueAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
            state: "EXECUTED",
          },
        });
      });
    }
    const input = requestOrInput;
    if (!input.subjectType || !input.subjectId || !input.makerUserId) {
      throw approvalError("INVALID_EMERGENCY_REQUEST", "Emergency request requires subject and maker");
    }
    this.assertHumanActor(input.makerUserId);
    const request = await this.proposeApproval({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      makerUserId: input.makerUserId,
      payloadDiff: input.payloadDiff,
      baseVersion: input.baseVersion,
      mode: "EMERGENCY_RATIFICATION",
      ratifyDueAt: input.ratifyDueAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
      riskAcceptanceNote: input.riskAcceptanceNote,
    });
    return this.emergencyExecuteWithRatification(request.id, input.makerUserId, input.ratifyDueAt);
  }

  async ratifyEmergencyRequest(
    requestId: string,
    checkerUserId: string,
    note?: string,
  ): Promise<ApprovalRequestRecord> {
    this.assertChecker(checkerUserId);
    return this.transactionRunner(async (transaction) => {
      const request = await this.getRequest(transaction, requestId);
      if (request.mode !== "EMERGENCY_RATIFICATION") {
        throw approvalError("NOT_EMERGENCY_REQUEST", "Approval request is not in emergency ratification mode");
      }
      if (request.makerUserId === checkerUserId) {
        throw approvalError("MAKER_CHECKER_SEPARATION", "Emergency ratifier must differ from maker", 403);
      }
      if (request.ratifyDueAt && request.ratifyDueAt.getTime() < Date.now()) {
        throw approvalError("EMERGENCY_RATIFICATION_EXPIRED", "Emergency ratification window has expired", 409);
      }
      return transaction.approvalRequest.update({
        where: { id: requestId },
        data: {
          checkerUserId: checkerUserId,
          riskAcceptanceNote: note ?? request.riskAcceptanceNote ?? null,
        },
      });
    });
  }

  private assertChecker(checkerUserId: string): void {
    if (!checkerUserId) {
      throw approvalError("INVALID_APPROVAL_CHECKER", "Checker user ID is required");
    }
    this.assertHumanActor(checkerUserId);
  }

  private assertHumanActor(actorUserId: string): void {
    if (actorUserId === SYSTEM_AUTOMATION) {
      throw approvalError("SYSTEM_AUTOMATION_CANNOT_CHECK", "SYSTEM_AUTOMATION cannot approve or check requests", 403);
    }
  }

  private assertPending(request: ApprovalRequestRecord): void {
    if (request.state !== "PENDING_REVIEW" && request.state !== "APPROVED") {
      throw approvalError("APPROVAL_NOT_PENDING", "Approval request is not pending review", 409);
    }
    if (request.expiresAt && request.expiresAt.getTime() < Date.now()) {
      throw approvalError("APPROVAL_EXPIRED", "Approval request has expired", 409);
    }
  }

  private async assertBaseVersion(
    transaction: ApprovalPrismaClient,
    request: ApprovalRequestRecord,
  ): Promise<void> {
    if (request.baseVersion === null || request.baseVersion === undefined) {
      return;
    }
    const current = this.options.getCurrentVersion
      ? await this.options.getCurrentVersion(transaction, request)
      : request.currentVersion;
    if (current === null || current === undefined) {
      throw approvalError("BASE_VERSION_UNAVAILABLE", "Current subject version could not be verified", 409);
    }
    if (String(current) !== String(request.baseVersion)) {
      throw approvalError(
        "BASE_VERSION_MISMATCH",
        `Approval base version ${request.baseVersion} does not match current version ${String(current)}`,
        409,
      );
    }
  }

  private async getRequest(transaction: ApprovalPrismaClient, requestId: string): Promise<ApprovalRequestRecord> {
    const request = await transaction.approvalRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      throw approvalError("APPROVAL_NOT_FOUND", `Approval request '${requestId}' does not exist`, 404);
    }
    return request;
  }
}
