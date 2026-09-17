import { planDraftSchema, plannedSessionSchema, type PlanDraft } from '@workout/contracts/planning';

export type DuplicateSessionResult =
  | { ok: true; draft: PlanDraft; sessionId: string }
  | {
      ok: false;
      error: 'invalid_draft' | 'capacity' | 'id_collision' | 'invalid_id' | 'missing_session';
    };

/** One immutable draft operation; it does not persist a plan or create an actual activity. */
export function duplicatePlannedSession(
  draft: PlanDraft,
  sourceId: string,
  createId: () => string,
): DuplicateSessionResult {
  const parsed = planDraftSchema.safeParse(draft);
  if (!parsed.success) return { ok: false, error: 'invalid_draft' };
  // Validation must not normalize unrelated in-progress editor text during a copy.
  const current = structuredClone(draft);
  if (current.sessions.length >= 1000) return { ok: false, error: 'capacity' };
  const source = current.sessions.find((session) => session.id === sourceId);
  if (!source) return { ok: false, error: 'missing_session' };
  const occupied = new Set([
    ...current.periods.map((period) => period.id),
    ...current.sessions.flatMap((session) => [session.id, ...session.steps.map((step) => step.id)]),
  ]);
  function nextId():
    { ok: true; id: string } | { ok: false; error: 'invalid_id' | 'id_collision' } {
    let value: string;
    try {
      value = createId();
    } catch {
      return { ok: false, error: 'invalid_id' };
    }
    const id = plannedSessionSchema.shape.id.safeParse(value);
    if (!id.success) return { ok: false, error: 'invalid_id' };
    if (occupied.has(id.data)) return { ok: false, error: 'id_collision' };
    occupied.add(id.data);
    return { ok: true, id: id.data };
  }
  const sessionId = nextId();
  if (!sessionId.ok) return sessionId;
  const steps = [];
  for (const step of source.steps) {
    const id = nextId();
    if (!id.ok) return id;
    steps.push({ ...step, id: id.id });
  }
  const copiedTitle = `${source.title} 복사`;
  const candidate = {
    ...current,
    sessions: [
      ...current.sessions,
      {
        ...source,
        id: sessionId.id,
        title: copiedTitle.length <= 200 ? copiedTitle : source.title,
        locks: { date: false, time: false, intensity: false, attendance: false },
        steps,
      },
    ],
  };
  // Recheck the complete size bound as well as all structural invariants after adding the copy.
  const result = planDraftSchema.safeParse(candidate);
  return result.success
    ? { ok: true, draft: candidate, sessionId: sessionId.id }
    : { ok: false, error: 'invalid_draft' };
}
