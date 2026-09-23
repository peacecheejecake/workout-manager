'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  courseAccessibilityNoteTextSchema,
  type CourseAccessibilityNote,
} from '@workout/contracts/courses';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import { CourseRequestError } from './course-api';
import type { CourseExtrasApi } from './course-extras-api';
import styles from './courses.module.css';

/**
 * The owner's accessibility note about a course (M2-01r, S13 "접근성 메모").
 *
 * Stored, private, the owner's own words — and never presented as more than that. A note is
 * not a fact this product checked: the screen says so every time it shows one. It is written
 * against the head revision on screen, and when the course has moved on since, the card and
 * the detail both say the note was written for an earlier line instead of letting it read as
 * a description of the current one.
 */
export function useAccessibilityNotes(api: CourseExtrasApi, scope: readonly string[]) {
  const notes = useQuery({
    queryKey: [...scope, 'accessibility-notes'],
    queryFn: ({ signal }) => api.accessibilityNotes(signal),
  });
  const byCourse = useMemo(() => {
    const map = new Map<string, CourseAccessibilityNote>();
    for (const note of notes.data?.notes ?? []) map.set(note.courseId, note);
    return map;
  }, [notes.data]);
  return { byCourse, isError: notes.isError, isPending: notes.isPending };
}

/**
 * What a course card says about the note. "No note" and "could not read the notes" are
 * different answers, and neither is shown as the other.
 */
export function accessibilityNoteSummary(
  note: CourseAccessibilityNote | undefined,
  headRevision: number | null,
  state: { readonly isError: boolean; readonly isPending: boolean },
): string {
  if (state.isError) return '접근성 메모를 불러오지 못했습니다';
  if (state.isPending) return '접근성 메모 확인 중';
  if (!note) return '접근성 메모 없음';
  const earlier =
    headRevision !== null && note.writtenAtRevision !== headRevision
      ? ` (수정 번호 ${note.writtenAtRevision}에서 적음 · 이후 코스가 바뀜)`
      : '';
  return `접근성 메모: ${note.note}${earlier}`;
}

function readableNoteError(error: unknown): string {
  if (error instanceof CourseRequestError) {
    if (error.code === 'COURSE_REVISION_CONFLICT')
      return '그 사이 코스가 바뀌었습니다. 바뀐 코스를 확인한 뒤 메모를 다시 저장하세요.';
    if (error.code === 'COURSE_UNAVAILABLE')
      return '원본 기록이 삭제되어 이 코스에는 메모를 쓸 수 없습니다.';
    if (error.status === 404) return '코스를 찾을 수 없습니다.';
    if (error.status === 400)
      return '메모는 256자 이하 한 줄이며, 꺾쇠괄호(<, >)와 제어 문자는 쓸 수 없습니다.';
  }
  return '메모를 저장하지 못했습니다. 저장된 메모는 그대로입니다.';
}

export interface CourseAccessibilityNotePanelProps {
  readonly api: CourseExtrasApi;
  /** Query scope of the signed-in owner and session. A cache never crosses an account. */
  readonly scope: readonly string[];
  readonly courseId: string;
  readonly headRevision: number;
}

/**
 * Read, write and clear the note of the course on screen. Render it keyed by the course: the
 * text being typed and the answer to a write both belong to one course and must not outlive
 * it onto the next one opened.
 */
export function CourseAccessibilityNotePanel({
  api,
  scope,
  courseId,
  headRevision,
}: CourseAccessibilityNotePanelProps) {
  const queries = useQueryClient();
  const notes = useAccessibilityNotes(api, scope);
  const stored = notes.byCourse.get(courseId);
  /** `null` until the owner types: until then the field shows what is stored. */
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const shown = draft ?? stored?.note ?? '';
  const write = useMutation({
    mutationFn: (note: string | null) =>
      api.writeAccessibilityNote(courseId, { expectedRevision: headRevision, note }),
    onSuccess: (result) => {
      setDraft(null);
      setMessage(
        result.note === null
          ? '접근성 메모를 지웠습니다.'
          : `접근성 메모를 저장했습니다. 수정 번호 ${result.note.writtenAtRevision} 기준입니다.`,
      );
    },
    onError: (error: unknown) => {
      setMessage(readableNoteError(error));
      // The course moved under the screen: read it again so the owner sees the line the
      // note would be written against before they try again.
      if (error instanceof CourseRequestError && [404, 409, 410].includes(error.status))
        void queries.invalidateQueries({ queryKey: scope });
    },
    // Re-read rather than trusting one answer: the list is what is true after every write.
    onSettled: () => queries.invalidateQueries({ queryKey: [...scope, 'accessibility-notes'] }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = shown.trim();
    if (text === '') {
      write.mutate(null);
      return;
    }
    // Checked here as well as at the contract, so the owner is told which rule it broke
    // rather than "the request was invalid".
    if (!courseAccessibilityNoteTextSchema.safeParse(text).success) {
      setMessage(readableNoteError(new CourseRequestError(400, 'INVALID_REQUEST')));
      return;
    }
    write.mutate(text);
  };

  return (
    <section className={styles.panel} aria-label="접근성 메모">
      <h3>접근성 메모</h3>
      <p className={styles.note}>
        계단·경사·문 닫는 시간처럼 이 코스를 다닐 때 알아둘 것을 직접 적어 두는 메모입니다. 본인이
        적은 내용이며 이 서비스가 확인한 사실이 아닙니다. 코스 수정본에는 포함되지 않습니다.
      </p>
      {notes.isError ? <p role="alert">저장된 접근성 메모를 불러오지 못했습니다.</p> : null}
      {stored && stored.writtenAtRevision !== headRevision ? (
        <p data-testid="accessibility-note-earlier">
          이 메모는 수정 번호 {stored.writtenAtRevision}에서 적었습니다. 지금 코스는 수정 번호{' '}
          {headRevision}입니다. 경로가 바뀌었을 수 있으니 다시 확인하세요.
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      <form className={styles.actions} onSubmit={submit}>
        <TextField
          label="접근성 메모"
          value={shown}
          maxLength={256}
          disabled={notes.isPending || notes.isError}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={write.isPending || notes.isError}>
          메모 저장
        </Button>
        {stored ? (
          <Button variant="secondary" disabled={write.isPending} onClick={() => write.mutate(null)}>
            메모 지우기
          </Button>
        ) : null}
      </form>
    </section>
  );
}
