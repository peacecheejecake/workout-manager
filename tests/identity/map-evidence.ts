import { expect, type Locator, type Page } from '@playwright/test';

/**
 * What the map says about itself, read the way assistive technology reads it.
 *
 * Every map screen mounts the kit's `MapView`: a region named after the map, holding one
 * `role="status"` line (a polite live region) and `data-map-status`. "Drawn" is claimed
 * only after the renderer went idle with our own line features on screen, counted on the
 * line layer alone (`data-rendered-lines`), so neither a loaded style nor points without
 * a line can satisfy these checks (M2-01k F2/F3, M2-01q).
 */
export function mapRegion(scope: Page | Locator, label: string): Locator {
  return scope.getByRole('region', { name: label, exact: true });
}

/** The live status line of one map: the text a screen reader announces. */
export function mapStatusLine(region: Locator): Locator {
  return region.getByRole('status').first();
}

export async function renderedLines(region: Locator): Promise<number> {
  return Number((await region.getAttribute('data-rendered-lines')) ?? '0');
}

/**
 * The line is drawn: the status says so, and the renderer's own line layer holds at least
 * one of our features after idle. Basemap tiles cannot satisfy this; neither can a point.
 */
export async function expectLineDrawn(
  region: Locator,
  options: {
    readonly timeout?: number;
    /**
     * The path generation before the action under test. The verdict must then be about a
     * different path: the action has to have reached the map before "drawn" counts.
     */
    readonly changedFrom?: string | null;
  } = {},
): Promise<void> {
  const { timeout = 20_000, changedFrom } = options;
  // The verdict must be about the path on screen NOW. A verdict stands until the next
  // observation, so right after the path changes on the same renderer (a cached course
  // switch, an edit) the region still says "drawn" about the previous path. Waiting for the
  // evidence generation to catch up with the path generation closes that gap (review N1).
  await expect
    .poll(
      async () => {
        const [paths, evidence, status] = await Promise.all([
          region.getAttribute('data-paths-generation'),
          region.getAttribute('data-evidence-generation'),
          region.getAttribute('data-map-status'),
        ]);
        if (paths === null || paths !== evidence) return `waiting:${status}`;
        if (changedFrom !== undefined && paths === changedFrom) return `unchanged:${status}`;
        return status;
      },
      { timeout, message: 'a "drawn" verdict about the path now handed to the map' },
    )
    .toBe('drawn');
  await expect(region).toHaveAttribute('data-map-status', 'drawn');
  await expect(mapStatusLine(region)).toHaveText(
    /^(지도에 경로를 표시했습니다\.|배경 지도 없이 경로를 표시했습니다\.)$/,
  );
  expect(await renderedLines(region)).toBeGreaterThan(0);
}

/**
 * Every `data-map-status` value any map on the page ever held, in order, recorded from the
 * first byte of the document. An assertion on the final state alone could miss a
 * "drawn" that was shown and then withdrawn; this history cannot.
 */
export async function recordMapStatuses(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __mapStatuses: string[] }).__mapStatuses = seen;
    const note = (element: Element) => {
      const value = element.getAttribute('data-map-status');
      if (value !== null && seen[seen.length - 1] !== value) seen.push(value);
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target instanceof Element) note(record.target);
        for (const node of record.addedNodes)
          if (node instanceof Element)
            for (const element of [node, ...node.querySelectorAll('[data-map-status]')])
              note(element);
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-map-status'],
    });
  });
}

export async function mapStatusHistory(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __mapStatuses?: string[] }).__mapStatuses ?? [],
  );
}

/** Refuse the MapLibre worker, which is what the Next course screen did by omission (F2). */
export async function refuseMapWorker(page: Page): Promise<void> {
  await page.route(/\/dist\/maplibre\/maplibre-gl-worker(-dev)?\.mjs$/, (route) => route.abort());
}

/** A browser whose canvases hand out no WebGL context at all. */
export async function withoutWebGl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      if (kind.startsWith('webgl') || kind === 'experimental-webgl') return null;
      return (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
}
