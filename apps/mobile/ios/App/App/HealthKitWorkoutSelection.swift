import Foundation

/// A sideband cancellation can target only the sheet opened by that exchange, including a lost open ACK.
struct HealthKitWorkoutSelectionExchangeLifetime {
    private var opened: (requestId: String, selectionId: UUID)?
    mutating func record(requestId: String, selectionId: UUID) { opened = (requestId, selectionId) }
    mutating func cancelRequest(_ requestId: String) -> UUID? {
        guard let value = opened, value.requestId == requestId else { return nil }
        opened = nil
        return value.selectionId
    }
    mutating func forget(_ selectionId: UUID) {
        if opened?.selectionId == selectionId { opened = nil }
    }
}

struct HealthKitWorkoutSelectionContext: Equatable {
    let ownerAthleteId: String
    let sessionId: String
    let consentRevision: Int
    let credentialIdentity: UUID
}

struct HealthKitWorkoutCandidate: Equatable {
    let sampleId: UUID
    let activityType: UInt
    let start: Date
    let end: Date
    let duration: Double
}

enum HealthKitWorkoutSelectionState: String {
    case idle, loading, choosing, confirming, registering, registered, refresh_pending
    case cancelled, offline, conflict, consent_required, unauthorized, unavailable
}

enum HealthKitWorkoutSelectionError: Error, Equatable {
    case invalidInput, stale, invalidReply, unavailable, offline, conflict, consentRequired, unauthorized
}

struct HealthKitWorkoutRegistrationRequest {
    let context: HealthKitWorkoutSelectionContext
    let sampleIds: [UUID]
    let expectedRegistryRevision: Int
    let idempotencyKey: String
    let body: Data
    private(set) var isRetry = false

    func asRetry() -> Self {
        var copy = self
        copy.isRetry = true
        return copy
    }

    init(
        context: HealthKitWorkoutSelectionContext, sampleIds: [UUID], registryRevision: Int,
        idempotencyKey: String = UUID().uuidString.lowercased()
    ) throws {
        guard (1...2_147_483_647).contains(context.consentRevision),
            !context.ownerAthleteId.isEmpty, !context.sessionId.isEmpty,
            (0...2_147_483_647).contains(registryRevision),
            (1...50).contains(sampleIds.count), Set(sampleIds).count == sampleIds.count,
            idempotencyKey.range(of: "^[A-Za-z0-9_-]{8,128}$", options: .regularExpression) != nil
        else {
            throw HealthKitWorkoutSelectionError.invalidInput
        }
        self.context = context
        self.sampleIds = sampleIds.sorted { $0.uuidString < $1.uuidString }
        self.expectedRegistryRevision = registryRevision
        self.idempotencyKey = idempotencyKey
        self.body = try JSONSerialization.data(
            withJSONObject: [
                "schemaVersion": 1, "sampleIds": self.sampleIds.map { $0.uuidString.lowercased() },
                "accountAttributionDeclared": true, "expectedConsentRevision": context.consentRevision,
                "expectedRegistryRevision": registryRevision, "idempotencyKey": idempotencyKey,
            ], options: [.sortedKeys])
        guard body.count <= 16_384 else { throw HealthKitWorkoutSelectionError.invalidInput }
    }

    func validatedReply(_ data: Data) throws -> HealthKitWorkoutRegistrationSnapshot {
        guard data.count <= 16_384,
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            Set(object.keys) == ["schemaVersion", "claims", "registryRevision"],
            HealthKitWorkoutUploader.number(object["schemaVersion"]) == 1,
            let revision = HealthKitWorkoutUploader.number(object["registryRevision"]),
            revision.rounded() == revision, (1...2_147_483_647).contains(revision),
            revision >= Double(expectedRegistryRevision),
            let items = object["claims"] as? [[String: Any]], items.count == sampleIds.count
        else {
            throw HealthKitWorkoutSelectionError.invalidReply
        }
        var claims: [HealthKitWorkoutClaim] = []
        for item in items {
            guard Set(item.keys) == ["sampleId", "claimEpoch"],
                let idText = item["sampleId"] as? String, let id = UUID(uuidString: idText),
                let epochText = item["claimEpoch"] as? String, let epoch = UUID(uuidString: epochText)
            else {
                throw HealthKitWorkoutSelectionError.invalidReply
            }
            claims.append(.init(sampleId: id, claimEpoch: epoch))
        }
        guard Set(claims.map(\.sampleId)) == Set(sampleIds),
            Set(claims.map(\.sampleId)).count == claims.count
        else { throw HealthKitWorkoutSelectionError.invalidReply }
        return .init(registryRevision: Int(revision), claims: claims)
    }
}

