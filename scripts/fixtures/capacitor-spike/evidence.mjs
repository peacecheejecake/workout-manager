const stages = new Set(['portrait', 'landscape', 'restored']);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const positive = (value) => finite(value) && value > 0;
const object = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const rect = (value) =>
  object(value) &&
  finite(value.x) &&
  finite(value.y) &&
  positive(value.width) &&
  positive(value.height) &&
  finite(value.x + value.width) &&
  finite(value.y + value.height);
const edges = (value) =>
  object(value) &&
  ['top', 'right', 'bottom', 'left'].every((key) => finite(value[key]) && value[key] >= 0);
const within = (inner, outer) =>
  inner.x >= outer.x - 1 &&
  inner.y >= outer.y - 1 &&
  inner.x + inner.width <= outer.x + outer.width + 1 &&
  inner.y + inner.height <= outer.y + outer.height + 1;

/** Validate measured simulator geometry; declarations alone are not evidence. */
export function validOrientationObservation(value, expectedStage) {
  if (
    !stages.has(expectedStage) ||
    !object(value) ||
    value.stage !== expectedStage ||
    value.outcome !== 'passed'
  )
    return false;
  const landscape = expectedStage === 'landscape';
  if (
    landscape
      ? !['landscapeLeft', 'landscapeRight'].includes(value.orientation)
      : value.orientation !== 'portrait'
  )
    return false;
  const geometry = value.geometry;
  if (
    !object(geometry) ||
    !['window', 'view', 'webView', 'safeRect', 'headingInWindow'].every((key) =>
      rect(geometry[key]),
    ) ||
    !edges(geometry.safeAreaInsets)
  )
    return false;
  const { window, safeRect, headingInWindow, safeAreaInsets, dom } = geometry;
  const measuredSafeRect = {
    x: window.x + safeAreaInsets.left,
    y: window.y + safeAreaInsets.top,
    width: window.width - safeAreaInsets.left - safeAreaInsets.right,
    height: window.height - safeAreaInsets.top - safeAreaInsets.bottom,
  };
  if (
    !rect(measuredSafeRect) ||
    !['x', 'y', 'width', 'height'].every(
      (key) => Math.abs(safeRect[key] - measuredSafeRect[key]) <= 1,
    )
  )
    return false;
  if (landscape ? window.width <= window.height : window.height <= window.width) return false;
  if (!within(safeRect, window) || !within(headingInWindow, safeRect)) return false;
  if (
    !object(dom) ||
    !['innerWidth', 'innerHeight', 'clientWidth', 'scrollWidth', 'bodyScrollWidth'].every((key) =>
      positive(dom[key]),
    ) ||
    !finite(dom.scrollX) ||
    !finite(dom.scrollY) ||
    !rect(dom.heading) ||
    !edges(dom.padding)
  )
    return false;
  const viewport = dom.visualViewport;
  if (
    !object(viewport) ||
    !positive(viewport.width) ||
    !positive(viewport.height) ||
    !positive(viewport.scale) ||
    !finite(viewport.offsetLeft) ||
    !finite(viewport.offsetTop)
  )
    return false;
  if (dom.scrollWidth > dom.clientWidth + 1 || dom.bodyScrollWidth > dom.clientWidth + 1)
    return false;
  return (
    object(value.checks) &&
    ['orientationMatches', 'headingWithinSafeArea', 'noHorizontalOverflow'].every(
      (key) => value.checks[key] === true,
    )
  );
}
