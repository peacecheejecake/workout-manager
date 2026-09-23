import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';

import { CourseWorkbench } from '../src/course-workbench';
import { decimalOrNull } from '../src/course-extras';

/**
 * The M2-01j screens (import, favourites, last used, place search, elevation, protected
 * areas and the privacy trim), against a transport under the test's control.
 *
 * What these fix is the part a screen can get wrong on its own: it must not compute
 * anything about the file it uploads, it must not turn "we have no dataset" into "nothing
 * found", it must not show a trim as an overwrite, and a preference must never travel as
 * anything but the two allowlisted fields.
 */
type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});

const courseId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const zoneId = '33333333-3333-4333-8333-333333333333';
const createdAt = '2026-03-01T00:00:00.000Z';

const head = {
  status: 'available',
  courseId,
  name: '가져온 코스',
  visibility: 'private',
  headRevision: 2,
  revisionId: '55555555-5555-4555-8555-555555555555',
  createdAt,
  updatedAt: createdAt,
};
const otherHead = { ...head, courseId: otherId, name: '다른 코스' };
const revision = {
  courseId,
  courseRevision: 2,
  revisionId: head.revisionId,
  name: '가져온 코스',
  geometry: {
    type: 'LineString',
    coordinates: [
      [126.9779, 37.5665],
      [126.9799, 37.5671],
    ],
  },
  waypoints: [
    { role: 'start', position: [126.9779, 37.5665], name: null, sourceSampleId: null },
    { role: 'finish', position: [126.9799, 37.5671], name: null, sourceSampleId: null },
  ],
  generation: {
    kind: 'imported-file',
    format: 'gpx',
    sourceKind: 'gpx-trk',
    itemIndex: 0,
    parserId: 'gpx-track-v1',
    parserVersion: 1,
    fileSha256: 'a'.repeat(64),
    fileByteLength: 320,
    originalFilename: 'course.gpx',
    fileCreator: 'garmin',
    vertexCount: 2,
    importedWaypointCount: 0,
    ignoredFileWaypointCount: 3,
  },
  edit: { kind: 'imported' },
  lineage: [],
  distanceMeters: 1830.5,
  contentDigest: 'b'.repeat(64),
  createdAt,
};

const dataset = {
  kind: 'places',
  datasetId: '0123456789ab',
  datasetVersion: 1,
  region: 'Seoul',
  sourceExtractSha256: 'a'.repeat(64),
  licence: 'ODbL-1.0',
  licenceUrl: 'https://www.openstreetmap.org/copyright',
  attribution: '© OpenStreetMap contributors',
  updateCadence: '월 1회',
  builtAt: createdAt,
  featureCount: 1,
  bbox: [126.7, 37.4, 127.3, 37.7],
};

interface Options {
  readonly preferences?: { courseId: string; favourite: boolean; lastUsedAt: string | null }[];
  readonly zones?: {
    zoneId: string;
    name: string;
    center: [number, number];
    radiusMeters: number;
  }[];
  readonly elevation?: unknown;
  readonly placeSearch?: unknown;
  /** One reply per place-search call, in order; falls back to `placeSearch`. */
  readonly placeSearchByCall?: readonly unknown[];
  /** Holds the FIRST place-search response until the test releases it. */
  readonly holdFirstPlaceSearch?: Promise<unknown>;
  /** Holds the protected-area ADD response until the test releases it. */
  readonly holdZoneAdd?: Promise<unknown>;
  /** The area an addition stores, so the mock server has something to add. */
  readonly zoneToAdd?: { zoneId: string; name: string; radiusMeters: number };
  /** Refuse every removal, the way a removal of an area somebody else deleted is refused. */
  readonly zoneRemoveFails?: boolean;
  readonly importReply?: { body: unknown; status?: number };
  /** Holds the FIRST import response until the test releases it. */
  readonly holdFirstImport?: Promise<unknown>;
  /** What that first, held response finally is, when it differs from the rest. */
  readonly firstImportReply?: { body: unknown; status?: number };
  readonly trimReply?: { body: unknown; status?: number };
  readonly athleteId?: string;
}

