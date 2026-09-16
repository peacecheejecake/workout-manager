import type {
  DashboardActual,
  DashboardMetric,
  DashboardPlanned,
  DashboardDay,
  DashboardWindow,
} from '@workout/contracts/dashboard';
export const durationKinds = ['timer', 'elapsed', 'moving', 'unknown'] as const;
export const emptyMetric = (): DashboardMetric => ({ value: null, knownCount: 0, missingCount: 0 });
export const emptyActual = (): DashboardActual => ({
  count: 0,
  distanceMeters: emptyMetric(),
  durationSeconds: {
    timer: emptyMetric(),
    elapsed: emptyMetric(),
    moving: emptyMetric(),
    unknown: emptyMetric(),
  },
  sources: { fit: 0, fixture: 0 },
  overlayCount: 0,
});
export const emptyPlanned = (): DashboardPlanned => ({
  count: 0,
  distanceMeters: emptyMetric(),
  durationSeconds: emptyMetric(),
});
function addMetric(target: DashboardMetric, input: DashboardMetric) {
  target.knownCount += input.knownCount;
  target.missingCount += input.missingCount;
  if (input.value !== null) target.value = (target.value ?? 0) + input.value;
}
/** Fold only bounded SQL daily aggregates, never raw health rows. */
export function summarizeDays(days: DashboardDay[]): DashboardWindow {
  const result: DashboardWindow = {
    actual: emptyActual(),
    planned: emptyPlanned(),
    checkInCount: 0,
    checkInDays: 0,
  };
  for (const day of days) {
    result.actual.count += day.actual.count;
    addMetric(result.actual.distanceMeters, day.actual.distanceMeters);
    for (const kind of durationKinds)
      addMetric(result.actual.durationSeconds[kind], day.actual.durationSeconds[kind]);
    result.actual.sources.fit += day.actual.sources.fit;
    result.actual.sources.fixture += day.actual.sources.fixture;
    result.actual.overlayCount += day.actual.overlayCount;
    result.planned.count += day.planned.count;
    addMetric(result.planned.distanceMeters, day.planned.distanceMeters);
    addMetric(result.planned.durationSeconds, day.planned.durationSeconds);
    result.checkInCount += day.checkInCount;
    if (day.checkInCount > 0) result.checkInDays++;
  }
  return result;
}
