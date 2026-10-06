import { describe, expect, it, vi } from 'vitest';
import { AppConsentRequiredError } from '@workout/server-persistence/app-admission';
import { PersistenceConflict } from '@workout/server-persistence/repositories';
import { command } from '../src/product-boundary.js';

describe('product app admission error boundary', () => {
  it('returns a committed result without translating it', async () => {
    const translate = vi.fn(() => undefined);
    const result = { revision: 1 };
    expect(await command(async () => result, translate)).toBe(result);
    expect(translate).not.toHaveBeenCalled();
  });

  it('maps a genuine app admission refusal to the stable sanitized conflict', async () => {
    const translate = vi.fn(() => undefined);
    await expect(
      command(async () => {
        throw new AppConsentRequiredError();
      }, translate),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'APP_CONSENT_REQUIRED',
      message: 'APP_CONSENT_REQUIRED',
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it('preserves the idempotency conflict returned before a fresh admission check', async () => {
    await expect(
      command(
        async () => {
          throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
        },
        () => undefined,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('does not trust a lookalike error code or convert an unrelated database failure', async () => {
    const failure = Object.assign(new Error('synthetic database failure'), {
      code: 'APP_CONSENT_REQUIRED',
    });
    const translate = vi.fn(() => undefined);
    await expect(
      command(async () => {
        throw failure;
      }, translate),
    ).rejects.toBe(failure);
    expect(translate).toHaveBeenCalledWith(failure);
  });
});
