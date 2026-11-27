import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";
import vueJsx from "vue-jsx/vite";

export default ({ mode }: { mode: string }) => {
  const loaded = loadEnv(mode, process.cwd());
  const backend = loaded.VITE_FAKE_RAILS_API || "http://127.0.0.1:4104";
  return defineConfig({
    plugins: [
      vueJsx({ vapor: true }),
    ],
    build: {
      assetsInlineLimit: 0,
    },
    resolve: {
            dedupe: ["vue", "@vue/runtime-vapor", "@vue/runtime-dom", "vue-router", "vue-i18n"],
            alias: {
                "@": fileURLToPath(new URL("./src", import.meta.url)),
                "vue-i18n": fileURLToPath(new URL("./node_modules/vue-i18n/dist/vue-i18n.mjs", import.meta.url)),
                "@pg/ui": fileURLToPath(new URL("../packages/ui/src", import.meta.url)),
            },
        },
    server: {
      port: 5104,
      // Same convention as the other portals: one extra hostname (LAN/Tailscale/Codespaces forwarded host).
      ...(loaded.VITE_MY_TAILSCALE ? { allowedHosts: [loaded.VITE_MY_TAILSCALE] } : {}),
      proxy: {
        "/portal-api": { target: backend, changeOrigin: true },
        "/rails": { target: backend, changeOrigin: true },
        "/sdk": { target: backend, changeOrigin: true },
        "/hosted": { target: backend, changeOrigin: true },
      },
    },
    css: {
      preprocessorOptions: {
        sass: { api: "modern-compiler" },
        scss: { api: "modern-compiler" },
      },
    },
  });
};
