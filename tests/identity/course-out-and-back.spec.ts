import assert from 'node:assert/strict';
import { expect, test, type Locator } from '@playwright/test';
import {
  courseReadResultSchema,
  courseRouteCandidateResultSchema,
  courseRouteProposalResultSchema,
  type CourseRouteKnowledge,
} from '../../packages/contracts/src/courses';
import { importCourse, login } from './course-editor-support';
import { expectLineDrawn, mapRegion } from './map-evidence';
import {
  expectedAccessText,
  expectedNightText,
  expectedStairsText,
  expectedSurfaceText,
} from './route-knowledge-text';

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

/**
 * The stairs, surface, access and night lines (M2-01ap), each compared with the wording built
 * from the server's own answer. `prefix` is `route` for the review and `candidate` for a
 * candidate row, whose test ids end in the ordinal.
 */
async function expectKnowledgeLines(
  scope: Locator,
  prefix: 'route' | 'candidate',
  knowledge: CourseRouteKnowledge,
  suffix = '',
) {
  await expect(scope.getByTestId(`${prefix}-access${suffix}`)).toHaveText(
    expectedAccessText(knowledge),
  );
  await expect(scope.getByTestId(`${prefix}-stairs${suffix}`)).toHaveText(
    expectedStairsText(knowledge),
  );
  await expect(scope.getByTestId(`${prefix}-surface${suffix}`)).toHaveText(
    expectedSurfaceText(knowledge),
  );
  await expect(scope.getByTestId(`${prefix}-night${suffix}`)).toHaveText(expectedNightText);
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
  const raw = (await answered.json()) as { outcome: string };
  // Reported verbatim, so a refusal from the real engine is visible in the failure.
  expect({ status: answered.status(), outcome: raw.outcome }).toEqual({
    status: 200,
    outcome: 'route_computed',
  });
  const answer = courseRouteProposalResultSchema.parse(raw);
  assert.ok(answer.outcome === 'route_computed');
  const engineDistance = answer.proposal.engineDistanceMeters;
  const knowledge = answer.knowledge;
  // The real engine was asked for every detail (M2-01ap); the fixture traverses no graph.
  if (routingMode === 'graphhopper')
    expect([
      knowledge.stairs.status,
      knowledge.surface.status,
      knowledge.accessRestrictions.status,
    ]).toEqual(['reported', 'reported', 'reported']);
  else
    expect([knowledge.surface.status, knowledge.accessRestrictions.status]).toEqual([
      'not_reported',
      'not_reported',
    ]);
  console.log(`[${routingMode}] proposal knowledge ${JSON.stringify(knowledge)}`);

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
  await expectKnowledgeLines(outAndBack, 'route', knowledge);
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
  const generatedRaw = (await generatedAnswer.json()) as { outcome: string };
  expect({ status: generatedAnswer.status(), outcome: generatedRaw.outcome }).toEqual({
    status: 200,
    outcome: 'candidates_generated',
  });
  const generatedBody = courseRouteCandidateResultSchema.parse(generatedRaw);
  assert.ok(generatedBody.outcome === 'candidates_generated');
  expect(generatedBody.set.evaluationVersion).toBe(2);
  const first = generatedBody.set.candidates.find((candidate) => candidate.ordinal === 0);
  assert.ok(first);
  assert.ok(first.evaluation.evaluationVersion === 2);
  const set = candidates.getByTestId('candidate-set');
  // The error the server measured and stored with the candidate, not one recomputed here.
  await expect(set.getByTestId('candidate-error-0')).toHaveText(
    errorText(first.evaluation.distanceErrorMeters, first.evaluation.distanceErrorRatio),
  );
  await expect(set.getByTestId('candidate-connectivity-0')).toContainText(
    '엔진이 지났다고 밝힌 도로 구간으로 이어짐',
  );
  await expect(set.getByTestId('candidate-repeat-0')).toHaveText(/^\d+(\.\d+)?k?m \(\d+%\)/);
  await expectKnowledgeLines(set, 'candidate', first.evaluation.knowledge, '-0');
  console.log(
    `[${routingMode}] candidate 0 knowledge ${JSON.stringify(first.evaluation.knowledge)}`,
  );
  await expect(set.getByTestId('candidate-gradient-0')).toHaveText(
    '확인되지 않음 (엔진 경사 자료 없음 · 고도 표본은 고도 확인 참조)',
  );
});

