import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const packageJson = JSON.parse(
    readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

const publicKeyPath = fileURLToPath(new URL("./public/content/public-key.txt", import.meta.url));
let pinnedPublicKey = "";
try {
    pinnedPublicKey = readFileSync(publicKeyPath, "utf8").trim();
} catch {
    pinnedPublicKey = "";
}

export default defineConfig({
    base: "./",
    plugins: [vue()],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(packageJson.version),
        "import.meta.env.VITE_COMPANION_CONTENT_PUBLIC_KEY": JSON.stringify(
            process.env.VITE_COMPANION_CONTENT_PUBLIC_KEY ?? pinnedPublicKey,
        ),
        "import.meta.env.VITE_COMPANION_UPDATE_URL": JSON.stringify(
            process.env.VITE_COMPANION_UPDATE_URL ?? "",
        ),
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        sourcemap: false,
        target: "es2020",
        chunkSizeWarningLimit: 900,
    },
    server: {
        port: 5180,
        host: "127.0.0.1",
    },
});
