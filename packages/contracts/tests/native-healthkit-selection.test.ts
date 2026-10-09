import { describe, expect, it } from 'vitest';
import {
  nativeBridgeCapabilitiesSchema,
  nativeBridgeReplySchema,
  nativeBridgeRequestSchema,
  nativeBridgeHealthKitSelectionStatusSchema,
} from '../src/native-bridge.js';

// M3-02n: native candidate identifiers and raw observations never cross the bridge.
describe('native-only workout selection boundary', () => {
  const status = { state: 'idle', registeredCount: null, selectedCount: 0, resultCount: null };
  const command = { kind: 'command', version: 3, id: 'select_1' };
  const reply = { kind: 'command.result', version: 3, id: 'select_1' };
  it('keeps older v3 hosts valid without claiming selection support', () => {
    const capabilities = nativeBridgeCapabilitiesSchema.parse({
      'app.openSettings': true,
      'healthkit.read': false,
      'healthkit.workouts': true,
      'auth.transport': true,
    });
    expect(capabilities['healthkit.workouts.selection']).toBeUndefined();
  });
  it('allows only an empty selection-open command', () => {
    const method = 'healthkit.workouts.select';
    expect(nativeBridgeRequestSchema.safeParse({ ...command, method, payload: {} }).success).toBe(
      true,
    );
    for (const payload of [
      { sampleIds: ['synthetic'] },
      { url: 'https://other.invalid' },
      { accountId: 'other' },
    ]) {
      expect(nativeBridgeRequestSchema.safeParse({ ...command, method, payload }).success).toBe(
        false,
      );
    }
  });
  it.each(['healthkit.workouts.selectionStatus', 'healthkit.workouts.cancelSelection'])(
    'requires a native lifetime handle for %s',
    (method) => {
      const selectionId = '1b6c48a7-f18e-456a-bcc4-c00072752e80';
      expect(
        nativeBridgeRequestSchema.safeParse({ ...command, method, payload: { selectionId } })
          .success,
      ).toBe(true);
      for (const payload of [
        {},
        { selectionId: 'invalid' },
        { selectionId, sampleIds: [] },
        { selectionId, accountId: 'other' },
      ]) {
        expect(nativeBridgeRequestSchema.safeParse({ ...command, method, payload }).success).toBe(
          false,
        );
      }
    },
  );
  it('distinguishes unverified counts from genuine zero and rejects private data', () => {
    expect(nativeBridgeHealthKitSelectionStatusSchema.parse(status).registeredCount).toBeNull();
    expect(
      nativeBridgeHealthKitSelectionStatusSchema.parse({ ...status, registeredCount: 0 })
        .registeredCount,
    ).toBe(0);
    for (const extra of [
      { sampleIds: [] },
      { claims: [] },
      { candidates: [] },
      { observedFrom: 'private' },
      { error: 'raw provider' },
    ]) {
      expect(
        nativeBridgeHealthKitSelectionStatusSchema.safeParse({ ...status, ...extra }).success,
      ).toBe(false);
    }
    for (const invalid of [
      { selectedCount: 51 },
      { registeredCount: 10001 },
      { resultCount: -1 },
      { state: 'read_granted' },
    ]) {
      expect(
        nativeBridgeHealthKitSelectionStatusSchema.safeParse({ ...status, ...invalid }).success,
      ).toBe(false);
    }
  });
  it('requires method-specific replies and excludes raw candidates from opened replies', () => {
    expect(
      nativeBridgeReplySchema.safeParse({
        ...reply,
        method: 'healthkit.workouts.select',
        status: 'opened',
        selectionId: '1b6c48a7-f18e-456a-bcc4-c00072752e80',
      }).success,
    ).toBe(true);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...reply,
        method: 'healthkit.workouts.select',
        status: 'registered',
      }).success,
    ).toBe(false);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...reply,
        method: 'healthkit.workouts.select',
        status: 'opened',
        selectionId: '1b6c48a7-f18e-456a-bcc4-c00072752e80',
        candidates: [],
      }).success,
    ).toBe(false);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...reply,
        method: 'healthkit.workouts.selectionStatus',
        status,
      }).success,
    ).toBe(true);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...reply,
        method: 'healthkit.workouts.cancelSelection',
        status: 'cancelled',
      }).success,
    ).toBe(true);
  });
});
