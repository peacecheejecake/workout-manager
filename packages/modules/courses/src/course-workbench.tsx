'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import type { CourseHead, CourseReadResult } from '@workout/contracts/courses';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import { courseExportPath, createCourseApi, CourseRequestError } from './course-api';
import styles from './courses.module.css';

/**
 * S13 course list and detail.
 *
 * Courses are private. This screen has no sharing control, because the server has no
 * sharing route; it offers the owner's own GPX download and nothing else that leaves the
 * account. Every write sends the revision the screen was showing, so a course changed
 * elsewhere produces a visible conflict instead of a silent overwrite.
 */
export interface CourseWorkbenchProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
}

export function CourseWorkbench(props: CourseWorkbenchProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <Workbench {...props} />
    </QueryClientProvider>
  );
}

function readableError(error: unknown): string {
  if (!(error instanceof CourseRequestError)) return '요청을 완료하지 못했습니다.';
  if (error.status === 409)
    return '다른 변경이 먼저 저장되었습니다. 최신 코스를 다시 불러온 뒤 시도하세요.';
  if (error.status === 410) return '원본 기록이 삭제되어 이 코스는 더 이상 사용할 수 없습니다.';
  if (error.status === 404) return '코스를 찾을 수 없습니다.';
  return '입력을 확인한 뒤 다시 시도하세요.';
}

