import CryptoKit
import Foundation
import HealthKit
import SQLite3

enum HealthKitWorkoutStateError: Error {
    case invalidInput
    case batchTooLarge
    case outboxFull
    case inactive
    case corruptState
    case storageFailure
    case acknowledgementMismatch
}

struct HealthKitWorkoutUpsert: Encodable {
    let sampleId: UUID
    let sourceBundleId: String
    let sourceVersion: String?
    let activityType: Int
    let observedFrom: String
    let observedTo: String
    let durationSeconds: Double
    let distanceMeters: Double?
    let energyKilocalories: Double?
}

enum HealthKitWorkoutEvent: Encodable {
    case upsert(HealthKitWorkoutUpsert)
    case delete(sampleId: UUID)

    var sampleId: UUID {
        switch self {
        case .upsert(let value): return value.sampleId
        case .delete(let sampleId): return sampleId
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .upsert(let value):
            try container.encode("upsert", forKey: .kind)
            try container.encode(value.sampleId.uuidString.lowercased(), forKey: .sampleId)
            try container.encode(value.sourceBundleId, forKey: .sourceBundleId)
            try container.encode(value.sourceVersion, forKey: .sourceVersion)
            try container.encode(value.activityType, forKey: .activityType)
            try container.encode(value.observedFrom, forKey: .observedFrom)
            try container.encode(value.observedTo, forKey: .observedTo)
            try container.encode(value.durationSeconds, forKey: .durationSeconds)
            try container.encode(value.distanceMeters, forKey: .distanceMeters)
            try container.encode(value.energyKilocalories, forKey: .energyKilocalories)
        case .delete(let sampleId):
            try container.encode("delete", forKey: .kind)
            try container.encode(sampleId.uuidString.lowercased(), forKey: .sampleId)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, sampleId, sourceBundleId, sourceVersion, activityType
        case observedFrom, observedTo, durationSeconds, distanceMeters, energyKilocalories
    }
}

struct HealthKitPendingBatch {
    let batchId: UUID
    let installationId: UUID
    let body: Data
    let eventCount: Int
    let consentRevision: Int?
    let pauseReason: HealthKitBatchPauseReason?

    var isPaused: Bool { pauseReason != nil }
}

enum HealthKitBatchPauseReason: String {
    case forbidden
    case conflict
    case rejected
}

struct HealthKitKnownSample {
    let sampleId: UUID
    let sourceBundleId: String
    let sourceVersion: String?
}

/** Owner-scoped HealthKit cursors and immutable upload outboxes. Call on the main actor. */
@MainActor
final class HealthKitWorkoutState {
    private var db: OpaquePointer
    private let databaseURL: URL
    private var currentDatabaseURL: URL
    private var legacyOwnerAccountId: String?
    private var owner: (accountId: String, installationId: UUID)?
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(databaseURL: URL) throws {
        guard databaseURL.isFileURL else { throw HealthKitWorkoutStateError.invalidInput }
        self.databaseURL = databaseURL
        currentDatabaseURL = databaseURL
        try FileManager.default.createDirectory(at: databaseURL.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                              ofItemAtPath: databaseURL.deletingLastPathComponent().path)
        #endif
        db = try Self.openDatabase(at: databaseURL)
        do {
            try configureDatabase(at: databaseURL)
            legacyOwnerAccountId = try storedOwner()?.accountId
            if legacyOwnerAccountId == nil, try hasPrivateRows() {
                throw HealthKitWorkoutStateError.corruptState
            }
        } catch {
            sqlite3_close(db)
            throw error
        }
    }

