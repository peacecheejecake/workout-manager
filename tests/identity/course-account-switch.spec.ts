import { expect, test } from '@playwright/test';
import { draftRevision, login, place, shells } from './course-editor-support';

for (const shell of shells) {
  test(`${shell.name}: an account switch clears the prior course draft and private browser cache`, async ({
    page,
    context,
  }) => {
    await login(page);
    const alice = (await (await page.request.get('/bff/v1/session')).json()) as {
      athleteId: string;
    };
    await page.goto(`${shell.origin}/courses/new`);
    const editor = page.getByRole('region', { name: '경유지 편집' });
    await place(editor, 126.978, 37.566);
    await place(editor, 126.982, 37.568);
    await editor.getByRole('textbox', { name: '1번 경유점 이름' }).fill('Alice의 비공개 초안');
    await expect(
      editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem'),
    ).toHaveCount(2);
    const aliceRevision = await draftRevision(editor);
    expect(aliceRevision).toBeGreaterThan(1);
    await page.evaluate(() => localStorage.setItem('workout:private:fixture-draft', 'Alice draft'));

    const other = await context.newPage();
    await other.goto(`${shell.origin}/bff/v1/auth/login`);
    await other.getByRole('link', { name: 'Sign in as Bob' }).click();
    await expect(other.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
    const bob = (await (await other.request.get('/bff/v1/session')).json()) as {
      athleteId: string;
    };
    expect(bob.athleteId).not.toBe(alice.athleteId);

    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('workout:private:account-scope')))
      .toBe(bob.athleteId);
    await expect(
      editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem'),
    ).toHaveCount(0);
    expect(await draftRevision(editor)).toBeLessThan(aliceRevision);
    expect(await page.evaluate(() => localStorage.getItem('workout:private:fixture-draft'))).toBe(
      null,
    );
    expect(await page.locator('body').textContent()).not.toContain('Alice의 비공개 초안');
    await other.close();
  });

  test(`${shell.name}: a late Alice API answer cannot restore her draft after a silent Bob switch`, async ({
    page,
    context,
  }) => {
    test.setTimeout(60_000);
    await login(page);
    await page.goto(`${shell.origin}/courses/new`);
    const editor = page.getByRole('region', { name: '경유지 편집' });
    await place(editor, 126.978, 37.566);
    await editor.getByRole('textbox', { name: '1번 경유점 이름' }).fill('Alice만의 늦은 초안');
    await page.evaluate(() => localStorage.setItem('workout:private:fixture-draft', 'Alice'));

    // Keep this tab visible after the other tab signs Bob in, but block the focus and
    // visibility listeners that would ordinarily refresh its session. This exercises the
    // cross-tab account boundary itself, with no synthetic visibilitychange rescue.
    await page.evaluate(() => {
      for (const type of ['focus', 'visibilitychange'])
        window.addEventListener(type, (event) => event.stopImmediatePropagation(), true);
    });
    // Hold the real 200 Response *inside the browser*, after native fetch has resolved but
    // before the session transport receives it. A route hold can instead be aborted before
    // delivery and cannot prove the transport's post-invalidation discard.
    await page.evaluate(() => {
      const original = window.fetch.bind(window);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const probe = {
        status: null as number | null,
        returnedToTransport: false,
        bodyRead: false,
        release,
      };
      (window as typeof window & { __oldAccountReply?: typeof probe }).__oldAccountReply = probe;
      window.fetch = async (input, init) => {
        const response = await original(input, init);
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.pathname !== '/bff/v1/courses/place-search') return response;
        probe.status = response.status;
        const originalJson = response.json.bind(response);
        response.json = async () => {
          probe.bodyRead = true;
          return originalJson();
        };
        await gate;
        probe.returnedToTransport = true;
        return response;
      };
    });
    const search = page.getByRole('region', { name: '장소 검색' });
    await search.getByRole('textbox', { name: '장소 이름' }).fill('서울');
    await search.getByRole('button', { name: '검색', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __oldAccountReply?: { status: number | null } })
              .__oldAccountReply?.status,
        ),
      )
      .toBe(200);

    const other = await context.newPage();
    await other.goto(`${shell.origin}/bff/v1/auth/login`);
    await other.getByRole('link', { name: 'Sign in as Bob' }).click();
    await expect(other.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
    const bob = (await (await other.request.get('/bff/v1/session')).json()) as {
      athleteId: string;
    };
    // OIDC callbacks may land on the Next origin. Mount Bob's workspace on the shell
    // origin so the browser emits the same-origin storage event to Alice's tab.
    await other.goto(`${shell.origin}/courses/new`);
    await expect(other.getByRole('region', { name: '새 코스' })).toBeVisible();
    await other.evaluate(() => localStorage.setItem('workout:private:bob-pending', 'Bob'));
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('workout:private:account-scope')))
      .toBe(bob.athleteId);
    await expect(
      editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem'),
    ).toHaveCount(0);
    await page.evaluate(() =>
      (
        window as typeof window & {
          __oldAccountReply?: { release: () => void };
        }
      ).__oldAccountReply?.release(),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __oldAccountReply?: { returnedToTransport: boolean };
              }
            ).__oldAccountReply?.returnedToTransport,
        ),
      )
      .toBe(true);
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { __oldAccountReply?: { bodyRead: boolean } })
            .__oldAccountReply?.bodyRead,
      ),
    ).toBe(false);
    await expect(page.getByText('Alice만의 늦은 초안')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('workout:private:fixture-draft'))).toBe(
      null,
    );
    expect(await page.evaluate(() => localStorage.getItem('workout:private:bob-pending'))).toBe(
      'Bob',
    );
    await other.close();
  });
}
