import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compile and exercise the exact actor used by the iOS probe with controlled task orderings.
const swift = readFileSync(
  fileURLToPath(new URL('../fixtures/device-probe/AppDelegate.swift', import.meta.url)),
  'utf8',
);
const actor = swift
  .match(/actor ProbeStateGate \{[\s\S]*?\n\}\n\nfunc digest/)?.[0]
  .replace(/\n\nfunc digest$/, '');
assert.ok(actor, 'ProbeStateGate source must be extractable');

const harness = `
import Foundation
${actor}

final class Model {
  var pending = true
  var enabled = false
  var disableCalls = 0
}

@main struct ProbeStateGateCheck {
  static func main() async {
    let gate = ProbeStateGate()
    let model = Model()
    let held = AsyncStream<Void>.makeStream()
    let release = AsyncStream<Void>.makeStream()

    // Explicit enable owns the gate. Recovery must recheck pending after enable commits.
    let enable = Task {
      await gate.withExclusive {
        held.continuation.yield(())
        for await _ in release.stream { break }
        model.pending = false
        model.enabled = true
      }
    }
    for await _ in held.stream { break }
    let staleRecovery = Task {
      await gate.retryPending(
        isPending: { model.pending },
        operation: {
          model.disableCalls += 1
          model.enabled = false
          return "disabled"
        })
    }
    release.continuation.yield(())
    await enable.value
    let skipped = await staleRecovery.value
    precondition(skipped == nil && model.enabled && model.disableCalls == 0,
      "Recovery disabled a newer explicit enable")

    // Recovery owns the gate first. A later explicit enable must win last.
    model.pending = true
    let retryHeld = AsyncStream<Void>.makeStream()
    let retryRelease = AsyncStream<Void>.makeStream()
    let recovery = Task {
      await gate.retryPending(
        isPending: { model.pending },
        operation: {
          retryHeld.continuation.yield(())
          for await _ in retryRelease.stream { break }
          model.disableCalls += 1
          model.pending = false
          model.enabled = false
          return "disabled"
        })
    }
    for await _ in retryHeld.stream { break }
    let laterEnable = Task {
      await gate.withExclusive {
        model.pending = false
        model.enabled = true
      }
    }
    retryRelease.continuation.yield(())
    let performed = await recovery.value
    await laterEnable.value
    precondition(performed == "disabled" && model.enabled && model.disableCalls == 1,
      "Later explicit enable did not win")
    print("PASS: both serialized recovery/enable orderings")
  }
}
`;

const directory = mkdtempSync(join(tmpdir(), 'wm-probe-gate-'));
try {
  const source = join(directory, 'check.swift');
  const executable = join(directory, 'check');
  writeFileSync(source, harness);
  const build = spawnSync(
    'xcrun',
    [
      'swiftc',
      '-parse-as-library',
      '-module-cache-path',
      join(directory, 'cache'),
      '-o',
      executable,
      source,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const run = spawnSync(executable, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /PASS: both serialized recovery\/enable orderings/);
  process.stdout.write(run.stdout);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
