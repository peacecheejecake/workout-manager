import assert from 'node:assert/strict';
import { expect, test } from '@playwright/test';
import { courseReadResultSchema } from '../../packages/contracts/src/courses';
import { importCourse, login } from './course-editor-support';
import { expectLineDrawn, mapRegion } from './map-evidence';

/**
 * M2-01k-j: the out-and-back (A→B→A) draft, and what the owner reads next to it and next to
 * each target-distance candidate — against the real session, API, PostgreSQL and, with
 * `IDENTITY_E2E_ROUTING=graphhopper`, the self-hosted engine.
 *
 * One stored course from A to B. The owner asks for the out-and-back: the request to the
 * engine is A→B→A (not A→B), the review shows the stretch the way back shares with the way
 * out, the error against the target in the field, and — each on its own line — connectivity,
 * known access restrictions and the gradient source. The map draws the shared stretch as its
 * own `overlap` line, observed on the renderer's line layer. The owner saves; the stored
 * revision names the graph and the engine version that computed it and keeps A→B→A. Then the
 * same five facts are read next to a target-distance candidate.
 *
 * ROUTING MODE. The fixture engine bends every leg to its own side, so its way back never
 * lies on its way out and the honest answer there is "겹치는 구간 없음". The real engine
 * retraces the streets, so there the overlap must be shown and drawn. Each mode asserts its
 * own answer, and the spec says which mode it ran in.
 */
const routingMode = process.env['IDENTITY_E2E_ROUTING'] ?? 'fixture';

function expectedEngine() {
  if (routingMode === 'fixture')
    return { graphBuildId: '0123456789abcdef', engineVersion: 'identity-e2e-fixture' };
  if (routingMode === 'graphhopper') {
    const graphBuildId = process.env['IDENTITY_E2E_EXPECTED_GRAPH_BUILD_ID'];
    assert.ok(
      graphBuildId !== undefined && /^[0-9a-f]{16}$/.test(graphBuildId),
      'IDENTITY_E2E_ROUTING=graphhopper needs IDENTITY_E2E_EXPECTED_GRAPH_BUILD_ID',
    );
    return { graphBuildId, engineVersion: '10.0' };
  }
  throw new Error(`Unsupported IDENTITY_E2E_ROUTING: ${routingMode}`);
}

// Near Seoul City Hall, on streets a real Seoul pedestrian graph snaps.
const A = [126.978, 37.566] as const;
const B = [126.982, 37.569] as const;
const target = 1_000;

/** The screen's own wording for a signed error and its ratio. */
function errorText(errorMeters: number, errorRatio: number): string {
  const metres = (value: number) =>
    value >= 1000 ? `${(value / 1000).toFixed(2)}km` : `${Math.round(value)}m`;
  return `${errorMeters >= 0 ? '+' : '−'}${metres(Math.abs(errorMeters))} (${(errorRatio * 100).toFixed(1)}%)`;
}

