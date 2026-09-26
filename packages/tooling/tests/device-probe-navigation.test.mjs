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

function embeddedScript(after) {
  const start = source.indexOf(after);
  assert.notEqual(start, -1);
  return source.slice(start).match(/"""\n([\s\S]*?)\n\s+"""/)?.[1];
}

it('native Back checks changed form fields before allowing history navigation', () => {
  assert.match(source, /allowsBackForwardNavigationGestures = false/);
  assert.match(source, /UIScreenEdgePanGestureRecognizer/);
  assert.match(source, /button\.accessibilityLabel = "뒤로 가기"/);
  assert.match(source, /UIAlertController\(/);
  const nativeCheck = embeddedScript('private static let unsavedInputScript');
  const injected = embeddedScript('static let script =');
  assert.ok(nativeCheck && injected);
  const listeners = new Map();
  const field = {
    id: 'workspace-note',
    tagName: 'TEXTAREA',
    type: 'textarea',
    value: '',
    defaultValue: '',
  };
  const context = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    document: {
      addEventListener: (name, callback) => listeners.set(name, callback),
      querySelector: () => field,
      querySelectorAll: () => [field],
    },
    location: { pathname: '/' },
    visualViewport: null,
    webkit: { messageHandlers: { wmDeviceProbe: { postMessage: () => {} } } },
  };
  vm.runInNewContext(injected, context);
  listeners.get('focusin')({ target: field });
  assert.equal(vm.runInNewContext(nativeCheck, context), false);
  field.value = 'unsaved';
  field.defaultValue = 'unsaved'; // React controlled textarea can synchronize this too.
  assert.equal(vm.runInNewContext(nativeCheck, context), true);
  field.value = '';
  field.defaultValue = '';
  assert.equal(vm.runInNewContext(nativeCheck, context), false);
  field.value = 'changed';
  listeners.get('input')({ target: field, inputType: 'insertText', isComposing: false });
  assert.equal(vm.runInNewContext(nativeCheck, context), true);
});

it('native keyboard reveal moves a focused field inside the visible landscape area', () => {
  assert.match(source, /keyboardWillChangeFrameNotification/);
  assert.match(source, /keyboardDidChangeFrameNotification/);
  assert.match(source, /event == "didShow" \|\| event == "didChangeFrame"/);
  assert.match(source, /latestKeyboardFrame/);
  assert.match(source, /scrollView\.contentInset = inset/);
  assert.match(source, /keyboardLayoutGuide\.topAnchor/);
  const script = embeddedScript('private func revealFocusedInput');
  assert.ok(script);
  const executable = script.replace('\\(bottom)', '168');
  const scrolls = [];
  const field = {
    matches: () => true,
    getBoundingClientRect: () => ({ top: 120, bottom: 190 }),
  };
  const context = {
    document: { activeElement: field },
    window: {
      visualViewport: { offsetTop: 0, height: 168 },
      scrollBy: (_x, y) => scrolls.push(y),
    },
    innerHeight: 430,
  };
  assert.equal(vm.runInNewContext(executable, context), true);
  assert.deepEqual(scrolls, [34]);
  field.getBoundingClientRect = () => ({ top: 40, bottom: 80 });
  assert.equal(vm.runInNewContext(executable, context), false);
  assert.deepEqual(scrolls, [34]);
});
