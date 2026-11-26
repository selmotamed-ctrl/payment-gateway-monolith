import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";
import vueJsx from "vue-jsx/vite";
import Vuetify from "vite-plugin-vuetify";

export default ({ mode }: any) => {
    process.env = { ...process.env, ...loadEnv(mode, process.cwd()) };
    return defineConfig({
        plugins: [
            vueJsx({ vapor: true }),
            Vuetify({ autoImport: false, styles: { configFile: "src/styles/settings.scss" } }),
        ],
        build: { assetsInlineLimit: 0 },
        optimizeDeps: { exclude: ["vuetify", "vue-router"] },
        define: { "process.env": {} },
        resolve: {
            alias: {
                "@": fileURLToPath(new URL("./src", import.meta.url)),
                "pagedjs-polyfill": fileURLToPath(
                    new URL("./node_modules/pagedjs/dist/paged.polyfill.min.js", import.meta.url),
                ),
            },
        },
        server: {
            proxy: { "/api": { target: process.env.VITE_API_URL || "http://localhost:4102", changeOrigin: true } },
            port: 5102,
            allowedHosts: [String(process.env.VITE_MY_TAILSCALE)],
        },
        css: { preprocessorOptions: { sass: { api: "modern-compiler" }, scss: { api: "modern-compiler" } } as any },
    });
};
