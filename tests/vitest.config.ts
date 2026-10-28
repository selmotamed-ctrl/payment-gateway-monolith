import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../admin-front/src", import.meta.url)),
    },
  },
  test: {
    include: ["unit/**/*.test.ts"],
    environment: "happy-dom",
  },
});