    private static func openDatabase(at url: URL) throws -> OpaquePointer {
        var pointer: OpaquePointer?
        guard sqlite3_open_v2(url.path, &pointer,
                              SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let pointer else {
            if let pointer { sqlite3_close(pointer) }
            throw HealthKitWorkoutStateError.storageFailure
        }
        return pointer
    }

    private func configureDatabase(at url: URL) throws {
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                                  ofItemAtPath: url.path)
            #endif
            try execute("PRAGMA journal_mode=DELETE")
            try execute("PRAGMA synchronous=FULL")
            try execute("PRAGMA secure_delete=ON")
            try execute("PRAGMA foreign_keys=ON")
            try execute("CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), account_id TEXT NOT NULL, installation_id TEXT NOT NULL, consent_revision INTEGER CHECK(consent_revision BETWEEN 1 AND 2147483647))")
            let hasConsentRevision = try withStatement("PRAGMA table_info(owner)") { statement -> Bool in
                var found = false
                var status = sqlite3_step(statement)
                while status == SQLITE_ROW {
                    if try text(statement, column: 1) == "consent_revision" { found = true }
                    status = sqlite3_step(statement)
                }
                guard status == SQLITE_DONE else { throw HealthKitWorkoutStateError.storageFailure }
                return found
            }
            if !hasConsentRevision {
                try execute("ALTER TABLE owner ADD COLUMN consent_revision INTEGER CHECK(consent_revision BETWEEN 1 AND 2147483647)")
            }
            try execute("CREATE TABLE IF NOT EXISTS cursor (singleton INTEGER PRIMARY KEY CHECK(singleton=1), archive BLOB NOT NULL)")
            try execute("CREATE TABLE IF NOT EXISTS pending (sequence INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL UNIQUE, installation_id TEXT NOT NULL, event_count INTEGER NOT NULL CHECK(event_count BETWEEN 1 AND 100), body BLOB NOT NULL, body_sha256 BLOB NOT NULL, pause_reason TEXT CHECK(pause_reason IN ('forbidden','conflict','rejected')))")
            try execute("CREATE TABLE IF NOT EXISTS known_sample (sample_id TEXT PRIMARY KEY, source_bundle_id TEXT NOT NULL, source_version TEXT)")
            try execute("CREATE TABLE IF NOT EXISTS collection_control (singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), wake_pending INTEGER NOT NULL DEFAULT 0 CHECK(wake_pending IN (0,1)), reconcile_pending INTEGER NOT NULL DEFAULT 0 CHECK(reconcile_pending IN (0,1)))")
            let hasReconcileColumn = try withStatement("PRAGMA table_info(collection_control)") { statement -> Bool in
                var found = false
                var status = sqlite3_step(statement)
                while status == SQLITE_ROW {
                    if try text(statement, column: 1) == "reconcile_pending" { found = true }
                    status = sqlite3_step(statement)
                }
                guard status == SQLITE_DONE else { throw HealthKitWorkoutStateError.storageFailure }
                return found
            }
            if !hasReconcileColumn {
                try execute("ALTER TABLE collection_control ADD COLUMN reconcile_pending INTEGER NOT NULL DEFAULT 0 CHECK(reconcile_pending IN (0,1))")
            }
            let check = try withStatement("PRAGMA quick_check") { statement -> String in
                guard sqlite3_step(statement) == SQLITE_ROW else { throw HealthKitWorkoutStateError.corruptState }
                return try text(statement, column: 0)
            }
            guard check == "ok" else { throw HealthKitWorkoutStateError.corruptState }
    }

    deinit { sqlite3_close(db) }

    /** Each account has its own protected store; switching never binds old batches to new credentials. */
    @discardableResult
    func activate(accountId: String) throws -> UUID {
        guard Self.validAccount(accountId) else { throw HealthKitWorkoutStateError.invalidInput }
        let targetURL: URL
        if legacyOwnerAccountId == accountId {
            targetURL = databaseURL
        } else {
            let digest = SHA256.hash(data: Data(accountId.utf8))
                .map { String(format: "%02x", $0) }.joined()
            targetURL = databaseURL.deletingLastPathComponent()
                .appendingPathComponent("\(databaseURL.deletingPathExtension().lastPathComponent)-account-\(digest).sqlite")
        }
        if targetURL != currentDatabaseURL {
            let replacement = try Self.openDatabase(at: targetURL)
            let previous = db
            db = replacement
            do {
                try configureDatabase(at: targetURL)
                let existing = try storedOwner()
                guard existing == nil || existing?.accountId == accountId else {
                    throw HealthKitWorkoutStateError.corruptState
                }
                if existing == nil, try hasPrivateRows() {
                    throw HealthKitWorkoutStateError.corruptState
                }
            } catch {
                db = previous
                sqlite3_close(replacement)
                owner = nil
                throw error
            }
            sqlite3_close(previous)
            currentDatabaseURL = targetURL
            owner = nil
        }
        let installationId = try transaction { () -> UUID in
            let prior = try storedOwner()
            if prior == nil {
                guard try !hasPrivateRows() else { throw HealthKitWorkoutStateError.corruptState }
                let installationId = UUID()
                try withStatement("INSERT INTO owner(singleton,account_id,installation_id) VALUES(1,?,?)") { statement in
                    try bind(accountId, at: 1, in: statement)
                    try bind(Self.key(installationId), at: 2, in: statement)
                    try stepDone(statement)
                }
                return installationId
            }
            guard let prior else { throw HealthKitWorkoutStateError.corruptState }
            guard prior.accountId == accountId else { throw HealthKitWorkoutStateError.corruptState }
            return prior.installationId
        }
        owner = (accountId, installationId)
        return installationId
    }

