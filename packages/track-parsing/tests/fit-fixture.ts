/** Synthetic FIT bytes. No personal or provider data, and no real device output. */
import { fitCrc } from '../src/fit';

export const FIT_EPOCH_MILLISECONDS = 631_065_600_000;
export const SEMICIRCLE = 180 / 2 ** 31;

export const degreesToSemicircles = (degrees: number): number => Math.round(degrees / SEMICIRCLE);
export const fitSeconds = (iso: string): number =>
  (Date.parse(iso) - FIT_EPOCH_MILLISECONDS) / 1000;

export interface FitField {
  readonly number: number;
  readonly baseType: number;
  /** `null` writes the base type's invalid sentinel. */
  readonly value: number | null;
}

const SIZES = new Map([
  [0x00, 1],
  [0x02, 1],
  [0x84, 2],
  [0x85, 4],
  [0x86, 4],
]);
const INVALID = new Map([
  [0x00, 0xff],
  [0x02, 0xff],
  [0x84, 0xffff],
  [0x85, 0x7fffffff],
  [0x86, 0xffffffff],
]);

export function fitMessage(globalNumber: number, fields: readonly FitField[]): Uint8Array {
  const definition: number[] = [0x40, 0, 0, globalNumber & 0xff, globalNumber >> 8, fields.length];
  const data: number[] = [0x00];
  for (const field of fields) {
    const size = SIZES.get(field.baseType) ?? 1;
    definition.push(field.number, size, field.baseType);
    const raw = field.value ?? INVALID.get(field.baseType) ?? 0;
    const buffer = new DataView(new ArrayBuffer(size));
    if (size === 1) buffer.setUint8(0, raw & 0xff);
    else if (size === 2) buffer.setUint16(0, raw & 0xffff, true);
    else if (field.baseType === 0x85) buffer.setInt32(0, raw, true);
    else buffer.setUint32(0, raw >>> 0, true);
    data.push(...new Uint8Array(buffer.buffer));
  }
  return new Uint8Array([...definition, ...data]);
}

export function fitFile(
  messages: readonly Uint8Array[],
  options: {
    readonly corruptFileCrc?: boolean;
    readonly corruptHeaderCrc?: boolean;
    /** Writes a zero trailer, the "omitted CRC" shape a forger would try. */
    readonly zeroFileCrc?: boolean;
  } = {},
): Uint8Array {
  const body = messages.reduce<number[]>((all, message) => [...all, ...message], []);
  const header = new Uint8Array(14);
  const view = new DataView(header.buffer);
  view.setUint8(0, 14);
  view.setUint8(1, 0x10);
  view.setUint16(2, 100, true);
  view.setUint32(4, body.length, true);
  header.set([0x2e, 0x46, 0x49, 0x54], 8);
  view.setUint16(12, fitCrc(header.subarray(0, 12)) ^ (options.corruptHeaderCrc ? 1 : 0), true);
  const content = new Uint8Array([...header, ...body]);
  const trailer = new Uint8Array(2);
  new DataView(trailer.buffer).setUint16(
    0,
    options.zeroFileCrc ? 0 : fitCrc(content) ^ (options.corruptFileCrc ? 1 : 0),
    true,
  );
  return new Uint8Array([...content, ...trailer]);
}

export interface RecordFixture {
  readonly at: string;
  readonly longitude?: number | null;
  readonly latitude?: number | null;
  readonly heartRate?: number | null;
  readonly distanceMeters?: number | null;
}

export function recordMessage(record: RecordFixture): Uint8Array {
  return fitMessage(20, [
    { number: 253, baseType: 0x86, value: fitSeconds(record.at) },
    {
      number: 0,
      baseType: 0x85,
      value:
        record.latitude === undefined || record.latitude === null
          ? null
          : degreesToSemicircles(record.latitude),
    },
    {
      number: 1,
      baseType: 0x85,
      value:
        record.longitude === undefined || record.longitude === null
          ? null
          : degreesToSemicircles(record.longitude),
    },
    { number: 3, baseType: 0x02, value: record.heartRate ?? null },
    {
      number: 5,
      baseType: 0x86,
      value:
        record.distanceMeters === undefined || record.distanceMeters === null
          ? null
          : Math.round(record.distanceMeters * 100),
    },
  ]);
}

export function sessionMessage(options: {
  readonly startedAt?: string;
  readonly elapsedSeconds?: number;
  readonly distanceMeters?: number | null;
}): Uint8Array {
  return fitMessage(18, [
    {
      number: 2,
      baseType: 0x86,
      value: options.startedAt === undefined ? null : fitSeconds(options.startedAt),
    },
    {
      number: 7,
      baseType: 0x86,
      value:
        options.elapsedSeconds === undefined ? null : Math.round(options.elapsedSeconds * 1000),
    },
    {
      number: 9,
      baseType: 0x86,
      value:
        options.distanceMeters === undefined || options.distanceMeters === null
          ? null
          : Math.round(options.distanceMeters * 100),
    },
  ]);
}

/** `eventType` follows FIT event_type: 1 stop, 4 stop_all, 8/9 stop_disable variants. */
export function timerStopMessage(at: string, eventType = 4): Uint8Array {
  return fitMessage(21, [
    { number: 253, baseType: 0x86, value: fitSeconds(at) },
    { number: 0, baseType: 0x00, value: 0 },
    { number: 1, baseType: 0x00, value: eventType },
  ]);
}

/** A data message with a compressed-timestamp header (bit 7 set) and no field 253. */
export function compressedRecordMessage(offset: number): Uint8Array {
  const definition = new Uint8Array([0x40, 0, 0, 20, 0, 1, 3, 1, 0x02]);
  return new Uint8Array([...definition, 0x80 | (offset & 0x1f), 120]);
}

export function lapMessage(startedAt: string, elapsedSeconds: number): Uint8Array {
  return fitMessage(19, [
    { number: 2, baseType: 0x86, value: fitSeconds(startedAt) },
    { number: 7, baseType: 0x86, value: Math.round(elapsedSeconds * 1000) },
  ]);
}
