import { expect, it } from 'vitest';
import {
  commandLatency,
  redactionRules,
  sanitizeLine,
  stripAnsi,
  worstLoopDelay,
} from '../../../tests/identity/diagnostics/protocol-lines';

/**
 * Every shape session material takes in the capture. `rule` names the only rule that
 * catches that line; the mutation test below removes it and expects the secret back.
 */
const forms: ReadonlyArray<{ rule: string | null; line: string }> = [
  // CDP header objects
  {
    rule: 'key-value',
    line: 'pw:protocol SEND ► {"id":1,"method":"Network.setExtraHTTPHeaders","params":{"headers":{"x-csrf-token":"SECRET-b","Authorization":"Bearer SECRET-g"}}}',
  },
  {
    rule: null,
    line: 'pw:protocol ◀ RECV {"method":"Network.requestWillBeSent","params":{"request":{"headers":{"Cookie":"workout_session=SECRET-a"}}}}',
  },
  // Response body as CDP carries it (escaped JSON)
  {
    rule: 'key-value',
    line: String.raw`pw:protocol ◀ RECV {"id":3,"result":{"body":"{\"athleteId\":\"a1\",\"sessionId\":\"SECRET-d\",\"csrfToken\":\"SECRET-b\"}"}}`,
  },
  // Doubly escaped (JSON inside a JSON string inside the message)
  {
    rule: 'key-value',
    line: String.raw`pw:protocol SEND ► {"id":4,"params":{"expression":"JSON.parse(\"{\\\"csrfToken\\\":\\\"SECRET-b\\\"}\")"}}`,
  },
  // returnByValue result, unescaped
  {
    rule: 'key-value',
    line: 'pw:protocol ◀ RECV {"id":5,"result":{"result":{"type":"object","value":{"athleteId":"a1","sessionId":"SECRET-d","csrfToken":"SECRET-b","password":"SECRET-h","code_verifier":"SECRET-i"}}}}',
  },
  // Script source in Runtime.evaluate / callFunctionOn
  {
    rule: 'key-value',
    line: `pw:protocol SEND ► {"id":6,"method":"Runtime.evaluate","params":{"expression":"fetch('/x', { headers: { 'x-csrf-token': 'SECRET-b', accessToken: 'SECRET-j' } })"}}`,
  },
  // Playwright's serialized evaluate arguments and results
  {
    rule: 'serialized-property',
    line: 'pw:protocol SEND ► {"id":7,"method":"Runtime.callFunctionOn","params":{"arguments":[{"value":{"o":[{"k":"x-workout-session-id","v":"SECRET-d"},{"k":"x-csrf-token","v":"SECRET-b"}]}}]}}',
  },
  {
    rule: 'serialized-property',
    line: 'pw:protocol ◀ RECV {"id":8,"result":{"result":{"type":"object","value":{"o":[{"k":"athleteId","v":{"s":"a1"}},{"k":"csrfToken","v":{"s":"SECRET-b"}},{"k":"refreshToken","v":{"s":"SECRET-k"}},{"k":"idToken","v":{"s":"SECRET-l"}}]}}}}',
  },
  {
    rule: 'serialized-property',
    line: String.raw`pw:protocol SEND ► {"id":9,"params":{"expression":"f({\"o\":[{\"k\":\"sessionId\",\"v\":{\"s\":\"SECRET-d\"}}]})"}}`,
  },
  // Cookie jars and header arrays
  {
    rule: 'name-value',
    line: 'pw:protocol ◀ RECV {"id":10,"result":{"cookies":[{"name":"workout_session","value":"SECRET-a"}]}}',
  },
  {
    rule: 'name-value',
    line: 'pw:api   {"headers":[{"name":"X-CSRF-Token","value":"SECRET-b"}]}',
  },
  // Raw header text and pw:api header logs
  {
    rule: null,
    line: String.raw`pw:protocol ◀ RECV {"method":"Network.responseReceivedExtraInfo","params":{"headersText":"HTTP/1.1 200 OK\r\nset-cookie: workout_session=SECRET-a; Path=/\r\n"}}`,
  },
  { rule: 'header-text', line: 'pw:api   x-csrf-token: SECRET-b' },
  { rule: 'header-text', line: 'pw:api   authorization: Bearer SECRET-g' },
  { rule: null, line: 'pw:api   cookie: workout_session=SECRET-a; workout_login=SECRET-c' },
  // This app's cookies on their own, e.g. document.cookie
  {
    rule: 'cookie-pair',
    line: 'pw:protocol ◀ RECV {"id":11,"result":{"result":{"type":"string","value":"theme=dark; workout_session=SECRET-a"}}}',
  },
  // OIDC redirects
  {
    rule: 'oidc-parameter',
    line: 'pw:api navigated to "http://127.0.0.1:3100/bff/v1/auth/callback?code=SECRET-e&state=SECRET-f"',
  },
  {
    rule: 'oidc-parameter',
    line: 'pw:protocol ◀ RECV {"method":"Page.frameNavigated","params":{"frame":{"url":"http://127.0.0.1:4400/authorize?client_id=c&nonce=SECRET-m#session_state=SECRET-n"}}}',
  },
];

