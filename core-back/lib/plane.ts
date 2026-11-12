import { env } from "./env";
import { ApiError } from "./error";
import { parseAllowedFakeHosts } from "../engine/apiConsumer/fakeRailsAllowlist";

export type ExecutionPlane = "LIVE" | "SANDBOX";

/**
 * The execution plane of this process. Unset is the historic single-process
 * development stack (no plane fence; both token prefixes are accepted).
 */
export const executionPlane = (): ExecutionPlane | null => env.EXECUTION_PLANE ?? null;

export const isSandboxPlane = (): boolean => executionPlane() === "SANDBOX";
export const isLivePlane = (): boolean => executionPlane() === "LIVE";

export const fakeRailsBaseUrl = (): string =>
  (env.FAKE_RAILS_PUBLIC_BASE_URL ?? "http://127.0.0.1:8444").replace(/\/+$/, "");

export const fakeRailsControlHeaders = (): Record<string, string> => ({
  "content-type": "application/json",
  "x-fake-rails-seeder-token": env.FAKE_RAILS_SEEDER_TOKEN ?? "",
});

const hostOf = (value: string): string | null => {
  try {
    return new URL(value).hostname.trim().toLowerCase().replace(/\.$/, "");
  } catch {
    // A bare host or a path-only URL still needs the Fake Rails path check.
    return null;
  }
};

export const isFakeRailsUrl = (value: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value.includes("/rails/");
  }
  const host = parsed.hostname.trim().toLowerCase().replace(/\.$/, "");
  const configuredHosts = new Set<string>();
  const baseHost = hostOf(env.FAKE_RAILS_PUBLIC_BASE_URL ?? "");
  if (baseHost) configuredHosts.add(baseHost);
  for (const entry of parseAllowedFakeHosts(env.FAKE_RAILS_ALLOWED_HOSTS)) {
    configuredHosts.add(entry.split(":")[0]!.replace(/\.$/, ""));
  }
  if (configuredHosts.has(host)) return true;
  return parsed.pathname.includes("/rails/");
};

/**
 * Process/network plane fence.
 *
 * - `LIVE` core must never call the Fake Rails emulator.
 * - `SANDBOX` core must never call a real partner switch.
 * - Unset (single-process development) keeps the historic behaviour.
 */
export const assertOutboundPlaneAllowed = (url: string): void => {
  const plane = executionPlane();
  if (!plane) return;
  const fake = isFakeRailsUrl(url);
  if (plane === "LIVE" && fake) {
    throw new ApiError(
      403,
      "FAKE_RAILS_FORBIDDEN_ON_LIVE_PLANE",
      "Fake Rails is forbidden on the Live production plane",
    );
  }
  if (plane === "SANDBOX" && !fake) {
    throw new ApiError(
      403,
      "LIVE_GATEWAY_FORBIDDEN_ON_SANDBOX_PLANE",
      "Live partner gateways are forbidden on the Sandbox plane; only the co-hosted Fake Rails emulator may be called",
    );
  }
};

/** Guard for the Fake Rails control/account APIs. */
export const assertFakeRailsControlAllowed = (): void => {
  if (isLivePlane() && env.ALLOW_FAKE_RAILS_HOSTS !== true) {
    throw new ApiError(
      403,
      "FAKE_RAILS_FORBIDDEN_ON_LIVE_PLANE",
      "Fake Rails control operations are strictly forbidden on the Live production plane",
    );
  }
};