test('an out-and-back draft is computed as A→B→A, reviewed with its overlap and saved with its graph', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const engine = expectedEngine();
  test.info().annotations.push({ type: 'routing-mode', description: routingMode });

  const headers = await login(page, 'Alice');
  await page.setViewportSize({ width: 1280, height: 900 });
  const name = `M2-01k-j 왕복 ${Date.now()}`;
  const courseId = await importCourse(page, headers, name, [A, B]);

  await page.goto('/courses');
  const workbench = page.getByRole('region', { name: '내 코스' });
  await workbench.getByRole('button', { name, exact: true }).click();
  const map = mapRegion(workbench, '코스 지도');
  await expectLineDrawn(map);
  await expect(workbench.getByTestId('course-revision')).toHaveText('1');
  const editor = workbench.getByRole('region', { name: '경유지 편집' });
  const candidates = workbench.getByRole('region', { name: '목표 거리 후보' });
  await candidates.getByLabel('목표 거리(m)').fill(String(target));

  // ── The out-and-back request: A→B→A, not the one-way A→B the course holds.
  const proposalRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/bff/v1/courses/${courseId}/route-proposals`,
  );
  const pathsBefore = await map.getAttribute('data-paths-generation');
  await candidates.getByRole('button', { name: '왕복 초안 계산 (A→B→A)' }).click();
  const sent = await proposalRequest;
  const asked = sent.postDataJSON() as {
    waypoints: { role: string; position: [number, number] }[];
  };
  expect(asked.waypoints.map((waypoint) => [waypoint.role, waypoint.position])).toEqual([
    ['start', [...A]],
    ['via', [...B]],
    ['finish', [...A]],
  ]);
  const answered = await sent.response();
  assert.ok(answered);
  const answer = (await answered.json()) as {
    outcome: string;
    proposal?: { engineDistanceMeters: number };
  };
  // Reported verbatim, so a refusal from the real engine is visible in the failure.
  expect({ status: answered.status(), outcome: answer.outcome }).toEqual({
    status: 200,
    outcome: 'route_computed',
  });
  const engineDistance = answer.proposal?.engineDistanceMeters ?? Number.NaN;

  // ── The review: overlap, target error, and the three facts each on its own line.
  const review = editor.getByRole('group', { name: '계산된 경로 검토' });
  await expect(review.getByTestId('route-graph')).toHaveText(engine.graphBuildId);
  const outAndBack = review.getByTestId('out-and-back-review');
  await expect(outAndBack).toBeVisible();
  const overlap = outAndBack.getByTestId('route-overlap');
  if (routingMode === 'graphhopper') {
    // The real engine walks back the way it came: most of the way back is shared.
    await expect(overlap).toHaveText(/^\d+(\.\d+)?k?m \((\d+)%\) · \d+곳$/);
    const percent = Number(/\((\d+)%\)/.exec((await overlap.textContent()) ?? '')?.[1]);
    expect(percent).toBeGreaterThanOrEqual(50);
    await expect(outAndBack.getByRole('list', { name: '겹치는 구간' })).toContainText('1구간');
  } else {
    await expect(overlap).toHaveText('겹치는 구간 없음');
  }
  // Recorded, so a run says what it saw and not only that it passed.
  console.log(
    `[${routingMode}] engine ${engineDistance} m · overlap "${await overlap.textContent()}"`,
  );
  await expect(outAndBack.getByTestId('route-target-error')).toHaveText(
    errorText(engineDistance - target, (engineDistance - target) / target),
  );
  await expect(outAndBack.getByTestId('route-connectivity')).toHaveText(
    '엔진이 지났다고 밝힌 도로 구간으로 이어짐 · 지금 통행할 수 있다는 보장은 아님',
  );
  await expect(outAndBack.getByTestId('route-access')).toHaveText(
    '확인되지 않음 (엔진에 요청하지 않음)',
  );
  await expect(outAndBack.getByTestId('route-conditions')).toHaveText(
    '계단 확인되지 않음 (엔진 도로 등급을 검증에만 쓰고 보관하지 않음) · 노면 확인되지 않음 (엔진에 요청하지 않음) · 야간 통행 확인되지 않음 (자료 없음)',
  );
  await expect(outAndBack.getByTestId('route-gradient')).toHaveText(
    '확인되지 않음 (엔진 경사 자료 없음 · 고도 표본은 고도 확인 참조)',
  );

  // ── The map: the shared stretch is a line of its own, drawn by the renderer.
  await expectLineDrawn(map, { changedFrom: pathsBefore });
  if (routingMode === 'graphhopper')
    await expect(map).toHaveAttribute('data-rendered-line-roles', /(^| )overlap( |$)/);
  else await expect(map).not.toHaveAttribute('data-rendered-line-roles', /(^| )overlap( |$)/);

  // ── A proposal is not a save. The explicit save stores A→B→A with its graph.
  await expect(workbench.getByTestId('course-revision')).toHaveText('1');
  await review.getByLabel('위 내용을 검토했습니다.').check();
  await review.getByRole('button', { name: '검토한 경로 저장' }).click();
  await expect(workbench.getByTestId('course-revision')).toHaveText('2');
  const stored = await page.request.get(`/bff/v1/courses/${courseId}`, { headers });
  expect(stored.status()).toBe(200);
  const read = courseReadResultSchema.parse(await stored.json());
  assert.ok(read.status === 'available');
  const generation = read.revision.generation;
  assert.ok(generation.kind === 'routed-waypoints');
  test.info().annotations.push({
    type: 'stored-graph',
    description: `${generation.computation.graph.graphBuildId} engine ${String(generation.computation.graph.engineVersion)}`,
  });
  expect({
    graphBuildId: generation.computation.graph.graphBuildId,
    engineVersion: generation.computation.graph.engineVersion,
    identitySource: generation.computation.graph.identitySource,
    waypointCount: generation.computation.conditions.waypointCount,
  }).toEqual({ ...engine, identitySource: 'engine', waypointCount: 3 });
  expect(read.revision.waypoints.map((waypoint) => [waypoint.role, waypoint.position])).toEqual([
    ['start', [...A]],
    ['via', [...B]],
    ['finish', [...A]],
  ]);
  expect(generation.engineDistanceMeters).toBe(engineDistance);
  console.log(
    `[${routingMode}] stored revision ${read.revision.courseRevision}: graph ${generation.computation.graph.graphBuildId} engine ${String(generation.computation.graph.engineVersion)}`,
  );

  // ── The same facts next to a target-distance candidate from the stored A.
  await candidates.getByLabel('목표 거리(m)').fill('1200');
  const generated = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/bff/v1/courses/${courseId}/route-candidates`,
  );
  await candidates.getByRole('button', { name: '목표 거리 후보 생성' }).click();
  const generatedAnswer = await generated;
  const generatedBody = (await generatedAnswer.json()) as {
    outcome: string;
    set?: {
      candidates: {
        ordinal: number;
        evaluation: { distanceErrorMeters: number; distanceErrorRatio: number };
      }[];
      targetDistanceMeters: number;
    };
  };
  expect({ status: generatedAnswer.status(), outcome: generatedBody.outcome }).toEqual({
    status: 200,
    outcome: 'candidates_generated',
  });
  const first = generatedBody.set?.candidates.find((candidate) => candidate.ordinal === 0);
  assert.ok(first);
  const set = candidates.getByTestId('candidate-set');
  // The error the server measured and stored with the candidate, not one recomputed here.
  await expect(set.getByTestId('candidate-error-0')).toHaveText(
    errorText(first.evaluation.distanceErrorMeters, first.evaluation.distanceErrorRatio),
  );
  await expect(set.getByTestId('candidate-connectivity-0')).toContainText(
    '엔진이 지났다고 밝힌 도로 구간으로 이어짐',
  );
  await expect(set.getByTestId('candidate-repeat-0')).toHaveText(/^\d+(\.\d+)?k?m \(\d+%\)/);
  await expect(set.getByTestId('candidate-access-0')).toHaveText(
    '확인되지 않음 (엔진에 요청하지 않음)',
  );
  await expect(set.getByTestId('candidate-knowledge-0')).toHaveText(
    '계단 확인되지 않음 (엔진 도로 등급을 검증에만 쓰고 보관하지 않음) · 노면 확인되지 않음 (엔진에 요청하지 않음) · 야간 통행 확인되지 않음 (자료 없음)',
  );
  await expect(set.getByTestId('candidate-gradient-0')).toHaveText(
    '확인되지 않음 (엔진 경사 자료 없음 · 고도 표본은 고도 확인 참조)',
  );
});
