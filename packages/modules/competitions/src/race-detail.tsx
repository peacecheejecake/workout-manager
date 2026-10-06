'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { raceEventSchema, type RaceEvent } from '@workout/contracts/races';
import {
  internalRecordEditor as RecordEditor,
  type CompetitionRelations,
} from './competition-workspace';
import { competitionRelationsSchema } from './competition-relations';
import { createRaceApi, RaceRequestError } from './race-api';
import { eventDraft, eventFields, parseEvent, type Draft } from './race-forms';
import styles from './competitions.module.css';

export interface RaceEventDetailWorkspaceProps {
  athleteId: string | null;
  sessionId: string;
  transport: AuthenticatedTransport;
  raceId: string;
  relations?: CompetitionRelations;
  onBack?: () => void;
}
export function RaceEventDetailWorkspace(props: RaceEventDetailWorkspaceProps) {
  if (!props.athleteId || !props.sessionId)
    return <p role="status">로그인 후 대회 상세를 볼 수 있습니다.</p>;
  const id = raceEventSchema.shape.id.safeParse(props.raceId);
  if (!id.success) return <p role="alert">대회 주소가 올바르지 않습니다.</p>;
  return (
    <Lifetime
      key={JSON.stringify([props.athleteId, props.sessionId, id.data])}
      {...props}
      athleteId={props.athleteId}
      raceId={id.data}
    />
  );
}
function Lifetime(props: RaceEventDetailWorkspaceProps & { athleteId: string }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  useEffect(
    () => () => {
      void client.cancelQueries();
      client.clear();
    },
    [client],
  );
  return (
    <QueryClientProvider client={client}>
      <Detail {...props} />
    </QueryClientProvider>
  );
}
function readError(error: unknown) {
  if (error instanceof RaceRequestError && error.status === 404)
    return '대회를 찾을 수 없거나 읽을 수 없습니다. 저장된 초안은 유지됩니다.';
  if (error instanceof RaceRequestError && error.code === 'REVISION_CONFLICT')
    return '다른 변경과 충돌했습니다. 최신 대회를 확인한 뒤 다시 시도하세요.';
  return '대회를 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요. 저장된 초안은 유지됩니다.';
}
function Summary({
  record,
  relations,
}: {
  record: RaceEvent;
  relations: CompetitionRelations | undefined;
}) {
  const course = record.course;
  return (
    <>
      <h2>{record.title}</h2>
      <p>
        {record.localDate} · {record.localStartTime ?? '출발 시간 미상'} · {record.timezone} ·{' '}
        {record.locationName ?? '장소 미상'}
      </p>
      <p>
        {record.distance.kind === 'standard'
          ? record.distance.class
          : `${record.distance.label} (${record.distance.nominalMeters ?? '미상'} m)`}{' '}
        · 우선순위 {record.priority ?? '미상'} · {record.participation}
      </p>
      <p>
        목표 {record.targetSeconds ?? '미상'} 초 · Plan{' '}
        {record.planVersionId === null
          ? '연결 없음'
          : (relations?.plans?.find((p) => p.id === record.planVersionId)?.label ?? '연결된 계획')}
      </p>
      <p>
        코스{' '}
        {course === null
          ? '연결 없음'
          : (relations?.courses?.find(
              (c) =>
                c.ref.courseId === course.courseId &&
                c.ref.courseRevision === course.courseRevision &&
                c.ref.revisionId === course.revisionId,
            )?.label ?? '고정 버전 코스 연결됨')}
      </p>
      {record.officialUrl ? (
        <a href={record.officialUrl} rel="noreferrer" target="_blank">
          공식 대회 안내
        </a>
      ) : null}
      <p>저장 버전 {record.revision}</p>
    </>
  );
}
function Detail(props: RaceEventDetailWorkspaceProps & { athleteId: string }) {
  const client = useQueryClient();
  const api = useMemo(() => createRaceApi(props.transport).events, [props.transport]);
  const key = ['competition-detail', props.athleteId, props.sessionId, props.raceId];
  const [deleted, setDeleted] = useState(false);
  const query = useQuery({
    queryKey: key,
    enabled: !deleted,
    queryFn: ({ signal }) => api.read(props.raceId, signal),
  });
  const review = useQuery({
    queryKey: [...key, 'revision-preview'],
    enabled: false,
    queryFn: ({ signal }) => api.read(props.raceId, signal),
  });
  const [editor, setEditor] = useState<RaceEvent | null>(null);
  const [latestShown, setLatestShown] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RaceEvent | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [backConfirmation, setBackConfirmation] = useState(false);
  const draftRef = useRef<Draft | null>(null);
  const backButton = useRef<HTMLButtonElement | null>(null);
  const continueButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (backConfirmation) continueButton.current?.focus();
  }, [backConfirmation]);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const deleteKeys = useRef(new Map<string, string>());
  useEffect(() => {
    alive.current = true;
    const keys = deleteKeys.current;
    return () => {
      alive.current = false;
      controller.current?.abort();
      keys.clear();
    };
  }, []);
  const relationRead =
    props.relations === undefined ? null : competitionRelationsSchema.safeParse(props.relations);
  const relations = relationRead?.success ? relationRead.data : undefined;
  function requestBack() {
    if (editor && draftRef.current) {
      try {
        if (
          JSON.stringify(parseEvent(draftRef.current)) ===
          JSON.stringify(parseEvent(eventDraft(editor)))
        ) {
          props.onBack?.();
          return;
        }
      } catch {
        /* Invalid edited input is also unsaved. */
      }
      setBackConfirmation(true);
      return;
    }
    props.onBack?.();
  }
  async function loadLatest() {
    const result = await review.refetch();
    if (!alive.current) return;
    if (result.error) setStatus(readError(result.error));
    else {
      setStatus('');
      setLatestShown(true);
    }
  }
  async function remove(target: RaceEvent) {
    if (deleting) return;
    const basis = `${target.id}:${target.revision}`;
    const commandKey = deleteKeys.current.get(basis) ?? crypto.randomUUID();
    deleteKeys.current.set(basis, commandKey);
    controller.current = new AbortController();
    setDeleting(true);
    setStatus('');
    try {
      await api.delete(
        target.id,
        { expectedRevision: target.revision, idempotencyKey: commandKey },
        controller.current.signal,
      );
      if (!alive.current) return;
      setDeleted(true);
      setDeleteTarget(null);
      client.removeQueries({ queryKey: key });
      await client.invalidateQueries({
        queryKey: ['competitions', props.athleteId, props.sessionId, 'race-event'],
      });
    } catch (error) {
      if (alive.current) setStatus(readError(error));
    } finally {
      if (alive.current) setDeleting(false);
    }
  }
  return (
    <section className={styles.workspace} aria-label="대회 상세">
      <h1>대회 상세</h1>
      {props.onBack ? (
        <button ref={backButton} type="button" disabled={saving || deleting} onClick={requestBack}>
          대회 목록으로
        </button>
      ) : null}
      {backConfirmation ? (
        <section className={styles.notice} aria-label="미저장 변경 이동 확인">
          <p role="alert">
            저장하지 않은 변경이 있습니다. 변경을 버리고 대회 목록으로 이동하시겠습니까?
          </p>
          <button
            ref={continueButton}
            type="button"
            disabled={saving || deleting}
            onClick={() => {
              setBackConfirmation(false);
              backButton.current?.focus();
            }}
          >
            계속 편집
          </button>
          <button
            type="button"
            disabled={saving || deleting}
            onClick={() => {
              setBackConfirmation(false);
              props.onBack?.();
            }}
          >
            변경을 버리고 이동
          </button>
        </section>
      ) : null}
      {!deleted ? (
        <button
          type="button"
          disabled={deleting || query.isFetching}
          onClick={() => {
            void query.refetch();
          }}
        >
          대회 새로고침
        </button>
      ) : null}
      {deleted ? (
        <p role="status">대회 삭제가 서버에 반영되었습니다.</p>
      ) : (
        <>
          {query.isPending ? <p role="status">대회를 불러오는 중입니다.</p> : null}
          {query.isError ? (
            <div role="alert">
              <p>{readError(query.error)}</p>
              <button
                type="button"
                onClick={() => {
                  void query.refetch();
                }}
              >
                대회 다시 불러오기
              </button>
            </div>
          ) : null}
          {relationRead && !relationRead.success ? (
            <p role="status">연결 목록을 읽을 수 없습니다. 기존 연결은 유지됩니다.</p>
          ) : null}
          {query.data ? (
            <div className={styles.card}>
              <Summary record={query.data} relations={relations} />
              {query.data.revision === 2147483647 ? (
                <p>최종 버전 대회는 읽기와 삭제만 가능합니다.</p>
              ) : null}
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={editor !== null || deleting || query.data.revision === 2147483647}
                  onClick={() => {
                    draftRef.current = query.data ? eventDraft(query.data) : null;
                    setEditor(query.data ?? null);
                    setStatus('');
                  }}
                >
                  대회 편집
                </button>
                <button
                  type="button"
                  disabled={editor !== null || deleting}
                  onClick={() => setDeleteTarget(query.data ?? null)}
                >
                  대회 삭제
                </button>
              </div>
            </div>
          ) : null}
          {deleteTarget ? (
            <div className={styles.notice}>
              <p>이 대회를 삭제하시겠습니까? 연결된 실제 활동이나 계획은 삭제하지 않습니다.</p>
              <button
                type="button"
                disabled={deleting}
                onClick={() => {
                  void remove(deleteTarget);
                }}
              >
                대회 삭제 확인
              </button>
              <button type="button" disabled={deleting} onClick={() => setDeleteTarget(null)}>
                삭제 취소
              </button>
            </div>
          ) : null}
          {editor ? (
            <RecordEditor
              key={editor.id}
              title="대회"
              initial={eventDraft(editor)}
              fields={(draft) =>
                eventFields(draft, relations).map((field) => ({
                  ...field,
                  apply: (before, next) => {
                    const updated = field.apply
                      ? field.apply(before, next)
                      : { ...before, [field.key]: next };
                    draftRef.current = updated;
                    return updated;
                  },
                }))
              }
              parse={parseEvent}
              commandKey={() => crypto.randomUUID()}
              commandBasis={`${editor.id}:${editor.revision}`}
              cancel={() => {
                setEditor(null);
                draftRef.current = null;
                setBackConfirmation(false);
                setLatestShown(false);
              }}
              revisionReview={
                <div className={styles.notice}>
                  <p>
                    편집 기준 revision {editor.revision}. 최신 값을 읽어 비교한 뒤에만 기준을 바꿀
                    수 있습니다.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      void loadLatest();
                    }}
                  >
                    최신 대회 확인
                  </button>
                  {latestShown && review.data ? (
                    <>
                      <h3>서버의 최신 대회</h3>
                      <Summary record={review.data} relations={relations} />
                      <button
                        type="button"
                        onClick={() => {
                          setEditor(review.data ?? null);
                          setLatestShown(false);
                        }}
                      >
                        비교 완료 · 초안 유지하며 최신 revision 채택
                      </button>
                    </>
                  ) : null}
                </div>
              }
              commit={async (values, commandKey, signal) => {
                setSaving(true);
                try {
                  const result = await api.update(
                    editor.id,
                    { values, expectedRevision: editor.revision, idempotencyKey: commandKey },
                    signal,
                  );
                  if (!alive.current) return;
                  setStatus(`저장이 서버에 반영되었습니다 (revision ${result.revision}).`);
                  setEditor(null);
                  draftRef.current = null;
                  setBackConfirmation(false);
                  setLatestShown(false);
                  await client.invalidateQueries({ queryKey: key, exact: true });
                } finally {
                  if (alive.current) setSaving(false);
                }
              }}
            />
          ) : null}
          <p role="status">{status}</p>
        </>
      )}
    </section>
  );
}