function setup(options: Options = {}) {
  let imports = 0;
  let searches = 0;
  // The mock server's own protected areas, so a write is observable in what a later read
  // answers. A fixed reply cannot show "the list the screen shows is not the list the
  // server holds", which is the defect these tests exist for.
  const stored = (options.zones ?? []).map((zone) => ({
    ...zone,
    createdAt,
    updatedAt: createdAt,
  }));
  const zoneList = () => ({
    zones: [...stored],
    total: stored.length,
    zoneSetDigest: stored.length === 0 ? 'd'.repeat(64) : 'c'.repeat(64),
  });
  const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
    if (input.path === '/bff/v1/courses' && input.method === 'GET')
      return reply({ courses: [head, otherHead], total: 2 });
    if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'GET')
      return reply({ status: 'available', course: head, revision, thumbnail: { status: 'none' } });
    if (input.path === `/bff/v1/courses/${otherId}` && input.method === 'GET')
      return reply({
        status: 'available',
        course: otherHead,
        revision: { ...revision, courseId: otherId, name: '다른 코스' },
        thumbnail: { status: 'none' },
      });
    if (input.path === '/bff/v1/courses/preferences' && input.method === 'GET')
      return reply({
        preferences: options.preferences ?? [],
        total: (options.preferences ?? []).length,
      });
    if (input.path === '/bff/v1/courses/preferences' && input.method === 'PUT')
      return reply({ courseId, favourite: true, lastUsedAt: createdAt });
    if (input.path === '/bff/v1/courses/privacy-zones' && input.method === 'GET')
      return reply(zoneList());
    if (input.path === '/bff/v1/courses/place-search' && input.method === 'POST') {
      searches += 1;
      const at = searches - 1;
      if (at === 0 && options.holdFirstPlaceSearch) await options.holdFirstPlaceSearch;
      return reply(
        options.placeSearchByCall?.[at] ?? options.placeSearch ?? { outcome: 'no_dataset' },
      );
    }
    if (input.path === '/bff/v1/courses/privacy-zones' && input.method === 'POST') {
      // The server stores the area and computes its answer now; only the answer is
      // delayed. That is what makes a held response *stale* rather than *pending*.
      if (options.zoneToAdd)
        stored.push({
          ...options.zoneToAdd,
          center: [127.1, 37.6] as [number, number],
          createdAt,
          updatedAt: createdAt,
        });
      const answer = zoneList();
      if (options.holdZoneAdd) await options.holdZoneAdd;
      return reply(answer);
    }
    if (input.path.startsWith('/bff/v1/courses/privacy-zones/') && input.method === 'DELETE') {
      if (options.zoneRemoveFails) return reply({ error: { code: 'PRIVACY_ZONE_NOT_FOUND' } }, 404);
      const gone = input.path.slice(input.path.lastIndexOf('/') + 1);
      const at = stored.findIndex((zone) => zone.zoneId === gone);
      if (at >= 0) stored.splice(at, 1);
      return reply(zoneList());
    }
    if (input.path.endsWith('/elevation') && input.method === 'GET')
      return reply(options.elevation ?? { outcome: 'no_dataset' });
    if (input.path === '/bff/v1/courses/imports' && input.method === 'POST') {
      imports += 1;
      const first = imports === 1;
      if (first && options.holdFirstImport) await options.holdFirstImport;
      const chosen = (first ? options.firstImportReply : undefined) ?? options.importReply;
      return reply(
        chosen?.body ?? {
          outcome: 'imported',
          course: { status: 'available', course: head, revision, thumbnail: { status: 'none' } },
        },
        chosen?.status ?? 200,
      );
    }
    if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'PATCH')
      return reply(
        options.trimReply?.body ?? {
          status: 'available',
          course: { ...head, headRevision: 3 },
          revision: { ...revision, courseRevision: 3 },
          thumbnail: { status: 'none' },
        },
        options.trimReply?.status ?? 200,
      );
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  const view = render(
    <CourseWorkbench
      athleteId={options.athleteId ?? 'athlete-1'}
      sessionId="session-1"
      transport={{ request }}
    />,
  );
  return { request, view };
}

/**
 * The list row a course sits in. The favourite toggle is named for the action rather than
 * for the course — two controls in one row answering to the same name is ambiguous — so a
 * test addresses it through the row it belongs to, exactly as a reader would.
 */
function courseRow(name: string): HTMLElement {
  const row = screen.getByRole('button', { name }).closest('li');
  if (!row) throw new Error(`no list row for ${name}`);
  return row;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * A `Blob.arrayBuffer` the test controls. jsdom ships none, so this both installs the
 * modern path the component prefers and lets each read be released by hand.
 */
function installArrayBuffer(
  onRead: (name: string, resolve: (buffer: ArrayBuffer) => void) => void,
) {
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    writable: true,
    value(this: File) {
      const name = this.name;
      return new Promise<ArrayBuffer>((resolve) => onRead(name, resolve));
    },
  });
}

function removeArrayBuffer() {
  Reflect.deleteProperty(Blob.prototype, 'arrayBuffer');
}

function gpxFile(name = 'course.gpx') {
  const document = `<?xml version="1.0"?><gpx version="1.1" creator="x" xmlns="http://www.topografix.com/GPX/1/1"><rte><name>r</name><rtept lat="37.5" lon="127.02"/><rtept lat="37.501" lon="127.021"/></rte></gpx>`;
  return new File([document], name, { type: 'application/gpx+xml' });
}

