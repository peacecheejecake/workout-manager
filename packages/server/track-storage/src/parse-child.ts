import { getHeapStatistics } from 'node:v8';

import { answerParseRequest } from './parse-request.js';

/**
 * Parse process entry point (M2-01ai). The host forks one of these per parse with
 * `--max-old-space-size` set to the parse ceiling; it answers exactly one request and is
 * then killed by the host.
 *
 * Why a process and not a worker thread: a worker's `resourceLimits` normally ends only the
 * worker, but an allocation inside a native, uninterruptible step (M2-01k-f observed
 * structured-clone deserialization, `ValueDeserializer`) can use up Node's near-heap-limit
 * grace, and V8 then aborts the whole process — the API with it (M2-01k-f.md F1). A V8
 * abort here ends this process and nothing else: the host sees it exit, reads the V8
 * out-of-memory report on this process's stderr, and answers `TRACK_PARSE_MEMORY_EXCEEDED`.
 *
 * The first message this process sends is the heap limit V8 actually gave it. The host
 * withholds the bytes until it has checked that value against the ceiling it asked for.
 *
 * It never outlives its host: when the IPC channel closes — the host died, or let go of it —
 * it exits. A parse that is running when that happens ends as soon as it next yields, and a
 * reply that can no longer be sent ends it too.
 */
const channel = process.send?.bind(process);
if (!channel) throw new Error('TRACK_PARSE_CHILD_REQUIRES_PARENT');
const send: NonNullable<typeof process.send> = channel;

const leave = () => process.exit(0);
process.on('disconnect', leave);

function reply(message: unknown) {
  try {
    send(message, undefined, undefined, (error) => {
      if (error) leave();
    });
  } catch {
    leave();
  }
}

process.once('message', (message: unknown) => {
  void answerParseRequest(message).then(reply, () =>
    reply({ ok: false, code: 'TRACK_PARSE_FAILED' }),
  );
});

reply({
  ready: true,
  appliedHeapLimitMb: getHeapStatistics().heap_size_limit / (1024 * 1024),
});
