import { afterEach, expect, it, vi } from 'vitest';
import { accountExportV38Schema, parseAccountExportV39 } from '@workout/contracts/operations';
import type { OperationsRepository } from '@workout/server-persistence/operations';
import { createApi } from '../src/app.js';

const at = '2026-10-10T00:00:00.000001Z';
const headers = {
  cookie: 'session=synthetic',
  origin: 'https://app.example',
  'x-workout-session-id': 'synthetic-session',
  'x-csrf-token': 'a'.repeat(32),
};
const apps: ReturnType<typeof createApi>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function artifact(athleteId: string) {
  const empty = Object.fromEntries(
    Object.keys(accountExportV38Schema.shape.data.shape).map((key) => [key, []]),
  );
  return parseAccountExportV39({
    schemaVersion: 39,
    athleteId,
    exportedAt: at,
    data: {
      ...empty,
      sourceProvenanceCoverage: 'saved_safe_dependency_facts',
      sourceAuthentication: 'not_authenticated',
      originalEventAuthentication: 'not_authenticated',
      galleryAlbums: [],
      galleryAlbumMemberships: [],
      galleryCourseAssociations: [],
      galleryAlbumDeletions: [],
    },
  });
}
it.each(['synthetic-owner', 'synthetic-other'])(
  'serves V39 only for the authenticated owner: %s',
  async (returnedOwner) => {
    const exported = artifact(returnedOwner);
    const operations: OperationsRepository = {
      exportAccount: vi.fn(async () => exported),
      eraseAccount: async () => ({ erased: true }),
      status: async () => ({
        checkedAt: at,
        outbox: { pending: 0, leased: 0, retrying: 0, completed: 0 },
        providers: { garmin: 'not_connected', healthkit: 'not_connected' },
        audit: [],
      }),
    };
    const app = createApi({
      auth: {
        authenticate: async () => ({
          athleteId: 'synthetic-owner',
          sessionId: 'synthetic-session',
          method: 'cookie',
          csrfToken: headers['x-csrf-token'],
        }),
      },
      consent: { getConsent: vi.fn(), setConsent: vi.fn() },
      operations,
      allowedOrigins: ['https://app.example'],
    });
    apps.push(app);
    const result = await app.inject({ method: 'POST', url: '/bff/v1/operations/export', headers });
    expect(operations.exportAccount).toHaveBeenCalledExactlyOnceWith('synthetic-owner');
    expect(result.headers['cache-control']).toBe('no-store');
    if (returnedOwner === 'synthetic-owner') {
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual(exported);
      expect(result.headers['content-disposition']).toContain('workout-account.json');
    } else {
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({ error: { code: 'EXPORT_SCOPE_MISMATCH' } });
      expect(result.body).not.toContain('galleryAlbums');
      expect(result.body).not.toContain('synthetic-other');
    }
  },
);
