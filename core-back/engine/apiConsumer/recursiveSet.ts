import { ApiError } from "../../lib/error";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const NUMBER_REGEX = /^[0-9]+$/;

function pathError(code: string, message: string): ApiError {
  return new ApiError(400, code, message);
}

function normalizePath(setter: string | readonly string[]): string[] {
  const rawList = typeof setter === "string" ? setter.split(".") : [...setter];
  if (rawList.length === 0 || rawList.some((segment) => typeof segment !== "string" || segment.length === 0)) {
    throw pathError("INVALID_PATH", "Setter path cannot be empty");
  }
  for (const segment of rawList) {
    if (FORBIDDEN_KEYS.has(segment)) {
      throw pathError("PROTOTYPE_POLLUTION_BLOCKED", `Forbidden path segment: ${segment}`);
    }
  }
  return rawList;
}

export function recursiveSet<T extends Record<string, unknown>>(
  object: T,
  setter: string | readonly string[],
  value: unknown,
): T {
  if (!object || typeof object !== "object") {
    throw pathError("INVALID_TARGET", "Setter target must be an object");
  }
  const path = normalizePath(setter);
  const lastSetter = path[path.length - 1] as string;
  let target: Record<string, unknown> = object as Record<string, unknown>;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index] as string;
    const nextKey = path[index + 1] as string;
    const existing = Object.hasOwn(target, key) ? target[key] : undefined;
    if (existing === undefined || existing === null || typeof existing !== "object") {
      target[key] = NUMBER_REGEX.test(nextKey) ? [] : {};
    }
    const next = target[key];
    if (!next || typeof next !== "object") {
      throw pathError("INVALID_PATH", `Path segment '${key}' cannot be traversed`);
    }
    target = next as Record<string, unknown>;
  }
  target[lastSetter] = value;
  return object;
}

export function recursiveSetImmutable<T extends Record<string, unknown>>(
  object: T,
  setter: string | readonly string[],
  value: unknown,
): T {
  const clone = structuredClone(object);
  return recursiveSet(clone, setter, value);
}
