import { defineConfig } from "vitest/config";
import vueJsx from "vue-jsx/vite";
import { fileURLToPath, URL } from "node:url";

const VAPOR_BUNDLE = "./node_modules/vue/dist/vue.runtime-with-vapor.esm-browser.js";
const BROWSER_CONDITIONS = ["browser", "module", "import", "default", "development"];

export default defineConfig({
    plugins: [vueJsx({ vapor: true })],
    resolve: {
        // Vitest resolves SSR/node builds by default; point Vue and vael-ui at
        // the browser bundles so the Vapor runtime is present and no server
        // renderer is required.
        conditions: BROWSER_CONDITIONS,
        alias: [
            { find: /^vue$/, replacement: fileURLToPath(new URL(VAPOR_BUNDLE, import.meta.url)) },
            {
                find: /^@vue\/runtime-vapor$/,
                replacement: fileURLToPath(new URL(VAPOR_BUNDLE, import.meta.url)),
            },
        ],
        dedupe: ["vue", "@vue/runtime-dom", "@vue/runtime-vapor", "@vue/reactivity", "@vue/shared", "vue-i18n"],
    },
    ssr: {
        resolve: { conditions: BROWSER_CONDITIONS },
    },
    test: {
        environment: "jsdom",
        include: ["test/**/*.test.{ts,tsx}"],
        setupFiles: ["test/setup.ts"],
        server: {
            deps: {
                inline: ["vue", "@vue/runtime-vapor", "vue-jsx", "vael-ui"],
            },
        },
    },
});