    func anchor() throws -> HKQueryAnchor? {
        _ = try verifyOwner()
        return try withStatement("SELECT archive FROM cursor WHERE singleton=1") { statement in
            guard try rowOrDone(statement) else { return nil }
            let data = try blob(statement, column: 0)
            guard let anchor = try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data) else {
                throw HealthKitWorkoutStateError.corruptState
            }
            return anchor
        }
    }

    /** A changed server consent epoch invalidates all staged source data and its cursor atomically. */
    @discardableResult
    func applyConsentRevision(_ revision: Int, forceReset: Bool = false) throws -> Bool {
        let active = try verifyOwner()
        guard (1...2_147_483_647).contains(revision) else { throw HealthKitWorkoutStateError.invalidInput }
        let rotated = try transaction { () -> UUID? in
            try verifyStoredOwner(active)
            let previous = try withStatement("SELECT consent_revision FROM owner WHERE singleton=1") { statement -> Int? in
                guard try rowOrDone(statement) else { throw HealthKitWorkoutStateError.corruptState }
                return sqlite3_column_type(statement, 0) == SQLITE_NULL ? nil : Int(sqlite3_column_int(statement, 0))
            }
            if previous == revision && !forceReset { return nil }
            let hasOldData = try hasPrivateRows()
            if forceReset || previous != nil || hasOldData {
                try execute("DELETE FROM pending")
                try execute("DELETE FROM known_sample")
                try execute("DELETE FROM cursor")
                try execute("UPDATE collection_control SET wake_pending=1,reconcile_pending=CASE WHEN enabled=1 THEN 1 ELSE 0 END")
                let replacement = UUID()
                try withStatement("UPDATE owner SET installation_id=?,consent_revision=? WHERE singleton=1") { statement in
                    try bind(Self.key(replacement), at: 1, in: statement)
                    sqlite3_bind_int(statement, 2, Int32(revision))
                    try stepDone(statement)
                }
                return replacement
            }
            try withStatement("UPDATE owner SET consent_revision=? WHERE singleton=1") { statement in
                sqlite3_bind_int(statement, 1, Int32(revision))
                try stepDone(statement)
            }
            return nil
        }
        if let rotated { owner = (active.accountId, rotated) }
        return rotated != nil
    }

    func consentRevision() throws -> Int? {
        _ = try verifyOwner()
        return try withStatement("SELECT consent_revision FROM owner WHERE singleton=1") { statement in
            guard try rowOrDone(statement) else { throw HealthKitWorkoutStateError.corruptState }
            return sqlite3_column_type(statement, 0) == SQLITE_NULL ? nil : Int(sqlite3_column_int(statement, 0))
        }
    }

