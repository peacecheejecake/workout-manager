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
  assert.match(swift, /HKAnchoredObjectQuery\(\s*type: type, predicate: predicate/);
  assert.match(swift, /HKObserverQuery\(sampleType: type, predicate: predicate\)/);
  assert.match(swift, /HKQuery\.predicateForObjects\(with: knownUUIDs\)/);
  assert.match(swift, /probeDeleted = deleted\.filter \{ known\.contains\(\$0\.uuid\) \}/);
  assert.doesNotMatch(swift, /deleted\.filter \{ \(\$0\.metadata\?/);
  assert.match(swift, /deleteObjects\(of: type, predicate: predicate\)/);
  assert.match(swift, /let predicate = taggedPredicate\(runId: runId\)/);
  assert.doesNotMatch(swift, /HKObserverQuery\(sampleType: type, predicate: nil\)/);
});

it('keeps cleanup explicit and distinguishes API success from hidden read authorization', () => {
  assert.match(driver, /'cleanup'/);
  assert.match(swift, /case "cleanup": result = await probe\.cleanup\(\)/);
  assert.match(swift, /deleteSynthetic\(runId: run\)/);
  assert.match(swift, /"deleteCallsSucceeded"/);
  assert.match(swift, /"taggedQueryEmpty"/);
  assert.match(swift, /"cleanupCallsSucceeded"/);
  assert.match(swift, /state\.schemaVersion == 1 \|\| state\.schemaVersion == 2/);
  assert.match(swift, /state\.schemaVersion = 3/);
  assert.match(swift, /state\.anchors = \[:\]/);
  assert.match(swift, /state\.outbox = \[\]/);
  assert.match(swift, /state\.migrationHistoryIncomplete = true/);
  assert.match(swift, /state\.taggedSampleUUIDs = tracked/);
  assert.match(swift, /try ProbeFiles\.save\(state, "state\.json"\)/);
});

it('serializes durable state transitions and refreshes observer UUID scope', () => {
  assert.match(swift, /actor ProbeStateGate/);
  assert.match(swift, /private let stateGate = ProbeStateGate\(\)/);
  for (const method of ['rememberTaggedSample', 'collect', 'send', 'setBackgroundDelivery']) {
    assert.match(swift, new RegExp(`func ${method}\\([^]*?await stateGate\\.withExclusive \\{`));
  }
  assert.match(swift, /membershipChanged = membershipChanged \|\| known != originalKnown/);
  assert.match(swift, /if membershipChanged \{ refreshObservers\(\) \}/);
  assert.match(swift, /private func refreshObservers\(\)/);
  assert.match(swift, /store\.stop\(observer\)/);
});

it('drains anchored pages before durable commit and acknowledges only successful collection', () => {
  assert.match(swift, /while true \{[^]*?try await anchored\(/);
  assert.match(swift, /if changeCount < 100 \{ break \}/);
  assert.match(swift, /throw ProbeCollectionError\.stalledAnchor/);
  assert.match(swift, /return \["perType": perType, "persisted": false\]/);
  assert.match(swift, /state\.anchors = anchors[^]*?try ProbeFiles\.save\(state, "state\.json"\)/);
  assert.match(swift, /if collected\["persisted"\] as\? Bool == true \{\s*completion\(\)/);
  assert.equal((swift.match(/completion\(\)/g) ?? []).length, 1);
  assert.match(swift, /observerRetryPending/);
});
