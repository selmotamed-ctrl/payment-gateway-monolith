import { client } from "../prisma/client";
import { getExecutionPlane, type ExecutionPlane } from "../lib/executionPlane";

export interface PlaneFenceClient {
  systemExecutionPlane: {
    findUnique(args: { where: { id: number } }): Promise<{
      id: number;
      plane: string;
      allowFakeRails: boolean;
    } | null>;
    create(args: {
      data: { id: number; plane: string; allowFakeRails: boolean };
    }): Promise<{ id: number; plane: string; allowFakeRails: boolean }>;
  };
}

export interface PlaneFenceOptions {
  db?: PlaneFenceClient;
  processEnv?: NodeJS.ProcessEnv;
  expectedPlane?: ExecutionPlane;
}

const fakeRailsEnabled = (processEnv: NodeJS.ProcessEnv): boolean =>
  String(processEnv.FAKE_RAILS_ENABLED ?? "false").trim().toLowerCase() === "true";

/**
 * Proves that this process is wired to the database of its execution plane
 * before it listens or starts a worker.
 *
 * The failure this prevents is silent and expensive: pointing
 * `pg-core-sandbox` at `payment_gateway_prod` (or the reverse) would let the
 * sandbox write Live wallets and journal lines. The check is a boot gate, so
 * a mismatched deployment crash-loops instead of mixing planes.
 */
export const verifyExecutionPlaneFenceOnBoot = async (
  options: PlaneFenceOptions = {},
): Promise<void> => {
  const processEnv = options.processEnv ?? process.env;
  const expectedPlane = options.expectedPlane ?? getExecutionPlane();
  const db = options.db ?? (client as unknown as PlaneFenceClient);
  const fakeRails = fakeRailsEnabled(processEnv);
  const allowFakeRailsOnLive =
    String(processEnv.PLANE_FENCE_ALLOW_FAKE_RAILS_ON_LIVE ?? "false").trim().toLowerCase() === "true";

  if (expectedPlane === "LIVE" && fakeRails && !allowFakeRailsOnLive) {
    throw new Error(
      "FATAL_PLANE_FENCE_VIOLATION: FAKE_RAILS_ENABLED=true is forbidden when EXECUTION_PLANE=LIVE "
        + "(the emulator belongs to the SANDBOX plane; set PLANE_FENCE_ALLOW_FAKE_RAILS_ON_LIVE=true only for a development deployment)",
    );
  }

  let row = await db.systemExecutionPlane.findUnique({ where: { id: 1 } });
  if (!row) {
    row = await db.systemExecutionPlane.create({
      data: {
        id: 1,
        plane: expectedPlane,
        allowFakeRails: expectedPlane === "SANDBOX",
      },
    });
  }

  if (row.plane !== expectedPlane) {
    throw new Error(
      `FATAL_PLANE_FENCE_VIOLATION: process started with EXECUTION_PLANE=${expectedPlane}, `
        + `but the connected database has system_execution_plane.plane=${row.plane}. `
        + "Refusing to boot to prevent Live/Sandbox cross-contamination.",
    );
  }

  if (expectedPlane === "LIVE" && row.allowFakeRails && !allowFakeRailsOnLive) {
    throw new Error(
      "FATAL_PLANE_FENCE_VIOLATION: system_execution_plane.allow_fake_rails is TRUE on the LIVE plane",
    );
  }
};
