import { env } from "../../lib/env";
import { parseCidr } from "../../lib/net";
import { zIdentifier, zListQuery } from "../../lib/zReady";
import express from "express";
import { z } from "zod";
import { coreTokenCreateSchema, coreTokenIpsSchema } from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const tokenParamsSchema = z.object({ id: zIdentifier });

/** Lowercase `resource:action`; no wildcards, no free-form scopes. */
export const TOKEN_SCOPE_PATTERN = /^[a-z][a-z0-9_]{1,31}:[a-z][a-z0-9_]{1,31}$/;
const MIN_IPV4_PREFIX = 8;
const MIN_IPV6_PREFIX = 32;
const DAY_MS = 86_400_000;

/** A well formed ip or CIDR that is not an "allow everyone" range (0.0.0.0/0, ::/0, /1../7 ...). */
const zStrictCidr = z
  .string()
  .min(3)
  .max(64)
  .superRefine((value, ctx) => {
    const parsed = parseCidr(value);
    if (!parsed) {
      ctx.addIssue({ code: "custom", message: "must be a valid ip address or CIDR" });
      return;
    }
    const minimum = parsed.version === 4 ? MIN_IPV4_PREFIX : MIN_IPV6_PREFIX;
    if (parsed.prefix < minimum) {
      ctx.addIssue({ code: "custom", message: `CIDR is too broad (minimum prefix /${minimum})` });
    }
  });

const zStrictCidrList = z.array(zStrictCidr).max(64);

const tokenCreateSchema = z
  .object({
    name: z.string().min(2).max(120),
    scopes: z
      .array(z.string().regex(TOKEN_SCOPE_PATTERN, "scopes look like resource:action (lowercase, no wildcards)"))
      .min(1)
      .superRefine((scopes, ctx) => {
        if (scopes.length > env.TOKEN_MAX_SCOPES) {
          ctx.addIssue({ code: "custom", message: `at most ${env.TOKEN_MAX_SCOPES} scopes are allowed` });
        }
        if (new Set(scopes).size !== scopes.length) {
          ctx.addIssue({ code: "custom", message: "scopes must be unique" });
        }
      }),
    allowedCidrs: zStrictCidrList.optional(),
    expiresAt: z.string().max(64).optional(),
  })
  .strict()
  .transform((value, ctx) => {
    const now = Date.now();
    if (value.expiresAt === undefined) {
      return { ...value, expiresAt: new Date(now + env.TOKEN_DEFAULT_TTL_DAYS * DAY_MS).toISOString() };
    }
    const at = Date.parse(value.expiresAt);
    if (Number.isNaN(at) || !/^\d{4}-\d{2}-\d{2}T/.test(value.expiresAt)) {
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "must be an ISO 8601 date-time" });
      return z.NEVER;
    }
    if (at <= now) {
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "must be in the future" });
      return z.NEVER;
    }
    if (at > now + env.TOKEN_MAX_TTL_DAYS * DAY_MS) {
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: `must be within ${env.TOKEN_MAX_TTL_DAYS} days` });
      return z.NEVER;
    }
    return { ...value, expiresAt: new Date(at).toISOString() };
  });

const tokenIpsSchema = z
  .object({
    allowedCidrs: zStrictCidrList,
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/tokens",
    querySchema: zListQuery,
  }),
);

router.post(
  "/",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/tokens",
    schema: tokenCreateSchema,
    coreSchema: coreTokenCreateSchema,
    status: 201,
  }),
);

router.put(
  "/:id/ips",
  coreForward({
    method: "PUT",
    path: (context) => `/internal/merchant/tokens/${encodeURIComponent(context.params.id ?? "")}/ips`,
    paramsSchema: tokenParamsSchema,
    schema: tokenIpsSchema,
    coreSchema: coreTokenIpsSchema,
  }),
);

router.delete(
  "/:id",
  coreForward({
    method: "DELETE",
    path: (context) => `/internal/merchant/tokens/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: tokenParamsSchema,
  }),
);

export const tokensRouter = router;
