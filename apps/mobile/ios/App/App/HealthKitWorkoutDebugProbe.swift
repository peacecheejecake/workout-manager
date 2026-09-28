#if DEBUG
import CryptoKit
import Foundation
import HealthKit

private enum DebugProbeError: Error {
    case unavailable
    case alreadyActive
    case noOwnedSample
    case invalidState
    case unexpectedSample
}

/** Local diagnostic only. It never reads or uploads the product collector's cursor/outbox. */
@MainActor
final class HealthKitWorkoutDebugProbe {
    static let shared = HealthKitWorkoutDebugProbe()

    static let markerKey = "org.workoutmanager.debug.synthetic-run"

    private struct Event: Codable {
        let kind: String
        let sampleId: UUID
    }

    private struct ReadResult {
        let sawUpsert: Bool
        let sawDeletion: Bool
        static let none = ReadResult(sawUpsert: false, sawDeletion: false)
    }

    private struct Run: Codable {
        let accountId: String
        let marker: String
        var sampleId: UUID?
        var saveConfirmed: Bool
        var saveFailed: Bool
        var readOptedIn: Bool
        var deletionAttempted: Bool
        var deletionConfirmed: Bool
        var anchorArchive: Data?
        var pendingEvents: [Event]
    }

    private let healthStore = HKHealthStore()
    private let workoutType = HKObjectType.workoutType()
    private var observer: HKObserverQuery?
    private var observerAccountId: String?
    private var activeRead: (token: UUID, accountId: String, task: Task<ReadResult, Error>)?
    private var operationInProgress = false
    private var ownerGeneration = 0

