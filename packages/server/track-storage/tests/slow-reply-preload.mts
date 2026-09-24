/**
 * Test-only preload for the orphan check (`orphan-driver.mts`): the parse process holds its
 * reply for 10 s on a timer before sending it, standing in for a parse that is still running
 * — and yielding — when its host dies. A process that did not react to its IPC channel
 * closing would live out that timer; the product's parse process must not.
 */
type Send = (this: unknown, message: unknown, ...rest: unknown[]) => unknown;

if (process.send) {
  const send = process.send as Send;
  process.send = function (this: unknown, message: unknown, ...rest: unknown[]) {
    const isReply = typeof message === 'object' && message !== null && 'ok' in message;
    if (!isReply) return send.call(this, message, ...rest);
    setTimeout(() => send.call(this, message, ...rest), 10_000);
    return true;
  } as typeof process.send;
}
