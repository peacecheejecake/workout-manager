import path from 'node:path';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createConfig } from '../eslint/index.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const linter = new Linter({ cwd: root });
const config = createConfig(root);

function lint(source, extension) {
  return linter.verify(source, config, {
    filename: path.join(root, `packages/tooling/tests/use-example.${extension}`),
  });
}

describe.each(['js', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'jsx'])(
  'React Hooks rules in .%s files',
  (extension) => {
    it('rejects conditional state hooks without JSX', () => {
      const messages = lint(
        `import { useState } from 'react';
         export function useExample(enabled) {
           if (enabled) return useState(0);
           return null;
         }`,
        extension,
      );
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: 'react-hooks/rules-of-hooks', severity: 2 }),
        ]),
      );
    });

    it('reports missing effect dependencies without JSX', () => {
      const messages = lint(
        `import { useEffect } from 'react';
         export function useExample(onChange) {
           useEffect(() => { onChange(); }, []);
         }`,
        extension,
      );
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: 'react-hooks/exhaustive-deps' }),
        ]),
      );
    });

    it('accepts unconditional hooks with complete effect dependencies', () => {
      expect(
        lint(
          `import { useEffect, useState } from 'react';
           export function useExample(onChange) {
             const [value, setValue] = useState(0);
             useEffect(() => { onChange(value); }, [onChange, value]);
             return { value, setValue };
           }`,
          extension,
        ),
      ).toEqual([]);
    });
  },
);
