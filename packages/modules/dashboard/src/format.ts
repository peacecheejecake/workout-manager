import type { DashboardMetric } from '@workout/contracts/dashboard';

export function metricText(metric: DashboardMetric, unit: string): string {
  return `${metric.value === null ? '미보고' : `${metric.value}${unit}`} · 알려진 ${metric.knownCount}개 · 미보고 ${metric.missingCount}개`;
}
