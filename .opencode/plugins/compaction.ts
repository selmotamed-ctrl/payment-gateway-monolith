import { readFileSync } from "node:fs";
import { join } from "node:path";

export default async ({ directory }: { directory?: string }) => {
  const root = directory ?? process.cwd();
  const fallback = `
## PROJECT CONTINUATION CONTEXT
This is the multi-rail payment gateway monorepo: core-back owns the database, KMS and domain logic; admin-back, merchant-back and checkout-back are mTLS-only edge BFFs; admin/merchant/checkout-front are Vue 3 + Vuetify SPAs; deploy/ is the multi-host deployment engine.

Before changing behavior, re-read:
- design/payment_gateway_final_design-v5.md
- design/payment-gateway-refined-design-v4.1.md
- design/payment_gateway_deployment_and_guides_architecture.md
- design/opencode_technical_delivery_design.md
- design/fixes/_0001_operator_cases.md
- core-back/prisma/schema.prisma and core-back/prisma/migrations/**
- core-back/api/internal/admin.ts and core-back/engine/**
- admin-back/api/protected/operations.ts
- admin-front/src/router/index.ts, constants/urlsMap, constants/env, components/Table, layouts/sections.tsx
- deploy/deploy.ts, deploy/lib/configSchema.ts, deploy/lib/hostPlanner.ts, deploy/templates/**

Never guess contracts. Money uses Decimal, sensitive actions use maker-checker, secrets stay in core, and every state change is audited. Preserve the current task, decisions, changed files, migrations, verification results and remaining steps. If a detail is missing, tell the resumed agent to re-read the relevant design/schema/code files before acting.
`;

  return {
    "experimental.session.compacting": async (
      _input: unknown,
      output: { context: string[]; prompt?: string },
    ) => {
      let context = fallback;
      try {
        context = readFileSync(join(root, ".opencode", "compaction-context.md"), "utf8");
      } catch {
        // Keep the fallback if the context file is unavailable.
      }
      output.context.push(context);
    },
  };
};
