'use client';
import { useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from 'zustand';
import { z } from 'zod';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  activitySchema,
  activityOverlayWriteSchema,
  manualActivityCreateSchema,
  manualActivityResultSchema,
  type Activity,
} from '@workout/contracts/activity';
import { planReadSchema } from '@workout/contracts/planning';
import { Button } from '@workout/ui-foundation/button';
import { createEditorStore, type EditorCommand } from './editor-store';
import { EditorFields } from './editor-fields';
import { EditorPreview, RecordPreview } from './editor-preview';
import styles from './activity-editor.module.css';
export interface ActivityEditorProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  target: { mode: 'create' } | { mode: 'edit'; activityId: string };
  initialStartedAt: string;
  initialTimezone: string;
  activityHref(id: string): string;
  listHref: string;
  createId?: () => string;
}
export function ActivityEditor(props: ActivityEditorProps) {
  return <Lifetime key={JSON.stringify([props.athleteId, props.sessionId])} {...props} />;
}
function Lifetime(props: ActivityEditorProps) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [store] = useState(() => createEditorStore(props.initialStartedAt, props.initialTimezone));
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <Workspace {...props} store={store} />
    </QueryClientProvider>
  );
}
const randomId = () => crypto.randomUUID();
function Workspace({
  store,
  target: requestedTarget,
  athleteId,
  sessionId,
  transport,
  activityHref,
  listHref,
  createId = randomId,
}: ActivityEditorProps & { store: ReturnType<typeof createEditorStore> }) {
  const [target, setTarget] = useState(requestedTarget);
  const fields = useStore(store, (state) => state.fields);
  const original = useStore(store, (state) => state.original);
  const phase = useStore(store, (state) => state.phase);
  const dirty = useStore(store, (state) => state.dirty);
  const frozenCommand = useStore(store, (state) => state.command);
  const actions = useStore(store, (state) => state.actions);
  const client = useQueryClient();
  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  const composing = useRef(false);
  const [message, setMessage] = useState('');
  const [latest, setLatest] = useState<Activity | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const targetId = target.mode === 'edit' ? target.activityId : null;
  const validTarget = targetId === null || z.uuid().safeParse(targetId).success;
  const key = ['users', athleteId, 'sessions', sessionId, 'activity-editor'];
  const record = useQuery({
    queryKey: [...key, 'record', targetId],
    enabled: targetId !== null && validTarget,
    queryFn: async ({ signal }) => {
      const result = await transport.request({
        path: `/bff/v1/activities/${targetId}`,
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal,
      });
      if (signal.aborted || result.status !== 200) throw new Error('RECORD_UNAVAILABLE');
      const value = activitySchema.parse(result.body);
      if (value.id !== targetId) throw new Error('RECORD_MISMATCH');
      return value;
    },
  });
  const plans = useQuery({
    queryKey: [...key, 'plans'],
    queryFn: async ({ signal }) => {
      const result = await transport.request({
        path: '/bff/v1/plans/current',
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal,
      });
      if (signal.aborted || result.status !== 200) throw new Error('PLAN_UNAVAILABLE');
      return planReadSchema.parse(result.body);
    },
  });
  useEffect(() => {
    if (record.data && !original && phase === 'draft') actions.load(record.data);
  }, [record.data, original, phase, actions]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
      actions.dispose();
    };
  }, [actions]);
  useEffect(() => {
    if (!dirty && !frozenCommand) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, frozenCommand]);
  const locked = phase === 'pending' || phase === 'uncertain' || reading;
  const switched = JSON.stringify(target) !== JSON.stringify(requestedTarget);
  const editable =
    phase === 'draft' &&
    !reading &&
    validTarget &&
    (target.mode === 'create' || (original !== null && !record.isError));
  function preview() {
    if (!editable || composing.current) return;
    const activity = {
      title: fields.title.trim() || null,
      kind: fields.kind,
      startedAt: fields.startedAt || null,
      timezone: fields.timezone || null,
      distanceMeters: fields.distance === '' ? null : Number(fields.distance),
      durationSeconds: fields.duration === '' ? null : Number(fields.duration),
      durationKind: fields.durationKind,
    };
    const report = {
      sessionRpe: fields.sessionRpe === '' ? null : Number(fields.sessionRpe),
      note: fields.note.trim() || null,
      planLink: fields.planLink,
    };
    const idempotencyKey = createId();
    const result =
      target.mode === 'create'
        ? manualActivityCreateSchema.safeParse({
            confirmed: true,
            activity,
            report,
            idempotencyKey,
          })
        : activityOverlayWriteSchema.safeParse({
            ...activity,
            report,
            reason: fields.reason,
            expectedRevision: original?.revision,
            idempotencyKey,
          });
    if (!result.success) {
      setMessage(
        '필수 제목·시작 시각·시간대, 0 이상의 거리·시간, 0~10 RPE와 정정 사유를 확인하세요. 시각에는 시간차를 포함하세요.',
      );
      return;
    }
    const { idempotencyKey: validatedKey, ...body } = result.data;
    actions.preview({
      path:
        target.mode === 'create' ? '/bff/v1/activities' : `/bff/v1/activities/${target.activityId}`,
      method: target.mode === 'create' ? 'POST' : 'PATCH',
      body: z.json().parse(body),
      idempotencyKey: validatedKey,
    });
    setMessage('');
    setDiscard(false);
  }
  async function readCurrent(id: string, mode: 'saved' | 'conflict') {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setReading(true);
    setLatest(null);
    try {
      const result = await transport.request({
        path: `/bff/v1/activities/${id}`,
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal: controller.signal,
      });
      if (!active.current || controller.signal.aborted) return;
      if (result.status !== 200) {
        setMessage(
          mode === 'saved'
            ? '저장은 확인되었지만 현재 기록이 삭제되었거나 조회할 수 없습니다.'
            : '최신 기록을 확인하지 못했습니다. 작성 내용은 유지됩니다.',
        );
        return;
      }
      const value = activitySchema.parse(result.body);
      if (value.id !== id) throw new Error('RECORD_MISMATCH');
      setLatest(value);
      client.setQueryData([...key, 'record', id], value);
      setMessage(
        mode === 'saved'
          ? '활동 저장이 확인되었습니다.'
          : '최신 원본과 작성 내용을 비교한 뒤 다시 정정하세요.',
      );
    } catch {
      if (active.current && !controller.signal.aborted)
        setMessage(
          mode === 'saved'
            ? '저장은 확인되었지만 최신 기록 조회에 실패했습니다.'
            : '최신 기록을 확인하지 못했습니다. 작성 내용은 유지됩니다.',
        );
    } finally {
      if (request.current === controller) request.current = null;
      if (active.current && !controller.signal.aborted) setReading(false);
    }
  }
  async function save(command: EditorCommand) {
    if (
      request.current ||
      !active.current ||
      !['preview', 'uncertain'].includes(store.getState().phase)
    )
      return;
    const controller = new AbortController();
    request.current = controller;
    actions.phase('pending');
    setMessage('');
    let committedId: string | null = null;
    try {
      const result = await transport.request({ ...command, signal: controller.signal });
      if (!active.current || controller.signal.aborted) return;
      if (result.status === 409) {
        actions.phase('conflict');
        setMessage(
          '기록이 변경되었거나 요청이 충돌했습니다. 작성 내용은 유지됩니다. 최신 기록을 확인하세요.',
        );
        return;
      }
      if (result.status === 400) {
        actions.phase('conflict');
        actions.edit();
        setMessage(
          '입력이 거절되었습니다. 활동 시각·계획 연결을 확인하세요. 미래 활동은 기록할 수 없습니다. 작성 내용은 유지됩니다.',
        );
        return;
      }
      if (result.status === 404) {
        actions.phase('conflict');
        setMessage(
          '활동 시각·계획 연결 또는 기록 상태를 확인하세요. 미래 활동은 기록할 수 없습니다. 작성 내용은 유지됩니다.',
        );
        return;
      }
      if (result.status !== 200) throw new Error('UNCONFIRMED');
      if (command.method === 'POST')
        committedId = manualActivityResultSchema.parse(result.body).activityId;
      else {
        const receipt = activitySchema.parse(result.body);
        if (receipt.id !== targetId) throw new Error('RECEIPT_MISMATCH');
        committedId = receipt.id;
      }
      actions.phase('saved');
      setSavedId(committedId);
      setLatest(null);
      setDiscard(false);
      setMessage('활동 저장이 확인되었습니다. 최신 기록을 확인합니다.');
      await client.cancelQueries({ queryKey: [...key, 'record'] });
    } catch {
      if (active.current && !controller.signal.aborted) {
        actions.phase('uncertain');
        setMessage('저장 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.');
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
    if (committedId && active.current && !controller.signal.aborted)
      await readCurrent(committedId, 'saved');
  }
  function reset() {
    if (locked || request.current) return false;
    if (phase === 'saved' && target.mode === 'edit' && !latest) {
      setMessage('최신 기록을 확인한 뒤 편집을 다시 시작하세요.');
      return false;
    }
    actions.reset();
    setLatest(null);
    setMessage('');
    setSavedId(null);
    setDiscard(false);
    return true;
  }
  return (
    <section className={styles.workspace} aria-label="활동 입력과 정정">
      <h2>{target.mode === 'create' ? '수동 활동 입력' : '활동 정정'}</h2>
      <p>실제로 수행한 활동을 직접 기록합니다. 계획이나 제안은 실제 수행 기록이 아닙니다.</p>
      <a
        href={listHref}
        onClick={(event) => {
          if (locked || request.current) {
            event.preventDefault();
            return;
          }
          if (dirty || frozenCommand) {
            event.preventDefault();
            setLeaving(true);
          }
        }}
      >
        활동 목록으로
      </a>
      {leaving ? (
        <div role="alert">
          <p>작성 내용을 버리고 목록으로 이동할까요?</p>
          {locked ? (
            <p>요청 결과를 확인한 뒤 이동하세요.</p>
          ) : (
            <a
              href={listHref}
              onClick={(event) => {
                if (request.current || ['pending', 'uncertain'].includes(store.getState().phase))
                  event.preventDefault();
              }}
            >
              초안 버리고 목록으로
            </a>
          )}
          <Button disabled={locked} onClick={() => setLeaving(false)}>
            목록 이동 취소
          </Button>
        </div>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {!validTarget ? <p role="alert">활동 주소가 올바르지 않습니다.</p> : null}
      {record.isFetching && target.mode === 'edit' ? (
        <p role="status">원본 기록을 확인하고 있습니다.</p>
      ) : null}
      {record.isError ? (
        <p role="alert">
          기록을 확인할 수 없습니다.{' '}
          <Button onClick={() => void record.refetch()}>원본 다시 확인</Button>
        </p>
      ) : null}
      {switched ? (
        <div role="alert">
          <p>다른 기록으로 이동 요청되었습니다. 현재 작성 내용은 유지됩니다.</p>
          <Button
            disabled={locked}
            onClick={() => {
              if (locked || request.current) return;
              if (reset()) setTarget(requestedTarget);
            }}
          >
            작성 내용 버리고 대상 전환
          </Button>
        </div>
      ) : null}
      {plans.isError ? (
        <p role="alert">
          계획을 불러오지 못했습니다. 기존 연결은 유지됩니다.{' '}
          <Button onClick={() => void plans.refetch()}>계획 다시 확인</Button>
        </p>
      ) : null}
      <form
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDownCapture={(event) => {
          if (
            event.key === 'Enter' &&
            (composing.current ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229)
          )
            event.preventDefault();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          preview();
        }}
      >
        <fieldset disabled={!editable}>
          <legend>실제 활동과 사용자 보고</legend>
          <EditorFields
            fields={fields}
            editing={target.mode === 'edit'}
            plans={plans.isError ? undefined : plans.data}
            change={actions.change}
          />
          <Button type="submit">활동 저장 미리보기</Button>
        </fieldset>
      </form>
      {original ? <RecordPreview record={original} label="정정 기준 원본" /> : null}
      {phase !== 'draft' ? <EditorPreview fields={fields} /> : null}
      {phase === 'preview' ? (
        <div className={styles.actions}>
          <Button
            onClick={() => {
              if (frozenCommand) void save(frozenCommand);
            }}
          >
            실제 활동 확인하고 저장
          </Button>
          <Button variant="secondary" onClick={actions.edit}>
            입력으로 돌아가기
          </Button>
        </div>
      ) : null}
      {phase === 'pending' ? <p role="status">활동을 저장하고 있습니다.</p> : null}
      {phase === 'uncertain' ? (
        <>
          <p role="alert">같은 요청의 결과가 확인될 때까지 입력·폐기·대상 전환을 잠급니다.</p>
          <Button
            onClick={() => {
              if (frozenCommand) void save(frozenCommand);
            }}
          >
            같은 활동 요청 다시 시도
          </Button>
        </>
      ) : null}
      {phase === 'conflict' && target.mode === 'edit' ? (
        <Button disabled={reading} onClick={() => void readCurrent(target.activityId, 'conflict')}>
          최신 활동 비교
        </Button>
      ) : null}
      {latest ? (
        <RecordPreview
          record={latest}
          label={phase === 'saved' ? '저장 후 현재 기록' : '최신 활동 원본'}
        />
      ) : null}
      {phase === 'conflict' && latest ? (
        <Button
          disabled={reading}
          onClick={() => {
            actions.rebase(latest);
            setLatest(null);
            setMessage('작성 내용을 유지하고 최신 수정 번호로 다시 정정을 준비했습니다.');
          }}
        >
          작성 내용 유지하고 다시 정정 준비
        </Button>
      ) : null}
      {phase === 'conflict' && target.mode === 'create' ? (
        <Button
          onClick={() => {
            actions.edit();
            setMessage('');
          }}
        >
          작성 내용 유지하고 입력 다시 확인
        </Button>
      ) : null}
      {phase === 'saved' && savedId ? (
        <>
          <p>
            <a href={activityHref(savedId)}>저장된 활동 상세 보기</a>
          </p>
          <Button disabled={reading} onClick={() => void readCurrent(savedId, 'saved')}>
            저장된 활동 다시 확인
          </Button>
        </>
      ) : null}
      <Button variant="secondary" disabled={locked} onClick={() => setDiscard(true)}>
        활동 초안 버리기
      </Button>
      {discard ? (
        <div role="alert">
          <p>작성한 내용을 버릴까요?</p>
          <Button disabled={locked} onClick={reset}>
            활동 초안 폐기 확인
          </Button>
          <Button variant="secondary" disabled={locked} onClick={() => setDiscard(false)}>
            계속 작성
          </Button>
        </div>
      ) : null}
    </section>
  );
}
