'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from 'zustand';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import {
  checkInDefinition,
  checkInSchema,
  checkInListSchema,
  checkInValuesSchema,
  checkInCreateSchema,
  checkInUpdateSchema,
  checkInDeleteSchema,
  checkInCommandResultSchema,
  type CheckIn,
} from '@workout/contracts/check-ins';
import { instantSchema, timeZoneSchema } from '@workout/contracts/primitives';
import { Button } from '@workout/ui-foundation/button';
import { createCheckInDraftStore, type CheckInFields } from './draft-store';
import { changeWellbeingSearch, localDateAt, readWellbeingSearch } from './search';
import styles from './wellbeing.module.css';

export interface WellbeingWorkspaceProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  search: string;
  onSearchChange(query: string): void;
  initialObservedAt: string;
  initialTimezone: string;
  createId?: () => string;
}
const randomId = () => crypto.randomUUID();
export function WellbeingWorkspace(props: WellbeingWorkspaceProps) {
  instantSchema.parse(props.initialObservedAt);
  timeZoneSchema.parse(props.initialTimezone);
  return <Lifetime key={JSON.stringify([props.athleteId, props.sessionId])} {...props} />;
}
function Lifetime(props: WellbeingWorkspaceProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  const [store] = useState(() =>
    createCheckInDraftStore(props.initialObservedAt, props.initialTimezone),
  );
  useEffect(
    () => () => {
      client.clear();
      store.getState().actions.reset();
    },
    [client, store],
  );
  return (
    <QueryClientProvider client={client}>
      <Workspace {...props} store={store} />
    </QueryClientProvider>
  );
}
type PendingCommand = {
  operation: 'create' | 'edit' | 'delete';
  path: string;
  method: 'POST' | 'PUT' | 'DELETE';
  body: TransportRequest['body'];
  idempotencyKey: string;
};
const conflictSchema = z.object({ error: z.object({ code: z.string() }) });
function RecordValues({ record }: { record: CheckIn }) {
  return (
    <dl className={styles.values}>
      <dt>관측 시각</dt>
      <dd>
        {record.values.observedAt} · {record.values.timezone}
      </dd>
      <dt>현지 날짜</dt>
      <dd>{record.localDate}</dd>
      <dt>피로</dt>
      <dd>{record.values.fatigue ?? checkInDefinition.missing}</dd>
      <dt>불편감</dt>
      <dd>{record.values.discomfort ?? checkInDefinition.missing}</dd>
      <dt>부위</dt>
      <dd>{record.values.bodyLocation ?? checkInDefinition.missing}</dd>
      <dt>메모</dt>
      <dd>{record.values.note ?? checkInDefinition.missing}</dd>
      <dt>출처</dt>
      <dd>사용자 보고 · 자기 보고 · 정의 {record.definitionVersion}</dd>
      <dt>기록 시각</dt>
      <dd>{record.recordedAt}</dd>
      <dt>마지막 정정</dt>
      <dd>
        {record.updatedAt} · 수정 {record.revision}
      </dd>
    </dl>
  );
}
function Workspace({
  store,
  athleteId,
  sessionId,
  transport,
  search,
  onSearchChange,
  initialObservedAt,
  initialTimezone,
  createId = randomId,
}: WellbeingWorkspaceProps & { store: ReturnType<typeof createCheckInDraftStore> }) {
  const client = useQueryClient();
  const draft = useStore(store, (state) => state.draft);
  const dirty = useStore(store, (state) => state.dirty);
  const actions = useStore(store, (state) => state.actions);
  const id = useId();
  const active = useRef(true);
  const composing = useRef(false);
  const request = useRef<AbortController | null>(null);
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [validation, setValidation] = useState('');
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<CheckIn | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<CheckIn | 'new' | null>(null);
  const today = localDateAt(initialObservedAt, initialTimezone);
  const parsed = readWellbeingSearch(search, today);
  const params = new URLSearchParams(search);
  const selected = params.get('selected');
  const selectedId = z.uuid().safeParse(selected);
  const prefix = ['users', athleteId, 'sessions', sessionId, 'check-ins'];
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
    };
  }, []);
  const list = useQuery({
    queryKey: [...prefix, 'list', parsed.query],
    enabled: parsed.query !== null,
    queryFn: async ({ signal }) => {
      if (!parsed.query) throw new Error('INVALID_FILTER');
      const query = new URLSearchParams(
        Object.entries(parsed.query).map(([key, value]) => [key, String(value)]),
      );
      const result = await transport.request({
        path: `/bff/v1/check-ins?${query}`,
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal,
      });
      if (result.status !== 200) throw new Error('LIST_UNAVAILABLE');
      return checkInListSchema.parse(result.body);
    },
  });
  const detail = useQuery({
    queryKey: [...prefix, 'detail', selected],
    enabled: selectedId.success,
    queryFn: async ({ signal }) => {
      const result = await transport.request({
        path: `/bff/v1/check-ins/${selectedId.success ? selectedId.data : ''}`,
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal,
      });
      if (result.status !== 200)
        throw new Error(result.status === 404 ? 'NOT_FOUND' : 'DETAIL_UNAVAILABLE');
      return checkInSchema.parse(result.body);
    },
  });
  const locked = busy || pending !== null;
  useEffect(() => {
    if (!dirty && pending === null) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, pending]);
  function navigate(changes: Record<string, string | null>) {
    onSearchChange(changeWellbeingSearch(search, changes));
  }
  function change(field: keyof CheckInFields, value: string) {
    actions.change(field, value);
    setValidation('');
  }
  function beginEdit(target: CheckIn | 'new') {
    if (locked) return;
    if (dirty) {
      setSwitchTarget(target);
      return;
    }
    replaceDraft(target);
  }
  function replaceDraft(target: CheckIn | 'new') {
    if (locked || request.current) return;
    if (target === 'new') actions.reset();
    else actions.edit(target);
    setSwitchTarget(null);
    setConflict(false);
    setLatest(null);
    setDeleteConfirmation(false);
    setValidation('');
    setNotice('');
  }
  async function execute(command: PendingCommand) {
    if (request.current || !active.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setPending(command);
    setNotice('');
    let committed = false;
    try {
      const { operation: _operation, ...input } = command;
      const result = await transport.request({ ...input, signal: controller.signal });
      if (!active.current || controller.signal.aborted) return;
      if (result.status === 409) {
        const code = conflictSchema.safeParse(result.body);
        setPending(null);
        setConflict(true);
        setNotice(
          code.success && code.data.error.code === 'IDEMPOTENCY_CONFLICT'
            ? '저장 요청이 이전 요청과 충돌했습니다. 작성 내용은 유지됩니다. 최신 기록을 확인하세요.'
            : '다른 변경으로 기록이 달라졌습니다. 작성 내용은 유지됩니다. 최신 기록을 확인한 뒤 다시 정정하세요.',
        );
        return;
      }
      if (result.status === 400 || result.status === 404) {
        setPending(null);
        setNotice(
          result.status === 404
            ? '기록이 삭제되었거나 접근할 수 없습니다. 작성 내용은 유지됩니다.'
            : '입력 내용을 저장할 수 없습니다. 관측 시각·시간대·보고 값과 정정 사유를 확인하세요.',
        );
        return;
      }
      if (result.status !== 200) throw new Error('UNCONFIRMED');
      const receipt = checkInCommandResultSchema.parse(result.body);
      committed = true;
      setSwitchTarget(null);
      setPending(null);
      actions.reset();
      setConflict(false);
      setLatest(null);
      setDeleteConfirmation(false);
      setNotice(
        command.operation === 'delete'
          ? '삭제가 확인되었습니다. 최신 목록을 확인하고 있습니다.'
          : '저장이 확인되었습니다. 최신 목록을 확인하고 있습니다.',
      );
      if (command.operation === 'delete') navigate({ selected: null });
      await client.cancelQueries({ queryKey: prefix });
      await client.resetQueries(
        {
          queryKey: prefix,
          predicate: (query) =>
            command.operation !== 'delete' ||
            query.queryKey[5] !== 'detail' ||
            query.queryKey[6] !== receipt.id,
        },
        { throwOnError: true },
      );
      if (command.operation === 'delete')
        client.removeQueries({ queryKey: [...prefix, 'detail', receipt.id], exact: true });
      if (active.current && !controller.signal.aborted)
        setNotice(
          command.operation === 'delete' ? '삭제가 확인되었습니다.' : '저장이 확인되었습니다.',
        );
    } catch {
      if (active.current && !controller.signal.aborted)
        setNotice(
          committed
            ? '저장 또는 삭제는 확인되었지만 최신 조회를 확인하지 못했습니다. 목록을 다시 확인하세요.'
            : '요청 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.',
        );
    } finally {
      if (request.current === controller) request.current = null;
      if (active.current && !controller.signal.aborted) setBusy(false);
    }
  }
  function save() {
    if (locked || conflict) return;
    const values = checkInValuesSchema.safeParse({
      observedAt: draft.fields.observedAt,
      timezone: draft.fields.timezone,
      fatigue: draft.fields.fatigue === '' ? null : Number(draft.fields.fatigue),
      discomfort: draft.fields.discomfort === '' ? null : Number(draft.fields.discomfort),
      bodyLocation: draft.fields.bodyLocation.trim() || null,
      note: draft.fields.note.trim() || null,
    });
    if (!values.success) {
      setValidation(
        '관측 시각은 시간차가 포함된 ISO 형식, 시간대는 지역 이름으로 입력하세요. 피로·불편감은 0~10 정수 또는 보고하지 않음을 선택하고, 보고 내용을 하나 이상 입력하세요.',
      );
      return;
    }
    const key = createId();
    const command =
      draft.mode === 'create'
        ? checkInCreateSchema.safeParse({ idempotencyKey: key, values: values.data })
        : checkInUpdateSchema.safeParse({
            idempotencyKey: key,
            values: values.data,
            expectedRevision: draft.original.revision,
            reason: draft.fields.reason,
          });
    if (!command.success) {
      setValidation('정정 사유를 1~500자로 입력하세요.');
      return;
    }
    const { idempotencyKey, ...body } = command.data;
    void execute({
      operation: draft.mode,
      method: draft.mode === 'create' ? 'POST' : 'PUT',
      path:
        draft.mode === 'create' ? '/bff/v1/check-ins' : `/bff/v1/check-ins/${draft.original.id}`,
      body,
      idempotencyKey,
    });
  }
  function remove() {
    if (locked || conflict || !deleteConfirmation || draft.mode !== 'edit') return;
    const { idempotencyKey, ...body } = checkInDeleteSchema.parse({
      idempotencyKey: createId(),
      expectedRevision: draft.original.revision,
    });
    void execute({
      operation: 'delete',
      path: `/bff/v1/check-ins/${draft.original.id}`,
      method: 'DELETE',
      body,
      idempotencyKey,
    });
  }
  async function readLatest() {
    if (draft.mode !== 'edit' || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setLatest(null);
    try {
      const result = await transport.request({
        path: `/bff/v1/check-ins/${draft.original.id}`,
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal: controller.signal,
      });
      if (!active.current || controller.signal.aborted) return;
      if (result.status !== 200) throw new Error('LATEST_UNAVAILABLE');
      setLatest(checkInSchema.parse(result.body));
    } catch {
      if (active.current && !controller.signal.aborted)
        setNotice('최신 기록을 확인하지 못했습니다. 작성 내용은 유지됩니다.');
    } finally {
      if (request.current === controller) request.current = null;
      if (active.current && !controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className={styles.workspace} aria-labelledby={`${id}-heading`}>
      <h1 id={`${id}-heading`}>회복·체크인</h1>
      <p>피로와 신체 불편감을 직접 기록합니다. 보고하지 않은 값은 0으로 처리하지 않습니다.</p>
      <details>
        <summary>보고 척도와 출처 안내</summary>
        <p>{checkInDefinition.limitation}</p>
        <p>
          피로: 0 {checkInDefinition.fatigue.low} ~ 10 {checkInDefinition.fatigue.high}. 불편감: 0{' '}
          {checkInDefinition.discomfort.low} ~ 10 {checkInDefinition.discomfort.high}.
        </p>
        <p>
          출처: 사용자 · 자기 보고 · 정의 {checkInDefinition.version}. 기기 지표와 별도의
          기록입니다.
        </p>
      </details>
      <div className={styles.layout}>
        <section aria-label="체크인 작성">
          <h2>{draft.mode === 'create' ? '새 체크인' : '체크인 정정'}</h2>
          {notice ? <p role="status">{notice}</p> : null}
          {validation ? <p role="alert">{validation}</p> : null}
          {pending ? (
            <p role="alert">
              저장 결과가 불확실하면 같은 요청으로 재시도합니다. 작성 내용은 보존됩니다.
            </p>
          ) : null}
          {pending && !busy ? (
            <Button onClick={() => void execute(pending)}>같은 요청 다시 시도</Button>
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
              if (!composing.current) save();
            }}
          >
            <fieldset disabled={locked}>
              <legend>사용자 보고</legend>
              <label>
                관측 시각 (시간차 포함 ISO)
                <input
                  value={draft.fields.observedAt}
                  onChange={(event) => change('observedAt', event.target.value)}
                  placeholder="2026-09-16T09:00:00+09:00"
                />
              </label>
              <label>
                관측 시간대
                <input
                  value={draft.fields.timezone}
                  onChange={(event) => change('timezone', event.target.value)}
                  placeholder="Asia/Seoul"
                />
              </label>
              {(['fatigue', 'discomfort'] as const).map((field) => (
                <div key={field}>
                  <label>
                    {field === 'fatigue' ? '피로 (0~10)' : '불편감 (0~10)'}
                    <select
                      aria-describedby={`${id}-${field}-question`}
                      value={draft.fields[field]}
                      onChange={(event) => change(field, event.target.value)}
                    >
                      <option value="">보고하지 않음</option>
                      {Array.from({ length: 11 }, (_, value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p id={`${id}-${field}-question`}>
                    {checkInDefinition[field].question} 0: {checkInDefinition[field].low} · 10:{' '}
                    {checkInDefinition[field].high}
                  </p>
                </div>
              ))}
              <label>
                불편한 부위
                <input
                  maxLength={200}
                  value={draft.fields.bodyLocation}
                  onChange={(event) => change('bodyLocation', event.target.value)}
                />
              </label>
              <label>
                체크인 메모
                <textarea
                  maxLength={2000}
                  value={draft.fields.note}
                  onChange={(event) => change('note', event.target.value)}
                />
              </label>
              {draft.mode === 'edit' ? (
                <label>
                  정정 사유
                  <textarea
                    maxLength={500}
                    value={draft.fields.reason}
                    onChange={(event) => change('reason', event.target.value)}
                  />
                </label>
              ) : null}
              <Button type="submit" disabled={conflict}>
                {draft.mode === 'create' ? '체크인 저장' : '정정 저장'}
              </Button>
            </fieldset>
          </form>
          <Button variant="secondary" disabled={locked} onClick={() => beginEdit('new')}>
            새 체크인 작성
          </Button>
          {switchTarget ? (
            <div role="alert">
              <p>작성 중인 내용을 버리고 전환할까요?</p>
              <Button disabled={locked} onClick={() => replaceDraft(switchTarget)}>
                작성 내용 버리고 전환
              </Button>
              <Button variant="secondary" disabled={locked} onClick={() => setSwitchTarget(null)}>
                계속 작성
              </Button>
            </div>
          ) : null}
          {draft.mode === 'edit' ? (
            <>
              <details>
                <summary>정정 기준 원본 · 수정 {draft.original.revision}</summary>
                <RecordValues record={draft.original} />
              </details>
              {conflict ? (
                <Button disabled={locked} onClick={() => void readLatest()}>
                  최신 기록 확인
                </Button>
              ) : null}
              {latest ? (
                <section aria-label="최신 원본 비교">
                  <h3>최신 원본 · 수정 {latest.revision}</h3>
                  <RecordValues record={latest} />
                  <Button
                    disabled={locked}
                    onClick={() => {
                      actions.rebase(latest);
                      setConflict(false);
                      setLatest(null);
                      setDeleteConfirmation(false);
                      setNotice(
                        '작성 내용을 유지하고 최신 원본을 기준으로 정정을 준비했습니다. 다시 확인한 뒤 저장하세요.',
                      );
                    }}
                  >
                    작성한 내용으로 다시 정정 준비
                  </Button>
                </section>
              ) : null}
              <fieldset disabled={locked || conflict}>
                <legend>체크인 삭제</legend>
                <label className={styles.confirm}>
                  <input
                    type="checkbox"
                    checked={deleteConfirmation}
                    onChange={(event) => setDeleteConfirmation(event.target.checked)}
                  />
                  이 체크인을 삭제합니다
                </label>
                <Button variant="secondary" disabled={!deleteConfirmation} onClick={remove}>
                  체크인 삭제
                </Button>
              </fieldset>
            </>
          ) : null}
        </section>
        <section aria-label="체크인 기록">
          <h2>체크인 기록</h2>
          <form
            key={`${parsed.query?.from}:${parsed.query?.toExclusive}`}
            className={styles.filters}
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              navigate({
                from: String(form.get('from')),
                toExclusive: String(form.get('toExclusive')),
                offset: null,
              });
            }}
          >
            <label>
              조회 시작일
              <input
                type="date"
                name="from"
                required
                defaultValue={parsed.query?.from ?? params.get('from') ?? today}
              />
            </label>
            <label>
              조회 종료일 (이 날짜 제외)
              <input
                type="date"
                name="toExclusive"
                required
                defaultValue={parsed.query?.toExclusive ?? params.get('toExclusive') ?? today}
              />
            </label>
            <Button type="submit">기간 적용</Button>
          </form>
          {parsed.error ? <p role="alert">{parsed.error}</p> : null}
          {list.isFetching ? <p role="status">체크인 목록을 불러오고 있습니다.</p> : null}
          {list.isError ? (
            <div role="alert">
              최신 목록을 확인하지 못했습니다.{' '}
              <Button onClick={() => void list.refetch()}>목록 다시 확인</Button>
            </div>
          ) : null}
          {list.isSuccess && !list.isFetching ? (
            <>
              <p>
                전체 {list.data.total}개 · 조회된 {list.data.items.length}개
              </p>
              {list.data.items.length === 0 ? (
                <p>이 기간에 기록한 체크인이 없습니다.</p>
              ) : (
                <ul className={styles.records}>
                  {list.data.items.map((record) => (
                    <li key={record.id}>
                      <article>
                        <p>
                          {record.localDate} · 피로 {record.values.fatigue ?? '보고하지 않음'} ·
                          불편감 {record.values.discomfort ?? '보고하지 않음'}
                        </p>
                        <Button
                          variant="secondary"
                          onClick={() => navigate({ selected: record.id })}
                        >
                          기록 상세 보기 · {record.values.observedAt}
                        </Button>
                        <p>{record.values.note ?? '메모 보고하지 않음'}</p>
                      </article>
                    </li>
                  ))}
                </ul>
              )}
              <div className={styles.actions}>
                <Button
                  variant="secondary"
                  disabled={!parsed.query || parsed.query.offset === 0}
                  onClick={() =>
                    navigate({ offset: String(Math.max(0, (parsed.query?.offset ?? 0) - 20)) })
                  }
                >
                  이전 기록
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    !parsed.query ||
                    parsed.query.offset + 20 >= list.data.total ||
                    parsed.query.offset + 20 > 10000
                  }
                  onClick={() => navigate({ offset: String((parsed.query?.offset ?? 0) + 20) })}
                >
                  다음 기록
                </Button>
              </div>
            </>
          ) : null}
          {selected && !selectedId.success ? (
            <p role="alert">선택한 기록 주소가 올바르지 않습니다.</p>
          ) : null}
          {selectedId.success ? (
            <section aria-label="선택한 체크인">
              <h3>선택한 체크인</h3>
              {detail.isFetching ? <p role="status">선택한 기록을 확인하고 있습니다.</p> : null}
              {detail.isError ? (
                <div role="alert">
                  기록이 삭제되었거나 불러올 수 없습니다.{' '}
                  <Button onClick={() => void detail.refetch()}>기록 다시 확인</Button>
                </div>
              ) : null}
              {detail.isSuccess && !detail.isFetching ? (
                <>
                  <RecordValues record={detail.data} />
                  <Button disabled={locked} onClick={() => beginEdit(detail.data)}>
                    이 기록 정정
                  </Button>
                </>
              ) : null}
              <Button variant="secondary" onClick={() => navigate({ selected: null })}>
                상세 닫기
              </Button>
            </section>
          ) : null}
        </section>
      </div>
    </section>
  );
}
