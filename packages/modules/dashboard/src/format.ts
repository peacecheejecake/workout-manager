import type { DashboardMetric } from '@workout/contracts/dashboard';

export function metricText(metric: DashboardMetric, unit: string): string {
  return `${metric.value === null ? '미보고' : `${metric.value}${unit}`} · 알려진 ${metric.knownCount}개 · 미보고 ${metric.missingCount}개`;
}

export function boundsText(bounds: { min: number; max: number } | null, unit: string): string {
  if (bounds === null) return '미보고';
  return bounds.min === bounds.max ? `${bounds.min}${unit}` : `${bounds.min}–${bounds.max}${unit}`;
}

export function plannedMetricText(
  metric: DashboardMetric,
  target:
    | {
        min: number | null;
        max: number | null;
        knownCount: number;
        missingCount: number;
        rangeCount: number;
      }
    | undefined,
  unit: string,
): string {
  if (target === undefined) return metricText(metric, unit);
  const bounds =
    target.min === null || target.max === null ? null : { min: target.min, max: target.max };
  return `${boundsText(bounds, unit)} · 알려진 ${target.knownCount}개 · 미보고 ${target.missingCount}개 · 범위 목표 ${target.rangeCount}개${target.knownCount > 0 && target.missingCount > 0 ? ' · 부분 합계' : ''}`;
}