/// Native-only memory. The bridge receives bounded states/counts, never candidate metadata or identifiers.
struct HealthKitWorkoutSelectionSession {
    private(set) var state: HealthKitWorkoutSelectionState = .idle
    private(set) var context: HealthKitWorkoutSelectionContext?
    private(set) var candidates: [HealthKitWorkoutCandidate] = []
    private(set) var selected = Set<UUID>()
    private(set) var registeredCount: Int?
    private(set) var resultCount: Int?
    private(set) var pending: HealthKitWorkoutRegistrationRequest?
    private(set) var acknowledgement: HealthKitWorkoutRegistrationSnapshot?
    private(set) var generation = 0
    private(set) var selectionId: UUID?
    private var registryRevision: Int?
    private var transmitted = false

    var status: [String: Any] {
        [
            "state": state.rawValue, "registeredCount": registeredCount as Any? ?? NSNull(),
            "selectedCount": selected.count, "resultCount": resultCount as Any? ?? NSNull(),
        ]
    }

    mutating func begin(_ context: HealthKitWorkoutSelectionContext) -> Int {
        let next = generation + 1
        self = Self()
        self.context = context
        generation = next
        selectionId = UUID()
        state = .loading
        return generation
    }
    mutating func reload() throws -> Int {
        guard let context, let selectionId, pending == nil else { throw HealthKitWorkoutSelectionError.invalidInput }
        let generation = begin(context)
        self.selectionId = selectionId
        return generation
    }

    func permitsUI(selectionId: UUID, generation: Int? = nil) -> Bool {
        self.selectionId == selectionId && context != nil && (generation == nil || self.generation == generation)
    }

    func current(_ expected: HealthKitWorkoutSelectionContext, generation: Int) -> Bool {
        context == expected && self.generation == generation && state != .cancelled && state != .unauthorized
    }

    mutating func loaded(
        _ values: [HealthKitWorkoutCandidate], snapshot: HealthKitWorkoutRegistrationSnapshot,
        from: Date, through: Date, generation: Int
    ) throws {
        guard self.generation == generation, state == .loading, context != nil,
            through >= from, through.timeIntervalSince(from) <= 366 * 86_400,
            values.count <= 200, Set(values.map(\.sampleId)).count == values.count,
            (0...2_147_483_647).contains(snapshot.registryRevision), snapshot.claims.count <= 10_000,
            Set(snapshot.claims.map(\.sampleId)).count == snapshot.claims.count,
            values.allSatisfy({
                $0.start >= from && $0.end <= through && $0.end >= $0.start && $0.activityType <= 1_000_000
                    && $0.duration.isFinite && (0...2_678_400).contains($0.duration)
            })
        else {
            throw HealthKitWorkoutSelectionError.invalidInput
        }
        let alreadyRegistered = Set(snapshot.claims.map(\.sampleId))
        candidates = values.filter { !alreadyRegistered.contains($0.sampleId) }.sorted {
            if $0.start == $1.start { return $0.sampleId.uuidString < $1.sampleId.uuidString }
            return $0.start > $1.start
        }
        registryRevision = snapshot.registryRevision
        registeredCount = snapshot.claims.count
        state = .choosing
    }

