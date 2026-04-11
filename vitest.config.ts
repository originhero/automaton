import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Day 2 hardening — test hygiene timeouts.
     *
     * testTimeout: any single test that takes more than 30s is broken.
     *   The median test in this suite runs in <100ms. A 30s limit is
     *   generous for DB transactions, async I/O with mocks, and even
     *   real Conway API stubs. Tests that need longer either have a
     *   hang (fix the hang), or should be an integration test run
     *   separately from the unit suite.
     *
     * teardownTimeout: 10s is enough for db.close(), server.close(),
     *   daemon.stop(), and any afterEach cleanup. A teardown that runs
     *   longer indicates a hung resource cleanup — fix the cleanup.
     *
     * See CONTRIBUTING.md "Test hygiene rules" for the 5 afterEach
     * conventions that prevent the kind of hang that these timeouts
     * exist to catch.
     */
    testTimeout: 30_000,
    teardownTimeout: 10_000,
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/__tests__/**",
        "src/types.ts",
        "node_modules/**",
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 55,
        lines: 60,
      },
      reporter: ["text", "text-summary", "json-summary"],
    },
  },
});
