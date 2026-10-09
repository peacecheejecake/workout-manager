import { describe, expect, it } from 'vitest';
import {
  nativeBridgeCapabilitiesSchema,
  nativeBridgeHealthKitManagementStatusSchema,
  nativeBridgeReplySchema,
  nativeBridgeRequestSchema,
} from '../src/native-bridge.js';

const handle = 'c9b21ef4-c38b-4d44-b67e-f9bb77f08061';
const command = { kind: 'command', version: 3, id: 'manage_1' };
const reply = { kind: 'command.result', version: 3, id: 'manage_1' };
const status = {
  state: 'pending_cleanup',
  registeredCount: null,
  selectedCount: 1,
  resultCount: null,
};

describe('native-only individual deregistration boundary', () => {
  it('does not infer management from an older host selection capability', () => {
    const parsed = nativeBridgeCapabilitiesSchema.parse({
      'app.openSettings': true,
      'healthkit.read': false,
      'healthkit.workouts': true,
      'healthkit.workouts.selection': true,
      'auth.transport': true,
    });
    expect(parsed['healthkit.workouts.management']).toBeUndefined();
  });
  it('opens only a native screen and requires its opaque handle for later commands', () => {
    expect(
      nativeBridgeRequestSchema.safeParse({
        ...command,
        method: 'healthkit.workouts.manage',
        payload: {},
      }).success,
    ).toBe(true);
    expect(
      nativeBridgeRequestSchema.safeParse({
        ...command,
        method: 'healthkit.workouts.manage',
        payload: { sampleId: handle },
      }).success,
    ).toBe(false);
    for (const method of [
      'healthkit.workouts.managementStatus',
      'healthkit.workouts.cancelManagement',
    ]) {
      expect(
        nativeBridgeRequestSchema.safeParse({
          ...command,
          method,
          payload: { managementId: handle },
        }).success,
      ).toBe(true);
      for (const payload of [
        {},
        { managementId: 'bad' },
        { managementId: handle, operationId: handle },
        { managementId: handle, accountId: 'other' },
      ]) {
        expect(nativeBridgeRequestSchema.safeParse({ ...command, method, payload }).success).toBe(
          false,
        );
      }
    }
  });
  it('preserves pending cleanup and unknown counts without accepting private facts', () => {
    expect(nativeBridgeHealthKitManagementStatusSchema.parse(status).resultCount).toBeNull();
    expect(
      nativeBridgeHealthKitManagementStatusSchema.parse({
        ...status,
        state: 'released',
        registeredCount: 0,
        resultCount: 1,
      }).registeredCount,
    ).toBe(0);
    for (const fields of [
      { sampleId: handle },
      { claimEpoch: handle },
      { operationId: handle },
      { registeredCount: 10001 },
      { selectedCount: 2 },
      { resultCount: 2 },
      { state: 'deleted_from_healthkit' },
    ]) {
      expect(
        nativeBridgeHealthKitManagementStatusSchema.safeParse({ ...status, ...fields }).success,
      ).toBe(false);
    }
  });
  it('rejects completion counts before release and verified registry', () => {
    expect(
      nativeBridgeHealthKitManagementStatusSchema.safeParse({ ...status, resultCount: 1 }).success,
    ).toBe(false);
    expect(
      nativeBridgeHealthKitManagementStatusSchema.safeParse({
        ...status,
        state: 'released',
        resultCount: 1,
      }).success,
    ).toBe(false);
    expect(
      nativeBridgeHealthKitManagementStatusSchema.safeParse({
        ...status,
        state: 'offline',
        registeredCount: 0,
        resultCount: 1,
      }).success,
    ).toBe(false);
  });
  it('uses method-specific replies and keeps cancellation separate from server release', () => {
    expect(
      nativeBridgeReplySchema.safeParse({
        ...reply,
        method: 'healthkit.workouts.manage',
        status: 'opened',
        managementId: handle,
      }).success,
    ).toBe(true);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...reply,
        method: 'healthkit.workouts.managementStatus',
        status,
      }).success,
    ).toBe(true);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...reply,
        method: 'healthkit.workouts.cancelManagement',
        status: 'cancelled',
      }).success,
    ).toBe(true);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...reply,
        method: 'healthkit.workouts.cancelManagement',
        status: 'released',
      }).success,
    ).toBe(false);
    expect(
      nativeBridgeReplySchema.safeParse({
        ...reply,
        method: 'healthkit.workouts.manage',
        status: 'opened',
        managementId: handle,
        sampleId: handle,
      }).success,
    ).toBe(false);
  });
});
