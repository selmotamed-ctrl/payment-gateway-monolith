import { ApiError } from "./error";

/**
 * Operating-status gates of the commerce entities.
 *
 * A freeze that does not freeze is a bug: every path that takes in a payment
 * (checkout intake, the attempt-creation guard, merchant/API link creation,
 * POS screens) asks these helpers, so the error codes are stable across them.
 *
 * `v38` removed the implicit "a not-yet-approved merchant is sandbox" fallback
 * (OD-10). Sandbox is a SEPARATE execution plane with its own database, so a
 * status is enforced identically on both planes: only `ACTIVE` may transact.
 * A merchant that is still `PENDING` on Live can train and integrate on the
 * Sandbox plane because its sandbox envelope is created as `ACTIVE`, never
 * because the Live status was reinterpreted.
 */
export type CommerceEnv = "LIVE" | "SANDBOX";

/** The execution plane an entity belongs to. Kept for call-site compatibility. */
export type CommerceEnvironment = CommerceEnv;

const ACTIVE = "ACTIVE";

const normalizeStatus = (status: unknown): string =>
  String(status ?? "")
    .trim()
    .toUpperCase();

export const isMerchantActive = (status: unknown): boolean =>
  normalizeStatus(status) === ACTIVE;

export const isApplicationActive = (
  status: unknown,
  _env?: CommerceEnvironment,
): boolean => normalizeStatus(status) === ACTIVE;

export const isWalletActive = (
  status: unknown,
  _env?: CommerceEnvironment,
): boolean => normalizeStatus(status) === ACTIVE;

export const assertMerchantActive = (status: unknown): void => {
  if (!isMerchantActive(status)) {
    throw new ApiError(409, "MERCHANT_NOT_ACTIVE", "The merchant is not active and can not take payments", {
      merchantStatus: normalizeStatus(status) || null,
    });
  }
};

export const assertApplicationActive = (status: unknown, _env?: CommerceEnv): void => {
  if (!isApplicationActive(status)) {
    throw new ApiError(409, "APPLICATION_NOT_ACTIVE", "The application is not active and can not accept payments", {
      applicationStatus: status ?? null,
    });
  }
};

export const assertWalletActive = (status: unknown, _env?: CommerceEnv): void => {
  if (!isWalletActive(status)) {
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
  merchantStatus?: unknown;
  applicationStatus: string | null | undefined;
  walletStatus: string | null | undefined;
  env?: CommerceEnv;
}): void => {
  if (input.merchantStatus !== undefined) {
    assertMerchantActive(input.merchantStatus);
  }
  assertApplicationActive(input.applicationStatus, input.env);
  assertWalletActive(input.walletStatus, input.env);
};
