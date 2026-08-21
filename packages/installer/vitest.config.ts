import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": path.resolve(import.meta.dirname, "test-support/cloudflare-workers.ts"),
    },
  },
  test: {
    environment: "node",
    restoreMocks: true,
  },
});
