import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  run: vi.fn<() => Promise<'stored'>>(),
  close: vi.fn<() => Promise<void>>(),
}));

vi.mock('@workout/server-coaching/runner', () => ({
  runOneCoachingJob: fixture.run,
  createDeterministicFixtureAdapter: vi.fn(() => ({})),
}));
vi.mock('@workout/server-persistence/database', () => ({
  createDatabase: vi.fn(() => ({ close: fixture.close })),
}));
vi.mock('@workout/server-persistence/coaching-runs', () => ({
  createCoachingRunWorkerStore: vi.fn(() => ({})),
}));
vi.mock('../src/config.js', () => ({
  parseFixtureWorkerConfig: vi.fn(() => ({
    athleteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    connectionString: 'redacted',
    policy: { id: 'running-core-v2-training', version: '1' },
    source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
  })),
}));

const originalRelease = process.env['WORKOUT_RELEASE'];
const originalExitCode = process.exitCode;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  fixture.run.mockReset();
  fixture.close.mockReset();
  if (originalRelease === undefined) delete process.env['WORKOUT_RELEASE'];
  else process.env['WORKOUT_RELEASE'] = originalRelease;
  process.exitCode = originalExitCode;
});

describe('coaching fixture worker log boundary', () => {
  it('emits only a bounded result, a trace id, and a validated release', async () => {
    process.env['WORKOUT_RELEASE'] = 'release-42';
    fixture.run.mockResolvedValue('stored');
    fixture.close.mockResolvedValue();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await import('../src/start.js');

    expect(errors).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledOnce();
    const event: unknown = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(event).toEqual({
      kind: 'coaching_fixture_worker_result',
      result: 'stored',
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/),
      version: 'release-42',
    });
  });

  it('keeps thrown evidence and an invalid release out of the failure event', async () => {
    process.env['WORKOUT_RELEASE'] = 'secret token with spaces';
    fixture.run.mockRejectedValue(new Error('secret token and private evidence'));
    fixture.close.mockResolvedValue();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await import('../src/start.js');

    expect(output).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledOnce();
    expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toEqual({
      kind: 'coaching_fixture_worker_failed',
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/),
      version: 'unreleased',
    });
    expect(String(errors.mock.calls[0]?.[0])).not.toContain('secret');
    expect(process.exitCode).toBe(1);
  });
});
