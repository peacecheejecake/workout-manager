import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';
import {
  createStreamPresentationStore,
  type StreamPresentationScope,
} from '@workout/conversation-kit/stream-presentation-store';
import { StreamTranscript } from '@workout/conversation-kit/stream-transcript';
import { ConversationComposer } from '@workout/conversation-kit/composer';
import styles from './workspace.module.css';

const bounds = {
  maxScopeBytes: 100,
  maxTextBytes: 4096,
  maxResultBytes: 1024,
  maxToolEntries: 1,
  maxLabelBytes: 100,
  maxEvents: 100,
};
function invocation(session: number, run: number) {
  const scope: StreamPresentationScope = {
    account: `synthetic-account-${session}`,
    session: `synthetic-session-${session}`,
    run: `synthetic-run-${run}`,
    attempt: 'synthetic-attempt',
  };
  return { scope, store: createStreamPresentationStore(scope, bounds), session, run };
}
/** Local synthetic controller, not a provider adapter or domain command. */
export function StreamPanel() {
  const [current, setCurrent] = useState(() => invocation(1, 1));
  const [previous, setPrevious] = useState<ReturnType<typeof invocation> | null>(null);
  const lease = useRef({ generation: 0 });
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(0);
  const [late, setLate] = useState<'none' | 'rejected' | 'unexpected'>('none');
  const snapshot = useSyncExternalStore(
    current.store.subscribe,
    current.store.getSnapshot,
    current.store.getServerSnapshot,
  );
  useEffect(() => {
    const lifetime = lease.current;
    const acquired = ++lifetime.generation;
    return () => {
      // React's development effect replay may immediately reacquire this controller.
      // Replacements already dispose synchronously; final unmount clears after replay.
      queueMicrotask(() => {
        if (lifetime.generation === acquired) current.store.dispose();
      });
    };
  }, [current.store]);
  function replace(changeSession: boolean) {
    current.store.dispose();
    setPrevious(current);
    setCurrent(invocation(current.session + (changeSession ? 1 : 0), current.run + 1));
    setLate('none');
    if (changeSession) {
      setDraft('');
      setSaved(0);
    }
  }
  function sendText() {
    current.store.accept({
      scope: current.scope,
      sequence: snapshot.sequence + 1,
      kind: 'text',
      text: '합성 응답 <b>태그</b>\n',
    });
  }
  function tool(state: 'running' | 'completed') {
    current.store.accept({
      scope: current.scope,
      sequence: snapshot.sequence + 1,
      kind: 'tool',
      tool: {
        id: 'synthetic-search',
        label: '합성 자료 검색',
        state,
        resultText: state === 'completed' ? '<script>합성 결과</script>\n계산 값 0 (합성)' : null,
      },
    });
  }
  function lateEvent() {
    const old = previous;
    if (!old) return;
    const event = {
      scope: old.scope,
      sequence: old.store.getSnapshot().sequence + 1,
      kind: 'text' as const,
      text: '이전 실행 비공개 합성 문자열',
    };
    const oldResult = old.store.accept(event);
    const newResult = current.store.accept({ ...event, sequence: snapshot.sequence + 1 });
    setLate(!oldResult.accepted && !newResult.accepted ? 'rejected' : 'unexpected');
  }
  // Pointer controls inject synthetic events without stealing an active draft focus.
  // Keyboard Tab/click navigation remains available.
  function retainDraftFocus(event: PointerEvent<HTMLButtonElement>) {
    if (event.isPrimary && event.button === 0) event.preventDefault();
  }
  const active = snapshot.phase === 'active';
  const progress = snapshot.tools[0];
  return (
    <section className={styles.card} aria-label="Streaming 합성 조합 검증">
      <h2>Streaming · 도구 결과 · 초안 분리</h2>
      <p>
        합성 자료만 사용하는 로컬 표시 실험입니다. 실제 제공자 전송·계획 승인·서버 저장은 없습니다.
      </p>
      <StreamTranscript store={current.store} label="합성 실행 표시" />
      <div>
        <button
          type="button"
          onPointerDown={retainDraftFocus}
          disabled={!active}
          onClick={sendText}
        >
          합성 텍스트 추가
        </button>
        <button
          type="button"
          onPointerDown={retainDraftFocus}
          disabled={!active || progress !== undefined}
          onClick={() => tool('running')}
        >
          합성 도구 시작
        </button>
        <button
          type="button"
          onPointerDown={retainDraftFocus}
          disabled={!active || progress?.state !== 'running'}
          onClick={() => tool('completed')}
        >
          합성 도구 결과
        </button>
        <button
          type="button"
          onPointerDown={retainDraftFocus}
          disabled={!active}
          onClick={() =>
            current.store.accept({
              scope: current.scope,
              sequence: snapshot.sequence + 1,
              kind: 'terminal',
              state: 'completed',
            })
          }
        >
          합성 실행 완료
        </button>
        <button type="button" onPointerDown={retainDraftFocus} onClick={() => replace(false)}>
          새 합성 실행
        </button>
        <button type="button" onClick={() => replace(true)}>
          합성 세션 변경
        </button>
        <button type="button" disabled={previous === null} onClick={lateEvent}>
          이전 실행 늦은 입력
        </button>
      </div>
      <p role="status" aria-label="늦은 입력 관측">
        {late === 'none'
          ? '늦은 입력 관측 없음'
          : late === 'rejected'
            ? '이전 실행 늦은 입력 거절됨'
            : '예상하지 않은 입력 수락'}
      </p>
      <ConversationComposer
        label="합성 메시지 초안"
        value={draft}
        onChange={setDraft}
        onSubmit={() => setSaved((value) => value + 1)}
        submitLabel="합성 초안 확인"
        state={{ kind: 'idle' }}
        maxLength={1000}
        help="확인은 로컬 횟수만 변경합니다. 도구 결과나 생성 완료는 초안을 제출하지 않습니다."
      />
      <p role="status" aria-label="합성 초안 확인 횟수">
        합성 초안 확인 횟수: {saved}
      </p>
    </section>
  );
}
