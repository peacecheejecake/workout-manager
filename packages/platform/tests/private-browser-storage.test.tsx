import { describe, expect, it } from 'vitest';
import {
  bindPrivateBrowserStorageAccount,
  clearPrivateBrowserStorage,
} from '../src/private-browser-storage';

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    port: {
      get length() {
        return values.size;
      },
      key(index: number) {
        return [...values.keys()][index] ?? null;
      },
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
      removeItem(key: string) {
        values.delete(key);
      },
    },
  };
}

describe('private browser storage account boundary', () => {
  it('clears only private keys on logout and on account change', () => {
    const { values, port } = storage();
    values.set('ordinary-preference', 'kept');
    expect(bindPrivateBrowserStorageAccount('athlete-a', port)).toBe(true);
    values.set('workout:private:supplementary:offline-sets:v1:athlete-a', 'sensitive');
    expect(bindPrivateBrowserStorageAccount('athlete-b', port)).toBe(true);
    expect(values.get('workout:private:supplementary:offline-sets:v1:athlete-a')).toBeUndefined();
    expect(values.get('workout:private:account-scope')).toBe('athlete-b');
    expect(values.get('ordinary-preference')).toBe('kept');
    expect(clearPrivateBrowserStorage(port)).toBe(true);
    expect([...values.keys()]).toEqual(['ordinary-preference']);
  });

  it('fails closed when old-account data cannot be removed', () => {
    const { values, port } = storage();
    values.set('workout:private:account-scope', 'athlete-a');
    values.set('workout:private:supplementary:offline-sets:v1:athlete-a', 'sensitive');
    const unavailable = {
      ...port,
      removeItem() {
        throw new Error('STORAGE_DENIED');
      },
    };
    expect(bindPrivateBrowserStorageAccount('athlete-b', unavailable)).toBe(false);
    expect(values.get('workout:private:account-scope')).toBe('athlete-a');
  });

  it('purges unknown private data when an account marker is missing', () => {
    const { values, port } = storage();
    values.set('workout:private:supplementary:offline-sets:v1:athlete-a', 'sensitive');
    expect(bindPrivateBrowserStorageAccount('athlete-b', port)).toBe(true);
    expect(values.has('workout:private:supplementary:offline-sets:v1:athlete-a')).toBe(false);
    expect(values.get('workout:private:account-scope')).toBe('athlete-b');
  });
});
