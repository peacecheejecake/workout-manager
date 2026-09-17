import type { PeriodDraft } from '@workout/contracts/planning';

export function periodPriorityLabel(priority: PeriodDraft['priority']): string {
  if (priority === undefined || priority === null) return '미지정';
  return { low: '낮음', normal: '보통', high: '높음' }[priority];
}
