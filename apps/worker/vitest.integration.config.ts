import { defineConfig } from 'vitest/config';

// Requires TEST_DATABASE_ADMIN_URL (disposable PostgreSQL 17) and FFmpeg/ffprobe 9.0.2.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    include: ['tests/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 180000,
  },
});
