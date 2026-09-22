'use client';

/**
 * Turning an explicitly selected range of a stored recording into a course.
 *
 * The selection is explicit in both directions: the user picks a sample — on the map, in
 * the sample list or through the chart — and then says whether it is the start or the end.
 * Nothing is inferred from a drag, and no range is proposed automatically, so a course is
 * never created from something the user did not name.
 *
 * Only the two sample ids and a name are sent. The geometry itself comes from the stored
 * derivative on the server, which is also why this component cannot silently change the
 * recording: it has no write path to an Activity at all.
 */
import { useRef, useState } from 'react';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { courseReadResultSchema } from '@workout/contracts/courses';
import { z } from 'zod';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import styles from './activity-track-panel.module.css';

const errorSchema = z.object({ error: z.object({ code: z.string() }) });

/**
 * Did this answer prove that nothing was stored?
 *
 * Only our own refusals do. A gateway or an overload answer (502/503/504, and a 408/425/429
 * that may have been produced anywhere between here and the server) says nothing about
 * whether the server already stored the course, so the command — body and key together —
 * must be kept for the retry. Treating those as "not applied" and retrying with a fresh key
 * is exactly how a duplicate course is created.
 */
function provesNothingWasStored(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

const messages: Record<string, string> = {
  SEGMENT_SPANS_A_GAP:
    '고른 두 지점이 끊긴 구간을 사이에 두고 있습니다. 끊긴 구간은 직선으로 잇지 않으므로 같은 구간 안에서 고르세요.',
  SEGMENT_ENDPOINT_NOT_DRAWN: '고른 지점이 지도에 그려진 좌표가 아닙니다.',
  SEGMENT_ENDPOINT_AMBIGUOUS: '고른 지점이 여러 좌표를 가리켜 구간을 정할 수 없습니다.',
  SEGMENT_TOO_SHORT: '시작과 끝이 같은 지점입니다. 서로 다른 두 지점을 고르세요.',
  TRACK_REVISION_CHANGED:
    '저장된 경로가 그 사이에 바뀌었습니다. 경로를 다시 조회한 뒤 구간을 고르세요.',
  COURSE_QUOTA_EXCEEDED: '저장할 수 있는 코스 수를 넘었습니다.',
};

export interface CourseFromSegmentProps {
  readonly transport: AuthenticatedTransport;
  readonly activityId: string;
  readonly trackRevision: number;
  /** The sample the screen currently has selected, or `null`. */
  readonly selectedSampleId: string | null;
  /** True when that sample is a drawn vertex; an undrawn sample cannot bound a course. */
  readonly selectedIsDrawn: boolean;
}

export function CourseFromSegment({
  transport,
  activityId,
  trackRevision,
  selectedSampleId,
  selectedIsDrawn,
}: CourseFromSegmentProps) {
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const pickable = selectedSampleId !== null && selectedIsDrawn;
  /**
   * The command in flight, kept while its outcome is unknown.
   *
   * A lost response is the case this exists for: retrying with a fresh key would ask the
   * server for a *second* course, because a new key is a new command. The key is therefore
   * bound to the body, reused for every retry of that exact body, and released only when
   * the command completes or the user changes what they are asking for.
   */
  const command = useRef<{ fingerprint: string; key: string } | null>(null);

  async function save() {
    if (start === null || end === null || name.trim().length === 0 || pending) return;
    const body = {
      name: name.trim(),
      from: {
        kind: 'recorded-segment' as const,
        activityId,
        trackRevision,
        startSampleId: start,
        endSampleId: end,
      },
    };
    const fingerprint = JSON.stringify(body);
    if (command.current?.fingerprint !== fingerprint)
      command.current = { fingerprint, key: crypto.randomUUID() };
    const key = command.current.key;
    setPending(true);
    setMessage('');
    try {
      const reply = transportReplySchema.parse(
        await transport.request({
          path: '/bff/v1/courses',
          method: 'POST',
          body,
          idempotencyKey: key,
        }),
      );
      if (reply.status < 200 || reply.status >= 300) {
        const parsed = errorSchema.safeParse(reply.body);
        const code = parsed.success ? parsed.data.error.code : 'REQUEST_FAILED';
        if (provesNothingWasStored(reply.status)) {
          // Our own refusal: nothing was written, so the next attempt is a new command.
          command.current = null;
          setMessage(messages[code] ?? '코스를 저장하지 못했습니다.');
          return;
        }
        // The outcome is unknown. The command is kept so the retry is the same command.
        setMessage(
          '코스 저장 결과를 확인하지 못했습니다. 같은 구간과 이름으로 다시 저장하면 중복이 생기지 않습니다.',
        );
        return;
      }
      const result = courseReadResultSchema.parse(reply.body);
      setMessage(
        result.status === 'available'
          ? `코스를 저장했습니다: ${result.revision.name} · 수정 번호 ${result.course.headRevision}`
          : '코스를 저장했지만 지금은 사용할 수 없습니다.',
      );
      command.current = null;
      setStart(null);
      setEnd(null);
      setName('');
    } catch {
      // The outcome is unknown, so the command is kept: pressing save again resends the
      // same body under the same key and the server answers with the original result.
      setMessage(
        '코스 저장 결과를 확인하지 못했습니다. 같은 구간과 이름으로 다시 저장하면 중복이 생기지 않습니다.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section className={styles.course} aria-label="선택 구간으로 코스 만들기">
      <h4>선택 구간으로 코스 만들기</h4>
      <p className={styles.note}>
        지도나 아래 목록에서 지점을 고른 뒤 구간의 시작과 끝으로 지정하세요. 저장해도 이 활동 기록은
        바뀌지 않으며, 코스는 비공개입니다.
      </p>
      {message ? <p role="status">{message}</p> : null}
      <div className={styles.actions}>
        <Button variant="secondary" disabled={!pickable} onClick={() => setStart(selectedSampleId)}>
          이 지점을 구간 시작으로
        </Button>
        <Button variant="secondary" disabled={!pickable} onClick={() => setEnd(selectedSampleId)}>
          이 지점을 구간 끝으로
        </Button>
      </div>
      <p className={styles.note} data-testid="course-range">
        시작 {start ?? '미지정'} · 끝 {end ?? '미지정'}
      </p>
      <TextField
        label="코스 이름"
        value={name}
        maxLength={120}
        onChange={(event) => setName(event.target.value)}
      />
      <Button
        disabled={start === null || end === null || name.trim().length === 0 || pending}
        onClick={() => void save()}
      >
        {pending ? '코스 저장 중' : '이 구간을 코스로 저장'}
      </Button>
    </section>
  );
}
