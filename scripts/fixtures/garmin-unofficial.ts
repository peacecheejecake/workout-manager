import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Identity E2E fixture for the temporary unofficial Garmin collector (M1-06b-tmp).
 *
 * The owner is the fixture OIDC account "Carol" (no other spec signs in as Carol, so no
 * spec's account erasure can move her id). The harness pre-creates her account with this
 * fixed id and configures it as the collector's only owner. Garmin itself is the Python
 * worker's synthetic provider (`--fixture`), driven by a scenario file both the harness and
 * the spec can find through the run id: no live Garmin account is involved.
 */
export const unofficialOwner = {
  subject: 'carol',
  athleteId: '0c0c0c0c-0000-4000-8000-00000000ca01',
} as const;
export const unofficialAccounts = {
  mfa: { email: 'owner-mfa@example.test', password: 'synthetic-pass-mfa-1', code: '246810' },
  plain: { email: 'owner@example.test', password: 'synthetic-pass-plain-1' },
  otherProfile: { email: 'someone-else@example.test', password: 'synthetic-pass-other-1' },
} as const;
export const unofficialActivityIds = ['880001', '880002'] as const;

export function unofficialScenarioPath(): string {
  const runId = process.env['IDENTITY_E2E_RUN_ID'] ?? 'local';
  return join(tmpdir(), `workout-identity-garmin-unofficial-${runId}.json`);
}

/** The repository's `uv sync` interpreter (default install; the fixture needs no extra). */
export function unofficialPython(root: string): string | null {
  const candidate = process.env['WORKOUT_PYTHON'] ?? join(root, '.venv/bin/python');
  return existsSync(candidate) ? candidate : null;
}

export async function writeUnofficialScenario(
  overrides: Record<string, unknown> = {},
  now = new Date(),
): Promise<void> {
  const day = 86_400_000;
  const at = (daysAgo: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysAgo * day)
      .toISOString()
      .replace('.000Z', '+00:00');
  await writeFile(
    unofficialScenarioPath(),
    JSON.stringify({
      accounts: [
        {
          email: unofficialAccounts.mfa.email,
          password: unofficialAccounts.mfa.password,
          profileId: 1001,
          mfaCode: unofficialAccounts.mfa.code,
        },
        {
          email: unofficialAccounts.plain.email,
          password: unofficialAccounts.plain.password,
          profileId: 1001,
        },
        {
          email: unofficialAccounts.otherProfile.email,
          password: unofficialAccounts.otherProfile.password,
          profileId: 2002,
        },
      ],
      activities: {
        '1001': [
          {
            id: Number(unofficialActivityIds[0]),
            startedAt: at(3),
            sport: 'running',
            seconds: 1800,
            meters: 5000,
          },
          {
            id: Number(unofficialActivityIds[1]),
            startedAt: at(2),
            sport: 'cycling',
            seconds: 3600,
            meters: 20000,
          },
        ],
      },
      ...overrides,
    }),
    { mode: 0o600 },
  );
}
