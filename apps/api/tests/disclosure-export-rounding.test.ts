import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import {
  courseReadResultSchema,
  courseWaypointListSchema,
  type CoursePosition,
} from '@workout/contracts/courses';
import {
  courseDisclosurePreviewSchema,
  courseDisclosureReceiptSchema,
} from '@workout/contracts/course-sharing';
import type { CourseHeadContent } from '@workout/server-persistence/courses';
import { greatCircleMeters } from '@workout/server-courses/geo';
import { privacyZoneSetDigest } from '@workout/server-courses/privacy-trim';
import {
  registerCourseDisclosureRoutes,
  type CourseDisclosureServices,
} from '../src/course-disclosure-routes.js';
const id = '10000000-0000-4000-8000-000000000001';
const time = '2026-10-10T00:00:00Z';
async function fixture(inside = false) {
  const coordinates: CoursePosition[] = [
    ...(inside ? [[127, 37.5] satisfies CoursePosition] : []),
    [127.0030049, 37.5],
    [127.01, 37.5],
    [127.02, 37.5],
  ];
  let head: CourseHeadContent = {
    courseId: id,
    courseRevision: 2,
    name: '합성 코스',
    coordinates,
    waypoints: courseWaypointListSchema.parse([
      {
        role: 'start',
        position: coordinates[0],
        name: '합성 시작',
        sourceSampleId: null,
        locked: false,
      },
      {
        role: 'finish',
        position: coordinates.at(-1),
        name: null,
        sourceSampleId: null,
        locked: false,
      },
    ]),
    generation: {
      kind: 'privacy-trimmed',
      sourceRevision: 1,
      sourceGenerationKind: 'imported-file',
      sourceGraphBuildId: null,
      policyVersion: 1,
      zoneSetDigest: 'a'.repeat(64),
      appliedZoneCount: 1,
      removedVertexCount: 1,
      removedLeadingVertexCount: 1,
      removedTrailingVertexCount: 0,
      removedWaypointCount: 1,
      vertexCount: coordinates.length,
    },
    lineage: [],
  };
  const zones = [
    {
      zoneId: id,
      name: '합성 구역',
      createdAt: '2026-10-10T00:00:00Z',
      updatedAt: '2026-10-10T00:00:00Z',
      center: [127, 37.5] as CoursePosition,
      radiusMeters: greatCircleMeters([127, 37.5], [127.003, 37.5]) + 0.2,
    },
  ];
  const read = () =>
    courseReadResultSchema.parse({
      status: 'available',
      course: {
        status: 'available',
        courseId: id,
        name: head.name,
        visibility: 'private',
        headRevision: head.courseRevision,
        revisionId: id,
        createdAt: time,
        updatedAt: time,
      },
      revision: {
        courseId: id,
        courseRevision: head.courseRevision,
        revisionId: id,
        name: head.name,
        geometry: { type: 'LineString', coordinates: head.coordinates },
        waypoints: head.waypoints,
        generation: head.generation,
        edit: { kind: 'privacy-trimmed' },
        lineage: [],
        distanceMeters: 1000,
        contentDigest: 'a'.repeat(64),
        createdAt: time,
      },
      thumbnail: {
        status: 'pending',
        courseRevision: head.courseRevision,
        queuedAt: time,
      },
    });
  const unused = async () => {
    throw new Error('UNEXPECTED_PORT');
  };
  let receipt: ReturnType<typeof courseDisclosureReceiptSchema.parse> | null = null;
  let failReceipt = false;
  const update: CourseDisclosureServices['courses']['update'] = vi.fn(
    async (_owner, _id, revision, content, _key, _request, options) => {
      expect(revision).toBe(head.courseRevision);
      expect(options?.requireZoneSet?.expectedDigest).toBe(privacyZoneSetDigest(zones));
      head = { ...head, ...content, courseRevision: head.courseRevision + 1 };
      return read();
    },
  );
  const recordReceipt: CourseDisclosureServices['sharing']['recordReceipt'] = vi.fn(
    async (_owner, input) => {
      if (failReceipt) throw new Error('SYNTHETIC_RECEIPT_FAILURE');
      receipt = courseDisclosureReceiptSchema.parse({
        receiptId: id,
        courseId: id,
        courseRevision: input.courseRevision,
        purpose: input.purpose,
        exposure: input.exposure,
        zoneSetDigest: input.zoneSetDigest,
        includeNames: input.includeNames,
        confirmedAt: time,
        expiresAt: '2026-10-10T01:00:00Z',
      });
      return receipt;
    },
  );
  const services: CourseDisclosureServices = {
    courses: {
      replayCommand: unused,
      create: unused,
      read: async () => read(),
      list: unused,
      readCardSources: unused,
      headContent: async () => head,
      update,
      storeRouteProposal: unused,
      storeRouteCandidateSet: unused,
      assertRouteProposalRoom: unused,
      readRouteCandidate: unused,
      readRouteProposal: unused,
      resolveThumbnailObject: unused,
      remove: unused,
      affectedByActivityDeletion: unused,
    },
    preferences: {
      list: unused,
      write: unused,
      listPrivacyZones: async () => zones,
      createPrivacyZone: unused,
      removePrivacyZone: unused,
      listAccessibilityNotes: unused,
      writeAccessibilityNote: unused,
    },
    sharing: {
      replayReceipt: async () => receipt,
      zonesWithShareOffsets: unused,
      recordReceipt,
      readUsableReceipt: async () =>
        receipt ? { receipt, headRevision: head.courseRevision, zones } : null,
      listShares: unused,
      createShare: unused,
      revokeShare: unused,
      revokeAllShares: unused,
    },
  };
  const app = Fastify();
  registerCourseDisclosureRoutes(app, services, () => ({
    athleteId: 'synthetic',
    sessionId: 'one',
    method: 'bearer',
  }));
  await app.ready();
  const preview = courseDisclosurePreviewSchema.parse(
    (
      await app.inject({
        method: 'GET',
        url: `/courses/${id}/disclosure-preview?purpose=export`,
      })
    ).json(),
  );
  const payload = {
    purpose: 'export',
    expectedRevision: preview.courseRevision,
    acknowledgedZoneSetDigest: preview.zoneSetDigest,
    exposure: 'trimmed',
    includeNames: false,
    acknowledgedRisk: false,
  };
  const confirm = (patch: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: `/courses/${id}/disclosure-confirmations`,
      headers: { 'idempotency-key': 'synthetic-rounding' },
      payload: { ...payload, ...patch },
    });
  return {
    app,
    preview,
    confirm,
    update,
    recordReceipt,
    getHead: () => head,
    advance: () => {
      head = { ...head, courseRevision: head.courseRevision + 1 };
    },
    changeZones: () => {
      zones.splice(0, 1);
    },
    setFail: () => {
      failReceipt = true;
    },
    export: () =>
      app.inject({
        method: 'GET',
        url: `/courses/${id}/export.gpx?receipt=${id}`,
      }),
  };
}
it.each([false, true])(
  'confirms the preview geometry with raw-inside=%s and exports/replays its receipt',
  async (inside) => {
    const f = await fixture(inside);
    try {
      const response = await f.confirm();
      expect(response.statusCode).toBe(200);
      expect(f.getHead().coordinates).toEqual(f.preview.options[0]?.coordinates);
      const download = await f.export();
      expect(download.statusCode).toBe(200);
      expect(download.body).toContain('lon="127.01000"');
      expect(download.body).not.toContain('127.00300');
      expect((await f.confirm()).json()).toEqual(response.json());
      expect(f.update).toHaveBeenCalledTimes(1);
      expect(f.recordReceipt).toHaveBeenCalledTimes(1);
    } finally {
      await f.app.close();
    }
  },
);
it.each([{ expectedRevision: 1 }, { acknowledgedZoneSetDigest: 'b'.repeat(64) }])(
  'rejects stale confirmation before any mutation %j',
  async (patch) => {
    const f = await fixture();
    try {
      expect((await f.confirm(patch)).statusCode).toBe(409);
      expect(f.update).not.toHaveBeenCalled();
      expect(f.recordReceipt).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  },
);
it('does not export or append again if the separate receipt write fails', async () => {
  const f = await fixture();
  try {
    f.setFail();
    expect((await f.confirm()).statusCode).toBe(500);
    expect((await f.export()).statusCode).toBe(409);
    expect((await f.confirm()).statusCode).toBe(409);
    expect(f.update).toHaveBeenCalledTimes(1);
  } finally {
    await f.app.close();
  }
});

it.each(['geometry', 'zones'] as const)(
  'refuses an export whose confirmed %s changed',
  async (kind) => {
    const f = await fixture();
    try {
      expect((await f.confirm()).statusCode).toBe(200);
      if (kind === 'geometry') f.advance();
      else f.changeZones();
      expect((await f.export()).statusCode).toBe(409);
    } finally {
      await f.app.close();
    }
  },
);
