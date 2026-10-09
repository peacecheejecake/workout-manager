import Foundation

enum HealthKitWorkoutManagementState: String {
    case idle, loading, choosing, confirming, deregistering, released, cancelled
    case pendingCleanup = "pending_cleanup"
    case offline, conflict, unauthorized, unavailable
    case consentRequired = "consent_required"
    case legacyBlocked = "legacy_blocked"
}
enum HealthKitWorkoutManagementError: Error {
    case legacyBlocked
    static func isLegacyBlocked(_ data: Data) -> Bool {
        guard data.count <= 4096,
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            Set(object.keys) == ["error", "requestId"],
            let requestId = object["requestId"] as? String, UUID(uuidString: requestId) != nil,
            let error = object["error"] as? [String: Any], Set(error.keys) == ["code"]
        else { return false }
        return error["code"] as? String == "RECEIPT_MEMBERSHIP_REQUIRED"
    }
}

struct HealthKitWorkoutDeregistrationRequest {
    let context: HealthKitWorkoutSelectionContext
    let claim: HealthKitWorkoutClaim
    let expectedRegistryRevision: Int
    let idempotencyKey: String
    let body: Data
    private(set) var isRetry = false
    func asRetry() -> Self {
        var value = self
        value.isRetry = true
        return value
    }
    init(
        context: HealthKitWorkoutSelectionContext, claim: HealthKitWorkoutClaim,
        registryRevision: Int,
        idempotencyKey: String = UUID().uuidString.lowercased()
    ) throws {
        guard (1...2_147_483_647).contains(context.consentRevision),
            (0...2_147_483_647).contains(registryRevision),
            idempotencyKey.range(of: "^[A-Za-z0-9_-]{8,128}$", options: .regularExpression) != nil
        else {
            throw HealthKitWorkoutSelectionError.invalidInput
        }
        self.context = context
        self.claim = claim
        expectedRegistryRevision = registryRevision
        self.idempotencyKey = idempotencyKey
        body = try JSONSerialization.data(
            withJSONObject: [
                "schemaVersion": 1, "sampleId": claim.sampleId.uuidString.lowercased(),
                "claimEpoch": claim.claimEpoch.uuidString.lowercased(),
                "expectedConsentRevision": context.consentRevision,
                "expectedRegistryRevision": registryRevision,
                "confirmRelatedRecordDeletion": true, "idempotencyKey": idempotencyKey,
            ], options: [.sortedKeys])
    }
}
struct HealthKitWorkoutDeregistrationReceipt {
    let operationId: UUID
    let state: HealthKitWorkoutManagementState
    let registryRevision: Int
    static func parse(_ data: Data, minimumRevision: Int, operationId: UUID? = nil) throws -> Self {
        guard data.count <= 4096,
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            Set(object.keys) == ["schemaVersion", "operationId", "status", "registryRevision"],
            HealthKitWorkoutUploader.number(object["schemaVersion"]) == 1,
            let text = object["operationId"] as? String, let id = UUID(uuidString: text),
            operationId == nil || operationId == id,
            let status = object["status"] as? String,
            let state = HealthKitWorkoutManagementState(rawValue: status),
            [.pendingCleanup, .released].contains(state),
            let revision = HealthKitWorkoutUploader.number(object["registryRevision"]),
            revision.rounded() == revision, (1...2_147_483_647).contains(revision),
            revision >= Double(minimumRevision)
        else { throw HealthKitWorkoutSelectionError.invalidReply }
        return .init(operationId: id, state: state, registryRevision: Int(revision))
    }
}
/// All identifiers/epochs and retry payloads are native-only. The opaque managementId identifies UI lifetime only.
struct HealthKitWorkoutManagementSession {
    private(set) var state: HealthKitWorkoutManagementState = .idle
    private(set) var context: HealthKitWorkoutSelectionContext?
    private(set) var managementId: UUID?
    private(set) var generation = 0
    private(set) var claims: [HealthKitWorkoutClaim] = []
    private(set) var selected: UUID?
    private(set) var registeredCount: Int?
    private(set) var resultCount: Int?
    private(set) var pending: HealthKitWorkoutDeregistrationRequest?
    private(set) var receipt: HealthKitWorkoutDeregistrationReceipt?
    private var registryRevision: Int?
    private(set) var transmitted = false
    var status: [String: Any] {
        [
            "state": state.rawValue,
            "registeredCount": registeredCount as Any? ?? NSNull(),
            "selectedCount": selected == nil ? 0 : 1,
            "resultCount": resultCount as Any? ?? NSNull(),
        ]
    }
    mutating func begin(_ context: HealthKitWorkoutSelectionContext) -> Int {
        let next = generation + 1
        self = Self()
        generation = next
        self.context = context
        managementId = UUID()
        state = .loading
        return next
    }
    var canResume: Bool { transmitted && pending != nil && state != .released }
    mutating func resume(_ context: HealthKitWorkoutSelectionContext) throws -> Int {
        guard canResume, self.context == context else { throw HealthKitWorkoutSelectionError.stale }
        generation += 1
        managementId = UUID()
        claims = []
        selected = nil
        registeredCount = nil
        resultCount = nil
        state = receipt == nil ? .offline : .pendingCleanup
        return generation
    }
    mutating func markTransmitted() throws {
        guard pending != nil, context != nil, state == .deregistering else {
            throw HealthKitWorkoutSelectionError.stale
        }
        transmitted = true
    }
    mutating func close() {
        guard transmitted, pending != nil else {
            invalidate(.cancelled)
            return
        }
        generation += 1
        claims = []
        selected = nil
        if state != .released {
            registeredCount = nil
            resultCount = nil
            state = receipt == nil ? .offline : .pendingCleanup
        }
    }
    func current(_ context: HealthKitWorkoutSelectionContext, generation: Int) -> Bool {
        self.context == context && self.generation == generation
    }
    func permits(_ id: UUID, generation: Int? = nil) -> Bool {
        managementId == id && context != nil && (generation == nil || generation == self.generation)
    }
    mutating func loaded(_ snapshot: HealthKitWorkoutRegistrationSnapshot, generation: Int) throws {
        guard generation == self.generation, context != nil, state == .loading,
            (0...2_147_483_647).contains(snapshot.registryRevision),
            snapshot.claims.count <= 10_000,
            Set(snapshot.claims.map(\.sampleId)).count == snapshot.claims.count
        else {
            throw HealthKitWorkoutSelectionError.invalidInput
        }
        claims = snapshot.claims.sorted { $0.sampleId.uuidString < $1.sampleId.uuidString }
        registeredCount = claims.count
        registryRevision = snapshot.registryRevision
        state = .choosing
    }
    mutating func select(_ id: UUID) throws {
        guard state == .choosing, claims.contains(where: { $0.sampleId == id }) else {
            throw HealthKitWorkoutSelectionError.invalidInput
        }
        selected = selected == id ? nil : id
    }
    mutating func showConfirmation() throws {
        guard state == .choosing, selected != nil else {
            throw HealthKitWorkoutSelectionError.invalidInput
        }
        state = .confirming
    }
    mutating func continueChoosing() { if state == .confirming { state = .choosing } }
    mutating func confirm(deletionDeclared: Bool) throws -> HealthKitWorkoutDeregistrationRequest {
        guard state == .confirming, deletionDeclared, let context, let registryRevision,
            let claim = claims.first(where: { $0.sampleId == selected })
        else {
            throw HealthKitWorkoutSelectionError.invalidInput
        }
        let request = try HealthKitWorkoutDeregistrationRequest(
            context: context, claim: claim,
            registryRevision: registryRevision)
        pending = request
        state = .deregistering
        return request
    }
    mutating func retry() throws -> HealthKitWorkoutDeregistrationRequest {
        guard [.offline, .unavailable].contains(state), receipt == nil, let pending else {
            throw HealthKitWorkoutSelectionError.invalidInput
        }
        state = .deregistering
        return pending.asRetry()
    }
    mutating func acknowledged(_ receipt: HealthKitWorkoutDeregistrationReceipt, generation: Int)
        throws
    {
        guard generation == self.generation, context != nil, let pending,
            receipt.registryRevision >= pending.expectedRegistryRevision,
            self.receipt == nil || self.receipt?.operationId == receipt.operationId,
            self.receipt?.state != .released || receipt.state == .released,
            receipt.registryRevision >= (self.receipt?.registryRevision ?? 0)
        else {
            throw HealthKitWorkoutSelectionError.invalidReply
        }
        self.receipt = receipt
        state = .pendingCleanup
        resultCount = nil
        registeredCount = nil
    }
    mutating func refreshed(_ snapshot: HealthKitWorkoutRegistrationSnapshot, generation: Int)
        throws
    {
        guard generation == self.generation, context != nil, let receipt, let pending,
            snapshot.registryRevision >= receipt.registryRevision, snapshot.claims.count <= 10_000,
            Set(snapshot.claims.map(\.sampleId)).count == snapshot.claims.count,
            !snapshot.claims.contains(where: { $0.sampleId == pending.claim.sampleId })
        else {
            throw HealthKitWorkoutSelectionError.conflict
        }
        claims = snapshot.claims
        registeredCount = claims.count
        selected = nil
        state = receipt.state
        resultCount = receipt.state == .released ? 1 : nil
    }
    mutating func failed(_ state: HealthKitWorkoutManagementState) {
        registeredCount = nil
        resultCount = nil
        self.state = state
    }
    mutating func invalidate(_ state: HealthKitWorkoutManagementState) {
        let next = generation + 1
        let handle = managementId
        self = Self()
        generation = next
        managementId = handle
        self.state = state
    }
}

/// Shared by bridge status polling and UIKit retry: one bounded operation, with token-fenced completion.
@MainActor
final class HealthKitWorkoutManagementWork {
    private(set) var task: Task<Void, Never>?
    private var token: UUID?
    var isRunning: Bool { task != nil }
    @discardableResult
    func start(_ operation: @escaping @MainActor () async -> Void) -> Bool {
        guard task == nil else { return false }
        let current = UUID()
        token = current
        task = Task { @MainActor in
            defer {
                if token == current {
                    task = nil
                    token = nil
                }
            }
            await operation()
        }
        return true
    }
    func wait() async { if let task { await task.value } }
    func cancel() {
        token = nil
        task?.cancel()
        task = nil
    }
    deinit { task?.cancel() }
}