describe('GPX import on screen', () => {
  it('sends the file and a name, and never a geometry or a distance', async () => {
    const { request } = setup();
    const input = await screen.findByLabelText('가져올 GPX 파일');
    await userEvent.upload(input, gpxFile());
    await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
    await waitFor(() => {
      const call = request.mock.calls.find(([value]) => value.path === '/bff/v1/courses/imports');
      expect(call).toBeDefined();
      const body = call?.[0].body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        'fileBase64',
        'name',
        'originalFilename',
        'selection',
      ]);
      expect(call?.[0].idempotencyKey).toBeTruthy();
    });
    expect(await screen.findByText(/코스를 가져왔습니다/)).toBeInTheDocument();
  });

  it('imports the file that is selected, even when an earlier read finishes last', async () => {
    // Reads finish out of order: a large first file can land after a small second one.
    // Only the latest selection may put bytes in the command. jsdom has no
    // `Blob.arrayBuffer`, so installing one here is also what makes the component take
    // that path — and it is the path a browser takes.
    const { request } = setup();
    const input = await screen.findByLabelText('가져올 GPX 파일');
    const held = new Map<string, () => void>();
    const bytes = new TextEncoder().encode('<gpx/>');
    installArrayBuffer((name, resolve) => held.set(name, () => resolve(bytes.buffer)));
    try {
      await userEvent.upload(input, gpxFile('slow.gpx'));
      await userEvent.upload(input, gpxFile('fast.gpx'));
      // The second read completes first, then the first one lands late.
      held.get('fast.gpx')?.();
      await waitFor(() => expect(screen.getByRole('button', { name: '가져오기' })).toBeEnabled());
      held.get('slow.gpx')?.();
      await settle();
      await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
      await waitFor(() => {
        const call = request.mock.calls.find(([value]) => value.path === '/bff/v1/courses/imports');
        expect(call?.[0].body).toMatchObject({ originalFilename: 'fast.gpx' });
      });
    } finally {
      removeArrayBuffer();
    }
  });

  /**
   * A response belongs to the selection it was sent for, and to no other.
   *
   * The read already knew that. The response did not: an import sent for the first file
   * cleared `pending`, the command key, the name field and the item list when it landed,
   * whichever file was selected by then. Choosing a second file while the first request is
   * still out and then pressing 가져오기 sent nothing at all, because the late success had
   * thrown the second file away.
   */
  it('does not let a late import response discard the file selected since', async () => {
    let releaseFirst = () => {};
    const firstImport = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { request } = setup({ holdFirstImport: firstImport });
    const input = await screen.findByLabelText('가져올 GPX 파일');
    const held = new Map<string, () => void>();
    const bytes = new TextEncoder().encode('<gpx/>');
    installArrayBuffer((name, resolve) => held.set(name, () => resolve(bytes.buffer)));
    try {
      await userEvent.upload(input, gpxFile('first.gpx'));
      held.get('first.gpx')?.();
      await waitFor(() => expect(screen.getByRole('button', { name: '가져오기' })).toBeEnabled());
      // The first import goes out and stays out.
      await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
      await waitFor(() =>
        expect(
          request.mock.calls.filter(([value]) => value.path === '/bff/v1/courses/imports'),
        ).toHaveLength(1),
      );
      // A second file is chosen and read while that request is still in flight.
      await userEvent.upload(input, gpxFile('second.gpx'));
      held.get('second.gpx')?.();
      await waitFor(() => expect(screen.getByRole('button', { name: '가져오기' })).toBeEnabled());
      // Now the first response lands. It speaks for a selection that is no longer current.
      releaseFirst();
      await settle();
      await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
      await waitFor(() => {
        const calls = request.mock.calls.filter(
          ([value]) => value.path === '/bff/v1/courses/imports',
        );
        expect(calls).toHaveLength(2);
        expect(calls[1]?.[0].body).toMatchObject({ originalFilename: 'second.gpx' });
      });
    } finally {
      removeArrayBuffer();
    }
  });

  /**
   * The same rule on the way out. A refusal of the first request used to drop the command
   * key and write its message over the screen the second selection was looking at, and to
   * clear `busy` while the second file was still being read.
   */
  it('does not let a late import refusal speak for the file selected since', async () => {
    let releaseFirst = () => {};
    const firstImport = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { request } = setup({
      holdFirstImport: firstImport,
      firstImportReply: { status: 422, body: { error: { code: 'COURSE_IMPORT_SPANS_A_GAP' } } },
    });
    const input = await screen.findByLabelText('가져올 GPX 파일');
    const held = new Map<string, () => void>();
    const bytes = new TextEncoder().encode('<gpx/>');
    installArrayBuffer((name, resolve) => held.set(name, () => resolve(bytes.buffer)));
    try {
      await userEvent.upload(input, gpxFile('first.gpx'));
      held.get('first.gpx')?.();
      await waitFor(() => expect(screen.getByRole('button', { name: '가져오기' })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
      await waitFor(() =>
        expect(
          request.mock.calls.filter(([value]) => value.path === '/bff/v1/courses/imports'),
        ).toHaveLength(1),
      );
      // Second file chosen; its read is still running when the first refusal arrives.
      await userEvent.upload(input, gpxFile('second.gpx'));
      releaseFirst();
      await settle();
      // The refusal was about the first file, which is no longer on screen.
      expect(screen.queryByText(/끊긴 구간이 여러 개입니다/)).not.toBeInTheDocument();
      // And the second file is still being read, so nothing may be sent yet.
      expect(screen.getByRole('button', { name: '가져오기' })).toBeDisabled();
      held.get('second.gpx')?.();
      await waitFor(() => expect(screen.getByRole('button', { name: '가져오기' })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
      await waitFor(() => {
        const calls = request.mock.calls.filter(
          ([value]) => value.path === '/bff/v1/courses/imports',
        );
        expect(calls).toHaveLength(2);
        expect(calls[1]?.[0].body).toMatchObject({ originalFilename: 'second.gpx' });
      });
    } finally {
      removeArrayBuffer();
    }
  });

  it('does not resurrect a file the owner replaced with one that is too large', async () => {
    const { request } = setup();
    const input = await screen.findByLabelText('가져올 GPX 파일');
    const held = new Map<string, () => void>();
    const bytes = new TextEncoder().encode('<gpx/>');
    installArrayBuffer((name, resolve) => held.set(name, () => resolve(bytes.buffer)));
    try {
      await userEvent.upload(input, gpxFile('first.gpx'));
      const oversize = new File(['x'], 'huge.gpx', { type: 'application/gpx+xml' });
      Object.defineProperty(oversize, 'size', { value: 8 * 1024 * 1024 });
      await userEvent.upload(input, oversize);
      expect(await screen.findByText('파일이 너무 큽니다.')).toBeInTheDocument();
      // The first read lands now. It must not become the file waiting to be sent.
      held.get('first.gpx')?.();
      await settle();
      await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
      await settle();
      expect(request.mock.calls.some(([value]) => value.path === '/bff/v1/courses/imports')).toBe(
        false,
      );
    } finally {
      removeArrayBuffer();
    }
  });

  it('asks which item to import when the server says the file holds several', async () => {
    const { request } = setup({
      importReply: {
        body: {
          outcome: 'requires_selection',
          fileSha256: 'd'.repeat(64),
          items: [
            {
              sourceKind: 'gpx-trk',
              itemIndex: 0,
              name: '기록',
              pointCount: 10,
              positionedPointCount: 10,
            },
            {
              sourceKind: 'gpx-rte',
              itemIndex: 0,
              name: '경로',
              pointCount: 3,
              positionedPointCount: 3,
            },
          ],
        },
      },
    });
    await userEvent.upload(await screen.findByLabelText('가져올 GPX 파일'), gpxFile());
    await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
    expect(await screen.findByText(/하나를 고르세요/)).toBeInTheDocument();
    const choice = await screen.findByRole('button', { name: /경로 1: 경로 · 3점/ });
    await userEvent.click(choice);
    await waitFor(() => {
      const second = request.mock.calls.filter(
        ([value]) => value.path === '/bff/v1/courses/imports',
      )[1];
      expect(second?.[0].body).toMatchObject({
        selection: { sourceKind: 'gpx-rte', itemIndex: 0 },
      });
    });
  });

  /**
   * The three 4xx codes that do **not** prove nothing was stored.
   *
   * 408, 425 and 429 can come from anything between the browser and us — a proxy, a
   * gateway, a rate limiter — so like a 5xx and like no response at all they leave the
   * outcome unknown, and M2-01f's rule is that an unknown outcome is retried under the
   * **same** idempotency key. A fresh key would turn one interrupted import into two
   * courses. The test above only ever exercised 503 and 422, so the exclusion list itself
   * was unfixed: removing it changed nothing any test could see.
   */
  it.each([408, 425, 429])(
    'keeps the command key after a %i, whose outcome is unknown',
    async (status) => {
      const { request } = setup({
        importReply: { status, body: { error: { code: 'REQUEST_FAILED' } } },
      });
      const input = await screen.findByLabelText('가져올 GPX 파일');
      await userEvent.upload(input, gpxFile());
      await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
      await screen.findByText(/입력을 확인한 뒤 다시 시도하세요|요청을 완료하지 못했습니다/);
      await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
      await waitFor(() => {
        const keys = request.mock.calls
          .filter(([value]) => value.path === '/bff/v1/courses/imports')
          .map(([value]) => value.idempotencyKey);
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBe(keys[1]);
      });
    },
  );

  /** And a 4xx of ours, which does prove it: a new command, under a new key. */
  it.each([400, 413, 422])('starts a new command after a %i of ours', async (status) => {
    const { request } = setup({
      importReply: { status, body: { error: { code: 'COURSE_IMPORT_TOO_FEW_POSITIONS' } } },
    });
    const input = await screen.findByLabelText('가져올 GPX 파일');
    await userEvent.upload(input, gpxFile());
    await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
    await screen.findByText(/좌표가 2개 미만|입력을 확인한 뒤 다시 시도하세요/);
    await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
    await waitFor(() => {
      const keys = request.mock.calls
        .filter(([value]) => value.path === '/bff/v1/courses/imports')
        .map(([value]) => value.idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe(keys[1]);
    });
  });

  it('retries a lost response under the same key, and starts a new command after a refusal', async () => {
    const { request } = setup({
      importReply: { status: 503, body: { error: { code: 'UPSTREAM_UNAVAILABLE' } } },
    });
    const input = await screen.findByLabelText('가져올 GPX 파일');
    await userEvent.upload(input, gpxFile());
    await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
    await screen.findByText(/입력을 확인한 뒤 다시 시도하세요|요청을 완료하지 못했습니다/);
    await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
    await waitFor(() => {
      const keys = request.mock.calls
        .filter(([value]) => value.path === '/bff/v1/courses/imports')
        .map(([value]) => value.idempotencyKey);
      expect(keys).toHaveLength(2);
      // The outcome was unknown, so the same command goes again under the same key.
      expect(keys[0]).toBe(keys[1]);
    });
  });

  it('issues a new key after a refusal that proves nothing was stored', async () => {
    const { request } = setup({
      importReply: { status: 422, body: { error: { code: 'COURSE_IMPORT_SPANS_A_GAP' } } },
    });
    await userEvent.upload(await screen.findByLabelText('가져올 GPX 파일'), gpxFile());
    await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
    await screen.findByText(/끊긴 곳을 직선으로 잇지 않으므로/);
    await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
    await waitFor(() => {
      const keys = request.mock.calls
        .filter(([value]) => value.path === '/bff/v1/courses/imports')
        .map(([value]) => value.idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe(keys[1]);
    });
  });

  it('explains a refusal in the owner words instead of a code', async () => {
    setup({
      importReply: {
        status: 422,
        body: { error: { code: 'COURSE_IMPORT_SPANS_A_GAP' } },
      },
    });
    await userEvent.upload(await screen.findByLabelText('가져올 GPX 파일'), gpxFile());
    await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
    expect(await screen.findByText(/끊긴 곳을 직선으로 잇지 않으므로/)).toBeInTheDocument();
  });

  it('says an imported course came from a file and names no recording', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    expect(await screen.findByTestId('course-generation')).toHaveTextContent(
      /가져온 파일 · GPX 기록\(trk\)/,
    );
    expect(screen.getByText(/가져온 파일에서 만든 코스입니다/)).toBeInTheDocument();
  });
});

describe('the course thumbnail', () => {
  it('draws the head line the owner is looking at and stores nothing', async () => {
    const { request } = setup();
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    const thumbnail = await screen.findByTestId('course-thumbnail');
    expect(thumbnail).toHaveAttribute('aria-label', expect.stringContaining('가져온 코스'));
    const drawn = thumbnail.querySelector('path')?.getAttribute('d') ?? '';
    expect(drawn.startsWith('M')).toBe(true);
    // No request of its own: it is a rendering of coordinates the screen already has.
    expect(request.mock.calls.some(([value]) => value.path.includes('thumbnail'))).toBe(false);
  });

  it('shows the trimmed line once a course has been trimmed, never the original', async () => {
    const trimmedRevision = {
      ...revision,
      courseRevision: 3,
      geometry: {
        type: 'LineString',
        coordinates: [
          [126.99, 37.57],
          [126.995, 37.575],
        ],
      },
      generation: {
        kind: 'privacy-trimmed',
        sourceRevision: 2,
        sourceGenerationKind: 'imported-file',
        sourceGraphBuildId: null,
        policyVersion: 1,
        zoneSetDigest: 'd'.repeat(64),
        appliedZoneCount: 1,
        removedVertexCount: 1,
        removedLeadingVertexCount: 1,
        removedTrailingVertexCount: 0,
        removedWaypointCount: 0,
        vertexCount: 2,
      },
      edit: { kind: 'privacy-trimmed' },
    };
    const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
      if (input.path === '/bff/v1/courses' && input.method === 'GET')
        return reply({ courses: [{ ...head, headRevision: 3 }], total: 1 });
      if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'GET')
        return reply({
          status: 'available',
          course: { ...head, headRevision: 3 },
          revision: trimmedRevision,
          thumbnail: { status: 'none' },
        });
      if (input.path === '/bff/v1/courses/preferences') return reply({ preferences: [], total: 0 });
      if (input.path === '/bff/v1/courses/privacy-zones')
        return reply({ zones: [], total: 0, zoneSetDigest: 'c'.repeat(64) });
      if (input.path.endsWith('/elevation')) return reply({ outcome: 'no_dataset' });
      throw new Error(`unexpected request ${input.method} ${input.path}`);
    });
    render(<CourseWorkbench athleteId="athlete-1" sessionId="session-1" transport={{ request }} />);
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    const thumbnail = await screen.findByTestId('course-thumbnail');
    expect(thumbnail).toHaveAttribute('data-vertices', '2');
    expect(thumbnail).toHaveAttribute('aria-label', expect.stringContaining('수정 번호 3'));
  });
});

