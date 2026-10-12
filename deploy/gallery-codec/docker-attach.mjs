import { types } from 'node:util';
import { createGalleryCodecOutputFrameDecoder } from './output-frame.mjs';

const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const getBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer').get;
const getSize = Object.getOwnPropertyDescriptor(typedArray, 'byteLength').get;
const getOffset = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset').get;
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const stdoutLimit = 67108864 + 16384 + 8;
const stderrLimit = 65536;
const frameLimit = 65536;
const wireLimit = stdoutLimit + stderrLimit + frameLimit * 8;

export class GalleryCodecAttachError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GalleryCodecAttachError';
    this.code = code;
  }
}
function fail(code) {
  throw new GalleryCodecAttachError(code);
}
function view(raw) {
  if (
    !types.isUint8Array(raw) ||
    types.isProxy(raw) ||
    ![Buffer.prototype, Uint8Array.prototype].includes(Object.getPrototypeOf(raw))
  )
    fail('attach_invalid');
  for (const key of ['buffer', 'byteLength', 'byteOffset', 'length'])
    if (Object.getOwnPropertyDescriptor(raw, key)) fail('attach_invalid');
  if (Object.getOwnPropertySymbols(raw).length) fail('attach_invalid');
  const buffer = getBuffer.call(raw);
  if (
    !(buffer instanceof ArrayBuffer) ||
    types.isSharedArrayBuffer(buffer) ||
    getResizable?.call(buffer)
  )
    fail('attach_invalid');
  const size = getSize.call(raw);
  if (size > wireLimit) fail('attach_budget');
  return new Uint8Array(buffer, getOffset.call(raw), size);
}

/** Docker non-TTY multiplexed stdout/stderr only. The trusted broker authenticates
 * the Engine connection and container before supplying bytes. This decoder grants
 * no process authority and does not establish successful exit or cgroup quiescence. */
export function createGalleryCodecDockerAttachDecoder(expected) {
  let output = createGalleryCodecOutputFrameDecoder(expected);
  const header = Buffer.alloc(8);
  let headerSize = 0;
  let remaining = 0;
  let stream = 0;
  let frames = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let wireBytes = 0;
  let state = 'open';
  function poison(error) {
    state = 'poisoned';
    output = undefined;
    header.fill(0);
    if (error instanceof GalleryCodecAttachError) throw error;
    fail('attach_output_invalid');
  }
  return Object.freeze({
    push(raw) {
      if (state !== 'open') fail('attach_state');
      try {
        const chunk = view(raw);
        wireBytes += chunk.byteLength;
        if (wireBytes > wireLimit) fail('attach_budget');
        let offset = 0;
        while (offset < chunk.byteLength) {
          if (remaining === 0) {
            const count = Math.min(8 - headerSize, chunk.byteLength - offset);
            Uint8Array.prototype.set.call(
              header,
              new Uint8Array(chunk.buffer, chunk.byteOffset + offset, count),
              headerSize,
            );
            offset += count;
            headerSize += count;
            if (headerSize !== 8) continue;
            headerSize = 0;
            if (++frames > frameLimit) fail('attach_budget');
            stream = header[0];
            if ((stream !== 1 && stream !== 2) || header[1] || header[2] || header[3])
              fail('attach_invalid');
            remaining = header.readUInt32BE(4);
            if (stream === 1) {
              stdoutBytes += remaining;
              if (stdoutBytes > stdoutLimit) fail('attach_budget');
            } else {
              stderrBytes += remaining;
              if (stderrBytes > stderrLimit) fail('attach_budget');
            }
            // Empty frames are legal, but count against the finite frame budget.
            if (remaining === 0) continue;
          }
          const count = Math.min(remaining, chunk.byteLength - offset);
          if (stream === 1)
            output.push(new Uint8Array(chunk.buffer, chunk.byteOffset + offset, count));
          // Stderr may contain decoder payloads; never retain, parse or log it.
          offset += count;
          remaining -= count;
        }
      } catch (error) {
        poison(error);
      }
    },
    finish() {
      if (state !== 'open') fail('attach_state');
      try {
        if (headerSize || remaining) fail('attach_partial');
        const result = output.finish();
        state = 'finished';
        output = undefined;
        return Object.freeze({
          result,
          stderrBytes,
          frameCount: frames,
          processingAuthority: 'none',
        });
      } catch (error) {
        poison(error);
      }
    },
  });
}