    /** Stages the next cursor with the immutable batch. Never advances a cursor without durable work. */
    func stagePage(batchId: UUID, events: [HealthKitWorkoutEvent], nextAnchor: HKQueryAnchor) throws {
        let active = try verifyOwner()
        guard try consentRevision() != nil else { throw HealthKitWorkoutStateError.invalidInput }
        guard (1...100).contains(events.count), Set(events.map(\.sampleId)).count == events.count else {
            throw HealthKitWorkoutStateError.invalidInput
        }
        try events.forEach(Self.validate)
        let body = try Self.makeBody(installationId: active.installationId, batchId: batchId, events: events)
        guard body.count <= 65_536 else { throw HealthKitWorkoutStateError.batchTooLarge }
        let archive = try NSKeyedArchiver.archivedData(withRootObject: nextAnchor, requiringSecureCoding: true)
        try transaction {
            try verifyStoredOwner(active)
            let pendingCount = try withStatement("SELECT COUNT(*) FROM pending") { statement -> Int in
                guard try rowOrDone(statement) else { throw HealthKitWorkoutStateError.corruptState }
                return Int(sqlite3_column_int(statement, 0))
            }
            guard pendingCount < 256 else { throw HealthKitWorkoutStateError.outboxFull }
            try withStatement("INSERT INTO pending(batch_id,installation_id,event_count,body,body_sha256) VALUES(?,?,?,?,?)") { statement in
                try bind(Self.key(batchId), at: 1, in: statement)
                try bind(Self.key(active.installationId), at: 2, in: statement)
                sqlite3_bind_int(statement, 3, Int32(events.count))
                try bind(body, at: 4, in: statement)
                try bind(Data(SHA256.hash(data: body)), at: 5, in: statement)
                try stepDone(statement)
            }
            for event in events {
                switch event {
                case .upsert(let value):
                    try withStatement("INSERT INTO known_sample(sample_id,source_bundle_id,source_version) VALUES(?,?,?) ON CONFLICT(sample_id) DO UPDATE SET source_bundle_id=excluded.source_bundle_id,source_version=excluded.source_version") { statement in
                        try bind(Self.key(value.sampleId), at: 1, in: statement)
                        try bind(value.sourceBundleId, at: 2, in: statement)
                        try bind(value.sourceVersion, at: 3, in: statement)
                        try stepDone(statement)
                    }
                case .delete(let sampleId):
                    try withStatement("DELETE FROM known_sample WHERE sample_id=?") { statement in
                        try bind(Self.key(sampleId), at: 1, in: statement)
                        try stepDone(statement)
                    }
                }
            }
            try withStatement("INSERT INTO cursor(singleton,archive) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET archive=excluded.archive") { statement in
                try bind(archive, at: 1, in: statement)
                try stepDone(statement)
            }
        }
    }

    /** Empty anchored pages can move the cursor because they contain no work to deliver. */
    func advanceEmptyPage(nextAnchor: HKQueryAnchor) throws {
        let active = try verifyOwner()
        let archive = try NSKeyedArchiver.archivedData(withRootObject: nextAnchor, requiringSecureCoding: true)
        try transaction {
            try verifyStoredOwner(active)
            try withStatement("INSERT INTO cursor(singleton,archive) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET archive=excluded.archive") { statement in
                try bind(archive, at: 1, in: statement)
                try stepDone(statement)
            }
        }
    }

    /** Explicit user request history, not evidence that HealthKit read authorization was granted. */
    func collectionEnabled() throws -> Bool {
        _ = try verifyOwner()
        return try withStatement("SELECT enabled FROM collection_control WHERE singleton=1") { statement in
            let status = sqlite3_step(statement)
            if status == SQLITE_DONE { return false }
            guard status == SQLITE_ROW else { throw HealthKitWorkoutStateError.storageFailure }
            let enabled = sqlite3_column_int(statement, 0)
            guard enabled == 0 || enabled == 1 else { throw HealthKitWorkoutStateError.corruptState }
            return enabled == 1
        }
    }

    /** A product action requests a fresh snapshot; it is not proof of OS read access. */
    func requestReconciliation() throws {
        let active = try verifyOwner()
        try transaction {
            try verifyStoredOwner(active)
            try execute("INSERT INTO collection_control(singleton,enabled,wake_pending,reconcile_pending) VALUES(1,1,1,1) ON CONFLICT(singleton) DO UPDATE SET enabled=1,wake_pending=1,reconcile_pending=1")
        }
    }

