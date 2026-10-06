import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@workout/modules-identity/healthkit-panel': fileURLToPath(
        new URL('../../../modules/identity/src/healthkit-panel.tsx', import.meta.url),
      ),
      '@workout/platform/native-bridge-client': fileURLToPath(
        new URL('../../../platform/src/native-bridge-client.ts', import.meta.url),
      ),
    },
  },
  build: { outDir: '/private/tmp/wm-m3-02n-selection-fixture', emptyOutDir: true },
});
