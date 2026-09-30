import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 集成测试需要启动真实浏览器，超时放宽。
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
