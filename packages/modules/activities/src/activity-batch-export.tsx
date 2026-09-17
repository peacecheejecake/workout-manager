import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { Button } from '@workout/ui-foundation/button';
import type { BatchSelectionStore } from './batch-selection';
import {
  prepareActivityBatchExport,
  serializeActivityBatchExport,
  type ExportReadResult,
} from './batch-export-command';
import styles from './activity-batch-export.module.css';
export interface ActivityBatchExportProps {
  store: BatchSelectionStore;
  transport: AuthenticatedTransport;
  scope: string[];
  now?: () => string;
}
export function ActivityBatchExport(props: ActivityBatchExportProps) {
  return <Controller key={JSON.stringify(props.scope)} {...props} />;
}
const labels = {
  ready: '조회 확인',
  conflict: '수정 충돌',
  unavailable: '기록 없음 또는 접근 불가',
  read_error: '조회 실패',
  reauth_required: '로그인 재확인 필요',
  not_attempted: '조회하지 않음',
};
const value = (number: number | null, unit: string) =>
  number === null ? '미확인' : `${number} ${unit}`;
function Controller({
  store,
  transport,
  now = () => new Date().toISOString(),
}: ActivityBatchExportProps) {
  const targets = useStore(store, (state) => state.targets),
    locked = useStore(store, (state) => state.locked);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'preview' | 'file'>('idle');
  const [results, setResults] = useState<ExportReadResult[]>([]);
  const [url, setUrl] = useState<string | null>(null),
    [error, setError] = useState('');
  const ownedURL = useRef<string | null>(null),
    active = useRef(true),
    request = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    focusBack = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
      if (ownedURL.current) {
        URL.revokeObjectURL(ownedURL.current);
        ownedURL.current = null;
      }
    };
  }, []);
  useLayoutEffect(() => {
    if (phase === 'idle' && focusBack.current) {
      focusBack.current = false;
      if (trigger.current && !trigger.current.disabled) trigger.current.focus();
      else heading.current?.focus();
    }
  }, [phase]);
  const focusDownload = useCallback((node: HTMLAnchorElement | null) => node?.focus(), []);
  const focusClose = useCallback((node: HTMLButtonElement | null) => node?.focus(), []);
  function close() {
    request.current?.abort();
    request.current = null;
    if (ownedURL.current) {
      URL.revokeObjectURL(ownedURL.current);
      ownedURL.current = null;
    }
    setUrl(null);
    setResults([]);
    setError('');
    store.getState().setLocked(false);
    focusBack.current = true;
    setPhase('idle');
  }
  async function prepare() {
    const current = store.getState();
    if (current.locked || !current.targets.length || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    current.setLocked(true);
    setResults([]);
    setError('');
    setPhase('loading');
    try {
      const read = await prepareActivityBatchExport({
        targets: current.targets.map((target) => ({ ...target })),
        transport,
        signal: controller.signal,
      });
      if (!active.current || controller.signal.aborted || request.current !== controller) return;
      setResults(read);
      setPhase('preview');
    } catch {
      if (active.current && !controller.signal.aborted && request.current === controller) {
        setError('선택한 활동을 확인하지 못했습니다. 닫은 뒤 다시 조회하세요.');
        setPhase('preview');
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }
  const allReady = results.length > 0 && results.every((result) => result.status === 'ready');
  function makeFile() {
    if (!active.current || !allReady || phase !== 'preview') return;
    setError('');
    try {
      const serialized = serializeActivityBatchExport({ results, generatedAt: now() });
      const next = URL.createObjectURL(
        new Blob([serialized.json], { type: 'application/json;charset=utf-8' }),
      );
      if (ownedURL.current) URL.revokeObjectURL(ownedURL.current);
      ownedURL.current = next;
      setUrl(next);
      setPhase('file');
    } catch {
      setError(
        '내보내기 파일을 만들지 못했습니다. 브라우저의 파일 기능과 조회 결과를 확인한 뒤 다시 시도하세요.',
      );
    }
  }
  return (
    <section className={styles.panel} aria-label="선택 활동 요약 내보내기">
      <h3 ref={heading} tabIndex={-1}>
        선택 활동 요약 내보내기
      </h3>
      <p>
        현재 선택 {targets.length}개. 원본 요약·사용자 정정·자기보고(RPE·메모)를 포함합니다. 개별
        관측·랩·GPS는 포함하지 않으며 다시 가져오기용 파일이 아닙니다.
      </p>
      <p>
        활동별 수정 번호를 확인하지만 모든 활동을 한 시점에 읽은 데이터베이스 스냅샷은 아닙니다.
      </p>
      {phase === 'idle' ? (
        <Button
          ref={trigger}
          variant="secondary"
          disabled={locked || !targets.length}
          onClick={() => void prepare()}
        >
          선택 활동 내보내기 미리보기
        </Button>
      ) : (
        <div className={styles.preview} role="group" aria-label="선택 활동 내보내기 확인">
          {phase === 'loading' ? (
            <p role="status">선택한 활동의 수정 번호와 요약을 조회하고 있습니다.</p>
          ) : null}
          <ul className={styles.targets}>
            {results.map((result) => (
              <li key={result.target.id}>
                {result.target.title} · 수정 번호 {result.target.revision} · {labels[result.status]}{' '}
                · 활동 ID {result.target.id}
                {result.status === 'ready' ? (
                  <details>
                    <summary>내보낼 요약 확인: {result.target.title}</summary>
                    <p>
                      원본 거리 {value(result.activity.original.distanceMeters, 'm')} · 시간{' '}
                      {value(result.activity.original.durationSeconds, '초')} (
                      {result.activity.original.durationKind})
                    </p>
                    <p>
                      정정 반영 거리 {value(result.activity.effective.distanceMeters, 'm')} · 시간{' '}
                      {value(result.activity.effective.durationSeconds, '초')} (
                      {result.activity.effective.durationKind})
                    </p>
                    <p>
                      자기보고 RPE{' '}
                      {value(
                        (result.activity.userReport ?? result.activity.overlay.userReport)
                          ?.sessionRpe ?? null,
                        '/ 10',
                      )}{' '}
                      · 메모{' '}
                      {(result.activity.userReport ?? result.activity.overlay.userReport)?.note ??
                        '미입력'}
                    </p>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
          {phase === 'preview' && !allReady ? (
            <p>
              일부 활동을 확인하지 못해 파일을 만들지 않습니다. 닫은 뒤 목록을 새로 조회하고, 변경된
              활동은 선택을 해제한 뒤 다시 선택하세요. 수정 번호를 자동으로 갱신하지 않습니다.
            </p>
          ) : null}
          {results.some((result) => result.status === 'reauth_required') ? (
            <p role="alert">로그인을 다시 확인하세요. 남은 활동은 조회하지 않았습니다.</p>
          ) : null}
          <div className={styles.actions}>
            {phase === 'preview' ? (
              <Button variant="secondary" disabled={!allReady} onClick={makeFile}>
                확인하고 내보내기 파일 만들기
              </Button>
            ) : null}
            {url ? (
              <a
                className={styles.download}
                ref={focusDownload}
                href={url}
                download="workout-manager-activity-summary.json"
              >
                선택 활동 JSON 다운로드
              </a>
            ) : null}
            <Button ref={focusClose} variant="secondary" onClick={close}>
              내보내기 닫기
            </Button>
          </div>
          {phase === 'file' ? (
            <p role="status">
              파일이 준비되었습니다. 다운로드 링크를 눌러 저장하세요. 실제 저장 완료 여부는
              브라우저에서 확인하세요.
            </p>
          ) : null}
        </div>
      )}
      {phase === 'idle' && locked ? <p>다른 일괄 작업을 닫은 뒤 내보내기를 시작하세요.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
