import AutoImport from "unplugin-auto-import/vite";
import VueRouter from "unplugin-vue-router/vite";
import Layouts from "vite-plugin-vue-layouts-next";
import Components from "unplugin-vue-components/vite";
import Fonts from "unplugin-fonts/vite";

import { fileURLToPath, URL } from "node:url";

import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import { VueRouterAutoImports } from "unplugin-vue-router";
import Vuetify, { transformAssetUrls } from "vite-plugin-vuetify";

import { VuetifyResolver } from "unplugin-vue-components/resolvers";

// https://vite.dev/config/
export default ({ mode }: any) => {
    process.env = { ...process.env, ...loadEnv(mode, process.cwd()) };
    return defineConfig({
        plugins: [
            vue({
                template: { transformAssetUrls },
            }),

            // IMPORTANT: put Components BEFORE vueJsx() so it can transform TSX/JSX usage
            Components({
                dirs: ["src/components"],
                extensions: ["vue", "tsx", "jsx"], // include jsx too
                deep: true,
                dts: "src/components.d.ts",
                // make sure plugin also scans TSX/JSX files for usage
                include: [/\.vue$/, /\.vue\?vue/, /\.jsx?$/, /\.tsx?$/],
                resolvers: [
                    // auto-import Vuetify components if you want that as well
                    VuetifyResolver(),
                ],
            }),

            Layouts(),
            vueJsx(),
            AutoImport({
                imports: ["vue", VueRouterAutoImports],
                eslintrc: {
                    enabled: true,
                },
                vueTemplate: true,
                dts: "src/auto-imports.d.ts",
            }),
            VueRouter({
                dts: "src/typed-router.d.ts",
            }),
            Vuetify({
                autoImport: true,
                styles: {
                    configFile: "src/styles/settings.scss",
                },
            }),

            Fonts({
                fontsource: {
                    families: [
                        {
                            name: "Roboto",
                            weights: [100, 300, 400, 500, 700, 900],
                            styles: ["normal", "italic"],
                        },
                    ],
                },
            }),
        ],
        optimizeDeps: {
            exclude: [
                "vuetify",
                "vue-router",
                "unplugin-vue-router/runtime",
                "unplugin-vue-router/data-loaders",
                "unplugin-vue-router/data-loaders/basic",
            ],
        },
        define: { "process.env": {} },
        resolve: {
            alias: {
                "@": fileURLToPath(new URL("./src", import.meta.url)),
            },
        },

        server: {
            proxy: {
                "/api": {
                    target: process.env.VITE_API_URL || "http://localhost:4101",
                    changeOrigin: true,
                },
            },
            port: 5101,
            allowedHosts: [String(process.env.VITE_MY_TAILSCALE)],
        },

        css: {
            preprocessorOptions: {
                sass: {
                    api: "modern-compiler",
                },
                scss: {
                    api: "modern-compiler",
                },
            } as any,
        },
    });
};
