import { expect, it } from 'vitest';
import { AppAdmissionBindingError } from '@workout/server-persistence/app-admission';
import { command, ProductRequestError } from '../src/product-boundary.js';

it.each(['APP_CONSENT_REQUIRED', 'STALE_APP_ADMISSION', 'APP_BINDING_UNAVAILABLE'] as const)(
  'returns a stable app binding conflict for %s',
  async (code) => {
    const pending = command(
      async () => {
        throw new AppAdmissionBindingError(code);
      },
      () => undefined,
    );
    await expect(pending).rejects.toBeInstanceOf(ProductRequestError);
    await expect(pending).rejects.toMatchObject({ statusCode: 409, code, message: code });
  },
);
