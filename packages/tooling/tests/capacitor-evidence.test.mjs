import { describe, expect, it } from 'vitest';
import {
  validKeyboardObservation,
  validOrientationObservation,
} from '../../../scripts/fixtures/capacitor-spike/evidence.mjs';

function observation(stage = 'portrait') {
  const landscape = stage === 'landscape';
  const width = landscape ? 844 : 390;
  const height = landscape ? 390 : 844;
  const window = { x: 0, y: 0, width, height };
  return {
    stage,
    outcome: 'passed',
    orientation: landscape ? 'landscapeLeft' : 'portrait',
    geometry: {
      window,
      view: { ...window },
      webView: { ...window },
      safeRect: { x: 0, y: 44, width, height: height - 78 },
      headingInWindow: { x: 16, y: 60, width: 300, height: 32 },
      safeAreaInsets: { top: 44, right: 0, bottom: 34, left: 0 },
      dom: {
        innerWidth: width,
        innerHeight: height,
        clientWidth: width,
        scrollWidth: width,
        bodyScrollWidth: width,
        scrollX: 0,
        scrollY: 0,
        visualViewport: { width, height, offsetLeft: 0, offsetTop: 0, scale: 1 },
        heading: { x: 16, y: 60, width: 300, height: 32 },
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
      },
    },
    checks: { orientationMatches: true, headingWithinSafeArea: true, noHorizontalOverflow: true },
  };
}

describe('measured simulator orientation evidence', () => {
  it.each(['portrait', 'landscape', 'restored'])(
    'accepts valid %s observations including zero CSS padding',
    (stage) => {
      expect(validOrientationObservation(observation(stage), stage)).toBe(true);
    },
  );
  it('accepts either landscape direction and only one pixel of measured tolerance', () => {
    const value = observation('landscape');
    value.orientation = 'landscapeRight';
    value.geometry.headingInWindow.x = -1;
    value.geometry.dom.scrollWidth += 1;
    expect(validOrientationObservation(value, 'landscape')).toBe(true);
    value.geometry.headingInWindow.x = -1.01;
    expect(validOrientationObservation(value, 'landscape')).toBe(false);
  });
  it.each([
    [
      'safe rect contradicts measured insets',
      (v) => {
        v.geometry.safeRect = { ...v.geometry.window };
      },
    ],
    [
      'heading escapes safe area',
      (v) => {
        v.geometry.headingInWindow.y = 0;
      },
    ],
    [
      'safe rect escapes window',
      (v) => {
        v.geometry.safeRect.width += 2;
      },
    ],
    [
      'document overflow',
      (v) => {
        v.geometry.dom.scrollWidth += 2;
      },
    ],
    [
      'body overflow',
      (v) => {
        v.geometry.dom.bodyScrollWidth += 2;
      },
    ],
    [
      'wrong window orientation',
      (v) => {
        v.geometry.window.width = 900;
      },
    ],
    [
      'wrong reported orientation',
      (v) => {
        v.orientation = 'landscapeLeft';
      },
    ],
    [
      'wrong stage',
      (v) => {
        v.stage = 'restored';
      },
    ],
    [
      'zero viewport',
      (v) => {
        v.geometry.dom.visualViewport.width = 0;
      },
    ],
    [
      'nonfinite heading',
      (v) => {
        v.geometry.dom.heading.x = Infinity;
      },
    ],
    [
      'nonfinite window',
      (v) => {
        v.geometry.window.height = NaN;
      },
    ],
    [
      'missing webview',
      (v) => {
        delete v.geometry.webView;
      },
    ],
    [
      'missing viewport',
      (v) => {
        delete v.geometry.dom.visualViewport;
      },
    ],
    [
      'negative inset',
      (v) => {
        v.geometry.safeAreaInsets.top = -1;
      },
    ],
    [
      'nonfinite padding',
      (v) => {
        v.geometry.dom.padding.left = Infinity;
      },
    ],
    [
      'failed declared check',
      (v) => {
        v.checks.orientationMatches = false;
      },
    ],
  ])('rejects %s even when other declared checks passed', (_name, mutate) => {
    const value = observation();
    mutate(value);
    expect(validOrientationObservation(value, 'portrait')).toBe(false);
  });
  it('rejects absent geometry, unknown stages and arbitrary untrusted values', () => {
    for (const value of [
      null,
      undefined,
      true,
      1,
      [],
      'passed',
      {},
      { stage: 'portrait', outcome: 'passed', checks: observation().checks },
    ]) {
      expect(validOrientationObservation(value, 'portrait')).toBe(false);
    }
    expect(validOrientationObservation(observation(), 'unknown')).toBe(false);
  });
});