describe('favourites and last used', () => {
  it('writes only the allowlisted field when a course is marked', async () => {
    const { request } = setup();
    await screen.findByRole('button', { name: '가져온 코스' });
    await userEvent.click(
      within(courseRow('가져온 코스')).getByRole('button', { name: '즐겨찾기' }),
    );
    await waitFor(() => {
      const call = request.mock.calls.find(
        ([value]) => value.path === '/bff/v1/courses/preferences' && value.method === 'PUT',
      );
      expect(call?.[0].body).toEqual({ courseId, update: { favourite: true } });
    });
  });

  it('records a use when a course is opened, with no moment of its own', async () => {
    const { request } = setup();
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    await waitFor(() => {
      const call = request.mock.calls.find(
        ([value]) =>
          value.path === '/bff/v1/courses/preferences' &&
          value.method === 'PUT' &&
          JSON.stringify(value.body).includes('markUsed'),
      );
      expect(call?.[0].body).toEqual({ courseId, update: { markUsed: true } });
    });
  });

  it('names the course when a preference write fails, because the list is not the detail', async () => {
    const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
      if (input.path === '/bff/v1/courses' && input.method === 'GET')
        return reply({ courses: [head, otherHead], total: 2 });
      if (input.path === '/bff/v1/courses/preferences' && input.method === 'GET')
        return reply({ preferences: [], total: 0 });
      if (input.path === '/bff/v1/courses/preferences' && input.method === 'PUT')
        return reply({ error: { code: 'UPSTREAM_UNAVAILABLE' } }, 503);
      throw new Error(`unexpected request ${input.method} ${input.path}`);
    });
    render(<CourseWorkbench athleteId="athlete-1" sessionId="session-1" transport={{ request }} />);
    await screen.findByRole('button', { name: '다른 코스' });
    await userEvent.click(within(courseRow('다른 코스')).getByRole('button', { name: '즐겨찾기' }));
    expect(
      await screen.findByText(/다른 코스: 기본 설정을 저장하지 못했습니다/),
    ).toBeInTheDocument();
  });

  it('puts favourites first and offers the owner last-used order', async () => {
    setup({ preferences: [{ courseId: otherId, favourite: true, lastUsedAt: createdAt }] });
    const list = await screen.findByRole('list', { name: '코스 목록' });
    await waitFor(() => {
      const names = [...list.querySelectorAll('li')].map((item) => item.textContent ?? '');
      expect(names[0]).toContain('다른 코스');
      expect(names[0]).toContain('★');
    });
    await userEvent.click(screen.getByRole('button', { name: '최근 사용순으로 보기' }));
    expect(screen.getByRole('button', { name: '이름순으로 보기' })).toBeInTheDocument();
  });

  /**
   * The order itself, not only the button that switches it.
   *
   * The existing test above read the button's label and never looked at the list, so the
   * whole last-used comparison was unfixed: reversing it, or dropping it, changed nothing
   * any test could see.
   */
  it("orders by name, then by the owner's last-used moments, favourites first in both", async () => {
    const courseOf = (id: string, name: string) => ({ ...head, courseId: id, name });
    const never = courseOf('a1111111-1111-4111-8111-111111111111', '가코스');
    const older = courseOf('b2222222-2222-4222-8222-222222222222', '나코스');
    const newer = courseOf('c3333333-3333-4333-8333-333333333333', '다코스');
    const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
      if (input.path === '/bff/v1/courses' && input.method === 'GET')
        return reply({ courses: [newer, never, older], total: 3 });
      if (input.path === '/bff/v1/courses/preferences' && input.method === 'GET')
        return reply({
          preferences: [
            // Never used, but a favourite: it leads both orders.
            { courseId: never.courseId, favourite: true, lastUsedAt: null },
            { courseId: older.courseId, favourite: false, lastUsedAt: '2026-03-01T00:00:00.000Z' },
            { courseId: newer.courseId, favourite: false, lastUsedAt: '2026-04-01T00:00:00.000Z' },
          ],
          total: 3,
        });
      throw new Error(`unexpected request ${input.method} ${input.path}`);
    });
    render(<CourseWorkbench athleteId="athlete-1" sessionId="session-1" transport={{ request }} />);
    const list = await screen.findByRole('list', { name: '코스 목록' });
    const order = () =>
      [...list.querySelectorAll('li')].map(
        (item) => item.textContent?.replace('★ ', '').slice(0, 3) ?? '',
      );
    await waitFor(() => expect(order()).toEqual(['가코스', '나코스', '다코스']));
    await userEvent.click(screen.getByRole('button', { name: '최근 사용순으로 보기' }));
    // Favourite first, then the most recently used, then the older one. A course that was
    // never used sorts last rather than pretending to a date — here it is only first
    // because it is a favourite.
    await waitFor(() => expect(order()).toEqual(['가코스', '다코스', '나코스']));
    await userEvent.click(screen.getByRole('button', { name: '이름순으로 보기' }));
    await waitFor(() => expect(order()).toEqual(['가코스', '나코스', '다코스']));
  });

  it('shows that a course has never been used rather than inventing a date', async () => {
    setup();
    const list = await screen.findByRole('list', { name: '코스 목록' });
    await waitFor(() => expect(list.textContent).toContain('사용 기록 없음'));
  });
});

