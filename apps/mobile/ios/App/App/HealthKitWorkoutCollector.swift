import Foundation
import HealthKit

private enum HealthKitCollectionFailure: Error {
    case unavailable
    case invalidSample
    case invalidAnchor
}

/// Workout-only collector. The OS read prompt is reserved for an explicit product action.
@MainActor
final class HealthKitWorkoutCollector {
    static let shared = HealthKitWorkoutCollector()

    private let workoutType = HKObjectType.workoutType()
    private let healthStore = HKHealthStore()
    private var state: HealthKitWorkoutState?
    private var observers: [HKObserverQuery] = []
    private var scopeOffset = 0
    private var completedScopes = Set<String>()
    private var activeAccountId: String?
    private var generation = 0
    private var collecting = false
    private var wakePending = false

    private init() {
        state = Self.openState()
        NotificationCenter.default.addObserver(
            forName: .nativeAuthCredentialInvalidated, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.invalidateOwner() }
        }
    }

    private static func openState() -> HealthKitWorkoutState? {
        let support = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first
        if let support {
            return try? HealthKitWorkoutState(
                databaseURL: support.appendingPathComponent("HealthKit", isDirectory: true)
                    .appendingPathComponent("workouts.sqlite"))
        }
        return nil
    }

    private func availableState() -> HealthKitWorkoutState? {
        if state == nil { state = Self.openState() }
        return state
    }

    func applicationDidLaunch() {
        #if DEBUG
            // Debug builds never resume the product-wide cursor against a device with personal workouts.
            return
        #else
            scheduleCollection()
        #endif
    }

    func sceneDidBecomeActive() {
        #if DEBUG
            return
        #else
            scheduleCollection()
        #endif
    }

    /** Bounded owner-only status. No raw UUIDs, anchor, sample, token, or timestamps cross the bridge. */
    func statusForCurrentAccount() async throws -> [String: Any] {
        guard let accountId = try await signedInAccount(), let state = availableState() else {
            throw HealthKitCollectionFailure.unavailable
        }
        _ = try state.activate(accountId: accountId)
        if activeAccountId != accountId {
            generation += 1
            stopObservers()
            scopeOffset = 0
            completedScopes.removeAll()
            activeAccountId = accountId
        }
        let pending = try state.pendingBatches()
        guard pending.count <= 256 else { throw HealthKitCollectionFailure.unavailable }
        return [
            "requestState": try state.collectionEnabled() ? "requested" : "not_requested",
            "pendingCount": pending.count,
            "pauseReason": pending.compactMap(\.pauseReason).first?.rawValue as Any? ?? NSNull(),
        ]
    }

    /** A committed server withdrawal is not reported as complete until local state is deleted. */
    func resetAfterCommittedWithdrawal() throws {
        generation += 1
        activeAccountId = nil
        wakePending = false
        stopObservers()
        guard let state = availableState() else { throw HealthKitCollectionFailure.unavailable }
        try state.reset()
    }

    /// Call only after a visible product action and server-side HealthKit consent.
    /// HealthKit intentionally does not reveal whether read access was denied.
    func requestReadAuthorizationFromProductAction() async throws {
        #if DEBUG
            // Only the isolated, marker-scoped debug probe may request HealthKit in Debug.
            throw HealthKitCollectionFailure.unavailable
        #else
            guard HKHealthStore.isHealthDataAvailable(), let state = availableState() else {
                throw HealthKitCollectionFailure.unavailable
            }
            guard let accountId = try await signedInAccount(),
                case .granted(let revision) = try await NativeAuth.shared.healthKitConsent()
            else {
                throw HealthKitCollectionFailure.unavailable
            }
            _ = try state.activate(accountId: accountId)
            if activeAccountId != accountId {
                generation += 1
                stopObservers()
                scopeOffset = 0
                completedScopes.removeAll()
                activeAccountId = accountId
            }
            if try state.applyConsentRevision(revision) { generation += 1 }
            let fence = HealthKitWorkoutCollectionFence(accountId: accountId, generation: generation)
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                healthStore.requestAuthorization(toShare: [], read: [workoutType]) { success, error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else if success {
                        continuation.resume()
                    } else {
                        continuation.resume(throwing: HealthKitCollectionFailure.unavailable)
                    }
                }
            }
            guard fence.permits(accountId: activeAccountId, generation: generation) else {
                throw HealthKitCollectionFailure.unavailable
            }
            // The previous anchor may have been advanced by an empty response while
            // read access was denied. A fresh snapshot is requested only by this
            // product action, after any older outbox batches have been acknowledged.
            // Request completion is not proof that read access was granted.
            try state.requestReconciliation()
            stopObservers()
            scheduleCollection()
        #endif
    }

    private func invalidateOwner() {
        generation += 1
        activeAccountId = nil
        wakePending = false
        stopObservers()
        state?.deactivate()
    }

    private func scheduleCollection() {
        #if DEBUG
            return
        #else
            wakePending = true
            guard !collecting else { return }
            completedScopes.removeAll()
            collecting = true
            Task { @MainActor in
                defer { collecting = false }
                while wakePending {
                    wakePending = false
                    await collectOnce()
                    if wakePending { try? await Task.sleep(nanoseconds: 1_000_000_000) }
                }
            }
        #endif
    }

    private func collectOnce() async {
        guard HKHealthStore.isHealthDataAvailable(), let state = availableState() else { return }
        let startedAt = generation
        let accountId: String
        do {
            guard let current = try await signedInAccount() else {
                invalidateOwner()
                return
            }
            accountId = current
            guard startedAt == generation else { return }
            if activeAccountId != accountId {
                generation += 1
                stopObservers()
                scopeOffset = 0
                completedScopes.removeAll()
                activeAccountId = accountId
            }
            _ = try state.activate(accountId: accountId)
            let consentGeneration = generation
            state.invalidateRegistrationVerification()
            stopObservers()
            let consent = try await NativeAuth.shared.healthKitConsent()
            guard consentGeneration == generation, activeAccountId == accountId else { return }
            switch consent {
            case .granted(let revision):
                if try state.applyConsentRevision(revision) { generation += 1 }
                let registryGeneration = generation
                let snapshot = try await NativeAuth.shared.fetchHealthKitRegisteredWorkouts(
                    ownerAthleteId: accountId, consentRevision: revision)
                guard registryGeneration == generation, activeAccountId == accountId else { return }
                if try state.applyRegisteredSnapshot(
                    snapshot, accountId: accountId, consentRevision: revision)
                {
                    generation += 1
                    scopeOffset = 0
                    completedScopes.removeAll()
                }
            case .notGranted:
                // Server-side withdrawal makes this account's queued health data invalid.
                try state.reset()
                invalidateOwner()
                return
            case .authenticationRequired:
                invalidateOwner()
                return
            }
            guard try state.collectionEnabled() else { return }
        } catch {
            // A transient session/consent failure does not turn an empty read into proof
            // of no workouts and does not advance the anchor.
            return
        }

        do {
            let scopes = try state.registeredScopes()
            guard !scopes.isEmpty else {
                try state.clearWakePending()
                return
            }
            registerObservers(scopes)
            guard await drainOutbox(accountId: accountId, state: state) else { return }
            _ = try state.beginReconciliationAfterOutboxDrain()
            let fence = HealthKitWorkoutCollectionFence(accountId: accountId, generation: generation)
            for _ in 0..<20 {
                let scope = scopes[scopeOffset % scopes.count]
                let previousAnchor = try state.anchor(scopeKey: scope.key)
                let allowed = Set(scope.claims.map(\.sampleId))
                var limit = 100
                var receivedCount = 0
                while true {
                    let page = try await queryPage(after: previousAnchor, limit: limit, sampleIds: allowed)
                    guard fence.permits(accountId: activeAccountId, generation: generation) else { return }
                    guard let nextAnchor = page.anchor else {
                        throw HealthKitCollectionFailure.invalidAnchor
                    }
                    receivedCount = page.samples.count + page.deleted.count
                    let events = try mapEvents(page.samples, page.deleted, allowed: allowed)
                    if events.isEmpty {
                        try state.advanceEmptyPage(nextAnchor: nextAnchor, scopeKey: scope.key)
                        break
                    }
                    do {
                        try state.stagePage(
                            batchId: UUID(), events: events, nextAnchor: nextAnchor, scopeKey: scope.key)
                        break
                    } catch HealthKitWorkoutStateError.batchTooLarge {
                        guard limit > 1 else { throw HealthKitWorkoutStateError.batchTooLarge }
                        limit = max(1, limit / 2)
                    }
                }
                guard await drainOutbox(accountId: accountId, state: state) else { return }
                if receivedCount < limit {
                    completedScopes.insert(scope.key)
                } else {
                    completedScopes.remove(scope.key)
                }
                scopeOffset = (scopeOffset + 1) % scopes.count
                if completedScopes.count == scopes.count {
                    try state.clearWakePending()
                    return
                }
            }
            // Rotate chunks on every page so a busy chunk cannot starve later registered UUIDs.
            wakePending = true
        } catch {
            // Fail closed: network, invalid scope, mapping, or persistence failure never advances a cursor.
            return
        }
    }

    private func signedInAccount() async throws -> String? {
        let session = try await NativeAuth.shared.currentSession()
        guard session["state"] == "signed_in" else { return nil }
        return session["athleteId"]
    }

    private func stopObservers() {
        for observer in observers { healthStore.stop(observer) }
        observers.removeAll()
    }

    private func registerObservers(_ scopes: [HealthKitWorkoutScope]) {
        #if DEBUG
            return
        #else
            guard observers.isEmpty, HKHealthStore.isHealthDataAvailable() else { return }
            guard let accountId = activeAccountId else { return }
            let fence = HealthKitWorkoutCollectionFence(accountId: accountId, generation: generation)
            for scope in scopes {
                let ids = Set(scope.claims.map(\.sampleId))
                guard !ids.isEmpty else { continue }
                let query = HKObserverQuery(
                    sampleType: workoutType, predicate: HKQuery.predicateForObjects(with: ids)
                ) { [weak self] _, completion, _ in
                    Task { @MainActor in
                        defer { completion() }
                        guard let self,
                            fence.permits(accountId: self.activeAccountId, generation: self.generation)
                        else { return }
                        if let state = self.availableState(), (try? state.markWakePending()) != nil {
                            self.completedScopes.removeAll()
                            self.scheduleCollection()
                        }
                    }
                }
                observers.append(query)
                healthStore.execute(query)
            }
            healthStore.enableBackgroundDelivery(for: workoutType, frequency: .immediate) { _, _ in }
        #endif
    }

    private typealias Page = (samples: [HKSample], deleted: [HKDeletedObject], anchor: HKQueryAnchor?)

    private func queryPage(after anchor: HKQueryAnchor?, limit: Int, sampleIds: Set<UUID>)
        async throws -> Page
    {
        guard !sampleIds.isEmpty, sampleIds.count <= 100 else {
            throw HealthKitCollectionFailure.invalidSample
        }
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKAnchoredObjectQuery(
                type: workoutType, predicate: HKQuery.predicateForObjects(with: sampleIds),
                anchor: anchor, limit: limit
            ) {
                _, samples, deleted, nextAnchor, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: (samples ?? [], deleted ?? [], nextAnchor))
                }
            }
            healthStore.execute(query)
        }
    }

    private func mapEvents(_ samples: [HKSample], _ deleted: [HKDeletedObject], allowed: Set<UUID>)
        throws
        -> [HealthKitWorkoutEvent]
    {
        var events: [HealthKitWorkoutEvent] = []
        var indexes: [UUID: Int] = [:]
        for sample in samples {
            guard allowed.contains(sample.uuid), let workout = sample as? HKWorkout else {
                throw HealthKitCollectionFailure.invalidSample
            }
            let source = workout.sourceRevision.source.bundleIdentifier
            let rawVersion = workout.sourceRevision.version
            let version = rawVersion.flatMap {
                $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0
            }
            let duration = workout.duration
            let distance = workout.totalDistance?.doubleValue(for: .meter())
            let energy = workout.totalEnergyBurned?.doubleValue(for: .kilocalorie())
            guard !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                source.utf16.count <= 255,
                (version?.utf16.count ?? 0) <= 128,
                duration.isFinite, (0...2_678_400).contains(duration),
                workout.endDate >= workout.startDate,
                workout.workoutActivityType.rawValue <= 1_000_000,
                validMetric(distance), validMetric(energy)
            else {
                throw HealthKitCollectionFailure.invalidSample
            }
            let event = HealthKitWorkoutEvent.upsert(
                HealthKitWorkoutUpsert(
                    sampleId: workout.uuid,
                    sourceBundleId: source,
                    sourceVersion: version,
                    activityType: Int(workout.workoutActivityType.rawValue),
                    observedFrom: Self.instant(workout.startDate),
                    observedTo: Self.instant(workout.endDate),
                    durationSeconds: duration,
                    distanceMeters: distance,
                    energyKilocalories: energy
                ))
            if let index = indexes[workout.uuid] {
                events[index] = event
            } else {
                indexes[workout.uuid] = events.count
                events.append(event)
            }
        }
        for deletion in deleted {
            guard allowed.contains(deletion.uuid) else { throw HealthKitCollectionFailure.invalidSample }
            let event = HealthKitWorkoutEvent.delete(sampleId: deletion.uuid)
            if let index = indexes[deletion.uuid] {
                events[index] = event
            } else {
                indexes[deletion.uuid] = events.count
                events.append(event)
            }
        }
        guard events.count <= 100 else { throw HealthKitCollectionFailure.invalidSample }
        return events
    }

    private func validMetric(_ value: Double?) -> Bool {
        guard let value else { return true }
        return value.isFinite && (0...1_000_000_000).contains(value)
    }

    private static func instant(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private func drainOutbox(accountId: String, state: HealthKitWorkoutState) async -> Bool {
        let fence = HealthKitWorkoutCollectionFence(accountId: accountId, generation: generation)
        do {
            for batch in try state.pendingBatches() {
                guard fence.permits(accountId: activeAccountId, generation: generation) else { return false }
                // A permanent server rejection is held for explicit investigation.
                // Keep later batches behind it so replay order cannot change.
                guard !batch.isPaused, try state.batchMayUpload(batch) else { return false }
                guard let consentRevision = batch.consentRevision else { return false }
                let outcome = try await NativeAuth.shared.uploadHealthKitWorkoutBatch(
                    body: batch.body,
                    ownerAthleteId: accountId,
                    installationId: batch.installationId,
                    batchId: batch.batchId,
                    eventCount: batch.eventCount,
                    consentRevision: consentRevision)
                guard fence.permits(accountId: activeAccountId, generation: generation) else { return false }
                switch outcome {
                case .accepted:
                    guard
                        try state.acknowledge(
                            batchId: batch.batchId,
                            installationId: batch.installationId,
                            acceptedCount: batch.eventCount)
                    else { return false }
                case .authenticationRequired:
                    invalidateOwner()
                    return false
                case .consentRequired:
                    try state.reset()
                    invalidateOwner()
                    return false
                case .consentEpochExpired:
                    // Only this server-owned error can discard old epoch data. Generic
                    // idempotency conflicts remain quarantined for investigation.
                    switch try await NativeAuth.shared.healthKitConsent() {
                    case .granted(let currentRevision):
                        guard fence.permits(accountId: activeAccountId, generation: generation) else { return false }
                        _ = try state.applyConsentRevision(currentRevision, forceReset: true)
                        generation += 1
                        scheduleCollection()
                    case .notGranted:
                        try state.reset()
                        invalidateOwner()
                    case .authenticationRequired:
                        invalidateOwner()
                    }
                    return false
                case .forbidden:
                    try state.pause(batchId: batch.batchId, reason: .forbidden)
                    return false
                case .conflict:
                    try state.pause(batchId: batch.batchId, reason: .conflict)
                    return false
                case .rejected:
                    try state.pause(batchId: batch.batchId, reason: .rejected)
                    return false
                }
            }
            return true
        } catch {
            // Network/5xx/malformed ACK are retried only on a later wake.
            return false
        }
    }
}