    /** Reset only after every older batch is ACKed; keep the intent durable until then. */
    @discardableResult
    func beginReconciliationAfterOutboxDrain() throws -> Bool {
        let active = try verifyOwner()
        return try transaction {
            try verifyStoredOwner(active)
            let pendingCount = try withStatement("SELECT COUNT(*) FROM pending") { statement -> Int in
                guard try rowOrDone(statement) else { throw HealthKitWorkoutStateError.corruptState }
                return Int(sqlite3_column_int(statement, 0))
            }
            guard pendingCount == 0 else { return false }
            let requested = try withStatement("SELECT reconcile_pending FROM collection_control WHERE singleton=1") { statement -> Bool in
                guard try rowOrDone(statement) else { return false }
                let value = sqlite3_column_int(statement, 0)
                guard value == 0 || value == 1 else { throw HealthKitWorkoutStateError.corruptState }
                return value == 1
            }
            guard requested else { return false }
            try execute("DELETE FROM cursor")
            try execute("DELETE FROM known_sample")
            try execute("UPDATE collection_control SET reconcile_pending=0,wake_pending=1 WHERE singleton=1")
            return true
        }
    }

    /** Persist observer wake intent before invoking HealthKit's completion callback. */
    func markWakePending() throws {
        let active = try verifyOwner()
        try transaction {
            try verifyStoredOwner(active)
            try execute("INSERT INTO collection_control(singleton,enabled,wake_pending) VALUES(1,0,1) ON CONFLICT(singleton) DO UPDATE SET wake_pending=1")
        }
    }

    func wakePending() throws -> Bool {
        _ = try verifyOwner()
        return try withStatement("SELECT wake_pending FROM collection_control WHERE singleton=1") { statement in
            guard try rowOrDone(statement) else { return false }
            let pending = sqlite3_column_int(statement, 0)
            guard pending == 0 || pending == 1 else { throw HealthKitWorkoutStateError.corruptState }
            return pending == 1
        }
    }

    func clearWakePending() throws {
        let active = try verifyOwner()
        try transaction {
            try verifyStoredOwner(active)
            try execute("UPDATE collection_control SET wake_pending=CASE WHEN reconcile_pending=1 THEN 1 ELSE 0 END WHERE singleton=1")
        }
    }

    func pendingBatches() throws -> [HealthKitPendingBatch] {
        let active = try verifyOwner()
        let revision = try consentRevision()
        return try withStatement("SELECT batch_id,installation_id,event_count,body,body_sha256,pause_reason FROM pending ORDER BY sequence") { statement in
            var result: [HealthKitPendingBatch] = []
            var status = sqlite3_step(statement)
            while status == SQLITE_ROW {
                guard let batch = UUID(uuidString: try text(statement, column: 0)),
                      let installation = UUID(uuidString: try text(statement, column: 1)),
                      installation == active.installationId else { throw HealthKitWorkoutStateError.corruptState }
                let count = Int(sqlite3_column_int(statement, 2))
                let body = try blob(statement, column: 3)
                let digest = try blob(statement, column: 4)
                let pauseRaw = try optionalText(statement, column: 5)
                let pauseReason = pauseRaw.flatMap(HealthKitBatchPauseReason.init(rawValue:))
                guard (1...100).contains(count),
                      pauseRaw == nil || pauseReason != nil,
                      body.count <= 65_536,
                      digest == Data(SHA256.hash(data: body)),
                      let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                      json["schemaVersion"] as? Int == 1,
                      json["installationId"] as? String == Self.key(installation),
                      json["batchId"] as? String == Self.key(batch),
                      (json["events"] as? [[String: Any]])?.count == count else {
                    throw HealthKitWorkoutStateError.corruptState
                }
                result.append(HealthKitPendingBatch(batchId: batch, installationId: installation,
                                                     body: body, eventCount: count, consentRevision: revision,
                                                     pauseReason: pauseReason))
                status = sqlite3_step(statement)
            }
            guard status == SQLITE_DONE else {
                throw HealthKitWorkoutStateError.storageFailure
            }
            return result
        }
    }

    /** Quarantine a permanent server rejection without changing the retriable request bytes. */
    func pause(batchId: UUID, reason: HealthKitBatchPauseReason) throws {
        let active = try verifyOwner()
        guard try pendingBatches().contains(where: { $0.batchId == batchId }) else {
            throw HealthKitWorkoutStateError.invalidInput
        }
        try transaction {
            try verifyStoredOwner(active)
            try withStatement("UPDATE pending SET pause_reason=COALESCE(pause_reason,?) WHERE batch_id=? AND installation_id=?") { statement in
                try bind(reason.rawValue, at: 1, in: statement)
                try bind(Self.key(batchId), at: 2, in: statement)
                try bind(Self.key(active.installationId), at: 3, in: statement)
                try stepDone(statement)
            }
            guard sqlite3_changes(db) == 1 else { throw HealthKitWorkoutStateError.invalidInput }
        }
    }

