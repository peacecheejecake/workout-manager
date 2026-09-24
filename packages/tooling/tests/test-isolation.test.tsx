import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, expect, it } from 'vitest';
import { LeakedTestWorkError, takeBlockedLeaks } from '../test-isolation';

/**
 * The shared component setup (`test-setup.ts`) installs the guard; these tests exercise it
 * deterministically. The first test ends with work still pending — exactly what a timed-out
 * body leaves behind — and a later test releases that work once its own DOM is in place.
 */
let releaseLeftovers!: () => void;
const laterTestReady = new Promise<void>((resolve) => {
  releaseLeftovers = resolve;
});
let leftoverClick: Promise<void> | undefined;
let leftoverDetached: Promise<boolean> | undefined;
const detached = document.createElement('div');
let detachedEvents = 0;
detached.addEventListener('ping', () => {
  detachedEvents += 1;
});

it('ends with async work still pending, as a timed-out test body does', () => {
  leftoverClick = (async () => {
    await laterTestReady;
    await userEvent.click(screen.getByRole('button', { name: 'Later test' }));
  })();
  leftoverDetached = (async () => {
    await laterTestReady;
    return detached.dispatchEvent(new Event('ping'));
  })();
});

it("refuses the finished test's leftover events on the live document", async () => {
  let clicks = 0;
  render(
    <button type="button" onClick={() => (clicks += 1)}>
      Later test
    </button>,
  );
  releaseLeftovers();
  await expect(leftoverClick).rejects.toBeInstanceOf(LeakedTestWorkError);
  expect(clicks).toBe(0);
  // The test's own events are untouched.
  await userEvent.click(screen.getByRole('button', { name: 'Later test' }));
  expect(clicks).toBe(1);
});

it('lets leftover work touch nodes outside the document, which no other test shares', async () => {
  await expect(leftoverDetached).resolves.toBe(true);
  expect(detachedEvents).toBe(1);
});

// Runs before the setup's own report, which would otherwise fail this file on purpose.
afterAll(() => {
  const leaks = takeBlockedLeaks();
  expect(leaks.length).toBeGreaterThan(0);
  expect(new Set(leaks.map(({ test }) => test))).toEqual(
    new Set(['ends with async work still pending, as a timed-out test body does']),
  );
});
