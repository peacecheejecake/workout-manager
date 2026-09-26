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
}
