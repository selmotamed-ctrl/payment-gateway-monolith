import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * OpenCode V2 plugin contract: the default export must be a definition with an
 * `id` and a `setup` function. The V1 shape (a default-exported factory
 * returning hooks) is rejected with "Plugin must export a default definition
 * with an id and an effect or setup function."
 *
 * Types are declared locally so the plugin loads without a node_modules tree;
 * `.opencode/node_modules` is gitignored, so a bare `@opencode/plugin` import
 * would fail on a fresh checkout.
 */
type SystemPart = { type: "text"; text: string };

type CompactionEvent = {
  readonly sessionID: string;
  readonly system: SystemPart[];
};

type HookRegistration = { dispose(): Promise<void> };

type PluginContext = {
  readonly location: { readonly directory: string };
  readonly session: {
    hook(
      name: "compaction",
      callback: (event: CompactionEvent) => void | Promise<void>,
    ): Promise<HookRegistration>;
  };
};

const FALLBACK_CONTEXT = `
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

export default {
  id: "project-compaction-context",
  async setup(ctx: PluginContext) {
    const root = ctx.location.directory;

    await ctx.session.hook("compaction", (event) => {
      let context = FALLBACK_CONTEXT;
      try {
        context = readFileSync(join(root, ".opencode", "compaction-context.md"), "utf8");
      } catch {
        // Keep the fallback if the context file is unavailable.
      }
      event.system.push({ type: "text", text: context });
    });
  },
};
