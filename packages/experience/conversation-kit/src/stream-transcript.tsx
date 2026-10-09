import { useSyncExternalStore } from 'react';
import type { StreamPresentationStore } from './stream-presentation-store.js';
import styles from './conversation.module.css';

export interface StreamTranscriptProps {
  /** The owning controller binds the invocation and owns disposal/account changes. */
  store: StreamPresentationStore;
  label: string;
}
const toolLabels = { running: '진행 중', completed: '결과 수신', unavailable: '결과 사용 불가' };
const terminalLabels = {
  completed: '생성이 끝났습니다. 검증과 승인은 별도로 진행합니다.',
  cancelled: '실행이 취소되었습니다.',
  unavailable: '실행 결과를 사용할 수 없습니다.',
};
/** Provisional/read-only presentation. This component never approves or disposes a run. */
export function StreamTranscript({ store, label }: StreamTranscriptProps) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  return (
    <section className={styles.transcript} aria-label={label} data-stream-phase={snapshot.phase}>
      {snapshot.provisionalText ? (
        <div>
          <p>작성 중인 내용 · 미검증</p>
          <p className={styles.content}>{snapshot.provisionalText}</p>
        </div>
      ) : null}
      {snapshot.tools.length > 0 ? (
        <ol aria-label="도구 진행과 결과">
          {snapshot.tools.map((tool) => (
            <li key={tool.id}>
              <p>
                {tool.label} · {toolLabels[tool.state]}
              </p>
              {tool.resultText !== null ? (
                <p className={styles.content}>{tool.resultText}</p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {snapshot.terminal !== null ? <p role="status">{terminalLabels[snapshot.terminal]}</p> : null}
      {snapshot.phase === 'disposed' ? <p>표시할 실행 정보가 없습니다.</p> : null}
    </section>
  );
}
