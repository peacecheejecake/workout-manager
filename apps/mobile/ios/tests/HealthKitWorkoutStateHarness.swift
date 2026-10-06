import CryptoKit
import Foundation
import HealthKit
import SQLite3

private enum HarnessFailure: Error { case failed(String) }

/// Synthetic UUIDs only. These tests never request HealthKit or touch the system health store.
@MainActor
@main
struct HealthKitWorkoutStateHarness {
    private static var checks = 0
    static func require(_ condition: Bool, _ label: String) throws {
        checks += 1
        if !condition { throw HarnessFailure.failed(label) }
    }
    static func denied(_ label: String, expected: HealthKitWorkoutStateError = .registrationRequired, _ action: () throws -> Void) throws {
        do { try action() } catch let error as HealthKitWorkoutStateError {
            guard error == expected else { throw HarnessFailure.failed(label + ": wrong error category") }
            checks += 1
            return
        }
        throw HarnessFailure.failed(label)
    }
    static func register(
        _ state: HealthKitWorkoutState, _ account: String,
        _ claims: [HealthKitWorkoutClaim], revision: Int = 1, consent: Int = 1
    ) throws -> String {
        try state.applyRegisteredSnapshot(
            .init(registryRevision: revision, claims: claims), accountId: account,
            consentRevision: consent)
        return try state.registeredScopes().first?.key ?? "empty"
    }
    static func archived(_ anchor: HKQueryAnchor?) throws -> Data? {
        guard let anchor else { return nil }
        return try NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true)
    }
    static func reconciliationSequences(_ directory: URL) throws {
        let account = "synthetic_reconcile_a"
        let other = "synthetic_reconcile_b"
        let x = HealthKitWorkoutClaim(sampleId: UUID(), claimEpoch: UUID())
        let y = HealthKitWorkoutClaim(sampleId: UUID(), claimEpoch: UUID())
        func upsert(_ claim: HealthKitWorkoutClaim) -> HealthKitWorkoutEvent {
            .upsert(
                .init(
                    sampleId: claim.sampleId, sourceBundleId: "synthetic.fixture",
                    sourceVersion: nil,
                    activityType: 37, observedFrom: "2026-09-20T01:00:00Z",
                    observedTo: "2026-09-20T01:30:00Z",
                    durationSeconds: 1800, distanceMeters: nil, energyKilocalories: nil))
        }
        let url = directory.appendingPathComponent("reconcile.sqlite")
        let state = try HealthKitWorkoutState(databaseURL: url)
        let installation = try state.activate(accountId: account)
        try state.applyConsentRevision(1)
        let scope = try register(state, account, [x, y])
        try state.requestReconciliation()
        _ = try state.beginReconciliationAfterOutboxDrain()
        let staleId = UUID()
        let mixedId = UUID()
        let validId = UUID()
        try state.stagePage(
            batchId: staleId, events: [upsert(x)], nextAnchor: HKQueryAnchor(fromValue: 1),
            scopeKey: scope)
        try state.stagePage(
            batchId: mixedId, events: [upsert(x), .delete(sampleId: y.sampleId)],
            nextAnchor: HKQueryAnchor(fromValue: 2), scopeKey: scope)
        try state.stagePage(
            batchId: validId, events: [upsert(y)], nextAnchor: HKQueryAnchor(fromValue: 3),
            scopeKey: scope)
        let original = try state.pendingBatches()
        state.invalidateRegistrationVerification()
        try require(
            try state.pendingBatches().map(\.body) == original.map(\.body)
                && !state.batchMayUpload(original[0]),
            "offline preserves uncertain ACK bytes and fences upload")
        _ = try state.activate(accountId: other)
        try state.applyConsentRevision(1)
        _ = try register(state, other, [], revision: 2)
        try require(
            try state.pendingBatches().isEmpty,
            "other account snapshot cannot read/reconcile owner queue"
        )
        _ = try state.activate(accountId: account)
        try require(
            try state.pendingBatches().map(\.body) == original.map(\.body),
            "A B A retains offline queue until authenticated A snapshot")
        try denied("foreign snapshot cannot clean queue", expected: .invalidInput) {
            _ = try register(state, other, [y], revision: 2)
        }
        try denied("wrong consent cannot clean queue", expected: .invalidInput) {
            _ = try register(state, account, [y], revision: 2, consent: 2)
        }
        try denied("same revision removal cannot clean queue", expected: .corruptState) {
            _ = try register(state, account, [y])
        }
        try require(
            try state.pendingBatches().map(\.body) == original.map(\.body)
                && state.registeredClaims().count == 2 && !state.batchMayUpload(original[0]),
            "invalid snapshots preserve registry/queue and disable verification")
        // A failing second write must roll back the preceding stale-batch deletion as well.
        let digest = SHA256.hash(data: Data(account.utf8)).map { String(format: "%02x", $0) }
            .joined()
        var pointer: OpaquePointer?
        let scopedURL = directory.appendingPathComponent("reconcile-account-\(digest).sqlite")
        guard sqlite3_open(scopedURL.path, &pointer) == SQLITE_OK, let pointer else {
            throw HarnessFailure.failed("reconcile fixture open")
        }
        defer { sqlite3_close(pointer) }
        guard
            sqlite3_exec(
                pointer,
                "CREATE TRIGGER fail_pending_update BEFORE UPDATE ON pending BEGIN SELECT RAISE(ABORT,'synthetic'); END",
                nil, nil, nil) == SQLITE_OK
        else { throw HarnessFailure.failed("failure fixture trigger") }
        try denied("partial write rolls back", expected: .storageFailure) {
            _ = try register(state, account, [y], revision: 2)
        }
        try require(
            try state.pendingBatches().map(\.body) == original.map(\.body)
                && state.registeredClaims().count == 2 && !state.batchMayUpload(original[0]),
            "failed reconciliation atomic and fail closed")
        guard sqlite3_exec(pointer, "DROP TRIGGER fail_pending_update", nil, nil, nil) == SQLITE_OK
        else { throw HarnessFailure.failed("remove failure fixture") }
        let yScope = try register(state, account, [y], revision: 2)
        let reconciled = try state.pendingBatches()
        try require(
            reconciled.count == 2 && reconciled[0].batchId != mixedId
                && reconciled[0].batchId != staleId
                && reconciled[0].eventCount == 1,
            "stale removed and mixed assigned new key at original queue position")
        guard
            let oldJSON = try JSONSerialization.jsonObject(with: original[1].body)
                as? [String: Any],
            let newJSON = try JSONSerialization.jsonObject(with: reconciled[0].body)
                as? [String: Any],
            let oldEvents = oldJSON["events"] as? [[String: Any]],
            let newEvents = newJSON["events"] as? [[String: Any]], newEvents.count == 1
        else { throw HarnessFailure.failed("mixed replacement shape") }
        try require(
            NSDictionary(dictionary: oldEvents[1]) == NSDictionary(dictionary: newEvents[0])
                && newEvents[0]["kind"] as? String == "delete",
            "valid tombstone exact fields retained")
        try require(
            reconciled[1].batchId == validId && reconciled[1].body == original[2].body
                && reconciled[0].body != original[1].body,
            "valid immutable retry preserved after replacement ordering")
        try require(
            try reconciled.allSatisfy { try state.batchMayUpload($0) }
                && state.anchor(scopeKey: yScope) == nil
                && state.knownSample(sampleId: x.sampleId) == nil,
            "remaining owner queue drains with fresh predicate anchor")
        try require(
            try !state.acknowledge(
                batchId: mixedId, installationId: installation, acceptedCount: 2),
            "late old ACK cannot delete replacement")
        let restarted = try HealthKitWorkoutState(databaseURL: url)
        _ = try restarted.activate(accountId: account)
        try require(
            try restarted.pendingBatches().map(\.body) == reconciled.map(\.body)
                && !restarted.batchMayUpload(reconciled[0]),
            "restart preserves replacement stable key/body but requires new server snapshot")
        _ = try register(restarted, account, [y], revision: 2)
        try require(
            try restarted.pendingBatches().map(\.body) == reconciled.map(\.body),
            "same fresh snapshot never remints replacement key")
        for batch in reconciled {
            try require(
                try restarted.acknowledge(
                    batchId: batch.batchId, installationId: installation,
                    acceptedCount: batch.eventCount),
                "remaining valid exact ACK")
        }
        try restarted.stagePage(
            batchId: UUID(), events: [upsert(y)], nextAnchor: HKQueryAnchor(fromValue: 4),
            scopeKey: yScope)
        try require(
            try restarted.pendingBatches().count == 1
                && restarted.batchMayUpload(restarted.pendingBatches()[0]),
            "remaining Y collects and uploads after stale X removal")
        let newY = HealthKitWorkoutClaim(sampleId: y.sampleId, claimEpoch: UUID())
        _ = try register(restarted, account, [newY], revision: 3)
        try require(
            try restarted.pendingBatches().isEmpty,
            "old epoch data removed rather than reassigned to new registration")
        try denied("backwards list cannot restore old epoch", expected: .corruptState) {
            _ = try register(restarted, account, [y], revision: 2)
        }
        _ = try register(restarted, account, [newY], revision: 3)
        let pausedScope = try register(restarted, account, [x, newY], revision: 4)
        let pausedId = UUID()
        try restarted.stagePage(
            batchId: pausedId, events: [upsert(x), .delete(sampleId: newY.sampleId)],
            nextAnchor: HKQueryAnchor(fromValue: 5), scopeKey: pausedScope)
        try restarted.pause(batchId: pausedId, reason: .conflict)
        _ = try register(restarted, account, [newY], revision: 5)
        let paused = try restarted.pendingBatches()[0]
        try require(
            try paused.batchId != pausedId && paused.pauseReason == .conflict
                && !restarted.batchMayUpload(paused),
            "mixed permanent rejection stays fail closed after stale cleanup")
        _ = try register(restarted, account, [], revision: 6)
        try require(
            try restarted.pendingBatches().isEmpty && restarted.registeredScopes().isEmpty,
            "fully removed claims release stale paused payload with no collection")
    }

    static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "wm-registered-state-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try reconciliationSequences(directory)
        let db = directory.appendingPathComponent("state.sqlite")
        let account = "synthetic_owner_a"
        let other = "synthetic_owner_b"
        let claims = (0..<100).map { _ in HealthKitWorkoutClaim(sampleId: UUID(), claimEpoch: UUID()) }
        let first = claims[0]
        let state = try HealthKitWorkoutState(databaseURL: db)
        let installation = try state.activate(accountId: account)
        try state.applyConsentRevision(1)
        try require(try !state.collectionEnabled(), "explicit action required")
        try denied("no registry query") { _ = try state.registeredScopes() }
        try denied("no registry stage") {
            try state.stagePage(
                batchId: UUID(), events: [.delete(sampleId: first.sampleId)],
                nextAnchor: HKQueryAnchor(fromValue: 1), scopeKey: "unverified")
        }
        let scope = try register(state, account, claims)
        try require(
            try state.registeredClaims().count == 100 && state.registeredScopes().count == 1,
            "complete snapshot yields one bounded scope")
        try state.requestReconciliation()
        try require(try state.beginReconciliationAfterOutboxDrain(), "initial reconciliation")
        let upsert = HealthKitWorkoutEvent.upsert(
            .init(
                sampleId: first.sampleId, sourceBundleId: "synthetic.fixture", sourceVersion: nil,
                activityType: 37, observedFrom: "2026-09-20T01:00:00Z", observedTo: "2026-09-20T01:30:00Z",
                durationSeconds: 1800, distanceMeters: nil, energyKilocalories: nil))
        let batchId = UUID()
        try state.stagePage(
            batchId: batchId, events: [upsert], nextAnchor: HKQueryAnchor(fromValue: 1), scopeKey: scope)
        let batch = try state.pendingBatches()[0]
        try require(try state.batchMayUpload(batch), "registered epoch upload eligible")
        guard let object = try JSONSerialization.jsonObject(with: batch.body) as? [String: Any],
            let events = object["events"] as? [[String: Any]], let event = events.first
        else { throw HarnessFailure.failed("v2 fixture shape") }
        try require(
            object["schemaVersion"] as? Int == 2
                && event["claimEpoch"] as? String == first.claimEpoch.uuidString.lowercased(),
            "v2 epoch exact")
        try require(
            event["sourceVersion"] is NSNull && event["distanceMeters"] is NSNull
                && event["energyKilocalories"] is NSNull, "unknowns stay null")
        try require(
            try state.knownSample(sampleId: first.sampleId)?.sourceBundleId == "synthetic.fixture",
            "known sample")
        let anchor = try archived(state.anchor(scopeKey: scope))
        try denied("foreign sample rejected") {
            try state.stagePage(
                batchId: UUID(), events: [.delete(sampleId: UUID())],
                nextAnchor: HKQueryAnchor(fromValue: 2), scopeKey: scope)
        }
        try denied("foreign scope rejected") {
            try state.advanceEmptyPage(nextAnchor: HKQueryAnchor(fromValue: 2), scopeKey: "foreign")
        }
        try denied("duplicate batch rejected", expected: .storageFailure) {
            try state.stagePage(
                batchId: batchId, events: [.delete(sampleId: first.sampleId)],
                nextAnchor: HKQueryAnchor(fromValue: 2), scopeKey: scope)
        }
        try denied("wrong ACK count rejected", expected: .acknowledgementMismatch) {
            _ = try state.acknowledge(batchId: batchId, installationId: installation, acceptedCount: 0)
        }
        try require(
            try state.pendingBatches().count == 1 && archived(state.anchor(scopeKey: scope)) == anchor,
            "failed commands atomic")
        let large = claims.map { c in
            HealthKitWorkoutEvent.upsert(
                .init(
                    sampleId: c.sampleId, sourceBundleId: String(repeating: "가", count: 255),
                    sourceVersion: String(repeating: "나", count: 128), activityType: 0,
                    observedFrom: "2026-09-20T01:00:00Z", observedTo: "2026-09-20T01:30:00Z",
                    durationSeconds: 1800, distanceMeters: nil, energyKilocalories: nil))
        }
        try denied("wire bound rejected", expected: .batchTooLarge) {
            try state.stagePage(
                batchId: UUID(), events: large, nextAnchor: HKQueryAnchor(fromValue: 2), scopeKey: scope)
        }
        try require(
            try state.pendingBatches().count == 1 && archived(state.anchor(scopeKey: scope)) == anchor,
            "oversize preserves cursor/outbox")
        state.invalidateRegistrationVerification()
        try require(try !state.batchMayUpload(batch), "offline or failed list disables upload")
        try denied("offline query disabled") { _ = try state.anchor(scopeKey: scope) }
        try require(
            try state.pendingBatches()[0].body == batch.body
                && state.registeredClaims()
                    == claims.sorted { $0.sampleId.uuidString < $1.sampleId.uuidString },
            "verification failure preserves snapshot/body")
        _ = try register(state, account, claims)
        try require(
            try state.batchMayUpload(batch) && archived(state.anchor(scopeKey: scope)) == anchor,
            "fresh same snapshot restores exact retry/cursor")
        try denied("same revision mutation rejected", expected: .corruptState) { _ = try register(state, account, [first]) }
        try require(
            try !state.batchMayUpload(batch) && state.pendingBatches()[0].body == batch.body,
            "invalid snapshot fail closed without swap")
        _ = try register(state, account, claims)
        try state.pause(batchId: batchId, reason: .conflict)
        try state.pause(batchId: batchId, reason: .rejected)
        try require(
            try state.pendingBatches()[0].pauseReason == .conflict
                && !state.batchMayUpload(state.pendingBatches()[0]), "first permanent reason preserved")
        try state.requestReconciliation()
        try state.clearWakePending()
        try require(
            try state.wakePending() && !state.beginReconciliationAfterOutboxDrain(),
            "pending retry wake cannot be cleared, paused outbox blocks reset")
        let secondInstallation = try state.activate(accountId: other)
        try require(
            secondInstallation != installation && state.pendingBatches().isEmpty
                && !state.collectionEnabled(), "account partition isolation")
        try denied("account switch drops freshness") { _ = try state.registeredScopes() }
        try denied("other account ACK rejected", expected: .acknowledgementMismatch) {
            _ = try state.acknowledge(batchId: batchId, installationId: installation, acceptedCount: 1)
        }
        try state.reset()
        try require(
            try state.activate(accountId: account) == installation
                && state.pendingBatches()[0].body == batch.body, "other reset preserves original data")
        _ = try register(state, account, claims)
        try require(
            try state.acknowledge(batchId: batchId, installationId: installation, acceptedCount: 1),
            "exact ACK")
        try require(
            try state.beginReconciliationAfterOutboxDrain() && state.anchor(scopeKey: scope) == nil
                && state.knownSample(sampleId: first.sampleId) == nil,
            "drained reconciliation resets scoped cursor only")
        try state.stagePage(
            batchId: UUID(), events: [upsert], nextAnchor: HKQueryAnchor(fromValue: 2), scopeKey: scope)
        let pending = try state.pendingBatches()[0]
        let restarted = try HealthKitWorkoutState(databaseURL: db)
        try require(
            try restarted.activate(accountId: account) == installation
                && restarted.pendingBatches()[0].body == pending.body, "restart exact body")
        try require(
            try !restarted.batchMayUpload(pending), "persisted registry is not fresh after restart")
        _ = try register(restarted, account, claims)
        try require(
            try restarted.batchMayUpload(pending) && restarted.anchor(scopeKey: scope) != nil,
            "restart full list revalidates")
        let replacementClaim = HealthKitWorkoutClaim(sampleId: first.sampleId, claimEpoch: UUID())
        let changed = claims.map { $0.sampleId == first.sampleId ? replacementClaim : $0 }
        let changedScope = try register(restarted, account, changed, revision: 2)
        try require(
            changedScope != scope && restarted.anchor(scopeKey: changedScope) == nil
                && !restarted.batchMayUpload(pending), "re-registration resets anchor and fences old epoch")
        try require(
            try restarted.pendingBatches().isEmpty, "stale epoch payload retired without rewriting old key")
        try denied("backwards revision rejected", expected: .corruptState) {
            _ = try register(restarted, account, claims, revision: 1)
        }
        _ = try register(restarted, account, changed, revision: 2)
        try require(
            try restarted.applyConsentRevision(3) && restarted.pendingBatches().isEmpty
                && restarted.registeredClaims().isEmpty && restarted.collectionEnabled(),
            "server consent rotation erases stale local data while preserving intent")
        try denied("consent rotation requires fresh list") { _ = try restarted.registeredScopes() }
        let newScope = try register(restarted, account, [replacementClaim], revision: 3, consent: 3)
        try restarted.stagePage(
            batchId: UUID(), events: [.delete(sampleId: first.sampleId)],
            nextAnchor: HKQueryAnchor(fromValue: 3), scopeKey: newScope)
        let deletion = try restarted.pendingBatches()[0]
        try require(
            deletion.installationId != installation && deletion.consentRevision == 3,
            "consent epoch rotates installation")
        try require(
            try restarted.knownSample(sampleId: first.sampleId) == nil, "explicit deletion mapping")
        try require(
            try !restarted.applyConsentRevision(3) && restarted.pendingBatches()[0].body == deletion.body,
            "same consent retains immutable delete retry")
        restarted.deactivate()
        try denied("logout inactive", expected: .inactive) { _ = try restarted.pendingBatches() }
        _ = try restarted.activate(accountId: account)
        try require(
            try restarted.pendingBatches()[0].body == deletion.body
                && !restarted.batchMayUpload(deletion), "offline deletion preserved but not uploaded")
        _ = try register(restarted, account, [replacementClaim], revision: 3, consent: 3)
        try require(try restarted.batchMayUpload(deletion), "original owner fresh deletion retry")
        try require(
            try restarted.applyConsentRevision(3, forceReset: true) && restarted.pendingBatches().isEmpty,
            "explicit server expired epoch reset")
        let freshInstall = try restarted.activate(accountId: account)
        let reinstalled = try HealthKitWorkoutState(
            databaseURL: directory.appendingPathComponent("reinstalled.sqlite"))
        try require(
            try reinstalled.activate(accountId: account) != freshInstall
                && !reinstalled.collectionEnabled(),
            "reinstall fresh installation/no assumed read authorization")
        try denied("reinstall no fallback query") { _ = try reinstalled.registeredScopes() }
        try reinstalled.applyConsentRevision(3)
        _ = try register(reinstalled, account, [], revision: 3, consent: 3)
        try require(try reinstalled.registeredScopes().isEmpty, "empty server registry yields no query")

        let bounded = try HealthKitWorkoutState(
            databaseURL: directory.appendingPathComponent("bounded.sqlite"))
        _ = try bounded.activate(accountId: account)
        try bounded.applyConsentRevision(1)
        let boundedScope = try register(bounded, account, [first])
        for i in 0..<256 {
            try bounded.stagePage(
                batchId: UUID(), events: [.delete(sampleId: first.sampleId)],
                nextAnchor: HKQueryAnchor(fromValue: i + 1), scopeKey: boundedScope)
        }
        try denied("outbox cap", expected: .outboxFull) {
            try bounded.stagePage(
                batchId: UUID(), events: [.delete(sampleId: first.sampleId)],
                nextAnchor: HKQueryAnchor(fromValue: 257), scopeKey: boundedScope)
        }
        try require(try bounded.pendingBatches().count == 256, "cap preserves existing outbox")
        let many = (0..<201).map { _ in HealthKitWorkoutClaim(sampleId: UUID(), claimEpoch: UUID()) }
        _ = try register(bounded, account, many, revision: 2)
        let chunks = try bounded.registeredScopes()
        try require(
            chunks.count == 3 && chunks.allSatisfy { !$0.claims.isEmpty && $0.claims.count <= 100 },
            "large registry chunks bounded explicit UUIDs")
        try denied("cross chunk event rejected") {
            try bounded.stagePage(
                batchId: UUID(), events: [.delete(sampleId: chunks[1].claims[0].sampleId)],
                nextAnchor: HKQueryAnchor(fromValue: 1), scopeKey: chunks[0].key)
        }
        try denied("duplicate claims rejected", expected: .invalidInput) {
            _ = try register(bounded, account, [first, first], revision: 3)
        }
        try require(try bounded.registeredClaims().count == 201, "failed swap leaves prior registry")

        // Raw SQLite corruption and a historical v1 body are fixture-only, never production migration.
        let fixture = try HealthKitWorkoutState(
            databaseURL: directory.appendingPathComponent("fixture.sqlite"))
        let fixtureInstallation = try fixture.activate(accountId: account)
        try fixture.applyConsentRevision(1)
        let fixtureScope = try register(fixture, account, [first])
        let fixtureBatch = UUID()
        try fixture.stagePage(
            batchId: fixtureBatch, events: [.delete(sampleId: first.sampleId)],
            nextAnchor: HKQueryAnchor(fromValue: 1), scopeKey: fixtureScope)
        let digest = SHA256.hash(data: Data(account.utf8)).map { String(format: "%02x", $0) }.joined()
        let fixtureURL = directory.appendingPathComponent("fixture-account-\(digest).sqlite")
        var pointer: OpaquePointer?
        guard sqlite3_open(fixtureURL.path, &pointer) == SQLITE_OK, let pointer else {
            throw HarnessFailure.failed("fixture open")
        }
        defer { sqlite3_close(pointer) }
        let legacy = try JSONSerialization.data(
            withJSONObject: [
                "schemaVersion": 1, "installationId": fixtureInstallation.uuidString.lowercased(),
                "batchId": fixtureBatch.uuidString.lowercased(),
                "events": [["kind": "delete", "sampleId": first.sampleId.uuidString.lowercased()]],
            ], options: [.sortedKeys])
        let bodyHex = legacy.map { String(format: "%02x", $0) }.joined()
        let hashHex = SHA256.hash(data: legacy).map { String(format: "%02x", $0) }.joined()
        guard
            sqlite3_exec(
                pointer, "UPDATE pending SET body=x'\(bodyHex)',body_sha256=x'\(hashHex)'", nil, nil, nil)
                == SQLITE_OK
        else { throw HarnessFailure.failed("fixture update") }
        let legacyBatch = try fixture.pendingBatches()[0]
        try require(
            legacyBatch.body == legacy && legacyBatch.isPaused && !fixture.batchMayUpload(legacyBatch),
            "legacy v1 retained and quarantined without conversion")
        guard sqlite3_exec(pointer, "UPDATE owner SET consent_revision=NULL", nil, nil, nil) == SQLITE_OK else { throw HarnessFailure.failed("legacy revision fixture") }
        _ = try fixture.applyConsentRevision(1)
        try require(try fixture.activate(accountId: account) == fixtureInstallation && fixture.pendingBatches()[0].body == legacy, "first consent migration retains legacy receipt and bytes")
        try require(try fixture.pendingBatches()[0].isPaused && !fixture.batchMayUpload(fixture.pendingBatches()[0]), "migration never activates v1 upload")
        _ = try register(fixture, account, [], revision: 2)
        try require(
            try fixture.pendingBatches()[0].body == legacy && fixture.pendingBatches()[0].isPaused,
            "fresh empty registry cannot reinterpret unknown legacy membership")
        guard sqlite3_exec(pointer, "UPDATE pending SET body=x'00'", nil, nil, nil) == SQLITE_OK else {
            throw HarnessFailure.failed("corruption write")
        }
        try denied("corrupt pending rejected", expected: .corruptState) { _ = try fixture.pendingBatches() }
        try denied("corrupt ACK rejected", expected: .corruptState) {
            _ = try fixture.acknowledge(
                batchId: fixtureBatch, installationId: fixtureInstallation, acceptedCount: 1)
        }
        // Upgrade from the old unpartitioned store retains receipt scope and immutable bytes.
        let upgradeBase = directory.appendingPathComponent("upgrade.sqlite")
        var upgradedBody = Data()
        var upgradeInstallation = UUID()
        do {
            let original = try HealthKitWorkoutState(databaseURL: upgradeBase)
            upgradeInstallation = try original.activate(accountId: account)
            try original.applyConsentRevision(1)
            let upgradeScope = try register(original, account, [first])
            try original.stagePage(
                batchId: UUID(), events: [.delete(sampleId: first.sampleId)],
                nextAnchor: HKQueryAnchor(fromValue: 1), scopeKey: upgradeScope)
            upgradedBody = try original.pendingBatches()[0].body
        }
        try FileManager.default.removeItem(at: upgradeBase)
        try FileManager.default.moveItem(
            at: directory.appendingPathComponent("upgrade-account-\(digest).sqlite"), to: upgradeBase)
        let upgraded = try HealthKitWorkoutState(databaseURL: upgradeBase)
        try require(
            try upgraded.activate(accountId: account) == upgradeInstallation
                && upgraded.pendingBatches()[0].body == upgradedBody,
            "unpartitioned owner upgrade receipt retained")
        _ = try upgraded.activate(accountId: other)
        try require(
            try upgraded.pendingBatches().isEmpty
                && upgraded.activate(accountId: account) == upgradeInstallation
                && upgraded.pendingBatches()[0].body == upgradedBody, "upgrade partition owner isolation")
        try require(
            try !upgraded.batchMayUpload(upgraded.pendingBatches()[0]),
            "upgrade still requires full registry")

        let controlBase = directory.appendingPathComponent("legacy-control.sqlite")
        var controlPointer: OpaquePointer?
        guard sqlite3_open(controlBase.path, &controlPointer) == SQLITE_OK, let controlPointer else {
            throw HarnessFailure.failed("control fixture")
        }
        guard
            sqlite3_exec(
                controlPointer,
                "CREATE TABLE collection_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),wake_pending INTEGER NOT NULL DEFAULT 0 CHECK(wake_pending IN(0,1)))",
                nil, nil, nil) == SQLITE_OK
        else { throw HarnessFailure.failed("control table") }
        sqlite3_close(controlPointer)
        let control = try HealthKitWorkoutState(databaseURL: controlBase)
        _ = try control.activate(accountId: account)
        try control.requestReconciliation()
        try require(
            try control.beginReconciliationAfterOutboxDrain() && control.wakePending(),
            "legacy control migration preserves reconciliation")
        let fence = HealthKitWorkoutCollectionFence(accountId: account, generation: 7)
        try require(fence.permits(accountId: account, generation: 7), "current completion permitted")
        try require(!fence.permits(accountId: other, generation: 7), "foreign owner callback denied")
        try require(
            !fence.permits(accountId: account, generation: 8),
            "same owner replaced session/consent/registry callback denied")
        try require(!fence.permits(accountId: nil, generation: 7), "logout callback denied")
        let beforeCallback = try bounded.pendingBatches().map(\.body)
        // Exercise the same fence used by observer, anchored-query and upload continuations.
        if fence.permits(accountId: other, generation: 8) { try bounded.reset() }
        try require(
            try bounded.pendingBatches().map(\.body) == beforeCallback,
            "stale callback cannot mutate durable state")
        print(
            "HealthKitWorkoutState registered harness passed: \(checks) assertions; synthetic SQLite fixtures cleaned"
        )
    }
}
