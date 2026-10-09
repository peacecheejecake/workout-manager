import { useId, useRef, type ReactNode } from 'react';
import styles from './conversation.module.css';

export type ConversationComposerState =
  | { kind: 'idle' }
  | { kind: 'submitting'; message: string }
  | { kind: 'uncertain' | 'conflict' | 'unavailable'; message: string };

export interface ConversationComposerProps {
  value: string;
  label: string;
  submitLabel: string;
  maxLength: number;
  state: ConversationComposerState;
  shortcut?: 'none' | 'control-enter';
  onChange(value: string): void;
  onSubmit(): void;
  controls?: ReactNode;
  help?: ReactNode;
}

/** Presentation only: the owner validates commands and decides retry/approval policy. */
export function ConversationComposer({
  value,
  label,
  submitLabel,
  maxLength,
  state,
  shortcut = 'none',
  onChange,
  onSubmit,
  controls,
  help,
}: ConversationComposerProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const stateId = `${id}-state`;
  const hasHelp = help !== undefined && help !== null && help !== false;
  const description =
    [hasHelp ? helpId : null, state.kind !== 'idle' ? stateId : null]
      .filter((part) => part !== null)
      .join(' ') || undefined;
  const composing = useRef(false);
  const blocked = state.kind !== 'idle' || !value.trim() || value.length > maxLength;
  const submit = () => {
    if (!blocked && !composing.current) onSubmit();
  };
  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        aria-describedby={description}
        value={value}
        maxLength={maxLength}
        readOnly={state.kind === 'submitting' || state.kind === 'unavailable'}
        onChange={(event) => onChange(event.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (
            shortcut !== 'control-enter' ||
            event.key !== 'Enter' ||
            !(event.ctrlKey || event.metaKey) ||
            event.altKey ||
            event.repeat ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 ||
            composing.current
          )
            return;
          event.preventDefault();
          submit();
        }}
      />
      {hasHelp ? <div id={helpId}>{help}</div> : null}
      {state.kind !== 'idle' ? (
        <p id={stateId} role={state.kind === 'submitting' ? 'status' : 'alert'}>
          {state.message}
        </p>
      ) : null}
      <div className={styles.controls}>
        {controls}
        <button type="submit" disabled={blocked}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
