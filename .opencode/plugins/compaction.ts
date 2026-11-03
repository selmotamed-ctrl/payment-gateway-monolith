import { readFileSync } from "node:fs";
import { join } from "node:path";

export default async ({ directory }: { directory?: string }) => {
  const root = directory ?? process.cwd();
  const fallback = `
## PROJECT CONTINUATION CONTEXT
This is the multi-rail payment gateway monorepo. The canonical design is in project-design/: read project-design/INDEX.md, project-design/STATUS.md and the relevant project-design/parts/** file before changing behavior. design/** is historical/reference only.

Before changing behavior, re-read:
- AGENTS.md
- project-design/INDEX.md and the relevant part
- core-back/prisma/schema.prisma and core-back/prisma/migrations/**
- core-back/lib/storageEngine/** and core-back/engine/**
- deploy/deploy.ts, deploy/lib/configSchema.ts, deploy/lib/hostPlanner.ts, deploy/provisioners/**
- the relevant service README and tests

Never guess contracts. Money uses Decimal, sensitive actions use maker-checker, secrets stay in core, and every state change is audited. Any behavior/API/schema/env/deploy/UI/test change must update the affected project-design part and project-design/TRACKER.md in the same change. Never hand-edit generated design files. Preserve the current task, decisions, changed files, migrations, verification results and remaining steps.
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
