import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import styles from './conversation.module.css';

export interface ConversationMessage {
  id: string;
  author: string;
  content: string;
  description?: string;
}
export type ConversationTranscriptState =
  { kind: 'ready' } | { kind: 'loading' | 'error' | 'unavailable'; message: string };
export interface ConversationTranscriptProps {
  /** Change on account/thread lifetime changes; no private DOM is retained across it. */
  lifetimeKey: string;
  label: string;
  messages: readonly ConversationMessage[];
  state: ConversationTranscriptState;
  empty: ReactNode;
  before?: ReactNode;
  after?: ReactNode;
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  loadOlderLabel?: string;
  newMessagesLabel?: string;
}
interface Position {
  bottom: boolean;
  anchor: string | null;
  offset: number;
}

export function ConversationTranscript(props: ConversationTranscriptProps) {
  return <TranscriptLifetime key={props.lifetimeKey} {...props} />;
}
function TranscriptLifetime({
  label,
  messages,
  state,
  empty,
  before,
  after,
  onLoadOlder,
  loadingOlder = false,
  loadOlderLabel = '이전 메시지 더 보기',
  newMessagesLabel = '새 메시지 보기',
}: ConversationTranscriptProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const position = useRef<Position>({ bottom: true, anchor: null, offset: 0 });
  const lastId = useRef<string | undefined>(undefined);
  const [newMessages, setNewMessages] = useState(false);
  const capture = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    const nodes = element.querySelectorAll<HTMLElement>('[data-message-id]');
    const visible = Array.from(nodes).find((node) => node.getBoundingClientRect().bottom > top);
    position.current = {
      bottom: element.scrollHeight - element.scrollTop - element.clientHeight <= 8,
      anchor: visible?.dataset.messageId ?? null,
      offset: visible ? visible.getBoundingClientRect().top - top : 0,
    };
  }, []);
  const reconcile = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const previous = position.current;
    if (previous.bottom) element.scrollTop = element.scrollHeight;
    else if (previous.anchor !== null) {
      const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find(
        (node) => node.dataset.messageId === previous.anchor,
      );
      if (anchor)
        element.scrollTop +=
          anchor.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          previous.offset;
    }
    capture();
  }, [capture]);
  useLayoutEffect(() => {
    const next = messages.at(-1)?.id;
    if (
      !position.current.bottom &&
      lastId.current !== undefined &&
      next !== lastId.current &&
      messages.some((message) => message.id === lastId.current)
    )
      setNewMessages(true);
    reconcile();
    lastId.current = next;
  }, [messages, reconcile]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reconcile);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [reconcile]);
  return (
    <section className={styles.transcript} aria-label={label}>
      {before}
      {onLoadOlder ? (
        <button type="button" disabled={loadingOlder} onClick={onLoadOlder}>
          {loadOlderLabel}
        </button>
      ) : null}
      <div
        className={styles.viewport}
        role="region"
        ref={viewport}
        data-conversation-viewport=""
        aria-label={`${label} 스크롤 영역`}
        onScroll={() => {
          capture();
          if (position.current.bottom) setNewMessages(false);
        }}
      >
        <ol>
          {messages.map((message) => (
            <li key={message.id} data-message-id={message.id}>
              <p>
                {message.author}
                {message.description ? ` · ${message.description}` : ''}
              </p>
              <p className={styles.content}>{message.content}</p>
            </li>
          ))}
        </ol>
        {messages.length === 0 && state.kind === 'ready' ? empty : null}
      </div>
      <div className={styles.controls}>
        <button
          type="button"
          onClick={() => {
            const element = viewport.current;
            if (element) {
              element.scrollTop -= element.clientHeight;
              capture();
            }
          }}
        >
          위로 읽기
        </button>
        <button
          type="button"
          onClick={() => {
            const element = viewport.current;
            if (element) {
              element.scrollTop += element.clientHeight;
              capture();
              if (position.current.bottom) setNewMessages(false);
            }
          }}
        >
          아래로 읽기
        </button>
      </div>
      {newMessages ? (
        <button
          type="button"
          onClick={() => {
            const element = viewport.current;
            if (element) element.scrollTop = element.scrollHeight;
            capture();
            setNewMessages(false);
          }}
        >
          {newMessagesLabel}
        </button>
      ) : null}
      {state.kind !== 'ready' ? (
        <p role={state.kind === 'loading' ? 'status' : 'alert'}>{state.message}</p>
      ) : null}
      {after}
    </section>
  );
}
