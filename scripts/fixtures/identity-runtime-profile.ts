/** Disposable identity acceptance composition only. These modes describe which
 * real installer/fixture path runs; they are not production readiness evidence. */
export function parseIdentityRuntimeProfile(input: {
  raceResultsV2: unknown;
  raceManualPublic: unknown;
  checkInTemplates: unknown;
}) {
  if (input.raceResultsV2 !== undefined && input.raceResultsV2 !== 'staged-108-111')
    throw new Error('IDENTITY_RACE_RESULT_STAGE_INVALID');
  if (input.checkInTemplates !== undefined && input.checkInTemplates !== 'staged-123')
    throw new Error('IDENTITY_CHECKIN_TEMPLATE_STAGE_INVALID');
  if (
    input.raceManualPublic !== undefined &&
    input.raceManualPublic !== 'staged-manual' &&
    input.raceManualPublic !== 'installed-runtime' &&
    input.raceManualPublic !== 'installed-current-profile22'
  )
    throw new Error('IDENTITY_RACE_MANUAL_STAGE_INVALID');
  const stageRaceResults = input.raceResultsV2 === 'staged-108-111';
  const stageCheckInTemplates = input.checkInTemplates === 'staged-123';
  const stageRaceManualPublic = input.raceManualPublic === 'staged-manual';
  const installedRuntime = input.raceManualPublic === 'installed-runtime';
  const installedCurrentRuntime = input.raceManualPublic === 'installed-current-profile22';
  if ((installedRuntime || installedCurrentRuntime) && (stageRaceResults || stageCheckInTemplates))
    throw new Error('IDENTITY_RUNTIME_PROFILE_CONFLICT');
  return {
    stageRaceResults,
    stageCheckInTemplates,
    stageRaceManualPublic,
    installedRuntime,
    installedCurrentRuntime,
    enableRaceResultsV2: stageRaceResults || installedRuntime || installedCurrentRuntime,
    enableRaceManualPublic: stageRaceManualPublic || installedRuntime || installedCurrentRuntime,
    enableCheckInTemplates: stageCheckInTemplates || installedRuntime || installedCurrentRuntime,
  };
}
