import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useQueryClient } from '@tanstack/react-query';
import { activityTagSchema } from '@workout/contracts/activity';
import { type AuthenticatedTransport } from '@workout/contracts/core';
import { Button } from '@workout/ui-foundation/button';
import type { BatchSelectionStore } from './batch-selection';
import {
  prepareActivityBatchTags,
  runActivityBatchTags,
  type TagOperation,
  type PreparedTags,
  type TagsPreviewResult,
  type BatchTagsResult,
} from './batch-tags-command';
import styles from './activity-batch-tags.module.css';
export interface ActivityBatchTagsProps {
  store: BatchSelectionStore;
  transport: AuthenticatedTransport;
  scope: string[];
  createId?: () => string;
}
export function ActivityBatchTags(props: ActivityBatchTagsProps) {
  return <Controller key={JSON.stringify(props.scope)} {...props} />;
}
const tagsText = (tags: string[] | undefined) =>
  tags === undefined
    ? '없음 (이전 형식에 값 없음)'
    : tags.length
      ? tags.join(' · ')
      : '없음 (명시적으로 비움)';
const previewLabels = {
  unchanged: '같은 태그 상태: 변경하지 않음',
  limit_exceeded: '태그 최대 20개 초과: 변경할 수 없음',
  conflict: '수정 충돌: 최신 기록 확인 필요',
  unavailable: '기록 없음 또는 접근 불가',
  read_error: '기존 태그 조회 실패',
  reauth_required: '로그인 재확인 필요',
  not_attempted: '조회하지 않음',
};
const resultLabels = {
  applied: '태그 변경 확인',
  conflict: '수정 충돌: 최신 기록 확인 필요',
  unavailable: '기록 없음 또는 접근 불가',
  invalid_input: '태그 또는 정정 사유 확인 필요',
  uncertain: '변경 결과 미확인',
  reauth_required: '로그인 재확인 필요',
  not_attempted: '실행하지 않음',
};
function Controller({
  store,
  transport,
  scope,
  createId = () => crypto.randomUUID(),
}: ActivityBatchTagsProps) {
  const targets = useStore(store, (state) => state.targets),
    locked = useStore(store, (state) => state.locked);
  const client = useQueryClient();
  const [mode, setMode] = useState<TagOperation>('add'),
    [tag, setTag] = useState(''),
    [reason, setReason] = useState('');
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'preview' | 'pending' | 'result'>(
    'idle',
  );
  const [preview, setPreview] = useState<TagsPreviewResult[]>([]),
    [results, setResults] = useState<BatchTagsResult[]>([]);
  const [frozen, setFrozen] = useState<{
    tag: string;
    operation: TagOperation;
    reason: string;
  } | null>(null);
  const [error, setError] = useState(''),
    [cacheError, setCacheError] = useState(false);
  const ownsLock = useRef(false);
  const active = useRef(true),
    request = useRef<AbortController | null>(null),
    focusBack = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
      if (ownsLock.current) store.getState().setLocked(false);
    };
  }, [store]);
  useLayoutEffect(() => {
    if (phase === 'idle' && focusBack.current) {
      focusBack.current = false;
      if (trigger.current && !trigger.current.disabled) trigger.current.focus();
      else heading.current?.focus();
    }
  }, [phase]);
  const focusCancel = useCallback((node: HTMLButtonElement | null) => node?.focus(), []);
  function close() {
    if (phase === 'pending') return;
    request.current?.abort();
    request.current = null;
    store.getState().setLocked(false);
    ownsLock.current = false;
    focusBack.current = true;
    setPhase('idle');
    setPreview([]);
    setResults([]);
    setFrozen(null);
  }
  async function prepare() {
    const state = store.getState();
    if (state.locked || !state.targets.length || request.current) return;
    const parsedTag = activityTagSchema.safeParse(tag);
    if (!parsedTag.success || !reason.trim() || reason.trim().length > 500) {
      setError(
        '태그는 공백 정리 후 1–40자이며 제어 문자를 포함할 수 없습니다. 1–500자 정정 사유도 입력하세요.',
      );
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    state.setLocked(true);
    ownsLock.current = true;
    setPhase('preparing');
    setError('');
    setCacheError(false);
    setFrozen({ tag: parsedTag.data, operation: mode, reason: reason.trim() });
    try {
      const prepared = await prepareActivityBatchTags({
        targets: state.targets.map((target) => ({ ...target })),
        tag: parsedTag.data,
        operation: mode,
        reason: reason.trim(),
        transport,
        signal: controller.signal,
        createId,
      });
      if (!active.current || controller.signal.aborted || request.current !== controller) return;
      const rejected = prepared.filter(
        (item) => item.status === 'conflict' || item.status === 'unavailable',
      );
      store
        .getState()
        .remove(
          rejected
            .filter((item) =>
              store
                .getState()
                .targets.some(
                  (target) =>
                    target.id === item.target.id && target.revision === item.target.revision,
                ),
            )
            .map((item) => item.target.id),
        );
      setPreview(prepared);
      setPhase('preview');
    } catch {
      if (active.current && !controller.signal.aborted && request.current === controller) {
        setError('변경 전 기록을 확인하지 못했습니다. 취소 후 다시 조회하세요.');
        setPhase('preview');
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }
  async function refresh(signal: AbortSignal) {
    try {
      await client.cancelQueries({ queryKey: scope });
      if (!active.current || signal.aborted) return;
      await client.resetQueries({ queryKey: scope }, { throwOnError: true });
    } catch {
      if (active.current && !signal.aborted) setCacheError(true);
    }
  }
  async function execute(prepared: PreparedTags[]) {
    if (!active.current || request.current || !prepared.length) return;
    const controller = new AbortController();
    request.current = controller;
    setPhase('pending');
    setCacheError(false);
    setError('');
    let changed = false;
    try {
      await runActivityBatchTags({
        prepared,
        transport,
        signal: controller.signal,
        onResult: (result) => {
          if (!active.current || controller.signal.aborted) return;
          setResults((previous) => [
            ...previous.filter((item) => item.prepared.target.id !== result.prepared.target.id),
            result,
          ]);
          if (
            result.status === 'applied' ||
            result.status === 'conflict' ||
            result.status === 'unavailable'
          ) {
            changed = true;
            const target = result.prepared.target;
            if (
              store
                .getState()
                .targets.some(
                  (current) => current.id === target.id && current.revision === target.revision,
                )
            )
              store.getState().remove([target.id]);
          }
        },
      });
      if (!active.current || controller.signal.aborted) return;
      if (changed) await refresh(controller.signal);
    } catch {
      if (active.current && !controller.signal.aborted)
        setError('실행 상태를 확인하지 못했습니다. 확인된 항목별 결과는 유지됩니다.');
    } finally {
      if (request.current === controller) request.current = null;
      if (active.current && !controller.signal.aborted) setPhase('result');
    }
  }
  const ready = preview.flatMap((item) => (item.status === 'ready' ? [item.prepared] : []));
  const auth =
    preview.some((item) => item.status === 'reauth_required') ||
    results.some((item) => item.status === 'reauth_required');
  const retries = results
    .filter((item) => item.status === 'uncertain')
    .map((item) => item.prepared);
  return (
    <section className={styles.panel} aria-label="선택 활동 일괄 태그">
      <h3 ref={heading} tabIndex={-1}>
        선택 활동 일괄 태그
      </h3>
      <p>
        현재 선택 {targets.length}개. 로컬 태그만 변경하며 거리·시간·RPE·메모·계획 연결·원본 출처를
        유지합니다.
      </p>
      {phase === 'idle' ? (
        <>
          <div className={styles.fields}>
            <label>
              일괄 태그 동작
              <select
                disabled={locked}
                value={mode}
                onChange={(event) => setMode(event.target.value === 'remove' ? 'remove' : 'add')}
              >
                <option value="add">태그 추가</option>
                <option value="remove">태그 제거</option>
              </select>
            </label>
            <label>
              변경할 로컬 태그
              <input
                disabled={locked}
                value={tag}
                onChange={(event) => setTag(event.target.value)}
              />
            </label>
            <label>
              일괄 태그 변경 사유
              <textarea
                disabled={locked}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          </div>
          <div className={styles.actions}>
            <Button
              ref={trigger}
              variant="secondary"
              disabled={locked || !targets.length}
              onClick={() => void prepare()}
            >
              태그 변경 미리보기
            </Button>
          </div>
          {locked ? (
            <p>
              다른 일괄 작업을 확인 중입니다. 그 작업을 닫으면 일괄 태그 동작을 시작할 수 있습니다.
            </p>
          ) : null}
        </>
      ) : (
        <div className={styles.preview} role="group" aria-label="일괄 태그 변경 확인">
          <p>
            변경할 태그: {frozen?.tag} · 동작: {frozen?.operation === 'remove' ? '제거' : '추가'} ·
            사유: {frozen?.reason}
          </p>
          <p>
            확인한 활동·수정 번호·기존 태그 값을 고정했습니다. 항목별로 처리하므로 일부만 변경될 수
            있습니다. 미리보기 조회는 변경을 저장하지 않습니다.
          </p>
          {preview.some(
            (item) =>
              item.status === 'conflict' ||
              item.status === 'unavailable' ||
              item.status === 'read_error',
          ) ||
          results.some(
            (item) =>
              item.status === 'conflict' ||
              item.status === 'unavailable' ||
              item.status === 'invalid_input',
          ) ? (
            <p>
              충돌하거나 사용할 수 없는 활동은 선택에서 해제합니다. 취소 또는 결과 닫기 후 활동
              목록을 새로 조회하고, 변경된 활동은 기존 선택을 해제한 뒤 다시 선택하세요. 조회 실패
              항목도 취소 후 다시 미리보기로 확인하세요. 수정 번호는 자동으로 올리지 않습니다.
            </p>
          ) : null}
          {phase === 'preparing' ? (
            <p role="status">선택한 활동의 기존 태그를 조회하고 있습니다.</p>
          ) : null}
          <ul className={styles.targets}>
            {preview.map((item) => {
              const target = item.status === 'ready' ? item.prepared.target : item.target;
              return (
                <li key={target.id}>
                  {target.title} · 수정 번호 {target.revision} ·{' '}
                  {item.status === 'ready' ? (
                    <>
                      이전 태그: {tagsText(item.prepared.previousTags)} → 새 태그:{' '}
                      {tagsText(item.prepared.command.tags)}
                    </>
                  ) : (
                    previewLabels[item.status]
                  )}{' '}
                  · 활동 ID {target.id}
                </li>
              );
            })}
          </ul>
          {phase === 'preview' || phase === 'preparing' ? (
            <div className={styles.actions}>
              {phase === 'preview' ? (
                <Button
                  variant="secondary"
                  disabled={!ready.length || auth}
                  onClick={() => void execute(ready)}
                >
                  태그 변경 확인
                </Button>
              ) : null}
              <Button ref={focusCancel} variant="secondary" onClick={close}>
                태그 변경 취소
              </Button>
            </div>
          ) : null}
          {phase === 'pending' ? (
            <p role="status">확인한 태그 변경을 항목별로 반영하고 있습니다.</p>
          ) : null}
          {results.length ? (
            <section aria-label="일괄 태그 변경 결과">
              <h4>활동별 태그 결과</h4>
              <ul className={styles.targets}>
                {results.map((item) => (
                  <li key={item.prepared.target.id}>
                    {item.prepared.target.title} · 수정 번호 {item.prepared.target.revision} ·{' '}
                    {resultLabels[item.status]} · 이전 태그: {tagsText(item.prepared.previousTags)}{' '}
                    → 새 태그: {tagsText(item.prepared.command.tags)} · 활동 ID{' '}
                    {item.prepared.target.id}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {phase === 'result' ? (
            <>
              <p>
                결과를 닫아도 반영된 변경은 취소되지 않습니다. 미확인 대상의 재확인은 같은 수정
                번호·내용·요청 식별자로 수행합니다.
              </p>
              <div className={styles.actions}>
                {retries.length && !auth ? (
                  <Button variant="secondary" onClick={() => void execute(retries)}>
                    미확인 태그 변경 다시 확인
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={close}>
                  태그 변경 결과 닫기
                </Button>
              </div>
            </>
          ) : null}
          {auth ? (
            <p role="alert">
              로그인을 다시 확인하세요. 남은 항목은 처리하지 않으며 여기서 재시도하지 않습니다.
            </p>
          ) : null}
        </div>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {cacheError ? (
        <p role="status">
          변경 응답은 확인했지만 최신 목록 조회에 실패했습니다. 확인된 변경 결과는 유지됩니다.
        </p>
      ) : null}
    </section>
  );
}
