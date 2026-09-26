import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { it } from 'vitest';

const source = readFileSync(
  fileURLToPath(
    new URL('../../../scripts/fixtures/device-probe/SceneDelegate.swift', import.meta.url),
  ),
  'utf8',
);
const script = source.match(/static let script = """\n([\s\S]*?)\n {4}"""/)?.[1];

it('device telemetry uses fixed operation and route classes with synthetic private content', () => {
  assert.ok(script, 'the embedded WKWebView probe script must be present');
  const events = new Map();
  const messages = [];
  const privateText = 'PRIVATE-athlete-name-and-health-note';
  const memo = {
    id: 'workspace-note',
    tagName: 'TEXTAREA',
    value: privateText,
    labels: [{ textContent: privateText }],
    getAttribute: () => privateText,
  };
  const button = {
    tagName: 'BUTTON',
    textContent: privateText,
    getAttribute: () => privateText,
    closest: () => button,
  };
  const context = {
    addEventListener: (name, callback) => events.set(name, callback),
    clearTimeout: () => {},
    setTimeout: (callback) => callback(),
    webkit: {
      messageHandlers: { wmDeviceProbe: { postMessage: (message) => messages.push(message) } },
    },
    document: {
      addEventListener: (name, callback) => events.set(name, callback),
      querySelector: (selector) => (selector === '#workspace-note' ? memo : null),
    },
    location: { pathname: `/activities/${privateText}` },
    visualViewport: null,
  };
  vm.runInNewContext(script, context);
  events.get('focusin')({ target: memo });
  events.get('input')({ target: memo, inputType: privateText, isComposing: false });
  events.get('click')({ target: button });
  events.get('pageshow')({ persisted: false });
  events.get('popstate')();

  assert.deepEqual(
    messages.map(({ kind, operation, route }) => ({ kind, operation, route })),
    [
      { kind: 'focus', operation: 'memo-input', route: undefined },
      { kind: 'input', operation: 'memo-input', route: undefined },
      { kind: 'click', operation: 'button', route: undefined },
      { kind: 'memoState', operation: undefined, route: undefined },
      { kind: 'pageshow', operation: undefined, route: 'other' },
      { kind: 'popstate', operation: undefined, route: 'other' },
    ],
  );
  assert.equal(messages.find((message) => message.kind === 'input').inputType, 'other');
  assert.equal(JSON.stringify(messages).includes(privateText), false);
});
