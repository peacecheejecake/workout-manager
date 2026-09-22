import { courseGpxCreator, courseLimits } from '@workout/contracts/courses';
import { parseTrackFile } from '@workout/track-parsing';
import { describe, expect, it } from 'vitest';

import { CourseImportError, courseFromImportedFile, listImportItems } from '../src/import.js';
import { writeCourseGpx } from '../src/gpx.js';

/**
 * Importing a GPX file as a course (M2-01j).
 *
 * Every fixture here is a real GPX document parsed by the real parser, so what these tests
 * fix is the whole path a file takes: bounds, the distinction between a recorded track, a
 * planned route and a waypoint, and the refusal to invent anything that was not in the file.
 */
const gpx = (body: string, creator = 'some-other-app') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="${creator}" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;

const trkBody = `<trk><name>아침 달리기</name><trkseg>
  <trkpt lat="37.5000000" lon="127.0200000"><time>2026-09-19T01:00:00Z</time></trkpt>
  <trkpt lat="37.5001000" lon="127.0201000"><time>2026-09-19T01:00:10Z</time></trkpt>
  <trkpt lat="37.5002000" lon="127.0202000"><time>2026-09-19T01:00:20Z</time></trkpt>
</trkseg></trk>`;

const rteBody = `<rte><name>계획 경로</name>
  <rtept lat="37.5000000" lon="127.0200000" />
  <rtept lat="37.5001000" lon="127.0201000" />
</rte>`;

async function parse(document: string, filename = 'course.gpx') {
  return parseTrackFile(new TextEncoder().encode(document), { filename });
}

