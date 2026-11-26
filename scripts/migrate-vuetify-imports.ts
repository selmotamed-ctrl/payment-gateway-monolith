#!/usr/bin/env bun
/**
 * Rewrites Vuetify imports to the vael-ui compatibility layer and vue-echarts
 * to the Vapor EChart wrapper. Run from the repository root.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PORTALS = ["admin-front", "merchant-front", "checkout-front", "fake-rails-front"];
const SKIP = new Set(["plugins/vuetify.ts"]);

const walk = (dir: string, out: string[]): void => {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        const stat = statSync(path);
        if (stat.isDirectory()) walk(path, out);
        else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
    }
};

for (const portal of PORTALS) {
    const src = join(ROOT, portal, "src");
    const files: string[] = [];
    walk(src, files);
    for (const file of files) {
        const relative = file.slice(src.length + 1);
        if (SKIP.has(relative)) continue;
        let text = readFileSync(file, "utf8");
        const before = text;
        text = text.replace(/from "vuetify\/components"/g, 'from "@/components/vael/VuetifyShim"');
        text = text.replace(/from "vuetify\/labs\/VDateInput"/g, 'from "@/components/vael/VuetifyShim"');
        text = text.replace(/from "vuetify"/g, 'from "@/utils/vael-compat"');
        text = text.replace(/import VChart from "vue-echarts";/g, 'import { EChart as VChart } from "@/components/EChart";');
        text = text.replace(/import \{ VChart \} from "vue-echarts";/g, 'import { EChart as VChart } from "@/components/EChart";');
        if (text !== before) writeFileSync(file, text);
    }
    console.log(`migrated imports in ${portal}`);
}
