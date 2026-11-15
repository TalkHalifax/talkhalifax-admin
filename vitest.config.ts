import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The admin Worker's unit tests, in the Workers runtime. No database and no platform: each test passes its own PLATFORM
// stand-in. What the platform's AdminApi answers is the platform's to test, in the public repo.
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./test/wrangler.unit.jsonc" },
    remoteBindings: false,
  })],
  test: { include: ["test/unit/**/*.test.ts"], unstubGlobals: true },
});
