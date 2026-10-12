import { describe, expect, it } from 'vitest';

import {
  galleryRenditionListV1Schema,
  galleryRenditionLineageV1Schema,
  galleryRenditionResponseV1Schema,
  galleryRenditionV1Schema,
} from '../src/gallery-rendition.js';

const lineage = {
  mediaItemId: '00000000-0000-4000-8000-000000000001',
  kind: 'image_preview',
  originalSha256: 'a'.repeat(64),
  parentAccessRevision: 1,
  recipeVersion: 1,
};
const imageOutput = {
  mediaType: 'image/webp',
  sha256: 'b'.repeat(64),
  byteSize: 1234,
  widthPixels: 1600,
  heightPixels: 900,
};
const ready = { schemaVersion: 1, ...lineage, state: 'ready', output: imageOutput };
const response = { schemaVersion: 1, requested: lineage, rendition: ready };

describe('gallery rendition lifecycle V1', () => {
  it.each(['queued', 'running'])(
    'requires explicit %s state without fabricated output',
    (state) => {
      expect(
        galleryRenditionV1Schema.safeParse({ schemaVersion: 1, ...lineage, state }).success,
      ).toBe(true);
      expect(
        galleryRenditionV1Schema.safeParse({ schemaVersion: 1, ...lineage, state, output: null })
          .success,
      ).toBe(false);
    },
  );

  it('accepts exact preview and thumbnail renderer recipe dimensions', () => {
    expect(galleryRenditionV1Schema.safeParse(ready).success).toBe(true);
    expect(
      galleryRenditionV1Schema.safeParse({
        ...ready,
        kind: 'image_thumbnail',
        output: { ...imageOutput, widthPixels: 320, heightPixels: 180 },
      }).success,
    ).toBe(true);
    expect(galleryRenditionV1Schema.safeParse({ ...ready, kind: 'image_thumbnail' }).success).toBe(
      false,
    );
  });

  it('accepts MP4 finite seconds with actual video output bound', () => {
    const value = {
      ...ready,
      kind: 'video_playback',
      output: {
        mediaType: 'video/mp4',
        sha256: 'c'.repeat(64),
        byteSize: 64 * 1024 * 1024,
        widthPixels: 1280,
        heightPixels: 720,
        durationSeconds: 0.125,
      },
    };
    expect(galleryRenditionV1Schema.safeParse(value).success).toBe(true);
    expect(galleryRenditionV1Schema.safeParse({ ...value, kind: 'image_preview' }).success).toBe(
      false,
    );
    expect(
      galleryRenditionV1Schema.safeParse({
        ...value,
        output: { ...value.output, durationSeconds: 3600.001 },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['byteSize', 2 * 1024 * 1024 + 1],
    ['byteSize', 0],
    ['widthPixels', 1601],
    ['heightPixels', 0],
    ['widthPixels', 1.5],
    ['sha256', 'invalid'],
    ['mediaType', 'image/jpeg'],
  ])('rejects unsupported output %s=%s', (field, value) => {
    expect(
      galleryRenditionV1Schema.safeParse({ ...ready, output: { ...imageOutput, [field]: value } })
        .success,
    ).toBe(false);
  });

  it('failed eligibility is explicit descriptive metadata, not retry approval', () => {
    const failed = {
      ...lineage,
      schemaVersion: 1,
      state: 'failed',
      code: 'timeout',
      retryEligibility: 'eligible',
    };
    expect(galleryRenditionV1Schema.safeParse(failed).success).toBe(true);
    expect(galleryRenditionV1Schema.safeParse({ ...failed, retryApproved: true }).success).toBe(
      false,
    );
    const { retryEligibility: _, ...missing } = failed;
    expect(galleryRenditionV1Schema.safeParse(missing).success).toBe(false);
    expect(
      galleryRenditionV1Schema.safeParse({ ...failed, code: 'arbitrary stderr' }).success,
    ).toBe(false);
  });

  it('unsupported is distinct from failed and unavailable', () => {
    const unsupported = {
      schemaVersion: 1,
      ...lineage,
      state: 'unsupported',
      code: 'unsupported_pages',
    };
    expect(galleryRenditionV1Schema.safeParse(unsupported).success).toBe(true);
    expect(galleryRenditionV1Schema.safeParse({ ...unsupported, state: 'failed' }).success).toBe(
      false,
    );
    expect(
      galleryRenditionV1Schema.safeParse({ ...unsupported, state: 'unavailable' }).success,
    ).toBe(false);
  });

  it.each([
    'consent_withdrawn',
    'media_deleted',
    'target_closed',
    'stale_lineage',
    'not_available',
  ])(
    'unavailable %s has requested lineage and exposes no descriptor or current proof',
    (reason) => {
      const unavailable = { schemaVersion: 1, ...lineage, state: 'unavailable', reason };
      expect(
        galleryRenditionResponseV1Schema.safeParse({ ...response, rendition: unavailable }).success,
      ).toBe(true);
      expect(
        galleryRenditionV1Schema.safeParse({ ...unavailable, output: imageOutput }).success,
      ).toBe(false);
      expect(
        galleryRenditionV1Schema.safeParse({ ...unavailable, authority: 'verified' }).success,
      ).toBe(false);
    },
  );

  it.each([
    ['mediaItemId', '00000000-0000-4000-8000-000000000002'],
    ['originalSha256', 'd'.repeat(64)],
    ['parentAccessRevision', 2],
    ['kind', 'image_thumbnail'],
    ['recipeVersion', 2],
  ])('rejects stale or foreign %s relative to request', (field, value) => {
    const rendition = {
      ...ready,
      output: { ...imageOutput, widthPixels: 320, heightPixels: 180 },
      [field]: value,
    };
    expect(galleryRenditionResponseV1Schema.safeParse({ ...response, rendition }).success).toBe(
      false,
    );
  });

  it.each(['ownerId', 'leaseId', 'jobId', 'rawPath', 'token', 'exifGps', 'codecStderr'])(
    'rejects private %s at envelope and output boundaries',
    (field) => {
      expect(galleryRenditionV1Schema.safeParse({ ...ready, [field]: 'private' }).success).toBe(
        false,
      );
      expect(
        galleryRenditionV1Schema.safeParse({
          ...ready,
          output: { ...imageOutput, [field]: 'private' },
        }).success,
      ).toBe(false);
    },
  );

  it('null/missing/unknown states and missing immutable lineage never imply ready', () => {
    expect(galleryRenditionV1Schema.safeParse({ ...ready, state: null }).success).toBe(false);
    expect(galleryRenditionV1Schema.safeParse({ ...ready, state: 'completed' }).success).toBe(
      false,
    );
    expect(galleryRenditionV1Schema.safeParse({ ...ready, output: null }).success).toBe(false);
    const { state: _, ...missing } = ready;
    expect(galleryRenditionV1Schema.safeParse(missing).success).toBe(false);
    const { originalSha256: __, ...noOriginal } = ready;
    expect(galleryRenditionV1Schema.safeParse(noOriginal).success).toBe(false);
  });

  it('invalid revisions are not rounded and exact request identity is retained', () => {
    expect(
      galleryRenditionLineageV1Schema.safeParse({ ...lineage, parentAccessRevision: 1.1 }).success,
    ).toBe(false);
    expect(
      galleryRenditionLineageV1Schema.safeParse({
        ...lineage,
        parentAccessRevision: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(galleryRenditionResponseV1Schema.safeParse(response).success).toBe(true);
  });

  it('rejects accessor input without invoking it and catches prototype traps', () => {
    let calls = 0;
    const raw = { ...ready };
    Object.defineProperty(raw, 'output', {
      enumerable: true,
      get() {
        calls++;
        return imageOutput;
      },
    });
    expect(galleryRenditionV1Schema.safeParse(raw).success).toBe(false);
    expect(calls).toBe(0);
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('private');
        },
      },
    );
    expect(() => galleryRenditionV1Schema.safeParse(proxy)).not.toThrow();
    expect(galleryRenditionV1Schema.safeParse(proxy).success).toBe(false);
  });

  it('oversized unknown strings, cycles and non-plain values fail bounded before DTO reads', () => {
    expect(
      galleryRenditionV1Schema.safeParse({ ...ready, privateField: 'x'.repeat(100_000) }).success,
    ).toBe(false);
    const cyclic: Record<string, unknown> = { ...ready };
    cyclic['self'] = cyclic;
    expect(galleryRenditionV1Schema.safeParse(cyclic).success).toBe(false);
    expect(galleryRenditionV1Schema.safeParse(new Date()).success).toBe(false);
  });

  it('parsed public metadata has no mutable dependency on original input', () => {
    const raw = { ...ready, output: { ...imageOutput } };
    const result = galleryRenditionV1Schema.parse(raw);
    raw.output.sha256 = 'e'.repeat(64);
    expect(result.state).toBe('ready');
    if (result.state === 'ready') expect(result.output.sha256).toBe('b'.repeat(64));
  });
});

describe('gallery rendition list V1', () => {
  const thumbnail = {
    ...ready,
    kind: 'image_thumbnail',
    output: { ...imageOutput, widthPixels: 320, heightPixels: 180 },
  };
  const list = {
    schemaVersion: 1,
    mediaItemId: lineage.mediaItemId,
    renditions: [ready, { schemaVersion: 1, ...lineage, kind: 'image_thumbnail', state: 'queued' }],
  };

  it('accepts exactly the image recipe pair or the video playback rendition', () => {
    expect(galleryRenditionListV1Schema.safeParse(list).success).toBe(true);
    expect(
      galleryRenditionListV1Schema.safeParse({ ...list, renditions: [ready, thumbnail] }).success,
    ).toBe(true);
    const video = {
      schemaVersion: 1,
      ...lineage,
      kind: 'video_playback',
      state: 'failed',
      code: 'decode_failed',
      retryEligibility: 'ineligible',
    };
    expect(galleryRenditionListV1Schema.safeParse({ ...list, renditions: [video] }).success).toBe(
      true,
    );
  });

  it('rejects missing, reordered, duplicated, foreign or mixed-lineage renditions', () => {
    for (const renditions of [
      [],
      [ready],
      [thumbnail, ready],
      [ready, ready],
      [ready, thumbnail, thumbnail],
      [ready, { ...thumbnail, mediaItemId: '00000000-0000-4000-8000-000000000002' }],
      [ready, { ...thumbnail, originalSha256: 'c'.repeat(64) }],
    ])
      expect(galleryRenditionListV1Schema.safeParse({ ...list, renditions }).success).toBe(false);
  });

  it('keeps the array guard bounded and plain', () => {
    const sparse: unknown[] = [ready];
    sparse.length = 2;
    expect(galleryRenditionListV1Schema.safeParse({ ...list, renditions: sparse }).success).toBe(
      false,
    );
    const extra = Object.assign([ready, thumbnail], { extra: true });
    expect(galleryRenditionListV1Schema.safeParse({ ...list, renditions: extra }).success).toBe(
      false,
    );
    expect(galleryRenditionV1Schema.safeParse({ ...ready, output: [imageOutput] }).success).toBe(
      false,
    );
  });
});