it('redacts session material in every form the capture sees it', () => {
  for (const { line } of forms) {
    const safe = sanitizeLine(line);
    expect(safe, line).not.toContain('SECRET');
    expect(safe).toContain('[redacted]');
  }
  // What is not session material stays readable.
  expect(sanitizeLine(forms[2]?.line ?? '')).toContain(String.raw`\"athleteId\":\"a1\"`);
  expect(sanitizeLine(forms[7]?.line ?? '')).toContain('{"k":"athleteId","v":{"s":"a1"}}');
  expect(sanitizeLine(forms[4]?.line ?? '')).toContain('"athleteId":"a1"');
  expect(sanitizeLine('pw:protocol SEND ► {"id":9,"method":"DOM.scrollIntoViewIfNeeded"}')).toBe(
    'pw:protocol SEND ► {"id":9,"method":"DOM.scrollIntoViewIfNeeded"}',
  );
});

it('needs every redaction rule: without it, its forms leak', () => {
  for (const rule of redactionRules) {
    const covered = forms.filter((form) => form.rule === rule.name);
    expect(covered.length, rule.name).toBeGreaterThan(0);
    const without = redactionRules.filter((other) => other !== rule);
    for (const { line } of covered)
      expect(sanitizeLine(line, without), rule.name).toContain('SECRET');
  }
  expect(new Set(forms.map(({ rule }) => rule).filter(Boolean))).toEqual(
    new Set(redactionRules.map(({ name }) => name)),
  );
});

it('bounds and flattens a captured line', () => {
  const line = sanitizeLine(`\u001b[32mfirst\u001b[39m\nsecond ${'x'.repeat(5000)}`);
  expect(line.startsWith('first second ')).toBe(true);
  expect(line.endsWith('…[truncated]')).toBe(true);
  expect(line.length).toBeLessThan(2100);
  expect(stripAnsi('\u001b[2mCall log\u001b[22m')).toBe('Call log');
});

it('finds commands the browser never answered or answered slowly', () => {
  const lines = [
    '2026-09-24T00:00:00.000Z t1 pw:protocol SEND ► {"id":1,"method":"Emulation.setDeviceMetricsOverride","params":{}}',
    '2026-09-24T00:00:00.010Z t1 pw:protocol SEND ► {"id":2,"method":"Runtime.callFunctionOn","params":{}}',
    '2026-09-24T00:00:00.020Z t1 pw:protocol ◀ RECV {"id":2,"result":{}}',
    '2026-09-24T00:00:01.500Z t1 pw:protocol ◀ RECV {"id":1,"result":{}}',
    '2026-09-24T00:00:01.600Z t1 pw:protocol SEND ► {"id":3,"method":"DOM.scrollIntoViewIfNeeded","params":{}}',
    '2026-09-24T00:00:01.700Z t1 pw:protocol ◀ RECV {"method":"Page.frameResized","params":{}}',
  ];
  expect(commandLatency(lines)).toEqual({
    unanswered: ['2026-09-24T00:00:01.600Z DOM.scrollIntoViewIfNeeded (id 3)'],
    slow: ['2026-09-24T00:00:00.000Z Emulation.setDeviceMetricsOverride (id 1) 1500 ms'],
  });
});

it('reports the worst worker event-loop delay', () => {
  expect(
    worstLoopDelay([
      'x t1 [diag] worker event-loop delay max=12.5ms p99=3.0ms',
      'x t1 [diag] worker event-loop delay max=840.2ms p99=10.0ms',
      'x t1 pw:api something else',
    ]),
  ).toBe(840.2);
  expect(worstLoopDelay([])).toBe(0);
});
