import { describe, expect, it, vi } from 'vitest';
import { AppAdmissionBindingError, requireAppBinding } from '../src/app-admission.js';
import type { Transaction } from '../src/database.js';

describe('app binding SQL boundary', () => {
  it.each(['evidence', 'run', 'candidate', 'integrated_candidate'] as const)(
    'binds the subject identifier as a parameter for %s',
    async (subject) => {
      const query = vi.fn<Transaction['query']>(async () => ({ rows: [], rowCount: 0 }));
      await requireAppBinding({ athleteId: 'synthetic', query }, subject, 'untrusted-subject');
      expect(query).toHaveBeenCalledWith(`SELECT public.require_${subject}_app_binding($1)`, [
        'untrusted-subject',
      ]);
    },
  );
  it.each(['APP_CONSENT_REQUIRED', 'STALE_APP_ADMISSION', 'APP_BINDING_UNAVAILABLE'] as const)(
    'translates an actual SQL gate failure %s into a bounded conflict',
    async (code) => {
      const failure = Object.assign(new Error(code), { code: 'P0001' });
      const transaction: Transaction = {
        athleteId: 'synthetic',
        query: async () => {
          throw failure;
        },
      };
      await expect(requireAppBinding(transaction, 'evidence', 'subject')).rejects.toMatchObject({
        code,
        message: code,
      });
      await expect(requireAppBinding(transaction, 'evidence', 'subject')).rejects.toBeInstanceOf(
        AppAdmissionBindingError,
      );
    },
  );
  it.each([
    new Error('STALE_APP_ADMISSION'),
    Object.assign(new Error('STALE_APP_ADMISSION'), { code: '42501' }),
    Object.assign(new Error('UNEXPECTED_PRIVATE_SQL_ERROR'), { code: 'P0001' }),
  ])('preserves unknown or incorrectly classified failures for rollback', async (failure) => {
    const transaction: Transaction = {
      athleteId: 'synthetic',
      query: async () => {
        throw failure;
      },
    };
    await expect(requireAppBinding(transaction, 'candidate', 'subject')).rejects.toBe(failure);
  });
});