function keyboardObservation(stage = 'keyboardShown') {
  const rotated = stage === 'keyboardLandscape';
  const value = observation(rotated ? 'landscape' : 'restored');
  const shown = stage !== 'keyboardDismissed';
  value.stage = stage;
  if (rotated) {
    value.geometry.safeAreaInsets = { top: 0, right: 62, bottom: 20, left: 62 };
    value.geometry.safeRect = { x: 62, y: 0, width: 720, height: 370 };
    value.geometry.headingInWindow.x = 78;
  }
  value.geometry.keyboard = {
    notification: shown ? 'didShow' : 'didHide',
    endFrameInWindow: {
      x: 0,
      y: shown ? (rotated ? 220 : 540) : 844,
      width: rotated ? 844 : 390,
      height: rotated ? 170 : 304,
    },
    focusedControlInWindow: {
      x: rotated ? 78 : 16,
      y: rotated ? 100 : 144,
      width: 358,
      height: 44,
    },
    focused: shown,
  };
  Object.assign(value.checks, {
    keyboardVisibilityMatches: true,
    focusMatches: true,
    focusedControlAboveKeyboard: true,
  });
  return value;
}

describe('measured simulator keyboard evidence', () => {
  it.each(['keyboardShown', 'keyboardLandscape', 'keyboardRestored', 'keyboardDismissed'])(
    'accepts %s only with its native frame',
    (stage) => {
      expect(validKeyboardObservation(keyboardObservation(stage), stage)).toBe(true);
    },
  );
  it.each([
    ['notification mismatch', (value) => (value.geometry.keyboard.notification = 'didHide')],
    ['missing keyboard frame', (value) => delete value.geometry.keyboard.endFrameInWindow],
    ['no visible keyboard overlap', (value) => (value.geometry.keyboard.endFrameInWindow.y = 844)],
    [
      'keyboard outside horizontally',
      (value) => (value.geometry.keyboard.endFrameInWindow.x = 900),
    ],
    ['keyboard only touches edge', (value) => (value.geometry.keyboard.endFrameInWindow.x = 389)],
    ['focus missing', (value) => (value.geometry.keyboard.focused = false)],
    ['field covered', (value) => (value.geometry.keyboard.focusedControlInWindow.y = 550)],
    ['field outside safe area', (value) => (value.geometry.keyboard.focusedControlInWindow.y = 0)],
    ['missing native check', (value) => delete value.checks.focusMatches],
    ['lying native check', (value) => (value.checks.focusMatches = false)],
  ])('rejects shown keyboard with %s', (_label, mutate) => {
    const value = keyboardObservation();
    mutate(value);
    expect(validKeyboardObservation(value, 'keyboardShown')).toBe(false);
  });
  it.each([
    ['keyboard still visible', (value) => (value.geometry.keyboard.endFrameInWindow.y = 540)],
    ['focus still held', (value) => (value.geometry.keyboard.focused = true)],
  ])('rejects dismissed keyboard with %s', (_label, mutate) => {
    const value = keyboardObservation('keyboardDismissed');
    mutate(value);
    expect(validKeyboardObservation(value, 'keyboardDismissed')).toBe(false);
  });
  it('accepts a dismissed keyboard completely outside the horizontal safe area', () => {
    const value = keyboardObservation('keyboardDismissed');
    value.geometry.keyboard.endFrameInWindow.x = 900;
    value.geometry.keyboard.endFrameInWindow.y = 540;
    expect(validKeyboardObservation(value, 'keyboardDismissed')).toBe(true);
  });
  it('rejects a keyboard rotation report whose actual scene is still portrait', () => {
    const value = keyboardObservation('keyboardLandscape');
    value.orientation = 'portrait';
    expect(validKeyboardObservation(value, 'keyboardLandscape')).toBe(false);
  });
});
