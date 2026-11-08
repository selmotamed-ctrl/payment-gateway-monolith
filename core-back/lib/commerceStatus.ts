import { ApiError } from "./error";

/**
 * Operating-status gates of the commerce entities.
 *
 * A freeze that does not freeze is a bug: every path that takes in a payment
 * (checkout intake, the attempt-creation guard, merchant/API link creation,
 * POS screens) asks these helpers, so the error codes are stable across them.
 */
export type CommerceEnv = "LIVE" | "SANDBOX";

/**
 * SANDBOX traffic of a merchant that is not approved yet (OD-10) runs on
 * PENDING/DRAFT applications and PENDING wallets; a SUSPENDED/CLOSED
 * application and a FROZEN/CLOSED wallet are refused in both environments.
 */
const SANDBOX_APPLICATION_STATUSES = new Set(["ACTIVE", "PENDING", "DRAFT"]);
const SANDBOX_WALLET_STATUSES = new Set(["ACTIVE", "PENDING"]);

export const assertApplicationActive = (status: string | null | undefined, env: CommerceEnv = "LIVE"): void => {
  const allowed = env === "SANDBOX" ? SANDBOX_APPLICATION_STATUSES.has(String(status)) : status === "ACTIVE";
  if (!allowed) {
    throw new ApiError(409, "APPLICATION_NOT_ACTIVE", "The application is not active and can not accept payments", {
      applicationStatus: status ?? null,
    });
  }
};

export const assertWalletActive = (status: string | null | undefined, env: CommerceEnv = "LIVE"): void => {
  const allowed = env === "SANDBOX" ? SANDBOX_WALLET_STATUSES.has(String(status)) : status === "ACTIVE";
  if (!allowed) {
    throw new ApiError(409, "WALLET_NOT_ACTIVE", "The settlement wallet is not active and can not accept payments", {
      walletStatus: status ?? null,
    });
  }
};

export const assertPosTerminalActive = (status: string | null | undefined): void => {
  if (status !== "ACTIVE") {
    throw new ApiError(409, "POS_TERMINAL_NOT_ACTIVE", "The POS terminal is not active", {
      terminalStatus: status ?? null,
    });
  }
};

export const assertCommerceActive = (input: {
  applicationStatus: string | null | undefined;
  walletStatus: string | null | undefined;
  env?: CommerceEnv;
}): void => {
  assertApplicationActive(input.applicationStatus, input.env);
  assertWalletActive(input.walletStatus, input.env);
};