describe('course import from a parsed file', () => {
  it('imports a recorded track as a planned course, never as a recorded actual', async () => {
    const parsed = await parse(gpx(trkBody));
    const content = courseFromImportedFile({
      parsed,
      selection: null,
      name: null,
    });
    expect(content.name).toBe('아침 달리기');
    expect(content.coordinates).toHaveLength(3);
    expect(content.generation.kind).toBe('imported-file');
    if (content.generation.kind !== 'imported-file') throw new Error('unreachable');
    // The file said `trk`. The course says so too — it does not pretend the line was
    // planned, and nothing here produces an Activity, a sample or a recorded actual.
    expect(content.generation.sourceKind).toBe('gpx-trk');
    expect(content.generation.parserId).toBe('gpx-track-v1');
    expect(content.generation.fileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps a route and a track apart and refuses to choose between them', async () => {
    const parsed = await parse(gpx(`${trkBody}${rteBody}`));
    const items = listImportItems(parsed);
    expect(items.map((item) => item.sourceKind)).toEqual(['gpx-trk', 'gpx-rte']);
    expect(() => courseFromImportedFile({ parsed, selection: null, name: null })).toThrow(
      new CourseImportError('COURSE_IMPORT_SELECTION_REQUIRED'),
    );
    const chosen = courseFromImportedFile({
      parsed,
      selection: { sourceKind: 'gpx-rte', itemIndex: 0 },
      name: null,
    });
    expect(chosen.name).toBe('계획 경로');
    if (chosen.generation.kind !== 'imported-file') throw new Error('unreachable');
    expect(chosen.generation.sourceKind).toBe('gpx-rte');
  });

  it('refuses a selection that names nothing in the file', async () => {
    const parsed = await parse(gpx(`${trkBody}${rteBody}`));
    expect(() =>
      courseFromImportedFile({
        parsed,
        selection: { sourceKind: 'gpx-rte', itemIndex: 4 },
        name: null,
      }),
    ).toThrow(new CourseImportError('COURSE_IMPORT_SELECTION_UNKNOWN'));
  });

  it('refuses a recording split into several runs instead of joining them', async () => {
    const twoSegments = `<trk><name>두 구간</name>
      <trkseg>
        <trkpt lat="37.5000000" lon="127.0200000" />
        <trkpt lat="37.5001000" lon="127.0201000" />
      </trkseg>
      <trkseg>
        <trkpt lat="37.5100000" lon="127.0300000" />
        <trkpt lat="37.5101000" lon="127.0301000" />
      </trkseg>
    </trk>`;
    const parsed = await parse(gpx(twoSegments));
    expect(() => courseFromImportedFile({ parsed, selection: null, name: null })).toThrow(
      new CourseImportError('COURSE_IMPORT_SPANS_A_GAP'),
    );
  });

  it('does not promote a stranger file waypoint into a course waypoint', async () => {
    const withWaypoints = `<wpt lat="37.4000000" lon="127.0000000"><name>카페</name></wpt>
      <wpt lat="37.4100000" lon="127.0100000"><name>편의점</name></wpt>${rteBody}`;
    const parsed = await parse(gpx(withWaypoints));
    const content = courseFromImportedFile({
      parsed,
      selection: null,
      name: null,
    });
    // The two ends of the imported line, not the file's points of interest.
    expect(content.waypoints.map((waypoint) => waypoint.position)).toEqual([
      [127.02, 37.5],
      [127.0201, 37.5001],
    ]);
    expect(content.waypoints.every((waypoint) => waypoint.name === null)).toBe(true);
    if (content.generation.kind !== 'imported-file') throw new Error('unreachable');
    expect(content.generation.importedWaypointCount).toBe(0);
    // Reported rather than silently dropped.
    expect(content.generation.ignoredFileWaypointCount).toBe(2);
  });

  it('adopts the waypoints of a document this product wrote, which is what round-trips', async () => {
    const document = writeCourseGpx({
      name: '한강 코스',
      courseId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      courseRevision: 2,
      createdAt: '2026-09-19T01:00:00.000Z',
      coordinates: [
        [127.02, 37.5],
        [127.0201, 37.5001],
        [127.0202, 37.5002],
      ],
      waypoints: [
        {
          role: 'start',
          position: [127.02, 37.5],
          name: '출발',
          sourceSampleId: '0:0',
          locked: false,
        },
        {
          role: 'via',
          position: [127.02015, 37.50015],
          name: '중간',
          sourceSampleId: null,
          locked: true,
        },
        {
          role: 'finish',
          position: [127.0202, 37.5002],
          name: null,
          sourceSampleId: '0:2',
          locked: false,
        },
      ],
    });
    const parsed = await parse(document, '한강 코스-r2.gpx');
    expect(parsed.creator).toBe(courseGpxCreator);
    const content = courseFromImportedFile({
      parsed,
      selection: null,
      name: null,
    });
    expect(content.name).toBe('한강 코스');
    expect(content.coordinates).toEqual([
      [127.02, 37.5],
      [127.0201, 37.5001],
      [127.0202, 37.5002],
    ]);
    expect(content.waypoints.map((waypoint) => [waypoint.role, waypoint.name])).toEqual([
      ['start', '출발'],
      ['via', '중간'],
      ['finish', null],
    ]);
    // An imported waypoint claims no recorded sample and no lock: neither is a fact about
    // the file, and a sample ordinal would name an observation we never made.
    expect(content.waypoints.every((waypoint) => waypoint.sourceSampleId === null)).toBe(true);
    expect(content.waypoints.every((waypoint) => !waypoint.locked)).toBe(true);
    if (content.generation.kind !== 'imported-file') throw new Error('unreachable');
    expect(content.generation.importedWaypointCount).toBe(3);
    expect(content.generation.fileCreator).toBe(courseGpxCreator);
  });

  it('needs a name when the file has none of its own', async () => {
    const unnamed = `<rte><rtept lat="37.5" lon="127.02" /><rtept lat="37.5001" lon="127.0201" /></rte>`;
    const parsed = await parse(gpx(unnamed));
    expect(() => courseFromImportedFile({ parsed, selection: null, name: null })).toThrow(
      new CourseImportError('COURSE_IMPORT_NAME_REQUIRED'),
    );
    const named = courseFromImportedFile({
      parsed,
      selection: null,
      name: '이름을 내가 준다',
    });
    expect(named.name).toBe('이름을 내가 준다');
  });

  it('refuses a name the ledger will not take, rather than failing unhandled', async () => {
    // Track metadata may be 256 characters; a course name may be 120. A file between the
    // two used to reach the ledger as an unhandled schema error.
    const longName = '가'.repeat(200);
    const parsed = await parse(
      gpx(
        `<rte><name>${longName}</name><rtept lat="37.5" lon="127.02" /><rtept lat="37.5001" lon="127.0201" /></rte>`,
      ),
    );
    expect(() => courseFromImportedFile({ parsed, selection: null, name: null })).toThrow(
      new CourseImportError('COURSE_IMPORT_NAME_INVALID'),
    );
  });

  it('drops a file waypoint name the ledger will not take instead of failing', async () => {
    const longName = '나'.repeat(200);
    const document =
      `<?xml version="1.0"?><gpx version="1.1" creator="${courseGpxCreator}" xmlns="http://www.topografix.com/GPX/1/1">` +
      `<wpt lat="37.5000000" lon="127.0200000"><name>${longName}</name></wpt>` +
      `<wpt lat="37.5010000" lon="127.0210000"><name>끝</name></wpt>` +
      `<rte><name>왕복</name><rtept lat="37.5000000" lon="127.0200000" /><rtept lat="37.5010000" lon="127.0210000" /></rte></gpx>`;
    const parsed = await parse(document);
    const content = courseFromImportedFile({
      parsed,
      selection: null,
      name: null,
    });
    expect(content.waypoints.map((waypoint) => waypoint.name)).toEqual([null, '끝']);
  });

  it('refuses a line of fewer than two positions', async () => {
    const single = `<rte><name>한 점</name><rtept lat="37.5" lon="127.02" /></rte>`;
    const parsed = await parse(gpx(single));
    expect(() => courseFromImportedFile({ parsed, selection: null, name: null })).toThrow(
      new CourseImportError('COURSE_IMPORT_TOO_FEW_POSITIONS'),
    );
  });

  /**
   * Bounds an owner's own bytes reach, each with its own refusal.
   *
   * These are not defensive checks against ourselves: a 4 MiB GPX holds roughly 70,000
   * `trkpt` elements, comfortably past the 20,000-vertex ceiling a course may carry. With
   * the refusal removed the file reaches the ledger and fails there as a raw schema error,
   * which is a 500 rather than "this file has too many points".
   */
  it('refuses a line with more vertices than a course may carry', async () => {
    const points = Array.from(
      { length: courseLimits.vertices + 1 },
      (_value, index) =>
        `<rtept lat="${(37.5 + index * 1e-6).toFixed(7)}" lon="${(127.02 + index * 1e-6).toFixed(7)}" />`,
    ).join('');
    const parsed = await parse(gpx(`<rte><name>너무 긺</name>${points}</rte>`));
    expect(() => courseFromImportedFile({ parsed, selection: null, name: null })).toThrow(
      new CourseImportError('COURSE_IMPORT_TOO_MANY_VERTICES'),
    );
  });

  it('refuses a file that offers nothing importable at all', async () => {
    // Waypoints only: a `wpt` is neither a recording nor a planned line, and promoting one
    // into a course is the thing this module exists to refuse.
    const parsed = await parse(
      gpx('<wpt lat="37.5000000" lon="127.0200000"><name>집</name></wpt>'),
    );
    expect(listImportItems(parsed)).toEqual([]);
    expect(() => courseFromImportedFile({ parsed, selection: null, name: null })).toThrow(
      new CourseImportError('COURSE_IMPORT_NO_IMPORTABLE_ITEM'),
    );
  });

  describe('adopting our own document waypoints', () => {
    const ourFile = (waypoints: string) =>
      `<?xml version="1.0"?><gpx version="1.1" creator="${courseGpxCreator}" xmlns="http://www.topografix.com/GPX/1/1">` +
      waypoints +
      `<rte><name>왕복</name><rtept lat="37.5000000" lon="127.0200000" />` +
      `<rtept lat="37.5010000" lon="127.0210000" /></rte></gpx>`;
    const wpt = (index: number) =>
      `<wpt lat="${(37.5 + index * 1e-4).toFixed(7)}" lon="${(127.02 + index * 1e-4).toFixed(7)}" />`;

    it('ignores a single waypoint: one point is not a start and a finish', async () => {
      const content = courseFromImportedFile({
        parsed: await parse(ourFile(wpt(0))),
        selection: null,
        name: null,
      });
      if (content.generation.kind !== 'imported-file') throw new Error('unreachable');
      expect(content.generation.importedWaypointCount).toBe(0);
      expect(content.generation.ignoredFileWaypointCount).toBe(1);
      expect(content.waypoints).toHaveLength(2);
    });

    it('adopts exactly the number of waypoints a course may hold', async () => {
      const content = courseFromImportedFile({
        parsed: await parse(
          ourFile(
            Array.from({ length: courseLimits.waypoints }, (_value, index) => wpt(index)).join(''),
          ),
        ),
        selection: null,
        name: null,
      });
      if (content.generation.kind !== 'imported-file') throw new Error('unreachable');
      expect(content.generation.importedWaypointCount).toBe(courseLimits.waypoints);
    });

    it('ignores one waypoint more than a course may hold, rather than truncating', async () => {
      const content = courseFromImportedFile({
        parsed: await parse(
          ourFile(
            Array.from({ length: courseLimits.waypoints + 1 }, (_value, index) => wpt(index)).join(
              '',
            ),
          ),
        ),
        selection: null,
        name: null,
      });
      if (content.generation.kind !== 'imported-file') throw new Error('unreachable');
      expect(content.generation.importedWaypointCount).toBe(0);
      expect(content.generation.ignoredFileWaypointCount).toBe(courseLimits.waypoints + 1);
      expect(content.waypoints).toHaveLength(2);
    });
  });

  it('records the file name the parser produced, never a caller-supplied one', async () => {
    // The browser is the only place that knows what the file was called, so the name does
    // come from the client — through the parse, which is where untrusted text is cleaned.
    const parsed = await parse(gpx(trkBody), 'seoul\u0007run.gpx');
    const content = courseFromImportedFile({ parsed, selection: null, name: null });
    if (content.generation.kind !== 'imported-file') throw new Error('unreachable');
    expect(content.generation.originalFilename).toBe(parsed.originalFilename);
    expect(content.generation.originalFilename).toBe('seoulrun.gpx');
  });

  it('carries no coordinate in the conditions it stores', async () => {
    const parsed = await parse(gpx(trkBody));
    const content = courseFromImportedFile({
      parsed,
      selection: null,
      name: null,
    });
    const serialized = JSON.stringify(content.generation);
    expect(serialized).not.toContain('127.02');
    expect(serialized).not.toContain('37.5');
  });

  it('measures the planned line rather than trusting the file', async () => {
    const parsed = await parse(gpx(trkBody));
    const content = courseFromImportedFile({
      parsed,
      selection: null,
      name: null,
    });
    expect(content.distanceMeters).toBeGreaterThan(20);
    expect(content.distanceMeters).toBeLessThan(40);
  });
});
