import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);