    mutating func toggle(_ id: UUID) throws {
        guard state == .choosing, candidates.contains(where: { $0.sampleId == id }) else {
            throw HealthKitWorkoutSelectionError.invalidInput
        }
        if selected.contains(id) {
            selected.remove(id)
        } else {
            guard selected.count < 50 else { throw HealthKitWorkoutSelectionError.invalidInput }
            selected.insert(id)
        }
    }
    mutating func showConfirmation() throws {
        guard state == .choosing, !selected.isEmpty else { throw HealthKitWorkoutSelectionError.invalidInput }
        state = .confirming
    }
    mutating func continueChoosing() { if state == .confirming { state = .choosing } }
    mutating func confirm(accountAttributionDeclared: Bool) throws -> HealthKitWorkoutRegistrationRequest {
        guard state == .confirming, accountAttributionDeclared, let context, let registryRevision else {
            throw HealthKitWorkoutSelectionError.invalidInput
        }
        let request = try HealthKitWorkoutRegistrationRequest(
            context: context, sampleIds: Array(selected), registryRevision: registryRevision)
        pending = request
        resultCount = nil
        state = .registering
        return request
    }
    mutating func retry() throws -> HealthKitWorkoutRegistrationRequest {
        guard state == .offline, let pending, acknowledgement == nil else {
            throw HealthKitWorkoutSelectionError.invalidInput
        }
        state = .registering
        return pending.asRetry()
    }
    mutating func markTransmitted() { if state == .registering { transmitted = true } }
    mutating func acknowledged(_ snapshot: HealthKitWorkoutRegistrationSnapshot, generation: Int) throws {
        guard self.generation == generation, state == .registering, let pending,
            (1...2_147_483_647).contains(snapshot.registryRevision),
            snapshot.registryRevision >= pending.expectedRegistryRevision,
            snapshot.claims.count == pending.sampleIds.count,
            Set(snapshot.claims.map(\.sampleId)) == Set(pending.sampleIds)
        else { throw HealthKitWorkoutSelectionError.stale }
        acknowledgement = snapshot
        resultCount = snapshot.claims.count
        registeredCount = nil
        state = .refresh_pending
    }
    mutating func refreshed(_ snapshot: HealthKitWorkoutRegistrationSnapshot, generation: Int) throws {
        guard self.generation == generation, state == .refresh_pending, let acknowledgement else {
            throw HealthKitWorkoutSelectionError.stale
        }
        guard (0...2_147_483_647).contains(snapshot.registryRevision),
            snapshot.registryRevision >= acknowledgement.registryRevision,
            snapshot.claims.count <= 10_000, Set(snapshot.claims.map(\.sampleId)).count == snapshot.claims.count
        else { throw HealthKitWorkoutSelectionError.conflict }
        let lookup = Dictionary(uniqueKeysWithValues: snapshot.claims.map { ($0.sampleId, $0.claimEpoch) })
        guard acknowledgement.claims.allSatisfy({ lookup[$0.sampleId] == $0.claimEpoch }) else {
            throw HealthKitWorkoutSelectionError.conflict
        }
        registeredCount = snapshot.claims.count
        state = .registered
        candidates.removeAll()
        selected.removeAll()
        pending = nil
        transmitted = false
    }
    mutating func failed(_ failure: HealthKitWorkoutSelectionState) {
        guard [.offline, .conflict, .consent_required, .unauthorized, .unavailable].contains(failure) else { return }
        if failure == .unauthorized || failure == .consent_required {
            invalidate(failure)
            return
        }
        registeredCount = nil
        state = acknowledgement != nil && failure == .offline ? .refresh_pending : failure
    }
    mutating func cancel(selectionId: UUID) {
        guard self.selectionId == selectionId else { return }
        let uncertain = transmitted
        invalidate(uncertain ? .refresh_pending : .cancelled)
    }
    mutating func invalidate(_ state: HealthKitWorkoutSelectionState = .unauthorized) {
        generation += 1
        context = nil
        candidates.removeAll()
        selected.removeAll()
        pending = nil
        acknowledgement = nil
        registeredCount = nil
        resultCount = nil
        registryRevision = nil
        transmitted = false
        self.state = state
    }
}
