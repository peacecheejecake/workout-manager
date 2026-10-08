import { expect, it } from 'vitest';
import { parseIdentityRuntimeProfile } from '../../../scripts/fixtures/identity-runtime-profile.js';
const normal = {
  raceResultsV2: undefined,
  raceManualPublic: undefined,
  checkInTemplates: undefined,
};
it('keeps the historical default and staged compositions independent', () => {
  expect(parseIdentityRuntimeProfile(normal)).toEqual({
    stageRaceResults: false,
    stageCheckInTemplates: false,
    stageRaceManualPublic: false,
    installedRuntime: false,
    installedCurrentRuntime: false,
    enableRaceResultsV2: false,
    enableRaceManualPublic: false,
    enableCheckInTemplates: false,
  });
  expect(
    parseIdentityRuntimeProfile({
      ...normal,
      raceManualPublic: 'staged-manual',
      raceResultsV2: 'staged-108-111',
    }),
  ).toMatchObject({
    stageRaceManualPublic: true,
    stageRaceResults: true,
    installedRuntime: false,
    enableRaceResultsV2: true,
    enableRaceManualPublic: true,
  });
  expect(parseIdentityRuntimeProfile({ ...normal, checkInTemplates: 'staged-123' })).toMatchObject({
    stageCheckInTemplates: true,
    enableCheckInTemplates: true,
    installedRuntime: false,
  });
});
it('installed-runtime explicitly enables all installed public families without any raw staging', () => {
  expect(parseIdentityRuntimeProfile({ ...normal, raceManualPublic: 'installed-runtime' })).toEqual(
    {
      stageRaceResults: false,
      stageCheckInTemplates: false,
      stageRaceManualPublic: false,
      installedRuntime: true,
      installedCurrentRuntime: false,
      enableRaceResultsV2: true,
      enableRaceManualPublic: true,
      enableCheckInTemplates: true,
    },
  );
});
it('profile22 is a separate installed path with all public families and no raw stages', () => {
  expect(
    parseIdentityRuntimeProfile({ ...normal, raceManualPublic: 'installed-current-profile22' }),
  ).toEqual({
    stageRaceResults: false,
    stageCheckInTemplates: false,
    stageRaceManualPublic: false,
    installedRuntime: false,
    installedCurrentRuntime: true,
    enableRaceResultsV2: true,
    enableRaceManualPublic: true,
    enableCheckInTemplates: true,
  });
});
it.each([
  { raceResultsV2: 'staged-108-111' },
  { checkInTemplates: 'staged-123' },
  { raceResultsV2: 'staged-108-111', checkInTemplates: 'staged-123' },
])('rejects current profile22/raw overlap before startup: %j', (overlap) => {
  expect(() =>
    parseIdentityRuntimeProfile({
      ...normal,
      ...overlap,
      raceManualPublic: 'installed-current-profile22',
    }),
  ).toThrow('IDENTITY_RUNTIME_PROFILE_CONFLICT');
});
it.each([
  'installed-current-profile21',
  'installed-current-profile23',
  ' installed-current-profile22',
  'installed-current-profile22 ',
  ['installed-runtime', 'installed-current-profile22'],
  { installedRuntime: true, installedCurrentRuntime: true },
])('rejects ambiguous or unsupported installed selectors %j', (raw) => {
  expect(() => parseIdentityRuntimeProfile({ ...normal, raceManualPublic: raw })).toThrow(
    'IDENTITY_RACE_MANUAL_STAGE_INVALID',
  );
});
it.each([
  { raceResultsV2: 'staged-108-111' },
  { checkInTemplates: 'staged-123' },
  { raceResultsV2: 'staged-108-111', checkInTemplates: 'staged-123' },
])('rejects installed/raw overlapping DDL before startup: %j', (overlap) => {
  expect(() =>
    parseIdentityRuntimeProfile({ ...normal, ...overlap, raceManualPublic: 'installed-runtime' }),
  ).toThrow('IDENTITY_RUNTIME_PROFILE_CONFLICT');
});
it.each([
  '',
  true,
  null,
  1,
  {},
  ' installed-runtime',
  'installed-runtime ',
  'installed',
  'staged-127',
])('rejects malformed manual opt-in %j', (raw) => {
  expect(() => parseIdentityRuntimeProfile({ ...normal, raceManualPublic: raw })).toThrow(
    'IDENTITY_RACE_MANUAL_STAGE_INVALID',
  );
});
it.each(['', true, null, {}, 'installed-runtime', 'staged-108-111 '])(
  'preserves strict legacy result flag validation %j',
  (raw) => {
    expect(() => parseIdentityRuntimeProfile({ ...normal, raceResultsV2: raw })).toThrow(
      'IDENTITY_RACE_RESULT_STAGE_INVALID',
    );
  },
);
it.each(['', true, null, {}, 'installed-runtime', 'staged-123 '])(
  'preserves strict legacy template flag validation %j',
  (raw) => {
    expect(() => parseIdentityRuntimeProfile({ ...normal, checkInTemplates: raw })).toThrow(
      'IDENTITY_CHECKIN_TEMPLATE_STAGE_INVALID',
    );
  },
);
