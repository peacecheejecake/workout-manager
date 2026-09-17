import { describe, expect, it } from 'vitest';
import { validOrientationObservation } from '../../../scripts/fixtures/capacitor-spike/evidence.mjs';

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
