import Foundation
import HealthKit

private enum HealthKitCollectionFailure: Error {
    case unavailable
    case invalidSample
    case invalidAnchor
}

/** Workout-only collector. The OS read prompt is reserved for an explicit product action. */
@MainActor
final class HealthKitWorkoutCollector {
    static let shared = HealthKitWorkoutCollector()

    private let workoutType = HKObjectType.workoutType()
    private let healthStore = HKHealthStore()
    private var state: HealthKitWorkoutState?
    private var observer: HKObserverQuery?
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
        let support = FileManager.default.urls(for: .applicationSupportDirectory,
                                               in: .userDomainMask).first
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
        scheduleCollection()
    }

    func sceneDidBecomeActive() {
        scheduleCollection()
    }

    /** Bounded owner-only status. No raw UUIDs, anchor, sample, token, or timestamps cross the bridge. */
    func statusForCurrentAccount() async throws -> [String: Any] {
        guard let accountId = try await signedInAccount(), let state = availableState() else {
            throw HealthKitCollectionFailure.unavailable
        }
        _ = try state.activate(accountId: accountId)
        let pending = try state.pendingBatches()
        guard pending.count <= 256 else { throw HealthKitCollectionFailure.unavailable }
        return [
            "requestState": try state.collectionEnabled() ? "requested" : "not_requested",
            "pendingCount": pending.count,
            "pauseReason": pending.compactMap(\.pauseReason).first?.rawValue as Any? ?? NSNull()
        ]
    }

    /** A committed server withdrawal is not reported as complete until local state is deleted. */
    func resetAfterCommittedWithdrawal() throws {
        generation += 1
        activeAccountId = nil
        wakePending = false
        if let observer {
            healthStore.stop(observer)
            self.observer = nil
        }
        guard let state = availableState() else { throw HealthKitCollectionFailure.unavailable }
        try state.reset()
    }

    /// Call only after a visible product action and server-side HealthKit consent.
    /// HealthKit intentionally does not reveal whether read access was denied.
    func requestReadAuthorizationFromProductAction() async throws {
        guard HKHealthStore.isHealthDataAvailable(), let state = availableState() else {
            throw HealthKitCollectionFailure.unavailable
        }
        guard let accountId = try await signedInAccount(),
              case .granted = try await NativeAuth.shared.healthKitConsent() else {
            throw HealthKitCollectionFailure.unavailable
        }
        _ = try state.activate(accountId: accountId)
        if activeAccountId != accountId {
            generation += 1
            activeAccountId = accountId
        }
        let ownerGeneration = generation
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            healthStore.requestAuthorization(toShare: [], read: [workoutType]) { success, error in
                if let error { continuation.resume(throwing: error) }
                else if success { continuation.resume() }
                else { continuation.resume(throwing: HealthKitCollectionFailure.unavailable) }
            }
        }
        guard ownerGeneration == generation, activeAccountId == accountId else {
            throw HealthKitCollectionFailure.unavailable
        }
        // This records an explicit request, not proof that read access was granted.
        try state.enableCollection()
        try state.markWakePending()
        registerObserverIfNeeded()
        scheduleCollection()
    }

    private func invalidateOwner() {
        generation += 1
        activeAccountId = nil
        wakePending = false
        if let observer {
            healthStore.stop(observer)
            self.observer = nil
        }
        try? state?.reset()
    }

    private func scheduleCollection() {
        wakePending = true
        guard !collecting else { return }
        collecting = true
        Task { @MainActor in
            defer { collecting = false }
            while wakePending {
                wakePending = false
                await collectOnce()
                if wakePending { try? await Task.sleep(nanoseconds: 1_000_000_000) }
            }
        }
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
                activeAccountId = accountId
            }
            _ = try state.activate(accountId: accountId)
            let consent = try await NativeAuth.shared.healthKitConsent()
            guard activeAccountId == accountId else { return }
            switch consent {
            case .granted: break
            case .notGranted, .authenticationRequired:
                invalidateOwner()
                return
            }
            guard try state.collectionEnabled() else { return }
        } catch {
            // A transient session/consent failure does not turn an empty read into proof
            // of no workouts and does not advance the anchor.
            return
        }

        registerObserverIfNeeded()
        guard await drainOutbox(accountId: accountId, state: state) else { return }
        let ownerGeneration = generation
        for _ in 0..<20 {
            do {
                let previousAnchor = try state.anchor()
                var limit = 100
                var receivedCount = 0
                while true {
                    let page = try await queryPage(after: previousAnchor, limit: limit)
                    guard ownerGeneration == generation, activeAccountId == accountId else { return }
                    guard let nextAnchor = page.anchor else {
                        throw HealthKitCollectionFailure.invalidAnchor
                    }
                    receivedCount = page.samples.count + page.deleted.count
                    let events = try mapEvents(page.samples, page.deleted)
                    if events.isEmpty {
                        try state.advanceEmptyPage(nextAnchor: nextAnchor)
                        try state.clearWakePending()
                        return
                    }
                    do {
                        try state.stagePage(batchId: UUID(), events: events, nextAnchor: nextAnchor)
                        break
                    } catch HealthKitWorkoutStateError.batchTooLarge {
                        // A 100-item page can exceed the 64 KiB wire cap. Requery
                        // the same anchor with a smaller limit; never skip its data.
                        guard limit > 1 else { throw HealthKitWorkoutStateError.batchTooLarge }
                        limit = max(1, limit / 2)
                    }
                }
                guard await drainOutbox(accountId: accountId, state: state) else { return }
                if receivedCount < limit {
                    try state.clearWakePending()
                    return
                }
            } catch {
                // On a failed query, mapping, or transaction, keep the old anchor.
                return
            }
        }
        // One pass handles at most 20 pages. Keep the durable wake and schedule
        // another pass after a pause, including when page limits were reduced.
        wakePending = true
    }

    private func signedInAccount() async throws -> String? {
        let session = try await NativeAuth.shared.currentSession()
        guard session["state"] == "signed_in" else { return nil }
        return session["athleteId"]
    }

    private func registerObserverIfNeeded() {
        guard observer == nil, HKHealthStore.isHealthDataAvailable() else { return }
        let query = HKObserverQuery(sampleType: workoutType, predicate: nil) { [weak self] _, completion, _ in
            Task { @MainActor in
                if let self {
                    // The OS wake is acknowledged after its retry intent is durable.
                    if let state = self.availableState(), (try? state.markWakePending()) != nil {
                        self.scheduleCollection()
                    } else {
                        // If the state store is unavailable, try a bounded pass
                        // before acknowledging; launch/foreground retry remains.
                        await self.collectOnce()
                    }
                }
                completion()
            }
        }
        observer = query
        healthStore.execute(query)
        healthStore.enableBackgroundDelivery(for: workoutType, frequency: .immediate) { _, _ in
            // Delivery is best effort; foreground/launch also checks the persisted anchor.
        }
    }

    private typealias Page = (samples: [HKSample], deleted: [HKDeletedObject], anchor: HKQueryAnchor?)

    private func queryPage(after anchor: HKQueryAnchor?, limit: Int) async throws -> Page {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKAnchoredObjectQuery(type: workoutType, predicate: nil,
                                              anchor: anchor, limit: limit) {
                _, samples, deleted, nextAnchor, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: (samples ?? [], deleted ?? [], nextAnchor)) }
            }
            healthStore.execute(query)
        }
    }

    private func mapEvents(_ samples: [HKSample], _ deleted: [HKDeletedObject]) throws
        -> [HealthKitWorkoutEvent] {
        var events: [HealthKitWorkoutEvent] = []
        var indexes: [UUID: Int] = [:]
        for sample in samples {
            guard let workout = sample as? HKWorkout else {
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
                  validMetric(distance), validMetric(energy) else {
                throw HealthKitCollectionFailure.invalidSample
            }
            let event = HealthKitWorkoutEvent.upsert(HealthKitWorkoutUpsert(
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
            if let index = indexes[workout.uuid] { events[index] = event }
            else {
                indexes[workout.uuid] = events.count
                events.append(event)
            }
        }
        for deletion in deleted {
            let event = HealthKitWorkoutEvent.delete(sampleId: deletion.uuid)
            if let index = indexes[deletion.uuid] { events[index] = event }
            else {
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
        do {
            for batch in try state.pendingBatches() {
                guard activeAccountId == accountId else { return false }
                // A permanent server rejection is held for explicit investigation.
                // Keep later batches behind it so replay order cannot change.
                guard !batch.isPaused else { return false }
                let outcome = try await NativeAuth.shared.uploadHealthKitWorkoutBatch(
                    body: batch.body,
                    ownerAthleteId: accountId,
                    installationId: batch.installationId,
                    batchId: batch.batchId,
                    eventCount: batch.eventCount)
                guard activeAccountId == accountId else { return false }
                switch outcome {
                case .accepted:
                    guard try state.acknowledge(batchId: batch.batchId,
                                                installationId: batch.installationId,
                                                acceptedCount: batch.eventCount) else { return false }
                case .authenticationRequired, .consentRequired:
                    invalidateOwner()
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
