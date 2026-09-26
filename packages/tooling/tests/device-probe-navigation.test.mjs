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
  const script = embeddedScript('private static let unsavedInputScript');
  assert.ok(script);
  const field = { type: 'text', value: '', defaultValue: '' };
  const context = { document: { querySelectorAll: () => [field] } };
  assert.equal(vm.runInNewContext(script, context), false);
  field.value = 'unsaved';
  assert.equal(vm.runInNewContext(script, context), true);
  field.value = '';
  assert.equal(vm.runInNewContext(script, context), false);
  field.type = 'checkbox';
  field.checked = true;
  field.defaultChecked = false;
  assert.equal(vm.runInNewContext(script, context), true);
});

it('native keyboard reveal moves a focused field inside the visible landscape area', () => {
  assert.match(source, /keyboardWillChangeFrameNotification/);
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
