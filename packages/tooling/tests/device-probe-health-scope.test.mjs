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
const scene = readFileSync(
  fileURLToPath(
    new URL('../../../scripts/fixtures/device-probe/SceneDelegate.swift', import.meta.url),
  ),
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

it('drains anchored pages before durable commit and acknowledges only durable work', () => {
  assert.match(swift, /while true \{[^]*?try await anchored\(/);
  assert.match(swift, /if changeCount < 100 \{ break \}/);
  assert.match(swift, /throw ProbeCollectionError\.stalledAnchor/);
  assert.match(swift, /return \["perType": perType, "persisted": false, "retryQueued": true\]/);
  assert.match(swift, /state\.anchors = anchors[^]*?try ProbeFiles\.save\(state, "state\.json"\)/);
  assert.match(
    swift,
    /if collected\["persisted"\] as\? Bool == true\s*\|\| collected\["retryQueued"\] as\? Bool == true\s*\{\s*completion\(\)/,
  );
  assert.equal((swift.match(/completion\(\)/g) ?? []).length, 1);
  assert.match(swift, /observerRetryPending/);
});

it('persists retry work and revisits it at launch and foreground', () => {
  const collect = swift
    .split('private func collectExclusive(')[1]
    .split('private enum ProbeCollectionError')[0];
  assert.match(
    collect,
    /state\.collectionPending = true[^]*?try ProbeFiles\.save\(state, "state\.json"\)[^]*?await anchored/,
  );
  assert.match(
    collect,
    /state\.collectionPending = false[^]*?try ProbeFiles\.save\(state, "state\.json"\)/,
  );
  assert.match(swift, /func recoverOnActivation\(_ source: String\) async/);
  assert.match(swift, /current\.collectionPending == true \|\| current\.backgroundDeliveryEnabled/);
  assert.match(swift, /recoverOnActivation\("launch"\)/);
  assert.match(scene, /recoverOnActivation\("foreground"\)/);
  assert.match(swift, /for _ in 0\.\.<2 \{[^]*?await self\.collect/);
});

it('blocks deletion on failed precollection and retries incomplete background cleanup', () => {
  const deletion = swift
    .split('func deleteSynthetic(')[1]
    .split('/// Anchored own-source query')[0];
  assert.match(deletion, /guard before\["persisted"\] as\? Bool == true else \{/);
  assert.match(
    deletion,
    /"deletionBlocked"\] = "preDeleteCollectionFailed"[^]*?return result[^]*?store\.deleteObjects/,
  );
  const delivery = swift
    .split('private func setBackgroundDeliveryExclusive(')[1]
    .split('/// Idempotent final cleanup')[0];
  assert.match(
    delivery,
    /state\.backgroundCleanupPending = true[^]*?try ProbeFiles\.save\(state, "state\.json"\)[^]*?store\.(enable|disable)BackgroundDelivery/,
  );
  assert.match(
    delivery,
    /state\.backgroundCleanupPending = enabled \? !succeeded && !rollbackSucceeded : !succeeded/,
  );
  assert.match(
    swift,
    /if state\.backgroundCleanupPending == true \{[^]*?await setBackgroundDelivery\(false\)/,
  );
});
