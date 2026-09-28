import CryptoKit
import Foundation
import HealthKit
import SQLite3

private enum HarnessFailure: Error { case failed(String) }

@MainActor
private func require(_ condition: Bool, _ label: String) throws {
    if !condition { throw HarnessFailure.failed(label) }
}

@MainActor
@main
struct HealthKitWorkoutStateHarness {
    static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("wm-healthkit-state-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = directory.appendingPathComponent("state.sqlite")
        let sampleId = UUID()
        let batchId = UUID()
        let account = "athlete_one"
        var originalBody = Data()
        var installationId = UUID()

        do {
            let state = try HealthKitWorkoutState(databaseURL: database)
            installationId = try state.activate(accountId: account)
            try require(try state.collectionEnabled() == false, "collection off before explicit request")
            try state.requestReconciliation()
            try require(try state.beginReconciliationAfterOutboxDrain(),
                        "initial request begins with a nil snapshot anchor")
            try state.markWakePending()
            try require(try state.wakePending(), "observer wake intent durable")
            let event = HealthKitWorkoutEvent.upsert(HealthKitWorkoutUpsert(
                sampleId: sampleId, sourceBundleId: "com.example.fixture", sourceVersion: nil,
                activityType: 37, observedFrom: "2026-09-20T01:00:00Z", observedTo: "2026-09-20T01:30:00Z",
                durationSeconds: 1800, distanceMeters: nil, energyKilocalories: nil))
            try state.stagePage(batchId: batchId, events: [event], nextAnchor: HKQueryAnchor(fromValue: 1))
            let pending = try state.pendingBatches()
            try require(pending.count == 1, "atomic outbox insert")
            originalBody = pending[0].body
            guard let json = try JSONSerialization.jsonObject(with: originalBody) as? [String: Any],
                  let events = json["events"] as? [[String: Any]], events.count == 1 else {
                throw HarnessFailure.failed("batch JSON shape")
            }
            try require(events[0]["sourceVersion"] is NSNull &&
                        events[0]["distanceMeters"] is NSNull &&
                        events[0]["energyKilocalories"] is NSNull,
                        "unknown metrics and version encoded as null")
            try require((try state.knownSample(sampleId: sampleId))?.sourceBundleId == "com.example.fixture",
                        "known sample mapping")
            try require(try state.anchor() != nil, "durable anchor")
            let firstAnchor = try NSKeyedArchiver.archivedData(withRootObject: state.anchor()!,
                                                              requiringSecureCoding: true)
            do {
                try state.stagePage(batchId: batchId, events: [.delete(sampleId: UUID())],
                                    nextAnchor: HKQueryAnchor(fromValue: 2))
                throw HarnessFailure.failed("duplicate batch accepted")
            } catch HealthKitWorkoutStateError.storageFailure { }
            try require(try state.pendingBatches().count == 1, "duplicate rolled back")
            do {
                try state.acknowledge(batchId: batchId, installationId: installationId, acceptedCount: 0)
                throw HarnessFailure.failed("wrong count ACK accepted")
            } catch HealthKitWorkoutStateError.acknowledgementMismatch { }
            try require(try state.pendingBatches().count == 1, "wrong ACK preserves outbox")
            let largeEvents: [HealthKitWorkoutEvent] = (0..<100).map { _ in
                .upsert(HealthKitWorkoutUpsert(
                    sampleId: UUID(), sourceBundleId: String(repeating: "가", count: 255),
                    sourceVersion: String(repeating: "나", count: 128), activityType: 0,
                    observedFrom: "2026-09-20T01:00:00Z", observedTo: "2026-09-20T01:30:00Z",
                    durationSeconds: 1800, distanceMeters: nil, energyKilocalories: nil))
            }
            do {
                try state.stagePage(batchId: UUID(), events: largeEvents, nextAnchor: HKQueryAnchor(fromValue: 3))
                throw HarnessFailure.failed("oversize batch accepted")
            } catch HealthKitWorkoutStateError.batchTooLarge { }
            try require(try state.pendingBatches().count == 1, "oversize batch did not advance outbox")
            try require(try NSKeyedArchiver.archivedData(withRootObject: state.anchor()!,
                                                         requiringSecureCoding: true) == firstAnchor,
                        "oversize batch did not advance anchor")
            try state.stagePage(batchId: UUID(), events: (0..<100).map { _ in .delete(sampleId: UUID()) },
                                nextAnchor: HKQueryAnchor(fromValue: 3))
            try state.pause(batchId: batchId, reason: .conflict)
            let quarantined = try state.pendingBatches()
            try require(quarantined[0].pauseReason == .conflict && quarantined[0].body == originalBody,
                        "pause retains exact batch")
            try state.pause(batchId: batchId, reason: .rejected)
            try require(try state.pendingBatches()[0].pauseReason == .conflict,
                        "first permanent reason is stable")
        }

        do {
            let restarted = try HealthKitWorkoutState(databaseURL: database)
            try require(try restarted.activate(accountId: account) == installationId,
                        "installation ID stable after restart")
            try require(try restarted.collectionEnabled(), "explicit collection flag survives restart")
            try require(try restarted.wakePending(), "wake intent survives restart")
            try restarted.clearWakePending()
            try require(try restarted.wakePending() == false, "wake intent clears explicitly")
            let pending = try restarted.pendingBatches()
            try require(pending.count == 2 && pending[0].body == originalBody,
                        "restart retries exact first body")
            try require(pending[0].isPaused && pending[0].pauseReason == .conflict,
                        "quarantine survives restart")
            try require(try restarted.acknowledge(batchId: batchId, installationId: installationId,
                                                 acceptedCount: 1), "matched ACK removes batch")
            try require(try restarted.pendingBatches().count == 1, "ACK preserves later batch")
            let later = try restarted.pendingBatches()[0]
            try restarted.pause(batchId: later.batchId, reason: .forbidden)
            try require(try restarted.pendingBatches()[0].pauseReason == .forbidden,
                        "forbidden batch quarantined")
            try restarted.stagePage(batchId: UUID(), events: [.delete(sampleId: sampleId)],
                                    nextAnchor: HKQueryAnchor(fromValue: 4))
            try require(try restarted.knownSample(sampleId: sampleId) == nil,
                        "delete removes known UUID mapping")
            let changedId = try restarted.activate(accountId: "athlete_two")
            try require(changedId != installationId, "owner switch rotates installation")
            try require(try restarted.pendingBatches().isEmpty, "other owner cannot see outbox")
            try require(try restarted.anchor() == nil, "other owner cannot see anchor")
            try require(try restarted.knownSample(sampleId: sampleId) == nil, "other owner cannot see mapping")
            try require(try restarted.collectionEnabled() == false, "other owner cannot see explicit flag")
            try require(try restarted.wakePending() == false, "other owner cannot see wake intent")
            do {
                _ = try restarted.acknowledge(batchId: batchId, installationId: installationId,
                                               acceptedCount: 1)
                throw HarnessFailure.failed("other owner ACKed old installation")
            } catch HealthKitWorkoutStateError.acknowledgementMismatch { }
            restarted.deactivate()
            do {
                _ = try restarted.pendingBatches()
                throw HarnessFailure.failed("logout kept active owner")
            } catch HealthKitWorkoutStateError.inactive { }
            try require(try restarted.activate(accountId: account) == installationId,
                        "same owner resumes original installation after logout")
            try require(try restarted.pendingBatches().count == 2,
                        "same owner resumes paused and deletion batches")
            try require(try restarted.anchor() != nil && restarted.collectionEnabled(),
                        "same owner resumes cursor and request intent")
            _ = try restarted.activate(accountId: "athlete_two")
            try restarted.reset()
            do {
                _ = try restarted.pendingBatches()
                throw HarnessFailure.failed("reset left active owner")
            } catch HealthKitWorkoutStateError.inactive { }
            try require(try restarted.activate(accountId: account) == installationId &&
                        restarted.pendingBatches().count == 2,
                        "other owner's local reset cannot erase retained batches")
        }

        let corruptionDatabase = directory.appendingPathComponent("corruption.sqlite")
        let corruptionBatchId = UUID()
        var corruptionInstallationId = UUID()
        do {
            let state = try HealthKitWorkoutState(databaseURL: corruptionDatabase)
            corruptionInstallationId = try state.activate(accountId: account)
            try state.stagePage(batchId: corruptionBatchId, events: [.delete(sampleId: sampleId)],
                                nextAnchor: HKQueryAnchor(fromValue: 4))
        }
        var raw: OpaquePointer?
        let accountDigest = SHA256.hash(data: Data(account.utf8))
            .map { String(format: "%02x", $0) }.joined()
        let accountDatabase = corruptionDatabase.deletingLastPathComponent()
            .appendingPathComponent("corruption-account-\(accountDigest).sqlite")
        guard sqlite3_open(accountDatabase.path, &raw) == SQLITE_OK, let raw else {
            throw HarnessFailure.failed("unable to open corruption fixture")
        }
        guard sqlite3_exec(raw, "UPDATE pending SET body=x'00'", nil, nil, nil) == SQLITE_OK else {
            sqlite3_close(raw)
            throw HarnessFailure.failed("unable to write corruption fixture")
        }
        sqlite3_close(raw)
        let corrupt = try HealthKitWorkoutState(databaseURL: corruptionDatabase)
        _ = try corrupt.activate(accountId: account)
        do {
            _ = try corrupt.pendingBatches()
            throw HarnessFailure.failed("corrupt outbox was treated as empty/valid")
        } catch HealthKitWorkoutStateError.corruptState { }
        do {
            _ = try corrupt.acknowledge(batchId: corruptionBatchId,
                                        installationId: corruptionInstallationId, acceptedCount: 1)
            throw HarnessFailure.failed("corrupt outbox was acknowledged")
        } catch HealthKitWorkoutStateError.corruptState { }

        let bounded = try HealthKitWorkoutState(databaseURL: directory.appendingPathComponent("bounded.sqlite"))
        _ = try bounded.activate(accountId: account)
        for index in 0..<256 {
            try bounded.stagePage(batchId: UUID(), events: [.delete(sampleId: UUID())],
                                  nextAnchor: HKQueryAnchor(fromValue: index + 1))
        }
        do {
            try bounded.stagePage(batchId: UUID(), events: [.delete(sampleId: UUID())],
                                  nextAnchor: HKQueryAnchor(fromValue: 257))
            throw HarnessFailure.failed("outbox over 256 batches accepted")
        } catch HealthKitWorkoutStateError.outboxFull { }
        try require(try bounded.pendingBatches().count == 256, "outbox cap leaves existing batches intact")

        let reconciliationDB = directory.appendingPathComponent("reconciliation.sqlite")
        let previouslyVisible = UUID()
        let replayBatchId = UUID()
        let replayEvent = HealthKitWorkoutEvent.upsert(HealthKitWorkoutUpsert(
            sampleId: previouslyVisible, sourceBundleId: "com.example.fixture", sourceVersion: nil,
            activityType: 37, observedFrom: "2026-09-20T01:00:00Z", observedTo: "2026-09-20T01:30:00Z",
            durationSeconds: 1800, distanceMeters: nil, energyKilocalories: nil))
        var replayInstallation = UUID()
        var replayBody = Data()
        do {
            let state = try HealthKitWorkoutState(databaseURL: reconciliationDB)
            replayInstallation = try state.activate(accountId: account)
            try state.stagePage(batchId: replayBatchId, events: [replayEvent],
                                nextAnchor: HKQueryAnchor(fromValue: 1))
            replayBody = try state.pendingBatches()[0].body
            try state.requestReconciliation()
            try require(try state.collectionEnabled(), "product retry records request history")
            try require(try state.wakePending(), "product retry keeps durable wake")
            try state.clearWakePending()
            try require(try state.wakePending(),
                        "in-flight empty page cannot erase a newer retry wake")
            try require(try !state.beginReconciliationAfterOutboxDrain(),
                        "offline outbox prevents anchor reset")
            try require(try state.anchor() != nil && state.pendingBatches()[0].body == replayBody,
                        "offline retry preserves cursor and exact request bytes")
        }
        do {
            let state = try HealthKitWorkoutState(databaseURL: reconciliationDB)
            try require(try state.activate(accountId: account) == replayInstallation,
                        "retry survives process restart under the same installation")
            try require(try !state.beginReconciliationAfterOutboxDrain(),
                        "restart still waits for old ACK")
            try require(try state.acknowledge(batchId: replayBatchId,
                                              installationId: replayInstallation, acceptedCount: 1),
                        "old batch gets its exact ACK")
            try require(try state.beginReconciliationAfterOutboxDrain(),
                        "ACK allows atomic cursor reset")
            try require(try state.anchor() == nil && state.knownSample(sampleId: previouslyVisible) == nil,
                        "requery begins at nil without treating missing UUID as deletion")
            try require(try state.wakePending(), "reset keeps wake durable across crash")
        }
        do {
            let state = try HealthKitWorkoutState(databaseURL: reconciliationDB)
            _ = try state.activate(accountId: account)
            try require(try state.anchor() == nil && state.wakePending(),
                        "crash after reset resumes from nil anchor")
            try state.stagePage(batchId: UUID(), events: [replayEvent],
                                nextAnchor: HKQueryAnchor(fromValue: 2))
            let replay = try state.pendingBatches()[0]
            try require(replay.installationId == replayInstallation && replay.body != replayBody,
                        "new snapshot stages a new immutable batch under the same installation")
        }
        do {
            let state = try HealthKitWorkoutState(databaseURL: reconciliationDB)
            _ = try state.activate(accountId: account)
            let replay = try state.pendingBatches()[0]
            try require(try state.anchor() != nil && replay.installationId == replayInstallation,
                        "partial requery restarts from staged cursor with its outbox intact")
            try require(try state.acknowledge(batchId: replay.batchId,
                                              installationId: replayInstallation, acceptedCount: 1),
                        "replayed visible UUID receives an independent ACK")
            try state.advanceEmptyPage(nextAnchor: HKQueryAnchor(fromValue: 3))
            try state.clearWakePending()
            try require(try state.knownSample(sampleId: previouslyVisible) != nil,
                        "empty page cannot synthesize a deletion")
            try state.requestReconciliation()
            try require(try state.beginReconciliationAfterOutboxDrain(),
                        "explicit retry after earlier empty page resets the anchor")
            try require(try state.anchor() == nil,
                        "permission change retry cannot be trapped behind an empty-result anchor")
            try state.stagePage(batchId: UUID(), events: [.delete(sampleId: previouslyVisible)],
                                nextAnchor: HKQueryAnchor(fromValue: 4))
            try require(try state.knownSample(sampleId: previouslyVisible) == nil,
                        "only an explicit deleted UUID removes local mapping")
        }

        let pausedDB = directory.appendingPathComponent("paused-reconciliation.sqlite")
        let paused = try HealthKitWorkoutState(databaseURL: pausedDB)
        let pausedInstallation = try paused.activate(accountId: account)
        let pausedBatchId = UUID()
        try paused.stagePage(batchId: pausedBatchId, events: [replayEvent],
                             nextAnchor: HKQueryAnchor(fromValue: 1))
        try paused.pause(batchId: pausedBatchId, reason: .conflict)
        try paused.requestReconciliation()
        try require(try !paused.beginReconciliationAfterOutboxDrain() && paused.anchor() != nil,
                    "paused batch blocks requery without discarding its anchor")
        try require(try paused.pendingBatches()[0].pauseReason == .conflict &&
                    paused.pendingBatches()[0].installationId == pausedInstallation,
                    "paused original stays quarantined for investigation")
        _ = try paused.activate(accountId: "athlete_two")
        try require(try paused.anchor() == nil && paused.pendingBatches().isEmpty &&
                    !paused.collectionEnabled() && !paused.wakePending() &&
                    !paused.beginReconciliationAfterOutboxDrain(),
                    "other account sees none of prior owner's retry state")
        try require(try paused.activate(accountId: account) == pausedInstallation &&
                    paused.pendingBatches()[0].pauseReason == .conflict &&
                    paused.anchor() != nil && paused.collectionEnabled(),
                    "prior owner's quarantined batch and retry intent survive account switch")

        let deletionDB = directory.appendingPathComponent("offline-deletion.sqlite")
        let deletionBatchId = UUID()
        let deletedId = UUID()
        var deletionInstallation = UUID()
        var deletionBody = Data()
        do {
            let state = try HealthKitWorkoutState(databaseURL: deletionDB)
            deletionInstallation = try state.activate(accountId: account)
            try state.requestReconciliation()
            try state.stagePage(batchId: deletionBatchId, events: [.delete(sampleId: deletedId)],
                                nextAnchor: HKQueryAnchor(fromValue: 1))
            deletionBody = try state.pendingBatches()[0].body
            state.deactivate() // Offline logout must not discard an unsent deletion.
            try require(try state.activate(accountId: "athlete_two") != deletionInstallation &&
                        state.pendingBatches().isEmpty,
                        "second account cannot send first account's queued deletion")
            let secondBatch = UUID()
            try state.stagePage(batchId: secondBatch, events: [.delete(sampleId: UUID())],
                                nextAnchor: HKQueryAnchor(fromValue: 1))
            try require(try state.pendingBatches().count == 1 &&
                        state.pendingBatches()[0].body != deletionBody,
                        "second account stages only its own request body")
        }
        do {
            let restarted = try HealthKitWorkoutState(databaseURL: deletionDB)
            let secondInstallation = try restarted.activate(accountId: "athlete_two")
            try require(try restarted.pendingBatches().count == 1,
                        "second account's outbox survives process restart")
            try require(try restarted.activate(accountId: account) == deletionInstallation,
                        "return to original owner retains installation receipt scope")
            let pending = try restarted.pendingBatches()
            try require(pending.count == 1 && pending[0].batchId == deletionBatchId &&
                        pending[0].body == deletionBody && pending[0].installationId == deletionInstallation,
                        "offline deletion retries exact original bytes under its owner")
            do {
                _ = try restarted.acknowledge(batchId: deletionBatchId,
                                               installationId: secondInstallation, acceptedCount: 1)
                throw HarnessFailure.failed("wrong owner's installation ACKed deletion")
            } catch HealthKitWorkoutStateError.acknowledgementMismatch { }
            try require(try restarted.acknowledge(batchId: deletionBatchId,
                                                  installationId: deletionInstallation, acceptedCount: 1),
                        "correct owner ACK removes queued deletion")
            try require(try restarted.pendingBatches().isEmpty,
                        "ACK only clears original owner's deletion")
            _ = try restarted.activate(accountId: "athlete_two")
            try require(try restarted.pendingBatches().count == 1,
                        "original owner's ACK cannot remove other owner's batch")
        }

        // An app upgraded from the singleton store must retain its old receipt scope.
        let oldBase = directory.appendingPathComponent("legacy-owner.sqlite")
        let oldBatch = UUID()
        var oldInstallation = UUID()
        var oldBody = Data()
        do {
            let newLayout = try HealthKitWorkoutState(databaseURL: oldBase)
            oldInstallation = try newLayout.activate(accountId: account)
            try newLayout.stagePage(batchId: oldBatch, events: [.delete(sampleId: UUID())],
                                    nextAnchor: HKQueryAnchor(fromValue: 1))
            oldBody = try newLayout.pendingBatches()[0].body
        }
        let oldAccountFile = oldBase.deletingLastPathComponent()
            .appendingPathComponent("legacy-owner-account-\(accountDigest).sqlite")
        try FileManager.default.removeItem(at: oldBase)
        try FileManager.default.moveItem(at: oldAccountFile, to: oldBase)
        let upgraded = try HealthKitWorkoutState(databaseURL: oldBase)
        try require(try upgraded.activate(accountId: account) == oldInstallation &&
                    upgraded.pendingBatches()[0].body == oldBody,
                    "upgrade reads the pre-partition owner and exact queued deletion")
        _ = try upgraded.activate(accountId: "athlete_two")
        try require(try upgraded.pendingBatches().isEmpty &&
                    upgraded.activate(accountId: account) == oldInstallation &&
                    upgraded.pendingBatches()[0].body == oldBody,
                    "upgrade switch preserves legacy owner's pending deletion")

        let legacyDB = directory.appendingPathComponent("legacy-reconciliation.sqlite")
        var legacyPointer: OpaquePointer?
        guard sqlite3_open(legacyDB.path, &legacyPointer) == SQLITE_OK, let legacyPointer else {
            throw HarnessFailure.failed("unable to create legacy state fixture")
        }
        guard sqlite3_exec(legacyPointer,
                           "CREATE TABLE collection_control (singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), wake_pending INTEGER NOT NULL DEFAULT 0 CHECK(wake_pending IN (0,1)))",
                           nil, nil, nil) == SQLITE_OK else {
            sqlite3_close(legacyPointer)
            throw HarnessFailure.failed("unable to create legacy control table")
        }
        sqlite3_close(legacyPointer)
        let migrated = try HealthKitWorkoutState(databaseURL: legacyDB)
        _ = try migrated.activate(accountId: account)
        try migrated.requestReconciliation()
        try require(try migrated.beginReconciliationAfterOutboxDrain() && migrated.anchor() == nil,
                    "legacy control table gains durable reconciliation column")

        let replacement = try HealthKitWorkoutState(
            databaseURL: directory.appendingPathComponent("reinstalled-workouts.sqlite"))
        try require(try replacement.activate(accountId: account) != replayInstallation,
                    "new installation rotates its receipt scope")
        try require(try replacement.anchor() == nil && !replacement.collectionEnabled(),
                    "reinstall starts at nil but does not assume OS read permission")

        print("HealthKitWorkoutState harness passed: atomic stage, replay, quarantine, ACK, owner isolation, offline deletion retry, corruption, outbox cap, reinstall/reconciliation")
    }
}
