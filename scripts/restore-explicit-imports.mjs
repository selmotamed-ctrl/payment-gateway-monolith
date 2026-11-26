#!/usr/bin/env node
/**
 * Restore explicit imports that used to be injected by unplugin-auto-import
 * and unplugin-vue-components. Run after vapor-codemod.mjs.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const portal = process.argv[2];
if (!portal) {
    console.error("usage: node scripts/restore-explicit-imports.mjs <frontend-dir>");
    process.exit(1);
}
const src = path.join(portal, "src");

const gitShow = (file) => {
    try {
        return execFileSync("git", ["show", `HEAD:${portal}/${file}`], { encoding: "utf8" });
    } catch {
        return "";
    }
};

const components = new Map();
for (const match of gitShow("src/components.d.ts").matchAll(
    /^\s+([A-Za-z_$][\w$]*): typeof import\('([^']+)'\)\['default'\]/gm,
)) {
    let file = match[2].replace(/^\.\//, "");
    if (file.endsWith(".vue")) file = file.replace(/\.vue$/, ".tsx");
    components.set(match[1], `@/${file.replace(/\.tsx$/, "")}`);
}

const autoImports = new Map();
for (const match of gitShow("src/auto-imports.d.ts").matchAll(
    /^\s+const ([A-Za-z_$][\w$]*): typeof import\('([^']+)'\)\[['"]([^'"]+)['"]\]/gm,
)) {
    autoImports.set(match[1], match[2]);
}

const vueNames = new Set([
    "computed", "createApp", "customRef", "defineAsyncComponent", "effectScope", "getCurrentInstance",
    "getCurrentScope", "h", "inject", "isProxy", "isReactive", "isReadonly", "isRef", "isShallow",
    "markRaw", "nextTick", "onActivated", "onBeforeMount", "onBeforeUnmount", "onDeactivated",
    "onMounted", "onScopeDispose", "onUnmounted", "onUpdated", "provide", "reactive", "readonly",
    "ref", "resolveComponent", "shallowReactive", "shallowRef", "toRaw", "toRef", "toRefs",
    "toValue", "triggerRef", "unref", "useAttrs", "useCssModule", "useCssVars", "useId",
    "useSlots", "useTemplateRef", "watch", "watchEffect", "watchPostEffect", "watchSyncEffect",
    "createSlot",
]);
const vueTypeNames = new Set([
    "Component", "ComponentPublicInstance", "ComputedRef", "DirectiveBinding", "ExtractDefaultPropTypes",
    "ExtractPropTypes", "ExtractPublicPropTypes", "InjectionKey", "PropType", "Ref", "ShallowRef",
    "Slot", "Slots", "VNode", "VNodeChild", "WritableComputedRef",
]);
const routerNames = new Set([
    "onBeforeRouteLeave", "onBeforeRouteUpdate", "useLink", "useRoute", "useRouter",
]);

const runTypecheck = () => {
    try {
        return execFileSync("bunx", ["vue-tsc", "--noEmit", "-p", "tsconfig.app.json"], {
            cwd: portal,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (error) {
        return `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
};

let rounds = 0;
while (rounds < 4) {
    rounds += 1;
    const output = runTypecheck();
    const missing = new Map();
    for (const match of output.matchAll(/^(.+?)\((\d+),\d+\): error TS(?:2304|2694): Cannot find name '([^']+)'|^(.+?)\((\d+),\d+\): error TS2694: Namespace 'globalThis' has no exported member '([^']+)'/gm)) {
        const file = match[1] ?? match[5];
        const name = match[3] ?? match[6];
        if (!file || !name) continue;
        if (!missing.has(file)) missing.set(file, new Set());
        missing.get(file).add(name);
    }
    if (!missing.size) break;

    for (const [file, names] of missing) {
        const full = path.join(portal, file);
        if (!fs.existsSync(full)) continue;
        let text = fs.readFileSync(full, "utf8");
        const vueValues = [];
        const vueTypes = [];
        const routerValues = [];
        const componentImports = [];
        for (const name of names) {
            if (components.has(name)) {
                componentImports.push(`import ${name} from "${components.get(name)}";`);
            } else if (vueTypeNames.has(name)) {
                vueTypes.push(name);
            } else if (vueNames.has(name) || autoImports.get(name) === "vue") {
                vueValues.push(name);
            } else if (routerNames.has(name) || autoImports.get(name) === "vue-router") {
                routerValues.push(name);
            } else if (name === "DCExpose") {
                vueTypes.push("DCExpose");
            }
        }

        const addToImport = (source, values, typeOnly = false) => {
            if (!values.length) return;
            const re = new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*["']${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'];?`);
            const match = text.match(re);
            if (match) {
                const existing = match[1].split(",").map((s) => s.trim()).filter(Boolean);
                for (const value of values) if (!existing.includes(value)) existing.push(value);
                text = text.replace(match[0], `import ${typeOnly ? "type " : ""}{ ${existing.join(", ")} } from "${source}";`);
            } else {
                text = `import ${typeOnly ? "type " : ""}{ ${values.join(", ")} } from "${source}";\n${text}`;
            }
        };

        addToImport("vue", vueValues);
        if (vueTypes.includes("DCExpose")) {
            vueTypes.splice(vueTypes.indexOf("DCExpose"), 1);
            addToImport("@/utils/dc", ["DCExpose"], true);
        }
        addToImport("vue", vueTypes, true);
        addToImport("vue-router", routerValues);
        if (componentImports.length) text = `${componentImports.join("\n")}\n${text}`;
        fs.writeFileSync(full, text);
    }
    console.log(`${portal}: round ${rounds}, fixed ${missing.size} files`);
}

console.log(`${portal}: components=${components.size}, autoImports=${autoImports.size}`);
