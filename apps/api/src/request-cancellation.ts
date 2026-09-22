import type { FastifyReply } from 'fastify';

/**
 * Cancellation means the client went away, and nothing else.
 *
 * The obvious wiring is wrong: `close` on the REQUEST stream fires as soon as the request
 * body has been read, which on a normal POST happens long before the handler answers. That
 * turned every request whose computation took a few tens of milliseconds into a
 * cancellation (measured on a real socket: request close at 1 ms, response close at 57 ms
 * for a 50 ms computation). The response stream is the right one to watch, and even there
 * `close` fires on a normal finish too, so the signal is only raised when the response had
 * not been written out yet.
 *
 * Shared by every bounded computation the server performs on a caller's behalf, so the two
 * routes that can spend engine time cancel by the same rule rather than by two copies of it.
 */
export function cancellationSignal(reply: FastifyReply): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  // The socket may already be gone before the handler starts.
  if (reply.raw.destroyed && !reply.raw.writableEnded) controller.abort();
  reply.raw.on('close', onClose);
  return {
    signal: controller.signal,
    dispose: () => {
      reply.raw.off('close', onClose);
    },
  };
}