/**
 * M2-01ap: a real sample, on the real Seoul graph, whose line crosses stretches the graph
 * records a finding for — shown next to the review exactly as the server measured them.
 *
 * HOW THE SAMPLES WERE FOUND. Both are research pairs published in the M0-06b Korean coverage
 * evidence (`docs/implementation/research/m0-06b-routing-korea-coverage.json`, graph
 * `c57f12f5975347e8`), whose probe asked the same engine for `road_access` and `surface` and
 * recorded metres per value. They are synthetic points on public streets, not anyone's track:
 *
 * - BRG-02 (126.969, 37.556 → 126.9785, 37.5585): the evidence records `road_access=no`
 *   over 669.2 m and `surface=concrete` over 517.6 m of the one-way line — a pedestrian
 *   overpass closed to vehicles, which is exactly why the screen says `road_access` is a
 *   vehicle/general value and not a walking ban.
 * - URB-SEL-02 (126.987, 37.5633 → 126.9776, 37.5592): `road_class=steps` over 23.6 m and
 *   `surface=paving_stones` over 611.2 m.
 *
 * The out-and-back doubles each stretch, so the thresholds below are the one-way figures
 * with a margin, not the recorded values: they assert that the finding is there and shown,
 * not a number to the metre.
 */
const samples = [
  {
    label: 'BRG-02',
    A: [126.969, 37.556] as const,
    B: [126.9785, 37.5585] as const,
    access: { value: 'road_access=no', atLeastMeters: 600 },
    surface: { value: 'concrete', atLeastMeters: 400 },
    stairs: null,
  },
  {
    label: 'URB-SEL-02',
    A: [126.987, 37.5633] as const,
    B: [126.9776, 37.5592] as const,
    access: null,
    surface: { value: 'paving_stones', atLeastMeters: 500 },
    stairs: { atLeastMeters: 20 },
  },
] as const;

for (const sample of samples)
  test(`a real sample (${sample.label}) shows what the graph records along it`, async ({
    page,
  }) => {
    test.skip(
      routingMode !== 'graphhopper',
      'the fixture engine traverses no graph and knows nothing about edges',
    );
    test.setTimeout(180_000);
    // Bob, not Alice: the candidate search above spends most of Alice's engine budget per
    // minute (a real 429 `overloaded` was observed on the third repetition otherwise).
    const headers = await login(page, 'Bob');
    await page.setViewportSize({ width: 1280, height: 900 });
    const name = `M2-01ap ${sample.label} ${Date.now()}`;
    const courseId = await importCourse(page, headers, name, [sample.A, sample.B]);
    await page.goto('/courses');
    const workbench = page.getByRole('region', { name: '내 코스' });
    await workbench.getByRole('button', { name, exact: true }).click();
    await expectLineDrawn(mapRegion(workbench, '코스 지도'));
    const editor = workbench.getByRole('region', { name: '경유지 편집' });
    const candidates = workbench.getByRole('region', { name: '목표 거리 후보' });
    await candidates.getByLabel('목표 거리(m)').fill('2000');
    const answered = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/bff/v1/courses/${courseId}/route-proposals`,
    );
    await candidates.getByRole('button', { name: '왕복 초안 계산 (A→B→A)' }).click();
    const response = await answered;
    const raw = (await response.json()) as { outcome: string };
    expect({ status: response.status(), outcome: raw.outcome }).toEqual({
      status: 200,
      outcome: 'route_computed',
    });
    const answer = courseRouteProposalResultSchema.parse(raw);
    assert.ok(answer.outcome === 'route_computed');
    const knowledge = answer.knowledge;
    console.log(`[${sample.label}] knowledge ${JSON.stringify(knowledge)}`);
    assert.ok(knowledge.accessRestrictions.status === 'reported');
    assert.ok(knowledge.surface.status === 'reported');
    assert.ok(knowledge.stairs.status === 'reported');
    const knownMeters = (
      known: readonly { value: string; meters: number }[],
      value: string,
    ): number => known.find((entry) => entry.value === value)?.meters ?? 0;
    // The finding the evidence recorded is in the answer...
    if (sample.access)
      expect(knownMeters(knowledge.accessRestrictions.known, sample.access.value)).toBeGreaterThan(
        sample.access.atLeastMeters,
      );
    expect(knownMeters(knowledge.surface.known, sample.surface.value)).toBeGreaterThan(
      sample.surface.atLeastMeters,
    );
    if (sample.stairs)
      expect(knownMeters(knowledge.stairs.known, 'steps')).toBeGreaterThan(
        sample.stairs.atLeastMeters,
      );

    // ...and on the screen, next to the review, exactly as the server measured it.
    const review = editor.getByRole('group', { name: '계산된 경로 검토' });
    const outAndBack = review.getByTestId('out-and-back-review');
    await expect(outAndBack).toBeVisible();
    await expectKnowledgeLines(outAndBack, 'route', knowledge);
    if (sample.access)
      await expect(outAndBack.getByTestId('route-access')).toContainText(`${sample.access.value}(`);
    await expect(outAndBack.getByTestId('route-surface')).toContainText(
      `(${sample.surface.value})`,
    );
    if (sample.stairs)
      await expect(outAndBack.getByTestId('route-stairs')).toContainText('(highway=steps)');
    // The parts of the line the graph records nothing for still say so.
    if (knowledge.surface.unknownMeters > 0)
      await expect(outAndBack.getByTestId('route-surface')).toContainText('확인되지 않음');
  });
