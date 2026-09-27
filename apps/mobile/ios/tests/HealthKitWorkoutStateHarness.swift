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
            try state.enableCollection()
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
            try require(try restarted.pendingBatches().isEmpty, "owner switch purges outbox")
            try require(try restarted.anchor() == nil, "owner switch purges anchor")
            try require(try restarted.knownSample(sampleId: sampleId) == nil, "owner switch purges mapping")
            try require(try restarted.collectionEnabled() == false, "owner switch purges explicit flag")
            try require(try restarted.wakePending() == false, "owner switch purges wake intent")
            try restarted.reset()
            do {
                _ = try restarted.pendingBatches()
                throw HarnessFailure.failed("reset left active owner")
            } catch HealthKitWorkoutStateError.inactive { }
        }

        let corruptionBatchId = UUID()
        var corruptionInstallationId = UUID()
        do {
            let state = try HealthKitWorkoutState(databaseURL: database)
            corruptionInstallationId = try state.activate(accountId: account)
            try state.stagePage(batchId: corruptionBatchId, events: [.delete(sampleId: sampleId)],
                                nextAnchor: HKQueryAnchor(fromValue: 4))
        }
        var raw: OpaquePointer?
        guard sqlite3_open(database.path, &raw) == SQLITE_OK, let raw else {
            throw HarnessFailure.failed("unable to open corruption fixture")
        }
        guard sqlite3_exec(raw, "UPDATE pending SET body=x'00'", nil, nil, nil) == SQLITE_OK else {
            sqlite3_close(raw)
            throw HarnessFailure.failed("unable to write corruption fixture")
        }
        sqlite3_close(raw)
        let corrupt = try HealthKitWorkoutState(databaseURL: database)
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

        print("HealthKitWorkoutState harness passed: atomic stage, replay, quarantine, ACK, owner purge, corruption, outbox cap")
    }
}
