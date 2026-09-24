/**
 * Pure helpers for the opt-in identity E2E diagnostics (see `protocol-capture.ts` and
 * `reporter.ts`): what a captured line may contain, and what a failed test's lines say.
 */
const maxLineLength = 2000;
// eslint-disable-next-line no-control-regex -- strips the colours debug adds on a TTY
const ansiEscapes = /\u001b\[[0-9;]*m/g;

/**
 * The accounts are the local fixture's synthetic ones, but a failure log should still not
 * carry replayable session material: cookies, CSRF and session tokens, OIDC codes.
 *
 * CDP carries the same value in several shapes, and each rule covers one of them. A quote
 * may be escaped any number of times (`"`, `\"`, `\\\"` — JSON inside a JSON string inside
 * a CDP message) and may be `'` in script source, hence `q`.
 */
export type RedactionRule = { name: string; pattern: RegExp };

const sensitiveKeys = [
  'cookie',
  'set-cookie',
  'authorization',
  'x-csrf-token',
  'x-workout-session-id',
  'csrfToken',
  'sessionId',
  'accessToken',
  'refreshToken',
  'idToken',
  'password',
  'code_verifier',
  'nonce',
].join('|');
const q = String.raw`\\*["']`;
const value = String.raw`[^"'\\]*`;

export const redactionRules: readonly RedactionRule[] = [
  {
    // Objects as JSON, escaped JSON or script source: "x-csrf-token":"…", \"csrfToken\":\"…\",
    // csrfToken: '…' — CDP headers, response bodies, returnByValue results, evaluate source.
    name: 'key-value',
    pattern: new RegExp(
      String.raw`((?:${q}|\b)(?:${sensitiveKeys})(?:${q})?\s*:\s*${q})${value}`,
      'gi',
    ),
  },
  {
    // Playwright's serialized evaluate arguments and results:
    // {"k":"x-csrf-token","v":"…"} or {"k":"csrfToken","v":{"s":"…"}}
    name: 'serialized-property',
    pattern: new RegExp(
      String.raw`(${q}k${q}\s*:\s*${q}(?:${sensitiveKeys})${q}\s*,\s*${q}v${q}\s*:\s*(?:\{\s*${q}s${q}\s*:\s*)?${q})${value}`,
      'gi',
    ),
  },
  {
    // Cookie jars and CDP header arrays: {"name":"…","value":"…"}
    name: 'name-value',
    pattern: new RegExp(
      String.raw`(${q}name${q}\s*:\s*${q}[^"'\\]*${q}\s*,\s*${q}value${q}\s*:\s*${q})${value}`,
      'gi',
    ),
  },
  {
    // Raw header text and pw:api header logs: "set-cookie: …", "x-csrf-token: …"
    name: 'header-text',
    pattern:
      /((?:set-cookie|cookie|authorization|x-csrf-token|x-workout-session-id): )[^\\\r\n"']*/gi,
  },
  {
    // This app's cookies anywhere, e.g. document.cookie: workout_session=…
    name: 'cookie-pair',
    pattern: /(\bworkout_[a-z_]+=)[^;,"'\\\s]+/gi,
  },
  {
    // OIDC redirects and form bodies: ?code=…&state=…
    name: 'oidc-parameter',
    pattern: /([?&#](?:code|state|nonce|session_state|code_verifier)=)[^&"'\s\\#]+/gi,
  },
];

export function sanitizeLine(text: string, rules: readonly RedactionRule[] = redactionRules) {
  let line = text.replace(ansiEscapes, '').replaceAll('\n', ' ');
  for (const { pattern } of rules) line = line.replace(pattern, '$1[redacted]');
  return line.length > maxLineLength ? `${line.slice(0, maxLineLength)} …[truncated]` : line;
}

export function stripAnsi(text: string): string {
  return text.replace(ansiEscapes, '');
}

type Command = { id: string; method: string; sentAt: string };

/**
 * Pairs CDP commands with their replies. Lines start with the capture's ISO timestamp.
 * Returns the commands never answered (oldest first) and those answered after at least
 * `slowMs` — a renderer that stops answering shows up in one list or the other.
 */
export function commandLatency(lines: readonly string[], slowMs = 1000) {
  const pending = new Map<string, Command>();
  const slow: string[] = [];
  for (const line of lines) {
    const at = line.slice(0, 24);
    const sent = /SEND ► \{"id":(\d+),"method":"([^"]+)"/.exec(line);
    if (sent?.[1] && sent[2]) {
      pending.set(sent[1], { id: sent[1], method: sent[2], sentAt: at });
      continue;
    }
    const received = /◀ RECV \{"id":(\d+),/.exec(line);
    const command = received?.[1] ? pending.get(received[1]) : undefined;
    if (!command) continue;
    pending.delete(command.id);
    const took = Date.parse(at) - Date.parse(command.sentAt);
    if (took >= slowMs)
      slow.push(`${command.sentAt} ${command.method} (id ${command.id}) ${took} ms`);
  }
  const unanswered = [...pending.values()].map(
    ({ id, method, sentAt }) => `${sentAt} ${method} (id ${id})`,
  );
  return { unanswered, slow };
}

/** The worst worker event-loop delay these lines recorded, in milliseconds. */
export function worstLoopDelay(lines: readonly string[]): number {
  let worst = 0;
  for (const line of lines) {
    const delay = /\[diag\] worker event-loop delay max=([\d.]+)ms/.exec(line);
    if (delay?.[1]) worst = Math.max(worst, Number(delay[1]));
  }
  return worst;
}
