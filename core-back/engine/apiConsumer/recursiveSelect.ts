import { ApiError } from "../../lib/error";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function pathError(code: string, message: string): ApiError {
  return new ApiError(400, code, message);
}

function normalizePath(selector: string | readonly string[]): string[] {
  const path = typeof selector === "string" ? selector.split(".") : [...selector];
  if (path.length === 0 || path.some((segment) => typeof segment !== "string" || segment.length === 0)) {
    throw pathError("INVALID_PATH", "Selector path cannot be empty");
  }
  for (const segment of path) {
    if (FORBIDDEN_KEYS.has(segment)) {
      throw pathError("PROTOTYPE_POLLUTION_BLOCKED", `Forbidden path segment: ${segment}`);
    }
  }
  return path;
}

export function recursiveSelect(target: unknown, selector: string | readonly string[]): unknown {
  const path = normalizePath(selector);
  let current = target;
  for (const segment of path) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    if (!Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export const recursiveSelectWithForLoop = recursiveSelect;
