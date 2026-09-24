import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, aroundEach } from 'vitest';

/**
 * Keeps a finished test's leftover async work out of the next test's DOM.
 *
 * Vitest does not stop a test body when it times out: the body's pending `await`s keep
 * running after cleanup, and every component test shares one `document`. A timed-out
 * body's `user.click(screen…)` then lands on the *next* test's elements and that test
 * fails with an unrelated assertion (M2-01ac: "expected 500 to have a length of 499").
 *
 * Each test body runs inside its own async context. Once the test has finished — passed,
 * failed or timed out — any DOM event its leftover work dispatches on the live document is
 * refused with an error in that leftover work, recorded, and reported when the file ends.
 * Events on nodes that are no longer in the document (the finished test's own unmounted
 * tree) are harmless and still dispatch.
 */
type TestOwner = { readonly name: string; finished: boolean };
export type BlockedLeak = { readonly test: string; readonly event: string };

const owners = new AsyncLocalStorage<TestOwner>();
const blocked: BlockedLeak[] = [];

export class LeakedTestWorkError extends Error {
  override name = 'LeakedTestWorkError';
}

/** Hands the recorded leaks to the caller and forgets them; the guard's own test uses it. */
export function takeBlockedLeaks(): BlockedLeak[] {
  return blocked.splice(0, blocked.length);
}

function reachesDocument(target: EventTarget): boolean {
  if (target === window || target === document) return true;
  return target instanceof Node && target.isConnected;
}

export function installTestIsolation() {
  const dispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function guardedDispatch(this: EventTarget, event) {
    const owner = owners.getStore();
    if (owner?.finished && reachesDocument(this)) {
      blocked.push({ test: owner.name, event: event.type });
      throw new LeakedTestWorkError(
        `A "${event.type}" event from the finished test "${owner.name}" reached the live document. ` +
          'Its leftover async work (for example after a timeout) would act on the next test.',
      );
    }
    return dispatch.call(this, event);
  };
  aroundEach(async (runTest, context) => {
    const owner: TestOwner = { name: context.task.name, finished: false };
    try {
      await owners.run(owner, runTest);
    } finally {
      owner.finished = true;
    }
  });
  afterAll(() => {
    const leaks = takeBlockedLeaks();
    if (leaks.length === 0) return;
    const summary = leaks.map(({ test, event }) => `"${test}" (${event})`).join(', ');
    throw new LeakedTestWorkError(
      `Blocked ${leaks.length} DOM event(s) from finished tests: ${summary}. ` +
        'A test left async work running past its end — usually a timeout; see that test first.',
    );
  });
}
