import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';
import { createBoundaryRule } from '../eslint/boundaries.mjs';

// Synthetic workspaces exercise manifest exports without adding fake product packages.
const root = mkdtempSync(path.join(tmpdir(), 'workout-boundaries-'));
const manifests = [
  ['apps/web', '@workout/web', { '.': './src/index.ts' }],
  [
    'packages/modules/activity',
    '@workout/activity',
    { '.': './src/index.ts', './list': './src/list.ts' },
  ],
  ['packages/modules/plan', '@workout/plan', { '.': './src/index.ts' }],
  ['packages/ui/controls', '@workout/controls', { '.': './src/index.ts' }],
  ['packages/experience/planner', '@workout/planner', { '.': './src/index.ts' }],
  [
    'packages/contracts',
    '@workout/contracts',
    {
      '.': { import: './src/index.ts' },
      './types/*': './src/types/*.ts',
      './types/private/*': null,
    },
  ],
  ['packages/platform', '@workout/platform', { '.': './src/index.ts' }],
  ['packages/api-client', '@workout/api-client', { '.': './src/index.ts' }],
  [
    'packages/shared',
    '@workout/shared',
    { './dates': './src/dates.ts', './units': './src/units.ts' },
  ],
  ['packages/server/domain', '@workout/domain', { '.': './src/index.ts' }],
  ['packages/server/persistence', '@workout/persistence', { '.': './src/index.ts' }],
];
for (const [directory, name, exports] of manifests) {
  mkdirSync(path.join(root, directory), { recursive: true });
  writeFileSync(path.join(root, directory, 'package.json'), JSON.stringify({ name, exports }));
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

const linter = new Linter({ cwd: root });
const config = [
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { architecture: { rules: { boundaries: createBoundaryRule(root) } } },
    rules: { 'architecture/boundaries': 'error' },
  },
];

function lint(directory, code, extension = 'ts') {
  return linter.verify(code, config, {
    filename: path.join(root, directory, `src/example.${extension}`),
  });
}

describe('architecture import boundaries', () => {
  it.each([
    ['apps/web', "import { list } from '@workout/activity/list';"],
    ['apps/web', "import { db } from '@workout/persistence';"],
    ['packages/modules/plan', "import { list } from '@workout/activity/list';"],
    ['packages/modules/plan', "import { schema } from '@workout/contracts/types/activity';"],
    ['packages/modules/plan', "import { local } from './local.js';"],
    ['packages/ui/controls', "import { schema } from '@workout/contracts';"],
    ['packages/server/domain', "import type { Activity } from '@workout/contracts';"],
    ['packages/server/domain', "import { date } from '@workout/shared/dates';"],
    ['packages/server/domain', "import { unit } from '@workout/shared/units';"],
    ['packages/modules/plan', "import { date } from '@workout/shared/dates';"],
    ['packages/shared', "import { unit } from './units.js';"],
    ['packages/server/persistence', "import { Pool } from 'pg';"],
    ['packages/server/persistence', "import { domain } from '@workout/domain';"],
  ])('allows public dependency %s: %s', (directory, code) => {
    expect(lint(directory, code)).toEqual([]);
  });

  it.each([
    ['packages/modules/plan', "import { x } from 'next/server';"],
    ['packages/modules/plan', "export * from 'next/navigation';"],
    ['packages/modules/plan', "const x = import('next/cache');"],
    ['packages/modules/plan', "const x = require('next/headers');"],
    ['packages/modules/plan', "type X = import('next/server').NextRequest;"],
    ['packages/modules/plan', "import x = require('next/server');"],
    ['packages/modules/plan', "import { x } from '@workout/activity/src/private';"],
    ['packages/modules/plan', "import { x } from '../../activity/src/private.js';"],
    ['packages/modules/plan', "import { x } from '@workout/contracts/types/private/secret';"],
    ['packages/modules/plan', "import { x } from '@workout/web';"],
    ['packages/ui/controls', "import { x } from '@workout/activity';"],
    ['packages/experience/planner', "import { x } from '@workout/domain';"],
    ['packages/contracts', "import { x } from '@workout/persistence';"],
    ['packages/platform', "import { x } from '@workout/controls';"],
    ['packages/api-client', "import { x } from 'pg';"],
    ['packages/modules/plan', "import { readFile } from 'node:fs';"],
    ['packages/modules/plan', "import { readFile } from 'fs/promises';"],
    ['packages/server/domain', "import { x } from 'react';"],
    ['packages/server/domain', "import { x } from 'fastify';"],
    ['packages/server/domain', "import { x } from '@workout/persistence';"],
    ['packages/server/domain', "import { x } from '@workout/api-client';"],
    ['packages/server/domain', "import { x } from 'node:fs';"],
    ['packages/shared', "import { x } from '@workout/persistence';"],
    ['packages/shared', "import { x } from '@workout/domain';"],
    ['packages/shared', "import { x } from '@workout/controls';"],
    ['packages/shared', "import { x } from '@workout/activity';"],
    ['packages/shared', "import { x } from '@workout/api-client';"],
    ['packages/shared', "import { x } from 'pg';"],
    ['packages/shared', "import { x } from 'node:fs';"],
    ['packages/shared', "import { x } from 'react';"],
    ['packages/shared', "import { x } from 'next/server';"],
    ['packages/shared', "import { x } from '../../server/persistence/src/private.js';"],
    ['packages/server/persistence', "import { x } from '@workout/activity';"],
    ['apps/web', "'use client'; import { x } from '@workout/persistence';"],
  ])('rejects forbidden dependency %s: %s', (directory, code) => {
    const messages = lint(directory, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ ruleId: 'architecture/boundaries', messageId: 'boundary' });
  });

  it('rejects computed imports whose target cannot be statically verified', () => {
    expect(lint('packages/modules/plan', 'const x = import(moduleName);')[0]).toMatchObject({
      messageId: 'computed',
    });
  });

  it('checks literal templates too', () => {
    expect(lint('packages/modules/plan', 'const x = import(`next/server`);')[0]).toMatchObject({
      messageId: 'boundary',
    });
  });

  it('enforces the client boundary in an app-owned TSX component', () => {
    const messages = lint(
      'apps/web',
      "'use client'; import { db } from '@workout/persistence'; export const View = () => <div />;",
      'tsx',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ ruleId: 'architecture/boundaries', messageId: 'boundary' });
  });

  it('allows app-owned server TSX composition to import server packages', () => {
    expect(
      lint(
        'apps/web',
        "import { db } from '@workout/persistence'; export const View = () => <div />;",
        'tsx',
      ),
    ).toEqual([]);
  });
});
