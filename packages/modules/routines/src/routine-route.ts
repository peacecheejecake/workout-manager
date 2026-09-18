import { z } from 'zod';

const uuid = z.uuid();
export type RoutineRoute =
  | { kind: 'library' }
  | { kind: 'detail'; routineId: string; edit?: boolean }
  | { kind: 'schedule'; routineId: string }
  | { kind: 'run'; runId: string };

export function parseRoutineRoute(pathname: string): RoutineRoute | null {
  const parts = pathname.split('/').filter(Boolean);
  const id = parts[1];
  if (parts.length === 1 && parts[0] === 'routines') return { kind: 'library' };
  if (!id || !uuid.safeParse(id).success) return null;
  if (parts.length === 2 && parts[0] === 'routines') return { kind: 'detail', routineId: id };
  if (parts.length === 3 && parts[0] === 'routines' && parts[2] === 'edit')
    return { kind: 'detail', routineId: id, edit: true };
  if (parts.length === 3 && parts[0] === 'routines' && parts[2] === 'schedule')
    return { kind: 'schedule', routineId: id };
  if (parts.length === 2 && parts[0] === 'routine-runs') return { kind: 'run', runId: id };
  return null;
}
