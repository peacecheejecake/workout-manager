import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { manualActivityResultSchema } from '../../packages/contracts/src/activity';
import { coachingMessageResultSchema } from '../../packages/contracts/src/coaching-threads';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';

/**
 * S09 impact split (M2-01k-m; 01 §7.2 S09-impact-split, S09-no-causal; 05 V2-F14), against the
 * real OIDC session, API and PostgreSQL, in both shells.
 *
 * The impact tab has three sections with their own heading and source line: observed/calculated,
 * classification/estimate, consultation. A classification appears only with its source, version
 * and uncertainty; a record-based estimate has no source, so it reads "추정 없음" with the reason.
 * Nowhere on the screen is there a risk percentage, a causal number or a contribution share,
 * and viewing the consultation section writes nothing — the plan head stays where it was.
 */
async function login(page: Page, name: 'Alice') {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${name}` }).click();
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

const shells = [
  ['Next', 'http://127.0.0.1:3100'],
  ['Vite', 'http://127.0.0.1:4200'],
] as const;

/**
 * What must not appear anywhere on the screen (01 §7.2): a percentage (risk or otherwise),
 * a number attached to risk/probability, a contribution share, or a causal "because of" number.
 */
const forbidden = [
  /\d\s*(?:%|％|퍼센트)/,
  /(?:위험|확률|가능성)[^.\n]{0,20}\d/,
  /(?:기여율|기여도|기여 비율|비중|점유율)[^.\n]{0,20}\d/,
  /때문에[^.\n]{0,40}\d/,
];

for (const [shell, origin] of shells)
  test(`${shell} shell: the impact tab separates observed, classification and consultation without risk %, causal numbers or contribution shares, and writes no plan`, async ({
    page,
  }) => {
    const headers = await login(page, 'Alice');
    try {
      const current = planReadSchema.parse(
        await (await page.request.get('/bff/v1/plans/current', { headers })).json(),
      );
      const draft = planDraftSchema.parse({
        title: `Synthetic impact ${randomUUID()}`,
        timezone: 'Asia/Seoul',
        periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
          id: `impact-${level}`,
          parentId: index === 0 ? null : `impact-${levels[index - 1]}`,
          level,
          title: level,
          startDate: '2019-03-01',
          endDateExclusive: '2019-03-11',
          timezone: 'Asia/Seoul',
          intent: '',
          isPartial: false,
        })),
        sessions: [
          {
            id: 'impact-session',
            blockId: 'impact-block',
            date: '2019-03-02',
            localStartTime: null,
            title: 'Synthetic impact session',
            sport: 'running',
            durationSeconds: 1800,
            distanceMeters: 5000,
            targetRpe: 5,
            intensityLabel: 'B',
            purpose: '유산소 기반 유지',
            notes: '',
            priority: 'normal',
            locks: { date: false, time: false, intensity: false },
            steps: [],
          },
        ],
      });
      const savedResponse = await page.request.put('/bff/v1/plans/current', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: {
          source: 'manual',
          confirmed: true,
          expectedVersionId: current.head?.id ?? null,
          draft,
        },
      });
      expect(savedResponse.status()).toBe(200);
      const saved = planSnapshotSchema.parse(await savedResponse.json());
      const create = async (title: string, linked: boolean) => {
        const response = await page.request.post('/bff/v1/activities', {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          data: {
            confirmed: true,
            activity: {
              title,
              kind: 'running',
              startedAt: '2019-03-02T08:00:00+09:00',
              timezone: 'Asia/Seoul',
              distanceMeters: 4200,
              durationSeconds: 1500,
              durationKind: 'timer',
            },
            report: {
              sessionRpe: 7,
              note: null,
              planLink: linked ? { planVersionId: saved.id, sessionId: 'impact-session' } : null,
            },
          },
        });
        expect(response.status()).toBe(200);
        return manualActivityResultSchema.parse(await response.json());
      };
      const linkedActivity = await create(`S09 영향 분리 ${randomUUID()}`, true);
      const unlinkedActivity = await create(`S09 영향 미연결 ${randomUUID()}`, false);
      // A consultation the user already started on this Block through the coach (S10).
      const threadResponse = await page.request.post('/bff/v1/coaching-threads', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: {
          planVersionId: saved.id,
          scope: { kind: 'block', targetId: 'impact-block' },
          title: 'Block 검토 상담',
          message: '이 Block의 거리 목표를 다시 보고 싶습니다.',
        },
      });
      expect(threadResponse.status()).toBe(200);
      const thread = coachingMessageResultSchema.parse(await threadResponse.json()).thread;

      const writes: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/bff/v1/') && request.method() !== 'GET')
          writes.push(`${request.method()} ${request.url()}`);
      });
      await page.goto(
        `${origin}/activities?selected=${linkedActivity.activityId}&detailTab=impact`,
      );
      const observed = page.getByRole('region', { name: '계획 연결과 관측 영향', exact: true });
      const classified = page.getByRole('region', { name: '분류·추정', exact: true });
      const consult = page.getByRole('region', { name: '상담', exact: true });
      // Three sections, three distinct headings.
      await expect(
        observed.getByRole('heading', { level: 3, name: '관측·계산', exact: true }),
      ).toBeVisible();
      await expect(
        classified.getByRole('heading', { level: 3, name: '분류·추정', exact: true }),
      ).toBeVisible();
      await expect(
        consult.getByRole('heading', { level: 3, name: '상담', exact: true }),
      ).toBeVisible();
      // Three distinct source lines, each inside its own section only.
      await expect(observed.getByText(/^출처: 이 활동의 기록 값\(출처 수동 기록/)).toBeVisible();
      await expect(observed).toContainText('보고한 RPE: 7 · 사용자 자기 보고');
      await expect(observed).toContainText('거리 차이 (실제 − 계획): -800m');
      await expect(classified.getByText(/^출처 표시: 항목마다 출처·버전·불확실성/)).toBeVisible();
      await expect(
        consult.getByText(
          /^출처: 관측·계산 절의 값에서 고정 규칙\(activity-impact-consultation-v1\)/,
        ),
      ).toContainText('제안일 뿐이며 계획을 바꾸지 않습니다.');
      await expect(classified.getByText(/^출처: /)).toHaveCount(2);
      await expect(observed.getByText(/^출처 표시:|고정 규칙/)).toHaveCount(0);
      // The classification comes with its source, version and uncertainty.
      const purpose = classified.locator('div').filter({ hasText: '목적 분류' });
      await expect(purpose.getByText('유산소 기반 유지', { exact: true })).toBeVisible();
      await expect(purpose).toContainText('출처: 연결 계획 세션 "Synthetic impact session"');
      await expect(purpose).toContainText(`버전: 계획 버전 ${saved.version} · ${saved.id}`);
      await expect(purpose).toContainText('불확실성: 계획을 세울 때 사용자가 붙인 분류입니다.');
      const intensity = classified.locator('div').filter({ hasText: '강도 분류' });
      await expect(intensity.getByText('강도 라벨 B', { exact: true })).toBeVisible();
      await expect(intensity).toContainText(`버전: 계획 버전 ${saved.version}`);
      await expect(classified).toContainText(
        '추정 없음 — 이 활동의 기록에서 목적이나 강도를 추정하는 검증된 분류 출처가 없습니다.',
      );
      // Consultation: review items, the coach link and the related thread — suggestions only.
      const items = consult.getByRole('list', { name: '향후 계획에서 검토할 항목' });
      await expect(items).toContainText('실제 거리가 계획보다 800m 짧았습니다.');
      await expect(items).toContainText('보고한 RPE는 7, 계획 목표 RPE는 5로 서로 다릅니다.');
      const review = consult.getByRole('link', { name: '코치에서 연결 Block 검토 열기' });
      expect(
        new URL(String(await review.getAttribute('href')), origin).searchParams.toString(),
      ).toBe(
        new URLSearchParams({
          planVersion: saved.id,
          scopeKind: 'block',
          targetId: 'impact-block',
        }).toString(),
      );
      await expect(
        consult
          .getByRole('list', { name: '관련 상담 기록' })
          .getByRole('link', { name: 'Block 검토 상담', exact: true }),
      ).toHaveAttribute('href', `/coach?thread=${thread.id}`);
      // Nowhere on the screen: a risk %, a causal number or a contribution share.
      const text = await page.locator('body').innerText();
      for (const pattern of forbidden) expect(text).not.toMatch(pattern);
      // Viewing the tab wrote nothing, and the plan head is the version the test saved.
      expect(writes).toEqual([]);
      expect(
        planReadSchema.parse(
          await (await page.request.get('/bff/v1/plans/current', { headers })).json(),
        ).head?.id,
      ).toBe(saved.id);

      // Without a plan link there is no classification source: 추정 없음, with the reason.
      await page.goto(
        `${origin}/activities?selected=${unlinkedActivity.activityId}&detailTab=impact`,
      );
      await expect(
        classified.getByText(/^추정 없음 — 연결한 계획이 없어 분류 출처가 없습니다/),
      ).toHaveCount(2);
      await expect(classified).toContainText('추정 없음 — 이 활동의 기록에서');
      await expect(classified.getByText(/^출처: /)).toHaveCount(0);
      await expect(consult.getByRole('list', { name: '향후 계획에서 검토할 항목' })).toContainText(
        '계획 연결이 없어 계획 대비 검토 항목을 만들지 않습니다.',
      );
      await expect(
        consult.getByRole('link', { name: '코치에서 연결 Block 검토 열기' }),
      ).toHaveCount(0);
      const unlinkedText = await page.locator('body').innerText();
      for (const pattern of forbidden) expect(unlinkedText).not.toMatch(pattern);
      expect(writes).toEqual([]);
    } finally {
      // Isolated local OIDC/PostgreSQL harness only: Alice is synthetic, never an external user.
      // Remove fixture plan versions and threads so later journeys start clean.
      const erased = await page.request.delete('/bff/v1/operations/account', {
        headers,
        data: { confirmation: 'DELETE MY ACCOUNT' },
      });
      expect(erased.status()).toBe(200);
    }
  });