    @discardableResult
    func acknowledge(batchId: UUID, installationId: UUID, acceptedCount: Int) throws -> Bool {
        let active = try verifyOwner()
        guard active.installationId == installationId else { throw HealthKitWorkoutStateError.acknowledgementMismatch }
        return try transaction {
            try verifyStoredOwner(active)
            let count: Int? = try withStatement("SELECT event_count,body,body_sha256 FROM pending WHERE batch_id=? AND installation_id=?") { statement in
                try bind(Self.key(batchId), at: 1, in: statement)
                try bind(Self.key(installationId), at: 2, in: statement)
                guard try rowOrDone(statement) else { return nil }
                let count = Int(sqlite3_column_int(statement, 0))
                let body = try blob(statement, column: 1)
                let digest = try blob(statement, column: 2)
                guard (1...100).contains(count), body.count <= 65_536,
                      digest == Data(SHA256.hash(data: body)),
                      let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                      json["batchId"] as? String == Self.key(batchId),
                      json["installationId"] as? String == Self.key(installationId),
                      (json["events"] as? [[String: Any]])?.count == count else {
                    throw HealthKitWorkoutStateError.corruptState
                }
                return count
            }
            guard let count else { return false }
            guard count == acceptedCount else { throw HealthKitWorkoutStateError.acknowledgementMismatch }
            try withStatement("DELETE FROM pending WHERE batch_id=? AND installation_id=?") { statement in
                try bind(Self.key(batchId), at: 1, in: statement)
                try bind(Self.key(installationId), at: 2, in: statement)
                try stepDone(statement)
            }
            return true
        }
    }

    func knownSample(sampleId: UUID) throws -> HealthKitKnownSample? {
        _ = try verifyOwner()
        return try withStatement("SELECT source_bundle_id,source_version FROM known_sample WHERE sample_id=?") { statement in
            try bind(Self.key(sampleId), at: 1, in: statement)
            guard try rowOrDone(statement) else { return nil }
            return HealthKitKnownSample(sampleId: sampleId, sourceBundleId: try text(statement, column: 0),
                                        sourceVersion: try optionalText(statement, column: 1))
        }
    }

    /** Call only for committed consent withdrawal or explicit local-health-data deletion. */
    func reset() throws {
        try transaction { try purgeRows() }
        owner = nil
    }

    /** Logout drops the in-memory owner binding; a later same-owner login can deliver its outbox. */
    func deactivate() {
        owner = nil
    }

    private func purgeRows() throws {
        try execute("DELETE FROM pending")
        try execute("DELETE FROM known_sample")
        try execute("DELETE FROM cursor")
        try execute("DELETE FROM collection_control")
        try execute("DELETE FROM owner")
    }

    private func hasPrivateRows() throws -> Bool {
        for table in ["cursor", "pending", "known_sample", "collection_control"] {
            let found = try withStatement("SELECT 1 FROM \(table) LIMIT 1") { statement in
                let status = sqlite3_step(statement)
                guard status == SQLITE_ROW || status == SQLITE_DONE else { throw HealthKitWorkoutStateError.storageFailure }
                return status == SQLITE_ROW
            }
            if found { return true }
        }
        return false
    }

    private func verifyOwner() throws -> (accountId: String, installationId: UUID) {
        guard let owner else { throw HealthKitWorkoutStateError.inactive }
        try verifyStoredOwner(owner)
        return owner
    }

    private func verifyStoredOwner(_ expected: (accountId: String, installationId: UUID)) throws {
        guard let actual = try storedOwner(), actual.accountId == expected.accountId,
              actual.installationId == expected.installationId else { throw HealthKitWorkoutStateError.corruptState }
    }

    private func storedOwner() throws -> (accountId: String, installationId: UUID)? {
        try withStatement("SELECT account_id,installation_id FROM owner WHERE singleton=1") { statement in
            guard try rowOrDone(statement) else { return nil }
            let account = try text(statement, column: 0)
            guard let id = UUID(uuidString: try text(statement, column: 1)), Self.validAccount(account) else {
                throw HealthKitWorkoutStateError.corruptState
            }
            return (account, id)
        }
    }

