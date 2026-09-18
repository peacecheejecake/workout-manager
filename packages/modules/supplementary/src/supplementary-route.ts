export type SupplementaryRoute =
  | { kind: 'overview' }
  | { kind: 'exercises' }
  | { kind: 'exercise'; exerciseId: string }
  | { kind: 'routine'; routineId: string }
  | { kind: 'execution'; executionId: string };

function segment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseSupplementaryRoute(pathname: string): SupplementaryRoute | null {
  if (pathname === '/supplementary') return { kind: 'overview' };
  if (pathname === '/supplementary/exercises') return { kind: 'exercises' };
  const exercise = /^\/supplementary\/exercises\/([^/]+)$/.exec(pathname);
  if (exercise?.[1]) {
    const exerciseId = segment(exercise[1]);
    return exerciseId === null ? null : { kind: 'exercise', exerciseId };
  }
  const routine = /^\/supplementary\/routines\/([^/]+)$/.exec(pathname);
  if (routine?.[1]) {
    const routineId = segment(routine[1]);
    return routineId === null ? null : { kind: 'routine', routineId };
  }
  const execution = /^\/supplementary\/sessions\/([^/]+)\/perform$/.exec(pathname);
  if (execution?.[1]) {
    const executionId = segment(execution[1]);
    return executionId === null ? null : { kind: 'execution', executionId };
  }
  return null;
}
