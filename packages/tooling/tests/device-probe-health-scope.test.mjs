import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

const swift = readFileSync(
  fileURLToPath(
    new URL('../../../scripts/fixtures/device-probe/AppDelegate.swift', import.meta.url),
  ),
  'utf8',
);
const driver = readFileSync(
  fileURLToPath(new URL('../../../scripts/probe-device.mjs', import.meta.url)),
  'utf8',
);

it('scopes every HealthKit change observation and deletion to this probe’s tagged source', () => {
  assert.match(swift, /HKQuery\.predicateForObjects\(from: HKSource\.default\(\)\)/);
  assert.match(swift, /withMetadataKey: probeTagKey, allowedValues: \[probeTag\]/);
  assert.match(swift, /HKAnchoredObjectQuery\(\s*type: type, predicate: probeOnly/);
  assert.match(swift, /HKObserverQuery\(sampleType: type, predicate: probeOnly\)/);
  assert.match(swift, /deleteObjects\(of: type, predicate: predicate\)/);
  assert.match(swift, /let predicate = taggedPredicate\(runId: runId\)/);
  assert.match(swift, /probeDeleted = deleted\.filter \{ \(\$0\.metadata\?\[probeTagKey\]/);
  assert.doesNotMatch(swift, /HKObserverQuery\(sampleType: type, predicate: nil\)/);
});

it('keeps cleanup explicit and distinguishes API success from hidden read authorization', () => {
  assert.match(driver, /'cleanup'/);
  assert.match(swift, /case "cleanup": result = await probe\.cleanup\(\)/);
  assert.match(swift, /deleteSynthetic\(runId: run\)/);
  assert.match(swift, /"deleteCallsSucceeded"/);
  assert.match(swift, /"taggedQueryEmpty"/);
  assert.match(swift, /"cleanupCallsSucceeded"/);
  assert.match(swift, /state\.schemaVersion = 2/);
  assert.match(swift, /state\.anchors = \[:\]/);
  assert.match(swift, /state\.outbox = \[\]/);
});
