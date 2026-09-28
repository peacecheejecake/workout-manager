import { identityMobileOrigin, identityWebOrigin } from '../../scripts/fixtures/identity-ports';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

// M2-01k-s/t: local fixture OIDC, both product shells, same-origin BFF and isolated PostgreSQL.
const shells = [
  { name: 'Next', origin: identityWebOrigin },
  { name: 'Vite', origin: identityMobileOrigin },
] as const;

async function login(page: Page, name: 'Alice' | 'Bob', origin: string) {
  await page.goto(`${origin}/account`);
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${name}` }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get(`${origin}/bff/v1/session`);
  expect(response.status()).toBe(200);
  const session = (await response.json()) as {
    athleteId: string;
    sessionId: string;
    csrfToken: string;
  };
  return {
    athleteId: session.athleteId,
    apiOrigin: new URL(page.url()).origin,
    headers: {
      origin: new URL(page.url()).origin,
      'x-workout-session-id': session.sessionId,
      'x-csrf-token': session.csrfToken,
    },
  };
}

for (const shell of shells) {
  test(`${shell.name}: activity editor routes open create and reject an invalid edit id`, async ({
    page,
  }) => {
    await login(page, 'Alice', shell.origin);
    await page.goto(`${shell.origin}/activities/new`);
    await expect(page.getByRole('heading', { name: '수동 활동 입력', level: 1 })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '활동 제목' })).toBeVisible();

    const response = await page.goto(`${shell.origin}/activities/not-a-valid-id/edit`);
    if (shell.name === 'Next') {
      expect(response?.status()).toBe(404);
    } else {
      await expect(page.getByRole('alert')).toHaveText('활동 주소가 올바르지 않습니다.');
    }
    await expect(page.getByRole('textbox', { name: '활동 제목' })).toHaveCount(0);
  });

  test(`${shell.name}: product private screens leave the old tabs on logout and Bob switch`, async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    const alice = await login(page, 'Alice', shell.origin);
    const apiOrigin = alice.apiOrigin;
    const marker = `Alice private ${randomUUID()}`;

    // Create a real activity so the activity workbench opens a populated edit surface.
    const activityResponse = await page.request.post(`${apiOrigin}/bff/v1/activities`, {
      headers: { ...alice.headers, 'idempotency-key': randomUUID() },
      data: {
        confirmed: true,
        activity: {
          title: `${marker} activity`,
          kind: 'running',
          startedAt: new Date(Date.now() - 3_600_000).toISOString(),
          timezone: 'UTC',
          distanceMeters: 1000,
          durationSeconds: 600,
          durationKind: 'elapsed',
        },
        report: { sessionRpe: null, note: null, planLink: null },
      },
    });
    expect(activityResponse.status()).toBe(200);
    const activity = (await activityResponse.json()) as { activityId: string };

    // A saved plan makes the planner and consultation routes show account-owned data.
    const currentResponse = await page.request.get(`${apiOrigin}/bff/v1/plans/current`, {
      headers: alice.headers,
    });
    expect(currentResponse.status()).toBe(200);
    const current = (await currentResponse.json()) as { head: { id: string } | null };
    const planResponse = await page.request.put(`${apiOrigin}/bff/v1/plans/current`, {
      headers: { ...alice.headers, 'idempotency-key': randomUUID() },
      data: {
        source: 'manual',
        confirmed: true,
        expectedVersionId: current.head?.id ?? null,
        draft: {
          title: `${marker} plan`,
          timezone: 'UTC',
          sessions: [],
          periods: (['season', 'wave', 'phase'] as const).map((level, index, levels) => ({
            id: level,
            parentId: index === 0 ? null : levels[index - 1],
            level,
            title: level,
            startDate: '2026-09-01',
            endDateExclusive: '2026-10-01',
            timezone: 'UTC',
            intent: '',
            isPartial: false,
          })),
        },
      },
    });
    expect(planResponse.status()).toBe(200);
    const plan = (await planResponse.json()) as { id: string };
    const threadResponse = await page.request.post(`${apiOrigin}/bff/v1/coaching-threads`, {
      headers: { ...alice.headers, 'idempotency-key': randomUUID() },
      data: {
        planVersionId: plan.id,
        scope: { kind: 'phase', targetId: 'phase' },
        title: `${marker} consultation`,
        message: `${marker} message`,
      },
    });
    expect(threadResponse.status()).toBe(200);
    const thread = (await threadResponse.json()) as { thread: { id: string } };

    // Resource creation is deliberately through the rendered product form.
    await page.goto(`${shell.origin}/resources`);
    const resourceForm = page.getByRole('form', { name: '텍스트 자료 만들기' });
    await resourceForm.getByLabel('제목', { exact: true }).fill(`${marker} resource`);
    await resourceForm.getByLabel('원문', { exact: true }).fill(`${marker} body`);
    await resourceForm.getByRole('button', { name: '텍스트 자료 저장' }).click();
    await expect(page).toHaveURL(/\/resources\/[0-9a-f-]+$/);
    const resourcePath = new URL(page.url()).pathname;
    await expect(page.locator('body')).toContainText(`${marker} body`);

    await page.goto(`${shell.origin}/wellbeing`);
    const checkInForm = page.getByRole('region', { name: '체크인 작성' });
    await checkInForm.getByLabel('관측 시각 (시간차 포함 ISO)').fill(new Date().toISOString());
    await checkInForm.getByLabel('관측 시간대').fill('UTC');
    await checkInForm.getByLabel('체크인 메모').fill(`${marker} check-in`);
    await checkInForm.getByRole('button', { name: '체크인 저장' }).click();
    await expect(page.locator('body')).toContainText(`${marker} check-in`);

    await page.goto(`${shell.origin}/recovery`);
    const methodForm = page
      .locator('form')
      .filter({ has: page.getByRole('heading', { name: '개인 방법 수동 기록' }) });
    await methodForm.getByLabel('방법 이름').fill(`${marker} recovery method`);
    await methodForm.getByRole('button', { name: '방법 저장' }).click();
    await expect(page.getByRole('heading', { name: `${marker} recovery method` })).toBeVisible();

    const routes = [
      {
        name: 'activity editing',
        path: `/activities/${activity.activityId}/edit`,
        surface: { role: 'textbox', name: '활동 제목' } as const,
        privateValue: `${marker} activity`,
      },
      {
        name: 'planning',
        path: '/planner',
        surface: { role: 'heading', name: '훈련 계획' } as const,
        privateText: `${marker} plan`,
      },
      {
        name: 'coaching',
        path: `/coach?${new URLSearchParams({ thread: thread.thread.id })}`,
        surface: { role: 'region', name: '상담 기록' } as const,
        privateText: `${marker} message`,
      },
      {
        name: 'recovery',
        path: '/recovery',
        surface: { role: 'region', name: '회복 전략 작업 공간' } as const,
        privateText: `${marker} recovery method`,
      },
      {
        name: 'resources',
        path: resourcePath,
        surface: { role: 'region', name: '개인 자료 작업 공간' } as const,
        privateText: `${marker} body`,
      },
      {
        name: 'wellbeing',
        path: '/wellbeing',
        surface: { role: 'region', name: '체크인 작성' } as const,
        privateText: `${marker} check-in`,
      },
      {
        name: 'dashboard',
        path: '/dashboard',
        surface: { role: 'heading', name: '오늘과 최근 기록' } as const,
        privateText: `${marker} plan`,
      },
    ];
    const openTabs: {
      page: Page;
      surface: { role: 'heading' | 'region' | 'textbox'; name: string };
    }[] = [];
    for (const route of routes) {
      const tab = await context.newPage();
      await tab.goto(`${shell.origin}${route.path}`);
      const surface = tab.getByRole(route.surface.role, { name: route.surface.name, exact: true });
      await expect(surface).toBeVisible();
      if ('privateValue' in route) await expect(surface).toHaveValue(route.privateValue);
      if ('privateText' in route)
        await expect(tab.locator('body')).toContainText(route.privateText);
      if (route.name === 'activity editing') {
        await surface.fill(`${marker} unsaved editor draft`);
        await expect(surface).toHaveValue(`${marker} unsaved editor draft`);
      }
      openTabs.push({ page: tab, surface: route.surface });
    }

    const logoutTab = await context.newPage();
    await logoutTab.goto(`${shell.origin}/account`);
    await logoutTab.getByRole('button', { name: '로그아웃', exact: true }).click();
    await expect(logoutTab.getByRole('link', { name: 'OIDC로 로그인' })).toBeVisible();
    expect((await logoutTab.request.get(`${shell.origin}/bff/v1/session`)).status()).toBe(401);

    for (const tab of openTabs) {
      await tab.page.bringToFront();
      // The local Chromium run exercises same-origin storage events and tab activation.
      // It does not establish OS/WebView foreground delivery on a physical device.
      await expect(tab.page.getByText('이 작업은 로그인이 필요합니다.')).toBeVisible();
      await expect(
        tab.page.getByRole(tab.surface.role, { name: tab.surface.name, exact: true }),
      ).toHaveCount(0);
      await expect(tab.page.locator('body')).not.toContainText(marker);
    }

    const bob = await login(logoutTab, 'Bob', shell.origin);
    expect(bob.athleteId).not.toBe(alice.athleteId);
    for (const tab of openTabs) {
      await tab.page.bringToFront();
      // Headless Chromium does not consistently deliver the OS focus event here.
      // This covers the product's focus revalidation handler, not real device delivery.
      await tab.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(tab.page.locator('body')).not.toContainText(marker);
      expect(
        await tab.page
          .locator('input, textarea')
          .evaluateAll((fields) =>
            fields.some(
              (field) =>
                'value' in field &&
                typeof field.value === 'string' &&
                field.value.includes('Alice private'),
            ),
          ),
      ).toBe(false);
      await expect(tab.page.getByText('이 작업은 로그인이 필요합니다.')).toHaveCount(0);
    }
  });
}
