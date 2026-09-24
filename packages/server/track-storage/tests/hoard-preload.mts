/**
 * Test-only preload that recreates M2-01k-f's M2b/M2d mutant conditions without touching
 * product code: the parse side holds `copies` structured clones of the parsed track while
 * its reply is serialized. M2d held 8 copies and M2b 10; at a 48 MiB ceiling that ran V8
 * out of heap inside a native structured-clone step and aborted the whole host (F1).
 *
 * It is loaded into the parse side with `--import` through the parser's `execArgv`, so it
 * works the same whether the parse runs in a child process (`process.send`) or — as the
 * mutant that moves parsing back into a worker thread does — in a worker (`parentPort`).
 * The copy count comes from the module URL (`?copies=N`) because the parse side is started
 * with an empty environment.
 */
import { parentPort } from 'node:worker_threads';

const copies = Number(new URL(import.meta.url).searchParams.get('copies') ?? '8');
const hoard: unknown[] = [];

type Send = (this: unknown, message: unknown, ...rest: unknown[]) => unknown;

/** Wraps a send so that, before a reply carrying a track goes out, `copies` clones are kept. */
function hoarding(send: Send): Send {
  return function (this: unknown, message: unknown, ...rest: unknown[]): unknown {
    const track = (message as { artifacts?: { track?: unknown } } | null)?.artifacts?.track;
    if (track !== undefined)
      for (let index = 0; index < copies; index += 1) hoard.push(structuredClone(track));
    return send.call(this, message, ...rest);
  };
}

if (parentPort)
  parentPort.postMessage = hoarding(
    parentPort.postMessage as Send,
  ) as typeof parentPort.postMessage;
else if (process.send) process.send = hoarding(process.send as Send) as typeof process.send;
