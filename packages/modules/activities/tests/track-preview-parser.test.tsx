import { describe, expect, it, vi } from 'vitest';
import {
  createInlineTrackParser,
  createWorkerTrackParser,
  TrackPreviewError,
  type PreviewWorkerLike,
  type TrackPreviewWorkerRequest,
} from '../src/track-preview-parser.js';
import { normalPreviewFile, requireItem } from './track-preview-fixtures.js';

interface Listeners {
  message: ((event: { data: unknown }) => void)[];
  messageerror: ((event: unknown) => void)[];
  error: ((event: unknown) => void)[];
}

function stubWorker() {
  const listeners: Listeners = { message: [], messageerror: [], error: [] };
  const sent: TrackPreviewWorkerRequest[] = [];
  const terminate = vi.fn();
  const worker: PreviewWorkerLike = {
    postMessage(message) {
      sent.push(message);
    },
    terminate,
    addEventListener(type: 'message' | 'messageerror' | 'error', listener: never) {
      listeners[type].push(listener);
    },
  } as PreviewWorkerLike;
  return {
    worker,
    sent,
    terminate,
    emit(data: unknown) {
      for (const listener of listeners.message) listener({ data });
    },
    emitError() {
      for (const listener of listeners.error) listener(new Error('worker crashed'));
    },
  };
}

const code = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
    return 'resolved';
  } catch (error) {
    return error instanceof TrackPreviewError ? error.code : `unexpected:${String(error)}`;
  }
};

describe('track preview parser port', () => {
  it('sends the bytes, not the filename, and returns a contract-valid file', async () => {
    const stub = stubWorker();
    const parser = createWorkerTrackParser({ createWorker: () => stub.worker });
    const controller = new AbortController();
    const promise = parser.parse(
      { bytes: new Uint8Array([1, 2, 3]), filename: 'notes.txt' },
      controller.signal,
    );
    expect(requireItem(stub.sent, 0).bytes).toEqual(new Uint8Array([1, 2, 3]));
    const file = normalPreviewFile();
    stub.emit({ kind: 'parsed', requestId: requireItem(stub.sent, 0).requestId, file });
    await expect(promise).resolves.toMatchObject({ fileSha256: file.fileSha256 });
    // One worker per parse, always terminated: its heap does not outlive the request.
    expect(stub.terminate).toHaveBeenCalledTimes(1);
  });

  it('refuses a reply that does not satisfy the parsed-file contract', async () => {
    const stub = stubWorker();
    const parser = createWorkerTrackParser({ createWorker: () => stub.worker });
    const promise = parser.parse(
      { bytes: new Uint8Array([1]), filename: null },
      new AbortController().signal,
    );
    stub.emit({
      kind: 'parsed',
      requestId: requireItem(stub.sent, 0).requestId,
      file: { recorded: [] },
    });
    expect(await code(promise)).toBe('PREVIEW_REPLY_INVALID');
    expect(stub.terminate).toHaveBeenCalledTimes(1);
  });

  it('ignores a reply addressed to another request', async () => {
    const stub = stubWorker();
    const parser = createWorkerTrackParser({ createWorker: () => stub.worker });
    const promise = parser.parse(
      { bytes: new Uint8Array([1]), filename: null },
      new AbortController().signal,
    );
    stub.emit({ kind: 'parsed', requestId: 'preview-999', file: normalPreviewFile() });
    expect(stub.terminate).not.toHaveBeenCalled();
    stub.emit({
      kind: 'parsed',
      requestId: requireItem(stub.sent, 0).requestId,
      file: normalPreviewFile(),
    });
    await expect(promise).resolves.toBeDefined();
  });

  it('passes a parser failure code through without a message', async () => {
    const stub = stubWorker();
    const parser = createWorkerTrackParser({ createWorker: () => stub.worker });
    const promise = parser.parse(
      { bytes: new Uint8Array([1]), filename: null },
      new AbortController().signal,
    );
    stub.emit({
      kind: 'failed',
      requestId: requireItem(stub.sent, 0).requestId,
      code: 'TRACK_ARCHIVE_REJECTED',
    });
    expect(await code(promise)).toBe('TRACK_ARCHIVE_REJECTED');
  });

  it('terminates the worker when the caller cancels', async () => {
    const stub = stubWorker();
    const parser = createWorkerTrackParser({ createWorker: () => stub.worker });
    const controller = new AbortController();
    const promise = parser.parse({ bytes: new Uint8Array([1]), filename: null }, controller.signal);
    controller.abort();
    expect(await code(promise)).toBe('PREVIEW_CANCELLED');
    expect(stub.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates the worker when the deadline passes, without waiting for it to answer', async () => {
    vi.useFakeTimers();
    try {
      const stub = stubWorker();
      const parser = createWorkerTrackParser({
        createWorker: () => stub.worker,
        timeoutMs: 1_000,
      });
      const promise = parser.parse(
        { bytes: new Uint8Array([1]), filename: null },
        new AbortController().signal,
      );
      vi.advanceTimersByTime(1_000);
      expect(await code(promise)).toBe('PREVIEW_TIMEOUT');
      expect(stub.terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an unavailable parser when the worker cannot be created', async () => {
    const parser = createWorkerTrackParser({
      createWorker: () => {
        throw new Error('no worker');
      },
    });
    expect(
      await code(
        parser.parse({ bytes: new Uint8Array([1]), filename: null }, new AbortController().signal),
      ),
    ).toBe('PREVIEW_PARSER_UNAVAILABLE');
  });

  it('reports a worker crash as its own failure', async () => {
    const stub = stubWorker();
    const parser = createWorkerTrackParser({ createWorker: () => stub.worker });
    const promise = parser.parse(
      { bytes: new Uint8Array([1]), filename: null },
      new AbortController().signal,
    );
    stub.emitError();
    expect(await code(promise)).toBe('PREVIEW_WORKER_FAILED');
    expect(stub.terminate).toHaveBeenCalledTimes(1);
  });

  it('validates an inline parser result and surfaces its error code', async () => {
    const good = createInlineTrackParser(() => normalPreviewFile());
    await expect(
      good.parse({ bytes: new Uint8Array([1]), filename: null }, new AbortController().signal),
    ).resolves.toBeDefined();

    const bad = createInlineTrackParser(() => ({ nope: true }));
    expect(
      await code(
        bad.parse({ bytes: new Uint8Array([1]), filename: null }, new AbortController().signal),
      ),
    ).toBe('PREVIEW_REPLY_INVALID');

    const failing = createInlineTrackParser(() => {
      throw Object.assign(new Error('TRACK_FIT_INVALID'), { code: 'TRACK_FIT_INVALID' });
    });
    expect(
      await code(
        failing.parse({ bytes: new Uint8Array([1]), filename: null }, new AbortController().signal),
      ),
    ).toBe('TRACK_FIT_INVALID');
  });
});
