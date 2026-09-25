import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  importActivitySchema,
} from '../../packages/contracts/src/activity';
import {
  fitFile,
  recordMessage,
  sessionMessage,
} from '../../packages/track-parsing/tests/fit-fixture';

/**
 * S14 target-distance candidates against the real OIDC session, API, PostgreSQL and object
 * storage (M2-01i).
 *
 * What this proves is the whole path on our side of the routing port: a bounded search
 * that spends real engine calls through the real service, candidates stored as proposals
 * in real PostgreSQL, a course that does not move while they sit there, and a revision
 * that appears only when the owner picks one and says they have read it.
 *
 * What it does not prove: anything about the engine. The harness port is
 * `scripts/fixtures/walking-route-fixture.ts`, a deterministic stand-in, because M2-01g's
 * adapter only runs against a verified graph build that is not present in a test
 * environment. Nothing here is evidence about pedestrian coverage, snapping, or whether a
 * real engine would find these loops.
 */
const start = Date.parse('2026-03-01T00:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const longitude = (index: number) => 126.978 + index / 2000;
const latitude = (index: number) => 37.566 + index / 2000;

const fitBytes = Buffer.from(
  fitFile([
    sessionMessage({ startedAt: at(0), elapsedSeconds: 40, distanceMeters: 512 }),
    ...[0, 1, 2, 3, 4].map((index) =>
      recordMessage({
        at: at(index * 10),
        longitude: longitude(index),
        latitude: latitude(index),
        heartRate: 140 + index,
        distanceMeters: index * 128,
      }),
    ),
  ]),
);

async function login(page: Page) {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get('/bff/v1/session');
  expect(response.status()).toBe(200);
  const session: unknown = await response.json();
  assert.ok(
    typeof session === 'object' &&
      session !== null &&
      'sessionId' in session &&
      typeof session.sessionId === 'string' &&
      'csrfToken' in session &&
      typeof session.csrfToken === 'string',
  );
  return {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
}

async function storeTrack(page: Page, headers: Record<string, string>) {
  const command = importActivitySchema.parse({
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'f'.repeat(64) },
    activity: {
      title: `후보 생성 원본 활동 ${randomUUID()}`,
      kind: 'running',
      startedAt: at(0),
      timezone: 'UTC',
      durationSeconds: 40,
      durationKind: 'elapsed',
      distanceMeters: 512,
    },
  });
  const { idempotencyKey, ...body } = command;
  const imported = await page.request.post('/bff/v1/activity-imports', {
    headers: { ...headers, 'idempotency-key': idempotencyKey },
    data: body,
  });
  expect(imported.status()).toBe(200);
  const result = activityImportResultSchema.parse(await imported.json());
  const reserved = await page.request.post(
    `/bff/v1/activities/${result.activityId}/track-uploads`,
    {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { expectedActivityRevision: result.revision, recordedTrackIndex: 0 },
    },
  );
  expect(reserved.status()).toBe(200);
  const reservation = (await reserved.json()) as { uploadId: string };
  const uploaded = await page.request.put(
    `/bff/v1/activity-track-uploads/${reservation.uploadId}/content`,
    {
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'x-track-file-name': encodeURIComponent('candidates.fit'),
      },
      data: fitBytes,
    },
  );
  expect(uploaded.status()).toBe(200);
  const finalized = await page.request.post(
    `/bff/v1/activity-track-uploads/${reservation.uploadId}/finalize`,
    { headers: { ...headers, 'idempotency-key': randomUUID() } },
  );
  expect(finalized.status()).toBe(200);
  return result;
}

const routeAddress = (activityId: string) => `/activities?selected=${activityId}&detailTab=route`;

