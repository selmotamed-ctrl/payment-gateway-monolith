import rateLimiter from "express-rate-limit";
import type { Request, RequestHandler, Response } from "express";
import { digestKeyPart, lazyLimiter, rateLimitKey } from "./clientIp";
import { env } from "./env";

/**
 * Per-account authentication limits.
 *
 * Both limiters count FAILED requests only (`skipSuccessfulRequests`), and the tight one is keyed on the
 * account AND the client address. The previous single limiter was keyed on the account alone and counted
 * every request, so anyone who knew a victim's email or phone could make the portal answer 429 to the
 * real owner with `AUTH_RATE_LIMIT_MAX` requests per window, from any address, without ever guessing a
 * password. Now one address can only exhaust its own budget for an account; guessing spread over many
 * addresses is still stopped by the account-wide ceiling (five times the per-address budget), and the
 * per-address limiter in front of both bounds a single source.
 *
 * An MFA `challengeId` is a secret capability, not a public identifier, so it keeps a single account-wide
 * key (nobody but the holder can spend its budget).
 */
export type AccountKey = { kind: "account" | "challenge"; value: string };

const limited = (_req: Request, res: Response): void => {
  res.status(429).json({
    code: "RATE_LIMITED",
    message: "Too many authentication attempts, please retry later",
  });
};

export const createAccountLimiters = (
  accountOf: (req: Request) => AccountKey | undefined,
): { perAddress: RequestHandler; ceiling: RequestHandler } => {
  const applies = (req: Request): boolean => req.method === "POST" && accountOf(req) !== undefined;
  const base = {
    windowMs: () => env.AUTH_RATE_LIMIT_WINDOW_MS,
    skipSuccessfulRequests: true,
    standardHeaders: false as const,
    legacyHeaders: false,
    handler: limited,
    validate: { keyGeneratorIpFallback: false },
  };
  const perAddress = lazyLimiter(() =>
    rateLimiter({
      ...base,
      windowMs: base.windowMs(),
      max: () => env.AUTH_RATE_LIMIT_MAX,
      skip: (req) => !applies(req),
      keyGenerator: (req) => {
        const account = accountOf(req)!;
        // A challenge is already unguessable and single-holder: one key regardless of the address.
        return account.kind === "challenge"
          ? `challenge:${digestKeyPart(account.value)}`
          : `account:${digestKeyPart(account.value)}|${rateLimitKey(req)}`;
      },
    }),
  );
  const ceiling = lazyLimiter(() =>
    rateLimiter({
      ...base,
      windowMs: base.windowMs(),
      max: () => env.AUTH_RATE_LIMIT_MAX * 5,
      skip: (req) => !applies(req) || accountOf(req)!.kind === "challenge",
      keyGenerator: (req) => `account-ceiling:${digestKeyPart(accountOf(req)!.value)}`,
    }),
  );
  return { perAddress, ceiling };
};