    private init() {
        NotificationCenter.default.addObserver(
            forName: .nativeAuthCredentialInvalidated, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.stopObserver() }
        }
    }

    private func stateURL(for accountId: String) -> URL? {
        guard Self.validAccount(accountId) else { return nil }
        let digest = SHA256.hash(data: Data(accountId.utf8))
            .map { String(format: "%02x", $0) }.joined()
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("HealthKitDebug", isDirectory: true)
            .appendingPathComponent("synthetic-run-account-\(digest).json")
    }

    private static func validAccount(_ accountId: String) -> Bool {
        accountId.range(of: "^[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil
    }

    static func matchesAccount(runAccountId: String, sessionAccountId: String?) -> Bool {
        sessionAccountId != nil && runAccountId == sessionAccountId
    }

    private func currentAccount() async throws -> String {
        let session = try await NativeAuth.shared.currentSession()
        guard session["state"] == "signed_in", let accountId = session["athleteId"],
              Self.validAccount(accountId) else { throw DebugProbeError.unavailable }
        return accountId
    }

    private func requireCurrentAccount(_ accountId: String) async throws {
        guard Self.matchesAccount(runAccountId: accountId,
                                  sessionAccountId: try await currentAccount()) else {
            throw DebugProbeError.unavailable
        }
    }

    private func load(accountId: String) throws -> Run? {
        guard let stateURL = stateURL(for: accountId) else { throw DebugProbeError.unavailable }
        guard FileManager.default.fileExists(atPath: stateURL.path) else { return nil }
        let decoded = try JSONDecoder().decode(Run.self, from: Data(contentsOf: stateURL))
        guard Self.matchesAccount(runAccountId: decoded.accountId, sessionAccountId: accountId),
              UUID(uuidString: decoded.marker) != nil,
              decoded.pendingEvents.count <= 100,
              !(decoded.saveConfirmed && decoded.saveFailed),
              (decoded.sampleId != nil || (!decoded.saveConfirmed && !decoded.saveFailed &&
                                            !decoded.deletionAttempted && !decoded.deletionConfirmed)),
              (!decoded.deletionConfirmed || (decoded.sampleId != nil && decoded.deletionAttempted)),
              (decoded.readOptedIn || (decoded.anchorArchive == nil && decoded.pendingEvents.isEmpty)),
              decoded.pendingEvents.allSatisfy({ $0.sampleId == decoded.sampleId }) else {
            throw DebugProbeError.invalidState
        }
        return decoded
    }

    private func persist(_ newRun: Run, accountId: String) throws {
        guard Self.matchesAccount(runAccountId: newRun.accountId, sessionAccountId: accountId),
              let stateURL = stateURL(for: accountId) else { throw DebugProbeError.unavailable }
        let directory = stateURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: directory.path)
        try JSONEncoder().encode(newRun).write(to: stateURL, options: .atomic)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: stateURL.path)
    }

    static func hasExactScope(marker: String, sampleId: UUID?) -> Bool {
        UUID(uuidString: marker) != nil && sampleId != nil
    }

    static func deletionPredicate(marker: String, sampleId: UUID?, source: HKSource) -> NSPredicate? {
        guard Self.hasExactScope(marker: marker, sampleId: sampleId), let sampleId else { return nil }
        return NSCompoundPredicate(andPredicateWithSubpredicates: [
            HKQuery.predicateForObjects(from: source),
            HKQuery.predicateForObjects(withMetadataKey: markerKey,
                                        operatorType: .equalTo, value: marker as NSString),
            HKQuery.predicateForObjects(with: [sampleId])
        ])
    }

    static func queryPredicate(sampleId: UUID?) -> NSPredicate? {
        guard let sampleId else { return nil }
        // HKDeletedObject retains UUID, but drops custom metadata and may not retain source.
        return HKQuery.predicateForObjects(with: [sampleId])
    }

    static func acceptsSample(_ sampleId: UUID, knownId: UUID?,
                              sourceBundleId: String, ownBundleId: String,
                              metadataMarker: String?, marker: String) -> Bool {
        sampleId == knownId && sourceBundleId == ownBundleId && metadataMarker == marker
    }

    static func acceptsDeletion(_ sampleId: UUID, knownId: UUID?) -> Bool {
        knownId != nil && sampleId == knownId
    }

    static func acceptsCompletedRead(startedMarker: String, startedSampleId: UUID?,
                                     latestMarker: String?, latestSampleId: UUID?) -> Bool {
        startedSampleId != nil && startedMarker == latestMarker && startedSampleId == latestSampleId
    }

    static func mayResumeRead(readOptedIn: Bool, sampleId: UUID?) -> Bool {
        readOptedIn && sampleId != nil
    }

    static func shouldResetAnchorAfterEmptyRead(deletionConfirmed: Bool,
                                                observedOwnedUpsert: Bool) -> Bool {
        !deletionConfirmed && !observedOwnedUpsert
    }

    static func canReportCurrentRead(deletionConfirmed: Bool, sawUpsert: Bool,
                                     sawDeletion: Bool) -> Bool {
        deletionConfirmed ? sawDeletion : sawUpsert
    }

    private func deletionPredicate(for run: Run) throws -> NSPredicate {
        guard let predicate = Self.deletionPredicate(marker: run.marker, sampleId: run.sampleId,
                                                     source: HKSource.default()) else {
            throw DebugProbeError.invalidState
        }
        return predicate
    }

    private func queryPredicate(for run: Run) throws -> NSPredicate {
        guard let predicate = Self.queryPredicate(sampleId: run.sampleId) else {
            throw DebugProbeError.invalidState
        }
        return predicate
    }

    /** A prior explicit run may resume its exact scope after launch/foreground, without a new prompt. */
    func resumeScopedRunIfNeeded() async {
        guard !operationInProgress, HKHealthStore.isHealthDataAvailable() else { return }
        operationInProgress = true
        defer { operationInProgress = false }
        do {
            let accountId = try await currentAccount()
            guard let current = try load(accountId: accountId),
                  Self.mayResumeRead(readOptedIn: current.readOptedIn,
                                     sampleId: current.sampleId) else { return }
            if observerAccountId != accountId { stopObserver() }
            if observer == nil { try startFilteredObserver(for: current) }
            _ = try await readFilteredPage(accountId: accountId)
        } catch {
            stopObserver()
            // A missing/corrupt run never falls back to the product-wide query.
        }
    }

    /** Called only after the visible native Debug control's create confirmation. */
    func createOneSyntheticWorkout() async throws -> String {
        guard !operationInProgress else { throw DebugProbeError.alreadyActive }
        operationInProgress = true
        defer { operationInProgress = false }
        guard HKHealthStore.isHealthDataAvailable() else { throw DebugProbeError.unavailable }
        let accountId = try await currentAccount()
        if try load(accountId: accountId)?.sampleId != nil { throw DebugProbeError.alreadyActive }
        // Finish any scoped read before rotating the run marker and cursor.
        await awaitActiveReadCompletion()
        try await requireCurrentAccount(accountId)
        stopObserver()
        let newRun = Run(accountId: accountId, marker: UUID().uuidString.lowercased(),
                         sampleId: nil, saveConfirmed: false, saveFailed: false,
                         readOptedIn: false, deletionAttempted: false,
                         deletionConfirmed: false,
                         anchorArchive: nil, pendingEvents: [])
        try persist(newRun, accountId: accountId)
        try await authorizeWriteOnly()
        try await requireCurrentAccount(accountId)
        guard healthStore.authorizationStatus(for: workoutType) == .sharingAuthorized else {
            throw DebugProbeError.unavailable
        }
        let end = Date()
        let start = end.addingTimeInterval(-60)
        let workout = HKWorkout(activityType: .walking, start: start, end: end,
                                duration: 60, totalEnergyBurned: nil, totalDistance: nil,
                                metadata: [Self.markerKey: newRun.marker])
        var saved = newRun
        saved.sampleId = workout.uuid
        // Persist the exact own UUID before save, so failed post-save I/O still has a cleanup target.
        try persist(saved, accountId: accountId)
        try await requireCurrentAccount(accountId)
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                healthStore.save(workout) { success, error in
                    if let error { continuation.resume(throwing: error) }
                    else if success { continuation.resume() }
                    else { continuation.resume(throwing: DebugProbeError.unavailable) }
                }
            }
        } catch {
            // A failed callback is not proof the sample is absent. Keep its exact cleanup target.
            saved.saveFailed = true
            try? persist(saved, accountId: accountId)
            throw error
        }
        try await requireCurrentAccount(accountId)
        saved.saveConfirmed = true
        try persist(saved, accountId: accountId)
        return "표식이 있는 합성 운동 1개를 저장했습니다. 운동 읽기 확인은 실행하지 않았습니다."
    }

    /** The OS read grant covers the workout type; only a separate informed action enters here. */
    func requestScopedReadFromExplicitAction() async throws -> String {
        guard !operationInProgress else { throw DebugProbeError.alreadyActive }
        operationInProgress = true
        defer { operationInProgress = false }
        guard HKHealthStore.isHealthDataAvailable() else { throw DebugProbeError.unavailable }
        let accountId = try await currentAccount()
        guard var current = try load(accountId: accountId),
              current.sampleId != nil else { throw DebugProbeError.noOwnedSample }
        await awaitActiveReadCompletion()
        try await requireCurrentAccount(accountId)
        guard let latest = try load(accountId: accountId),
              latest.sampleId == current.sampleId, latest.marker == current.marker else {
            throw DebugProbeError.invalidState
        }
        current = latest
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            healthStore.requestAuthorization(toShare: [], read: [workoutType]) { success, error in
                if let error { continuation.resume(throwing: error) }
                else if success { continuation.resume() }
                else { continuation.resume(throwing: DebugProbeError.unavailable) }
            }
        }
        try await requireCurrentAccount(accountId)
        current.readOptedIn = true
        if !current.deletionConfirmed {
            // The explicit action must see this sample anew; an older empty page may
            // have advanced its cursor while OS read access was denied.
            current.anchorArchive = nil
        }
        try persist(current, accountId: accountId)
        if observerAccountId != accountId { stopObserver() }
        if observer == nil { try startFilteredObserver(for: current) }
        let readResult = try await readFilteredPage(accountId: accountId)
        try await requireCurrentAccount(accountId)
        guard Self.canReportCurrentRead(deletionConfirmed: current.deletionConfirmed,
                                        sawUpsert: readResult.sawUpsert,
                                        sawDeletion: readResult.sawDeletion) else {
            // HealthKit does not reveal read denial; an empty page is not proof of permission.
            throw DebugProbeError.unavailable
        }
        return current.deletionConfirmed
            ? "표식이 있는 이 앱의 합성 운동 삭제 이벤트를 확인했습니다."
            : "표식이 있는 이 앱의 합성 운동 1개만 읽기 확인했습니다."
    }

    /** Explicit cleanup can target only the persisted UUID plus source and marker. */
    func deleteOwnedSyntheticWorkout() async throws -> String {
        guard !operationInProgress else { throw DebugProbeError.alreadyActive }
        operationInProgress = true
        defer { operationInProgress = false }
        guard HKHealthStore.isHealthDataAvailable() else { throw DebugProbeError.unavailable }
        let accountId = try await currentAccount()
        guard let current = try load(accountId: accountId),
              let sampleId = current.sampleId else { throw DebugProbeError.noOwnedSample }
        if current.deletionConfirmed {
            return "삭제 API 성공 기록이 이미 있습니다. 삭제 이벤트 확인 또는 명시적 종료를 선택하세요."
        }
        // A prior observer read must not later restore the old UUID or anchor.
        await awaitActiveReadCompletion()
        try await requireCurrentAccount(accountId)
        guard let latest = try load(accountId: accountId),
              latest.sampleId == sampleId, latest.marker == current.marker,
              !latest.deletionConfirmed else { throw DebugProbeError.invalidState }
        var attempted = latest
        attempted.deletionAttempted = true
        // Durable intent precedes the external delete API. If a successful API
        // result cannot be persisted, the next explicit retry remains uncertain.
        try persist(attempted, accountId: accountId)
        let predicate = try deletionPredicate(for: attempted)
        let count = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Int, Error>) in
            healthStore.deleteObjects(of: workoutType, predicate: predicate) { success, count, error in
                if let error { continuation.resume(throwing: error) }
                else if success { continuation.resume(returning: count) }
                else { continuation.resume(throwing: DebugProbeError.unavailable) }
            }
        }
        try await requireCurrentAccount(accountId)
        guard count == 1 else {
            // Zero or unexpected counts leave the UUID durable for explicit retry/investigation.
            if count == 0 {
                return attempted.saveConfirmed
                    ? "삭제 대상이 확인되지 않았습니다. 이전 삭제 시도 결과가 불명확할 수 있어 표본 식별자를 유지합니다."
                    : "저장 성공 여부가 불명확하며 삭제 대상도 확인되지 않았습니다. 중복 생성을 막기 위해 이 표본 식별자를 유지합니다. 앱에서 다시 정리하거나 직접 조사해야 합니다."
            }
            throw DebugProbeError.unexpectedSample
        }
        var confirmed = attempted
        confirmed.deletionConfirmed = true
        try persist(confirmed, accountId: accountId)
        // The delete API result and the anchored tombstone are separate evidence.
        let tombstoneObserved: Bool
        if attempted.readOptedIn, let result = try? await readFilteredPage(accountId: accountId) {
            tombstoneObserved = result.sawDeletion
        } else {
            tombstoneObserved = false
        }
        try await requireCurrentAccount(accountId)
        let tombstone = tombstoneObserved ? "삭제 이벤트 확인됨." : "삭제 이벤트는 확인되지 않음."
        return "표식이 있는 합성 운동 1개 삭제 API 성공. \(tombstone) 기록은 명시적 종료 전까지 보존됩니다."
    }

    /** Explicitly closes a confirmed delete; absent tombstone remains unverified. */
    func finalizeConfirmedDeletion() async throws -> String {
        guard !operationInProgress else { throw DebugProbeError.alreadyActive }
        operationInProgress = true
        defer { operationInProgress = false }
        let accountId = try await currentAccount()
        guard var current = try load(accountId: accountId), current.deletionConfirmed,
              let sampleId = current.sampleId else { throw DebugProbeError.invalidState }
        await awaitActiveReadCompletion()
        try await requireCurrentAccount(accountId)
        guard let latest = try load(accountId: accountId), latest.deletionConfirmed,
              latest.sampleId == sampleId else { throw DebugProbeError.invalidState }
        current = latest
        let observed = current.pendingEvents.contains {
            $0.kind == "delete" && $0.sampleId == sampleId
        }
        stopObserver()
        current.sampleId = nil
        current.saveConfirmed = false
        current.saveFailed = false
        current.readOptedIn = false
        current.deletionAttempted = false
        current.deletionConfirmed = false
        current.anchorArchive = nil
        current.pendingEvents = []
        try persist(current, accountId: accountId)
        return observed ? "삭제 이벤트 확인 후 검증 기록을 종료했습니다."
            : "삭제 이벤트 미확인 상태로 검증 기록을 종료했습니다. 이벤트 검증은 미실행입니다."
    }

    private func authorizeWriteOnly() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            healthStore.requestAuthorization(toShare: [workoutType], read: []) { success, error in
                if let error { continuation.resume(throwing: error) }
                else if success { continuation.resume() }
                else { continuation.resume(throwing: DebugProbeError.unavailable) }
            }
        }
    }

    private func startFilteredObserver(for run: Run) throws {
        guard observer == nil else { return }
        guard run.readOptedIn, run.sampleId != nil else { throw DebugProbeError.invalidState }
        let scoped = try queryPredicate(for: run)
        let query = HKObserverQuery(sampleType: workoutType, predicate: scoped) {
            [weak self] _, completion, _ in
            Task { @MainActor in
                if let self, !self.operationInProgress {
                    _ = try? await self.readFilteredPage(accountId: run.accountId)
                }
                completion()
            }
        }
        observer = query
        observerAccountId = run.accountId
        healthStore.execute(query)
    }

    private func stopObserver() {
        ownerGeneration += 1
        if let observer { healthStore.stop(observer) }
        observer = nil
        observerAccountId = nil
    }

    private func awaitActiveReadCompletion() async {
        guard let activeRead else { return }
        _ = try? await activeRead.task.value
        if self.activeRead?.token == activeRead.token { self.activeRead = nil }
    }

    private func readFilteredPage(accountId: String) async throws -> ReadResult {
        if let activeRead {
            guard activeRead.accountId == accountId else { throw DebugProbeError.unavailable }
            return try await activeRead.task.value
        }
        let token = UUID()
        let task = Task { try await performFilteredRead(accountId: accountId) }
        activeRead = (token, accountId, task)
        defer {
            if activeRead?.token == token { activeRead = nil }
        }
        return try await task.value
    }

    private func performFilteredRead(accountId: String) async throws -> ReadResult {
        let startedGeneration = ownerGeneration
        try await requireCurrentAccount(accountId)
        guard var current = try load(accountId: accountId), current.readOptedIn,
              current.sampleId != nil else { return .none }
        let scoped = try queryPredicate(for: current)
        let anchor: HKQueryAnchor?
        if let archive = current.anchorArchive {
            guard let decoded = try NSKeyedUnarchiver.unarchivedObject(
                ofClass: HKQueryAnchor.self, from: archive) else { throw DebugProbeError.invalidState }
            anchor = decoded
        } else {
            anchor = nil
        }
        let result = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<([HKSample], [HKDeletedObject], HKQueryAnchor?), Error>) in
            let query = HKAnchoredObjectQuery(type: workoutType, predicate: scoped,
                                              anchor: anchor, limit: 20) {
                _, samples, deleted, nextAnchor, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: (samples ?? [], deleted ?? [], nextAnchor)) }
            }
            healthStore.execute(query)
        }
        guard let nextAnchor = result.2 else { throw DebugProbeError.invalidState }
        try await requireCurrentAccount(accountId)
        guard startedGeneration == ownerGeneration else { throw DebugProbeError.unavailable }
        guard let latest = try load(accountId: accountId),
              Self.acceptsCompletedRead(startedMarker: current.marker,
                                        startedSampleId: current.sampleId,
                                        latestMarker: latest.marker,
                                        latestSampleId: latest.sampleId),
              latest.anchorArchive == current.anchorArchive else {
            throw DebugProbeError.invalidState
        }
        var sawUpsert = false
        var sawDeletion = false
        for sample in result.0 {
            guard Self.acceptsSample(sample.uuid, knownId: current.sampleId,
                                     sourceBundleId: sample.sourceRevision.source.bundleIdentifier,
                                     ownBundleId: HKSource.default().bundleIdentifier,
                                     metadataMarker: sample.metadata?[Self.markerKey] as? String,
                                     marker: current.marker) else {
                throw DebugProbeError.unexpectedSample
            }
            sawUpsert = true
            if !current.pendingEvents.contains(where: {
                $0.kind == "upsert" && $0.sampleId == sample.uuid
            }) {
                current.pendingEvents.append(Event(kind: "upsert", sampleId: sample.uuid))
            }
        }
        for deleted in result.1 {
            // A deletion carries no reliable source metadata; only the known own UUID is accepted.
            guard Self.acceptsDeletion(deleted.uuid, knownId: current.sampleId) else {
                throw DebugProbeError.unexpectedSample
            }
            sawDeletion = true
            if !current.pendingEvents.contains(where: {
                $0.kind == "delete" && $0.sampleId == deleted.uuid
            }) {
                current.pendingEvents.append(Event(kind: "delete", sampleId: deleted.uuid))
            }
        }
        guard current.pendingEvents.count <= 100 else { throw DebugProbeError.invalidState }
        if Self.shouldResetAnchorAfterEmptyRead(deletionConfirmed: current.deletionConfirmed,
                                                observedOwnedUpsert: sawUpsert) {
            // Applies to launch/foreground observer reads too, not just explicit retries.
            current.anchorArchive = nil
        } else {
            current.anchorArchive = try NSKeyedArchiver.archivedData(
                withRootObject: nextAnchor, requiringSecureCoding: true)
        }
        try persist(current, accountId: accountId)
        return ReadResult(sawUpsert: sawUpsert, sawDeletion: sawDeletion)
    }
}
#endif
