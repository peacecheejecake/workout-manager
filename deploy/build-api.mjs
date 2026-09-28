import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const api = resolve(root, 'apps/api');
const require = createRequire(resolve(api, 'package.json'));
const { build } = require('esbuild');
const parseHost = resolve(root, 'packages/server/track-storage/src/parse-host.ts');

const workspaceSources = {
  name: 'workspace-sources-and-parse-child',
  setup(bundler) {
    bundler.onResolve({ filter: /^@workout\// }, (args) => ({
      path: require.resolve(args.path, { paths: [args.resolveDir] }),
    }));
    bundler.onLoad({ filter: /parse-host\.ts$/ }, async (args) => {
      if (args.path !== parseHost) return undefined;
      const source = await readFile(args.path, 'utf8');
      const oldPath = "new URL('./parse-child.ts', import.meta.url)";
      if (source.split(oldPath).length !== 2) throw new Error('Parse child location changed');
      return {
        contents: source.replace(oldPath, "new URL('./parse-child.mjs', import.meta.url)"),
        loader: 'ts',
      };
    });
  },
};

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  plugins: [workspaceSources],
  logLevel: 'warning',
};

await build({
  ...shared,
  entryPoints: [resolve(api, 'src/start.ts')],
  outfile: resolve(api, 'dist/start.mjs'),
});
await build({
  ...shared,
  entryPoints: [resolve(root, 'packages/server/track-storage/src/parse-child.ts')],
  outfile: resolve(api, 'dist/parse-child.mjs'),
});
