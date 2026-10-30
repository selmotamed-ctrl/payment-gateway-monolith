import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../../lib/env";
import { ApiError, parseOrThrow } from "../../lib/error";
import { signJwt } from "../../lib/jwt";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(512),
});

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

const constantTimeEquals = (left: string, right: string): boolean => {
  const leftDigest = digest(left);
  const rightDigest = digest(right);
  return timingSafeEqual(leftDigest, rightDigest);
};

interface AttemptWindow {
  failures: number[];
}

const attempts = new Map<string, AttemptWindow>();

const isRateLimited = (ip: string): boolean => {
  const now = Date.now();
  const window = attempts.get(ip) ?? { failures: [] };
  window.failures = window.failures.filter((at) => now - at < env.FAKE_RAILS_PORTAL_RATE_WINDOW_MS);
  attempts.set(ip, window);
  return window.failures.length >= env.FAKE_RAILS_PORTAL_RATE_LIMIT;
};

const recordFailure = (ip: string): void => {
  const window = attempts.get(ip) ?? { failures: [] };
  window.failures.push(Date.now());
  attempts.set(ip, window);
};

const clearFailures = (ip: string): void => {
  attempts.delete(ip);
};

export const createAuthRouter = (): Router => {
  const router = Router();

  router.post("/login", (request, response) => {
    const ip = request.ip ?? "unknown";
    if (isRateLimited(ip)) {
      throw new ApiError(429, "TOO_MANY_ATTEMPTS", "Too many failed login attempts; try again later");
    }
    const body = parseOrThrow(loginSchema, request.body);
    const validUser = constantTimeEquals(body.username, env.FAKE_RAILS_ADMIN_USER);
    const validPassword = constantTimeEquals(body.password, env.FAKE_RAILS_ADMIN_PASSWORD);
    if (!validUser || !validPassword) {
      recordFailure(ip);
      throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid username or password");
    }
    clearFailures(ip);
    const token = signJwt(
      {
        sub: env.FAKE_RAILS_ADMIN_USER,
        role: "FAKE_RAILS_TESTER",
        allowInProduction: env.FAKE_RAILS_ALLOW_IN_PRODUCTION,
      },
      env.FAKE_RAILS_JWT_SECRET,
    );
    response.json({
      token,
      user: {
        username: env.FAKE_RAILS_ADMIN_USER,
        allowInProduction: env.FAKE_RAILS_ALLOW_IN_PRODUCTION,
        environment: env.NODE_ENV === "production" ? "PRODUCTION TEST SERVER" : "SANDBOX",
      },
    });
  });

  router.get("/me", (request, response) => {
    response.json({
      user: {
        username: request.tester?.sub,
        role: request.tester?.role,
        environment: env.NODE_ENV === "production" ? "PRODUCTION TEST SERVER" : "SANDBOX",
      },
    });
  });

  return router;
};