    private static func key(_ id: UUID) -> String { id.uuidString.lowercased() }

    private static func validAccount(_ account: String) -> Bool {
        (1...200).contains(account.utf8.count) &&
        account.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    }

    private static func validate(_ event: HealthKitWorkoutEvent) throws {
        guard case .upsert(let value) = event else { return }
        guard (1...255).contains(value.sourceBundleId.utf16.count), !value.sourceBundleId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.sourceVersion.map({ (1...128).contains($0.utf16.count) && !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) ?? true,
              (0...1_000_000).contains(value.activityType),
              (0...2_678_400).contains(value.durationSeconds), value.durationSeconds.isFinite,
              [value.distanceMeters, value.energyKilocalories].allSatisfy({ metric in
                  guard let metric else { return true }
                  return metric.isFinite && (0...1_000_000_000).contains(metric)
              }),
              let from = parseDate(value.observedFrom), let to = parseDate(value.observedTo), to >= from else {
            throw HealthKitWorkoutStateError.invalidInput
        }
    }

    private static func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    private struct Batch: Encodable {
        let schemaVersion = 1
        let installationId: String
        let batchId: String
        let events: [HealthKitWorkoutEvent]
    }

    private static func makeBody(installationId: UUID, batchId: UUID,
                                 events: [HealthKitWorkoutEvent]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(Batch(installationId: key(installationId), batchId: key(batchId), events: events))
    }

    private func transaction<T>(_ operation: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try operation()
            try execute("COMMIT")
            return result
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    private func execute(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
            throw HealthKitWorkoutStateError.storageFailure
        }
    }

    private func withStatement<T>(_ sql: String, _ operation: (OpaquePointer) throws -> T) throws -> T {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK,
              let statement else { throw HealthKitWorkoutStateError.storageFailure }
        defer { sqlite3_finalize(statement) }
        return try operation(statement)
    }

    private func bind(_ value: String, at index: Int32, in statement: OpaquePointer) throws {
        guard sqlite3_bind_text(statement, index, value, -1, transient) == SQLITE_OK else {
            throw HealthKitWorkoutStateError.storageFailure
        }
    }

    private func bind(_ value: String?, at index: Int32, in statement: OpaquePointer) throws {
        if let value { try bind(value, at: index, in: statement) }
        else if sqlite3_bind_null(statement, index) != SQLITE_OK { throw HealthKitWorkoutStateError.storageFailure }
    }

    private func bind(_ value: Data, at index: Int32, in statement: OpaquePointer) throws {
        let result = value.withUnsafeBytes { buffer in
            sqlite3_bind_blob(statement, index, buffer.baseAddress, Int32(value.count), transient)
        }
        guard result == SQLITE_OK else { throw HealthKitWorkoutStateError.storageFailure }
    }

    private func stepDone(_ statement: OpaquePointer) throws {
        guard sqlite3_step(statement) == SQLITE_DONE else { throw HealthKitWorkoutStateError.storageFailure }
    }

    private func rowOrDone(_ statement: OpaquePointer) throws -> Bool {
        let status = sqlite3_step(statement)
        if status == SQLITE_ROW { return true }
        if status == SQLITE_DONE { return false }
        throw HealthKitWorkoutStateError.storageFailure
    }

    private func text(_ statement: OpaquePointer, column: Int32) throws -> String {
        guard let raw = sqlite3_column_text(statement, column),
              let value = String(validatingUTF8: UnsafeRawPointer(raw).assumingMemoryBound(to: CChar.self)) else {
            throw HealthKitWorkoutStateError.corruptState
        }
        return value
    }

    private func optionalText(_ statement: OpaquePointer, column: Int32) throws -> String? {
        sqlite3_column_type(statement, column) == SQLITE_NULL ? nil : try text(statement, column: column)
    }

    private func blob(_ statement: OpaquePointer, column: Int32) throws -> Data {
        let size = Int(sqlite3_column_bytes(statement, column))
        guard size > 0, let pointer = sqlite3_column_blob(statement, column) else {
            throw HealthKitWorkoutStateError.corruptState
        }
        return Data(bytes: pointer, count: size)
    }
}
