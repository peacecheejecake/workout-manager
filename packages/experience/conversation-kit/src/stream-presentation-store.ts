/** Presentation only: no provider protocol, authorization, persistence or approval. */
export interface StreamPresentationScope {
  readonly account: string;
  readonly session: string;
  readonly run: string;
  readonly attempt: string;
}
export interface StreamPresentationBounds {
  readonly maxScopeBytes: number;
  readonly maxTextBytes: number;
  readonly maxResultBytes: number;
  readonly maxToolEntries: number;
  readonly maxLabelBytes: number;
  readonly maxEvents: number;
}
export interface StreamToolProgress {
  readonly id: string;
  readonly label: string;
  readonly state: 'running' | 'completed' | 'unavailable';
  /** Plain presentation text; only completed progress may carry a result. */
  readonly resultText: string | null;
}
export type StreamPresentationEvent = {
  readonly scope: StreamPresentationScope;
  readonly sequence: number;
} & (
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly tool: StreamToolProgress }
  | { readonly kind: 'terminal'; readonly state: 'completed' | 'cancelled' | 'unavailable' }
);
export interface StreamPresentationSnapshot {
  readonly phase: 'active' | 'terminal' | 'disposed';
  readonly sequence: number;
  readonly provisionalText: string;
  readonly tools: readonly StreamToolProgress[];
  readonly terminal: 'completed' | 'cancelled' | 'unavailable' | null;
}
export type StreamPresentationAcceptance =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason: 'disposed' | 'terminal' | 'scope' | 'sequence' | 'bounds' | 'invalid';
    };
export interface StreamPresentationStore {
  getSnapshot(): StreamPresentationSnapshot;
  subscribe(listener: () => void): () => void;
  accept(event: StreamPresentationEvent): StreamPresentationAcceptance;
  dispose(): void;
}
const encoder = new TextEncoder();
function textBytes(text: string, maximum: number): number | null {
  if (typeof text !== 'string' || text.length > maximum || text.includes('\0')) return null;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
    } else if (code >= 0xdc00 && code <= 0xdfff) return null;
  }
  const bytes = encoder.encode(text).length;
  return bytes <= maximum ? bytes : null;
}
const scopeFields = ['account', 'session', 'run', 'attempt'] as const;
/** Caller supplies already validated presentation events and explicit resource bounds.
 * A new account/session/run/attempt requires a new factory and disposal of the old one.
 * Gaps reject without advancing; the controller must recover from authoritative data.
 */
export function createStreamPresentationStore(
  scope: StreamPresentationScope,
  bounds: StreamPresentationBounds,
): StreamPresentationStore {
  if (
    ![
      bounds.maxScopeBytes,
      bounds.maxTextBytes,
      bounds.maxResultBytes,
      bounds.maxToolEntries,
      bounds.maxLabelBytes,
      bounds.maxEvents,
    ].every((value) => Number.isSafeInteger(value) && value > 0) ||
    scopeFields.some(
      (field) =>
        typeof scope[field] !== 'string' ||
        !scope[field] ||
        textBytes(scope[field], bounds.maxScopeBytes) === null,
    )
  )
    throw new Error('INVALID_PRESENTATION_CONFIGURATION');
  const identity = Object.freeze({ ...scope });
  const limits = Object.freeze({ ...bounds });
  let textSize = 0;
  let resultSize = 0;
  let snapshot: StreamPresentationSnapshot = Object.freeze({
    phase: 'active',
    sequence: 0,
    provisionalText: '',
    tools: Object.freeze([]),
    terminal: null,
  });
  const listeners = new Set<() => void>();
  function publish(next: StreamPresentationSnapshot) {
    snapshot = Object.freeze(next);
    // Observer errors cannot change the accepted state or stop other observers.
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener();
      } catch {
        /* Observer owns its own error handling. */
      }
    }
  }
  const reject = (
    reason: Extract<StreamPresentationAcceptance, { accepted: false }>['reason'],
  ): StreamPresentationAcceptance => ({ accepted: false, reason });
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (snapshot.phase === 'disposed') return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    accept(event) {
      if (snapshot.phase === 'disposed') return reject('disposed');
      if (snapshot.phase === 'terminal') return reject('terminal');
      if (scopeFields.some((field) => event.scope[field] !== identity[field]))
        return reject('scope');
      if (!Number.isSafeInteger(event.sequence) || event.sequence !== snapshot.sequence + 1)
        return reject('sequence');
      if (event.sequence > limits.maxEvents) return reject('bounds');
      switch (event.kind) {
        case 'text': {
          const bytes = textBytes(event.text, limits.maxTextBytes - textSize);
          if (bytes === null) return reject('bounds');
          textSize += bytes;
          publish({
            ...snapshot,
            sequence: event.sequence,
            provisionalText: snapshot.provisionalText + event.text,
          });
          return { accepted: true };
        }
        case 'tool': {
          const tool = event.tool;
          if (
            !tool.id ||
            textBytes(tool.id, limits.maxScopeBytes) === null ||
            textBytes(tool.label, limits.maxLabelBytes) === null ||
            !['running', 'completed', 'unavailable'].includes(tool.state)
          )
            return reject('invalid');
          const index = snapshot.tools.findIndex((current) => current.id === tool.id);
          if (index === -1 && snapshot.tools.length >= limits.maxToolEntries)
            return reject('bounds');
          const previous = snapshot.tools[index];
          if (
            (tool.state === 'completed'
              ? typeof tool.resultText !== 'string'
              : tool.resultText !== null) ||
            (previous &&
              (previous.label !== tool.label ||
                (previous.state !== 'running' &&
                  (previous.state !== tool.state || previous.resultText !== tool.resultText))))
          )
            return reject('invalid');
          // Count retained results across tools, not each replay of an unchanged result.
          const bytes =
            tool.resultText === null ? 0 : textBytes(tool.resultText, limits.maxResultBytes);
          if (bytes === null) return reject('bounds');
          const addedBytes = previous?.state === 'completed' ? 0 : bytes;
          if (addedBytes > limits.maxResultBytes - resultSize) return reject('bounds');
          const copy = Object.freeze({
            id: tool.id,
            label: tool.label,
            state: tool.state,
            resultText: tool.resultText,
          });
          resultSize += addedBytes;
          const tools = [...snapshot.tools];
          if (index === -1) tools.push(copy);
          else tools[index] = copy;
          publish({ ...snapshot, sequence: event.sequence, tools: Object.freeze(tools) });
          return { accepted: true };
        }
        case 'terminal':
          if (!['completed', 'cancelled', 'unavailable'].includes(event.state))
            return reject('invalid');
          publish({
            ...snapshot,
            phase: 'terminal',
            sequence: event.sequence,
            terminal: event.state,
          });
          return { accepted: true };
        default:
          return reject('invalid');
      }
    },
    dispose() {
      if (snapshot.phase === 'disposed') return;
      textSize = 0;
      resultSize = 0;
      publish({
        phase: 'disposed',
        sequence: snapshot.sequence,
        provisionalText: '',
        tools: Object.freeze([]),
        terminal: null,
      });
      listeners.clear();
    },
  };
}