test('generates target-distance candidates, saves nothing, and only then picks one', async ({
  page,
}) => {
  const headers = await login(page);
  const activity = await storeTrack(page, headers);

  await page.goto(routeAddress(activity.activityId));
  const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
  const courseSection = panel.getByRole('region', { name: '선택 구간으로 코스 만들기' });
  await panel.getByRole('button', { name: '시작 지점', exact: true }).click();
  await courseSection.getByRole('button', { name: '이 지점을 구간 시작으로' }).click();
  await panel.getByRole('button', { name: '끝 지점', exact: true }).click();
  await courseSection.getByRole('button', { name: '이 지점을 구간 끝으로' }).click();
  await courseSection.getByLabel('코스 이름').fill('목표 거리 후보 대상');
  await courseSection.getByRole('button', { name: '이 구간을 코스로 저장' }).click();
  await expect(courseSection.getByRole('status')).toContainText('코스를 저장했습니다');

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/courses');
  const workbench = page.getByRole('region', { name: '내 코스' });
  // `exact` because another control on the same row carries this name as a prefix.
  await workbench.getByRole('button', { name: '목표 거리 후보 대상', exact: true }).click();
  const section = workbench.getByRole('region', { name: '목표 거리 후보' });
  await expect(section).toBeVisible();
  await expect(section).toContainText('목표 거리는');

  await section.getByLabel('목표 거리(m)').fill('1200');
  await section.getByRole('button', { name: '목표 거리 후보 생성' }).click();
  const set = section.getByTestId('candidate-set');
  await expect(set).toBeVisible();

  // Every bound and the seed are on screen, and the attempt log keeps the rejections.
  await expect(section.getByTestId('candidate-seed')).toHaveText(/^[0-9a-f]{16}$/);
  await expect(section.getByTestId('evaluation-version')).toHaveText('1');
  await expect(section.getByTestId('candidate-attempts')).toContainText('/ 8');
  await expect(section.getByRole('list', { name: '시도 기록' })).toBeVisible();

  // A missing fact is reported as missing, never as satisfied.
  await expect(section.getByTestId('candidate-knowledge-0')).toContainText('확인되지 않음');
  await expect(section.getByTestId('candidate-gradient-0')).toHaveText(
    '확인되지 않음 (엔진 경사 자료 없음 · 고도 표본은 고도 확인 참조)',
  );
  await expect(section.getByTestId('candidate-error-0')).toContainText('%');
  await expect(section.getByTestId('candidate-repeat-0')).toBeVisible();

  // Nothing is saved or approved: the course is still exactly what it was.
  await expect(workbench.getByTestId('course-revision')).toHaveText('1');
  await expect(workbench.getByTestId('course-generation')).toContainText('기록 구간 잘라내기');

  await section.getByRole('button', { name: '1번 후보 보기' }).click();
  const review = section.getByTestId('candidate-review');
  await expect(review).toBeVisible();
  // Picking one is still not a save.
  await expect(workbench.getByTestId('course-revision')).toHaveText('1');
  const save = review.getByRole('button', { name: '고른 후보 저장' });
  await expect(save).toBeDisabled();

  await review.getByLabel('위 후보 내용을 검토했습니다.').check();
  await save.click();
  await expect(workbench.getByTestId('course-revision')).toHaveText('2');
  await expect(workbench.getByTestId('course-generation')).toContainText('목표 거리 후보');

  // The stored revision records the search that produced it and keeps the lineage.
  const courseUrl = await workbench.getByTestId('course-export').getAttribute('href');
  assert.ok(courseUrl);
  const stored = await page.request.get(courseUrl.replace('/export.gpx', ''), { headers });
  expect(stored.status()).toBe(200);
  const body = (await stored.json()) as {
    revision: {
      generation: {
        kind: string;
        targetDistanceMeters: number;
        searchSeed: string;
        candidateSeed: string;
        generatorVersion: string;
        evaluation: { evaluationVersion: number; knowledge: Record<string, string> };
        computation: { graph: { graphBuildId: string } };
      };
      lineage: { activityId: string }[];
    };
  };
  expect(body.revision.generation.kind).toBe('target-distance-loop');
  expect(body.revision.generation.targetDistanceMeters).toBe(1200);
  expect(body.revision.generation.generatorVersion).toBe('target-distance-loop-v1');
  expect(body.revision.generation.searchSeed).toMatch(/^[0-9a-f]{16}$/);
  expect(body.revision.generation.candidateSeed).toMatch(/^[0-9a-f]{16}$/);
  expect(body.revision.generation.evaluation.evaluationVersion).toBe(1);
  expect(body.revision.generation.evaluation.knowledge['surface']).toBe('unknown');
  expect(body.revision.generation.computation.graph.graphBuildId).toBe('0123456789abcdef');
  expect(body.revision.lineage[0]?.activityId).toBe(activity.activityId);
  // The conditions the account export carries have no coordinate in them.
  expect(JSON.stringify(body.revision.generation)).not.toContain('126.9');

  // The picked candidate is spent. The review panel is gone and nothing can save it twice.
  await expect(section.getByTestId('candidate-set')).toHaveCount(0);
  await expect(section.getByTestId('candidate-review')).toHaveCount(0);
});

test('answers a target the search cannot meet without saving anything', async ({ page }) => {
  const headers = await login(page);
  const activity = await storeTrack(page, headers);

  await page.goto(routeAddress(activity.activityId));
  const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
  const courseSection = panel.getByRole('region', { name: '선택 구간으로 코스 만들기' });
  await panel.getByRole('button', { name: '시작 지점', exact: true }).click();
  await courseSection.getByRole('button', { name: '이 지점을 구간 시작으로' }).click();
  await panel.getByRole('button', { name: '끝 지점', exact: true }).click();
  await courseSection.getByRole('button', { name: '이 지점을 구간 끝으로' }).click();
  await courseSection.getByLabel('코스 이름').fill('도달 불가 목표');
  await courseSection.getByRole('button', { name: '이 구간을 코스로 저장' }).click();
  await expect(courseSection.getByRole('status')).toContainText('코스를 저장했습니다');

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/courses');
  const workbench = page.getByRole('region', { name: '내 코스' });
  await workbench.getByRole('button', { name: '도달 불가 목표', exact: true }).click();
  const section = workbench.getByRole('region', { name: '목표 거리 후보' });
  const editor = workbench.getByRole('region', { name: '경유지 편집' });

  // A target far beyond what this fixture's geometry can reach: the search spends its
  // attempts inside its bounds and says it found none. It never offers a near miss.
  await section.getByLabel('목표 거리(m)').fill('4');
  await section.getByRole('button', { name: '목표 거리 후보 생성' }).click();
  // The message belongs to the editor region, which is where this screen speaks.
  await expect(editor.getByText(/목표 거리는 500m 이상/)).toBeVisible();
  await expect(section.getByTestId('candidate-set')).toHaveCount(0);
  await expect(workbench.getByTestId('course-revision')).toHaveText('1');

  // The bounded search itself is refused when the pinned waypoints already exceed it.
  await editor.getByLabel('경유점 경도').fill('127.5');
  await editor.getByLabel('경유점 위도').fill('37.9');
  await editor.getByRole('button', { name: '좌표로 경유점 추가' }).click();
  await editor.getByRole('button', { name: '2번 잠그기' }).click();
  await section.getByLabel('목표 거리(m)').fill('500');
  await section.getByRole('button', { name: '목표 거리 후보 생성' }).click();
  await expect(editor.getByText(/탐색 범위 밖|목표 거리를 넘습니다/)).toBeVisible();
  await expect(section.getByTestId('candidate-set')).toHaveCount(0);
  await expect(workbench.getByTestId('course-revision')).toHaveText('1');
});
