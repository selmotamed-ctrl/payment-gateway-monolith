/**
 * The execution plane of a core process.
 *
 * Live and Sandbox are separated by PROCESS and DATABASE, not by a column:
 * `pg-core-back` runs with `EXECUTION_PLANE=LIVE` against
 * `payment_gateway_prod`, while `pg-core-sandbox` runs with
 * `EXECUTION_PLANE=SANDBOX` against `payment_gateway_sandbox`. The plane is
 * therefore a property of the running process, never of a merchant status.
 *
 * `getExecutionPlane` fails closed: an unset or invalid value is `LIVE` (the
 * production default), while an explicitly invalid value aborts the process
 * at boot through the environment schema.
 */
export type ExecutionPlane = "LIVE" | "SANDBOX";

const parsePlane = (raw: string | undefined): ExecutionPlane => {
  const normalized = String(raw ?? "LIVE")
    .trim()
    .toUpperCase();
  if (normalized === "LIVE" || normalized === "SANDBOX") {
    return normalized;
  }
  throw new Error(
    `FATAL_CONFIG_ERROR: EXECUTION_PLANE must be 'LIVE' or 'SANDBOX' (received '${normalized}')`,
  );
};

export const getExecutionPlane = (): ExecutionPlane =>
  parsePlane(process.env.EXECUTION_PLANE);

export const isSandboxPlane = (): boolean => getExecutionPlane() === "SANDBOX";
export const isLivePlane = (): boolean => getExecutionPlane() === "LIVE";

/** The API token prefix of the plane (`pg_live_` or `pg_test_`). */
export const accessTokenPrefixForPlane = (plane: ExecutionPlane = getExecutionPlane()): string =>
  plane === "SANDBOX" ? "pg_test_" : "pg_live_";

/** True when `token` belongs to the given plane (or is not a plane-tagged API token). */
export const tokenMatchesPlane = (
  token: string,
  plane: ExecutionPlane = getExecutionPlane(),
): boolean => {
  if (token.startsWith("pg_test_")) return plane === "SANDBOX";
  if (token.startsWith("pg_live_")) return plane === "LIVE";
  return true;
};