function metres(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}km` : `${Math.round(value)}m`;
}

/**
 * The owner's GPX download.
 *
 * A plain navigation cannot carry the session header the API requires for a cookie
 * session, so the anchor keeps its real `href` — visible, keyboard reachable and the same
 * address the API serves — while the click performs the authenticated read itself and
 * hands the bytes to the browser.
 *
 * Two checks bound it to the session that started it. The request carries an abort signal
 * that the screen fires when it goes away, and the private bytes are turned into an object
 * URL **only after** the reply has arrived and the session is still the one that asked.
 * Revoking afterwards would not help: a download already handed to the browser cannot be
 * taken back, so it must never be handed over in the first place.
 */
async function downloadCourseGpx(input: {
  readonly courseId: string;
  readonly sessionId: string;
  readonly fileName: string;
  readonly signal: AbortSignal;
  readonly stillCurrent: () => boolean;
}) {
  const response = await fetch(courseExportPath(input.courseId), {
    method: 'GET',
    headers: { 'x-workout-session-id': input.sessionId },
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: input.signal,
  });
  if (!response.ok) throw new CourseRequestError(response.status, 'EXPORT_FAILED');
  const blob = await response.blob();
  if (input.signal.aborted || !input.stillCurrent()) return;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = input.fileName;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function Workbench({ athleteId, sessionId, transport }: CourseWorkbenchProps) {
  const api = useRef(createCourseApi(transport));
  // The session this screen belongs to. An in-flight download is aborted when the screen
  // goes away, which is what the shell does on logout and on an account switch, and the
  // session it started under is compared again before any byte is handed to the browser.
  const live = useRef({ session: sessionId, active: true });
  const downloads = useRef(new Set<AbortController>());
  useEffect(() => {
    const started = downloads.current;
    const current = live.current;
    current.session = sessionId;
    current.active = true;
    return () => {
      current.active = false;
      for (const controller of started) controller.abort();
      started.clear();
    };
  }, [sessionId]);
  const queries = useQueryClient();
  const scope = ['users', athleteId, 'sessions', sessionId, 'courses'] as const;
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');

  const list = useQuery({
    queryKey: [...scope, 'list'],
    queryFn: ({ signal }) => api.current.list(signal),
  });
  const detail = useQuery({
    queryKey: [...scope, 'detail', selected ?? ''],
    enabled: selected !== null,
    queryFn: ({ signal }) => api.current.read(selected ?? '', signal),
  });

  const rename = useMutation({
    mutationFn: (input: { courseId: string; expectedRevision: number; name: string }) =>
      api.current.update(
        input.courseId,
        { expectedRevision: input.expectedRevision, change: { kind: 'rename', name: input.name } },
        crypto.randomUUID(),
      ),
    onSuccess: async (result: CourseReadResult) => {
      setMessage(
        result.status === 'available'
          ? `이름을 저장했습니다. 현재 수정 번호 ${result.course.headRevision}`
          : '코스를 사용할 수 없습니다.',
      );
      await queries.invalidateQueries({ queryKey: scope });
    },
    onError: (error: unknown) => setMessage(readableError(error)),
  });

  const remove = useMutation({
    mutationFn: (input: { courseId: string; expectedRevision: number }) =>
      api.current.remove(input.courseId, input.expectedRevision),
    onSuccess: async () => {
      setSelected(null);
      setMessage('코스를 삭제했습니다.');
      await queries.invalidateQueries({ queryKey: scope });
    },
    onError: (error: unknown) => setMessage(readableError(error)),
  });

  const courses: readonly CourseHead[] = list.data?.courses ?? [];
  const current = detail.data ?? null;

  function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (current === null || current.status !== 'available') return;
    rename.mutate({
      courseId: current.course.courseId,
      expectedRevision: current.course.headRevision,
      name,
    });
  }

  return (
    <section className={styles.workbench} aria-label="내 코스">
      <h2>내 코스</h2>
      <p className={styles.note}>
        코스는 비공개입니다. 공개 공유 기능은 없으며, 내보내기는 본인 인증 다운로드입니다.
      </p>
      {message ? <p role="status">{message}</p> : null}
      {list.isPending ? <p role="status">코스를 불러오는 중입니다.</p> : null}
      {list.isError ? (
        <div role="group" aria-label="코스 목록 오류">
          <p role="alert">코스 목록을 불러오지 못했습니다.</p>
          <Button variant="secondary" onClick={() => void list.refetch()}>
            다시 불러오기
          </Button>
        </div>
      ) : null}
      {list.isSuccess && courses.length === 0 ? (
        <p>아직 저장한 코스가 없습니다. 활동 상세의 경로 탭에서 구간을 골라 만들 수 있습니다.</p>
      ) : null}
      <ul className={styles.list}>
        {courses.map((course) => (
          <li key={course.courseId}>
            <Button
              variant={selected === course.courseId ? 'primary' : 'secondary'}
              aria-pressed={selected === course.courseId}
              onClick={() => {
                setSelected(course.courseId);
                setName(course.name);
                setMessage('');
              }}
            >
              {course.name}
            </Button>
            <span>
              {course.status === 'available'
                ? `수정 번호 ${course.headRevision}`
                : '사용 불가 · 원본 기록 삭제됨'}
            </span>
          </li>
        ))}
      </ul>
      {detail.isPending && selected !== null ? <p role="status">코스를 여는 중입니다.</p> : null}
      {current?.status === 'unavailable' ? (
        <div role="group" aria-label="사용할 수 없는 코스">
          <p role="alert">
            {current.course.name}: 이 코스가 만들어진 활동 기록이 삭제되어 경로를 더 이상 사용할 수
            없습니다. 참조만 남아 있습니다.
          </p>
          <Button
            variant="danger"
            onClick={() =>
              remove.mutate({ courseId: current.course.courseId, expectedRevision: 1 })
            }
          >
            이 참조 삭제
          </Button>
        </div>
      ) : null}
      {current?.status === 'available' ? (
        <div className={styles.detail}>
          <h3>{current.course.name}</h3>
          <dl>
            <dt>현재 수정 번호</dt>
            <dd data-testid="course-revision">{current.course.headRevision}</dd>
            <dt>계획 선 길이</dt>
            <dd>{metres(current.revision.distanceMeters)}</dd>
            <dt>경유점</dt>
            <dd>{current.revision.waypoints.length}개</dd>
            <dt>출처 기록</dt>
            <dd>
              {current.revision.lineage
                .map(
                  (source) =>
                    `활동 ${source.activityId.slice(0, 8)} · 기록본 ${source.trackRevision}`,
                )
                .join(', ')}
            </dd>
          </dl>
          <p className={styles.note}>
            계획 선 길이는 이 코스 선의 길이입니다. 기기 보고 거리·GPS 재계산 거리·경로 계산 예상
            거리와 다른 값입니다.
          </p>
          <form onSubmit={submitRename}>
            <TextField
              label="코스 이름"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" disabled={rename.isPending}>
              이름 저장
            </Button>
          </form>
          <a
            className={styles.download}
            href={courseExportPath(current.course.courseId)}
            download
            data-testid="course-export"
            onClick={(event) => {
              event.preventDefault();
              const controller = new AbortController();
              downloads.current.add(controller);
              void downloadCourseGpx({
                courseId: current.course.courseId,
                sessionId,
                fileName: `${current.revision.name}-r${current.course.headRevision}.gpx`,
                signal: controller.signal,
                stillCurrent: () => live.current.active && live.current.session === sessionId,
              })
                .catch((error: unknown) => {
                  if (live.current.active && !controller.signal.aborted)
                    setMessage(readableError(error));
                })
                .finally(() => downloads.current.delete(controller));
            }}
          >
            GPX 내보내기
          </a>
          <Button
            variant="danger"
            onClick={() =>
              remove.mutate({
                courseId: current.course.courseId,
                expectedRevision: current.course.headRevision,
              })
            }
          >
            코스 삭제
          </Button>
        </div>
      ) : null}
    </section>
  );
}