describe('place search and elevation', () => {
  it('says the server has no place data instead of "nothing found"', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    const field = await screen.findByLabelText('장소 이름');
    await userEvent.type(field, '남산');
    await userEvent.click(screen.getByRole('button', { name: '검색' }));
    expect(await screen.findByText(/장소 데이터가 배포되어 있지 않습니다/)).toBeInTheDocument();
  });

  it('hands a searched place to the screen and names the dataset it came from', async () => {
    setup({
      placeSearch: {
        outcome: 'results',
        dataset,
        matchCount: 1,
        places: [
          {
            placeId: 'p1',
            name: '남산',
            localName: 'Namsan',
            kind: 'place:locality',
            position: [126.9882, 37.5512],
            distanceMeters: null,
          },
        ],
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    await userEvent.type(await screen.findByLabelText('장소 이름'), '남산');
    await userEvent.click(screen.getByRole('button', { name: '검색' }));
    await userEvent.click(await screen.findByRole('button', { name: /남산 \(Namsan\)/ }));
    expect(await screen.findByText(/선택한 장소: 남산/)).toBeInTheDocument();
    // The picked position is what the waypoint editor reads.
    expect(await screen.findByTestId('picked-position')).toHaveTextContent('37.55120, 126.98820');
    expect(
      screen.getByText(/© OpenStreetMap contributors · 데이터 0123456789ab/),
    ).toBeInTheDocument();
  });

  /**
   * A search answer belongs to the query it was sent for.
   *
   * The import panel next door had this fixed; this one did not, and the consequence is
   * worse: a picked place hands its coordinate to the waypoint editor, so an owner could
   * put a **different place's** position into a course while looking at the name of the
   * one they searched for.
   */
  it('does not let a late place-search answer replace the results of a newer query', async () => {
    let releaseFirst = () => {};
    const firstSearch = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const placeOf = (placeId: string, name: string, position: [number, number]) => ({
      outcome: 'results',
      dataset,
      matchCount: 1,
      places: [
        { placeId, name, localName: null, kind: 'place:locality', position, distanceMeters: null },
      ],
    });
    setup({
      holdFirstPlaceSearch: firstSearch,
      placeSearchByCall: [
        placeOf('p1', '남산', [126.9882, 37.5512]),
        placeOf('p2', '여의도', [126.9245, 37.5219]),
      ],
    });
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    const field = await screen.findByLabelText('장소 이름');
    await userEvent.type(field, '남산');
    await userEvent.click(screen.getByRole('button', { name: '검색' }));
    await settle();
    // A second query, while the first answer is still out.
    await userEvent.clear(field);
    await userEvent.type(field, '여의도');
    await userEvent.click(screen.getByRole('button', { name: '검색' }));
    expect(await screen.findByRole('button', { name: /여의도/ })).toBeInTheDocument();
    // The first answer lands now. It speaks for a query nobody is looking at.
    releaseFirst();
    await settle();
    expect(screen.getByRole('button', { name: /여의도/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /남산/ })).not.toBeInTheDocument();
  });

  /**
   * A superseded query is not only ignored — it is **cancelled**.
   *
   * `owns()` keeps the screen right on its own, so dropping the signal broke no other
   * test. What it would break is the promise the API client's `signal` parameter makes:
   * without it that parameter is dead and a slow query keeps a request in flight nobody
   * will read. Observed in a real browser as `aborted requests: ["남산"]`; this is that
   * observation as a test.
   */
  it('cancels the request of a query a newer one replaced', async () => {
    let releaseFirst = () => {};
    const firstSearch = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { request } = setup({ holdFirstPlaceSearch: firstSearch });
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    const field = await screen.findByLabelText('장소 이름');
    await userEvent.type(field, '남산');
    await userEvent.click(screen.getByRole('button', { name: '검색' }));
    await settle();
    const searches = () =>
      request.mock.calls.filter(([value]) => value.path === '/bff/v1/courses/place-search');
    expect(searches()).toHaveLength(1);
    expect(searches()[0]?.[0].signal?.aborted).toBe(false);
    await userEvent.clear(field);
    await userEvent.type(field, '여의도');
    await userEvent.click(screen.getByRole('button', { name: '검색' }));
    // The first request is cancelled the moment the second one starts.
    await waitFor(() => expect(searches()[0]?.[0].signal?.aborted).toBe(true));
    // And the one that replaced it is not.
    expect(searches()[1]?.[0].signal?.aborted).toBe(false);
    releaseFirst();
    await settle();
  });

  it('reports elevation coverage and never a total ascent', async () => {
    setup({
      elevation: {
        outcome: 'profile',
        dataset: { ...dataset, kind: 'elevation', datasetId: 'beef0123cafe' },
        maxSourceDistanceMeters: 150,
        points: [
          { vertexIndex: 0, elevationMeters: 267, sourceDistanceMeters: 12 },
          { vertexIndex: 1, elevationMeters: null, sourceDistanceMeters: null },
        ],
        knownCount: 1,
        vertexCount: 2,
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    const panel = await screen.findByRole('region', { name: '고도 출처' });
    await waitFor(() => expect(panel.textContent).toContain('1곳'));
    expect(panel.textContent).toContain('모름');
    expect(panel.textContent).not.toContain('누적 상승 ');
    expect(panel.textContent).toContain('확인되지 않음');
  });

  it('says so when no elevation dataset is deployed', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    expect(await screen.findByText(/고도 데이터가 배포되어 있지 않습니다/)).toBeInTheDocument();
  });
});

describe('protected areas and the privacy trim', () => {
  const zones = [
    { zoneId, name: '집', center: [126.9779, 37.5665] as [number, number], radiusMeters: 300 },
  ];

  it('tells an empty coordinate apart from a zero one', () => {
    // `Number('')` and `Number('   ')` are 0, which is a real position and a real radius.
    expect(decimalOrNull('')).toBeNull();
    expect(decimalOrNull('   ')).toBeNull();
    expect(decimalOrNull('abc')).toBeNull();
    expect(decimalOrNull('1,5')).toBeNull();
    expect(decimalOrNull('0')).toBe(0);
    expect(decimalOrNull(' -0.0 ')).toBe(-0);
    expect(decimalOrNull('126.9779')).toBe(126.9779);
  });

  it('refuses a protected area whose coordinate was left blank instead of storing 0', async () => {
    const { request } = setup({ zones: [] });
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    const panel = await screen.findByRole('region', { name: '보호 구역' });
    await userEvent.type(within(panel).getByLabelText('보호 구역 이름'), '집');
    // Longitude left empty, latitude filled: the old code sent [0, 37.5].
    await userEvent.type(within(panel).getByLabelText('보호 구역 위도'), '37.5665');
    await userEvent.click(within(panel).getByRole('button', { name: '보호 구역 추가' }));
    expect(await screen.findByText(/좌표는 비워 둘 수 없습니다/)).toBeInTheDocument();
    expect(
      request.mock.calls.some(
        ([value]) => value.path === '/bff/v1/courses/privacy-zones' && value.method === 'POST',
      ),
    ).toBe(false);
  });

  it('accepts a coordinate that really is zero', async () => {
    const { request } = setup({ zones: [] });
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    const panel = await screen.findByRole('region', { name: '보호 구역' });
    await userEvent.type(within(panel).getByLabelText('보호 구역 이름'), '적도');
    await userEvent.type(within(panel).getByLabelText('보호 구역 경도'), '0');
    await userEvent.type(within(panel).getByLabelText('보호 구역 위도'), '0');
    await userEvent.click(within(panel).getByRole('button', { name: '보호 구역 추가' }));
    await waitFor(() => {
      const call = request.mock.calls.find(
        ([value]) => value.path === '/bff/v1/courses/privacy-zones' && value.method === 'POST',
      );
      expect(call?.[0].body).toMatchObject({ name: '적도', center: [0, 0] });
    });
  });

  const workZone = {
    zoneId: '44444444-4444-4444-8444-444444444444',
    name: '직장',
    radiusMeters: 300,
  };

  /** Fills and submits the protected-area form. The values themselves are beside the point. */
  async function addZone(panel: HTMLElement) {
    await userEvent.type(within(panel).getByLabelText('보호 구역 이름'), '직장');
    await userEvent.type(within(panel).getByLabelText('보호 구역 경도'), '127.1');
    await userEvent.type(within(panel).getByLabelText('보호 구역 위도'), '37.6');
    await userEvent.click(within(panel).getByRole('button', { name: '보호 구역 추가' }));
  }

  const shownZones = (panel: HTMLElement) =>
    within(panel)
      .queryAllByRole('button', { name: /삭제$/u })
      .map((button) => button.textContent ?? '');

  /**
   * Neither write may resurrect what another removed.
   *
   * An addition sent before a removal answers with a list that still contains the removed
   * area, because that is what the server held when it ran.
   */
  it('does not let a late area addition put back an area removed since', async () => {
    let releaseAdd = () => {};
    const addResponse = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    setup({ zones, holdZoneAdd: addResponse, zoneToAdd: workZone });
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    const panel = await screen.findByRole('region', { name: '보호 구역' });
    await addZone(panel);
    await settle();
    // While that is out, the owner deletes the area they already had.
    await userEvent.click(within(panel).getByRole('button', { name: '집 삭제' }));
    expect(await screen.findByText('보호 구역을 삭제했습니다.')).toBeInTheDocument();
    // Now the addition answers, with a list that still contains the deleted area.
    releaseAdd();
    await settle();
    await waitFor(() => expect(shownZones(panel)).toEqual(['직장 삭제']));
    expect(screen.getByText('보호 구역을 삭제했습니다.')).toBeInTheDocument();
  });

  /**
   * And neither write may lose what it stored.
   *
   * This is the other half, and it was missing. When the removal that followed a
   * successful addition **failed**, the addition's answer was discarded as superseded and
   * nothing else told the screen about it: the list showed only the old area while the
   * server held both. Safe — a trim against a stale list is refused by the server's own
   * acknowledged-set guard — but it is still a list that is not the owner's.
   */
  it('does not lose an area it stored when a later removal fails', async () => {
    setup({ zones, zoneToAdd: workZone, zoneRemoveFails: true });
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    const panel = await screen.findByRole('region', { name: '보호 구역' });
    await addZone(panel);
    await waitFor(() => expect(shownZones(panel)).toEqual(['집 삭제', '직장 삭제']));
    // The removal that follows is refused by the server.
    await userEvent.click(within(panel).getByRole('button', { name: '집 삭제' }));
    await settle();
    // The refusal is reported, and the area that WAS stored is still on screen.
    expect(
      screen.getByText(/입력을 확인한 뒤 다시 시도하세요|보호 구역이 없습니다/),
    ).toBeInTheDocument();
    await waitFor(() => expect(shownZones(panel)).toEqual(['집 삭제', '직장 삭제']));
  });

  /**
   * The same, in the order the reviewer reproduced it: the addition is still in flight
   * when the removal starts, the removal fails, and only then does the addition land.
   */
  it('keeps an area whose answer arrives after a removal that failed', async () => {
    let releaseAdd = () => {};
    const addResponse = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    setup({ zones, holdZoneAdd: addResponse, zoneToAdd: workZone, zoneRemoveFails: true });
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    const panel = await screen.findByRole('region', { name: '보호 구역' });
    await addZone(panel);
    await settle();
    await userEvent.click(within(panel).getByRole('button', { name: '집 삭제' }));
    await settle();
    releaseAdd();
    await settle();
    await waitFor(() => expect(shownZones(panel)).toEqual(['집 삭제', '직장 삭제']));
  });

  it('sends the area set it was showing with the trim', async () => {
    const { request } = setup({ zones });
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    await userEvent.click(await screen.findByRole('button', { name: '보호 구역 제거본 만들기' }));
    await waitFor(() => {
      const call = request.mock.calls.find(
        ([value]) =>
          value.method === 'PATCH' && JSON.stringify(value.body).includes('privacy-trim'),
      );
      expect(call?.[0].body).toEqual({
        expectedRevision: 2,
        change: { kind: 'privacy-trim', acknowledgedZoneSetDigest: 'c'.repeat(64) },
      });
    });
  });

  it('says the trim added a revision and left the earlier one alone', async () => {
    setup({ zones });
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    await userEvent.click(await screen.findByRole('button', { name: '보호 구역 제거본 만들기' }));
    expect(await screen.findByText(/이전 수정본은 그대로 남아 있습니다/)).toBeInTheDocument();
  });

  it('does not say a course re-enters an area when only its line crosses one', async () => {
    setup({
      zones,
      trimReply: { status: 422, body: { error: { code: 'COURSE_TRIM_LINE_CROSSES_AREA' } } },
    });
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    await userEvent.click(await screen.findByRole('button', { name: '보호 구역 제거본 만들기' }));
    const message = await screen.findByText(/정점 사이를 잇는 선이 보호 구역을 지나갑니다/);
    expect(message).toBeInTheDocument();
    // The re-entry wording belongs to the other refusal, and describes something that did
    // not happen here.
    expect(screen.queryByText(/다시 들어옵니다/)).not.toBeInTheDocument();
  });

  it('explains a course that re-enters a protected area instead of trimming it', async () => {
    setup({
      zones,
      trimReply: { status: 422, body: { error: { code: 'COURSE_TRIM_SPLITS_THE_LINE' } } },
    });
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    await userEvent.click(await screen.findByRole('button', { name: '보호 구역 제거본 만들기' }));
    expect(await screen.findByText(/보호 구역에 다시 들어옵니다/)).toBeInTheDocument();
  });

  it('cannot be asked for a trim with no protected area at all', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    expect(await screen.findByRole('button', { name: '보호 구역 제거본 만들기' })).toBeDisabled();
  });

  it('offers no way to share a course, trimmed or not', async () => {
    setup({ zones });
    await userEvent.click(await screen.findByRole('button', { name: '가져온 코스' }));
    for (const forbidden of ['공유', '링크 복사', '공개'])
      expect(screen.queryByRole('button', { name: new RegExp(forbidden) })).toBeNull();
  });
});

describe('private cache scope', () => {
  it('reads preferences under the signed-in owner, so another account starts empty', async () => {
    const first = setup({ preferences: [{ courseId, favourite: true, lastUsedAt: createdAt }] });
    await waitFor(() =>
      expect(
        first.request.mock.calls.some(
          ([value]) => value.path === '/bff/v1/courses/preferences' && value.method === 'GET',
        ),
      ).toBe(true),
    );
    first.view.unmount();
    const second = setup({ athleteId: 'athlete-2' });
    const list = await screen.findByRole('list', { name: '코스 목록' });
    await waitFor(() => expect(list.textContent).not.toContain('★'));
    expect(
      second.request.mock.calls.some(
        ([value]) => value.path === '/bff/v1/courses/preferences' && value.method === 'GET',
      ),
    ).toBe(true);
  });
});
