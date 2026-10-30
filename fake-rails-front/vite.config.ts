import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import Components from "unplugin-vue-components/vite";
import AutoImport from "unplugin-auto-import/vite";
import Vuetify, { transformAssetUrls } from "vite-plugin-vuetify";
import { VuetifyResolver } from "unplugin-vue-components/resolvers";

export default ({ mode }: { mode: string }) => {
  const loaded = loadEnv(mode, process.cwd());
  const backend = loaded.VITE_FAKE_RAILS_API || "http://127.0.0.1:4104";
  return defineConfig({
    plugins: [
      vue({ template: { transformAssetUrls } }),
      // Components must be registered BEFORE vueJsx() so TSX usage resolves.
      Components({
        dirs: ["src/components"],
        extensions: ["vue", "tsx", "jsx"],
        deep: true,
        dts: "src/components.d.ts",
        include: [/\.vue$/, /\.vue\?vue/, /\.jsx?$/, /\.tsx?$/],
        resolvers: [VuetifyResolver()],
      }),
      vueJsx(),
      AutoImport({
        imports: ["vue", "vue-router"],
        dts: "src/auto-imports.d.ts",
        vueTemplate: true,
      }),
      Vuetify({ autoImport: true, styles: { configFile: "src/styles/settings.scss" } }),
    ],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: {
      port: 5104,
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
