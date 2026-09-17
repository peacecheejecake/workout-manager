import { z } from 'zod';
import { activityListQuerySchema } from '@workout/contracts/activity';

export function readActivitySearch(search: string) {
  const params = new URLSearchParams(search);
  const input: Record<string, string | number> = {
    limit: 20,
    offset: params.get('offset') ?? 0,
    sort: params.get('sort') ?? 'started_desc',
  };
  for (const key of [
    'search',
    'tag',
    'from',
    'toExclusive',
    'timezone',
    'kind',
    'source',
    'quality',
    'linkedPlanVersionId',
    'linkedBlockId',
  ]) {
    const value = params.get(key);
    if (value !== null) input[key] = value;
  }
  const query = activityListQuerySchema.safeParse(input);
  const view = z.enum(['table', 'cards']).safeParse(params.get('view') ?? 'cards');
  const selected = z.uuid().nullable().safeParse(params.get('selected'));
  return {
    query: query.success ? query.data : null,
    view: view.success ? view.data : null,
    selected: selected.success ? selected.data : null,
    invalid: !query.success || !view.success || !selected.success,
  };
}
export function updateActivitySearch(search: string, changes: Record<string, string | null>) {
  const params = new URLSearchParams(search);
  for (const [name, value] of Object.entries(changes)) {
    if (value === null || value === '') params.delete(name);
    else params.set(name, value);
  }
  return params.toString();
}
