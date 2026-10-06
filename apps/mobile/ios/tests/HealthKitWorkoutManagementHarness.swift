import Foundation

private enum ManagementFailure: Error { case failed(String) }
@main struct HealthKitWorkoutManagementHarness {
    static var checks = 0
    static func require(_ value: Bool, _ label: String) throws {
        checks += 1
        if !value { throw ManagementFailure.failed(label) }
    }
    static func reject(_ label: String, _ action: () throws -> Void) throws {
        do { try action() } catch is HealthKitWorkoutSelectionError {
            checks += 1
            return
        }
        throw ManagementFailure.failed(label)
    }
    static func data(_ operation: UUID, _ status: String, revision: Any = 4) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1, "operationId": operation.uuidString,
            "status": status, "registryRevision": revision,
        ])
    }
    @MainActor static func main() async throws {
        let context = HealthKitWorkoutSelectionContext(
            ownerAthleteId: "synthetic_a", sessionId: "synthetic_session",
            consentRevision: 1, credentialIdentity: UUID())
        let claim = HealthKitWorkoutClaim(sampleId: UUID(), claimEpoch: UUID())
        let other = HealthKitWorkoutClaim(sampleId: UUID(), claimEpoch: UUID())
        var session = HealthKitWorkoutManagementSession()
        let generation = session.begin(context)
        guard let handle = session.managementId else { throw ManagementFailure.failed("handle") }
        try require(
            handle != claim.sampleId && handle != claim.claimEpoch, "separate native handle")
        try require(session.registeredCount == nil && session.resultCount == nil, "loading unknown")
        try reject("no implicit delete") { _ = try session.confirm(deletionDeclared: true) }
        try session.loaded(
            .init(registryRevision: 3, claims: [claim, other]), generation: generation)
        try require(session.state == .choosing && session.pending == nil, "list not deletion")
        try reject("foreign sample") { try session.select(UUID()) }
        try session.select(claim.sampleId)
        try session.select(other.sampleId)
        try require(session.selected == other.sampleId, "single explicit target")
        try session.select(claim.sampleId)
        try session.showConfirmation()
        try require(session.pending == nil, "confirmation dialog no write")
        try reject("deletion declaration required") {
            _ = try session.confirm(deletionDeclared: false)
        }
        session.continueChoosing()
        try session.showConfirmation()
        let request = try session.confirm(deletionDeclared: true)
        let body = try JSONSerialization.jsonObject(with: request.body) as? [String: Any]
        try require(
            Set(body?.keys.map { $0 } ?? []) == [
                "schemaVersion", "sampleId", "claimEpoch",
                "expectedConsentRevision", "expectedRegistryRevision",
                "confirmRelatedRecordDeletion",
                "idempotencyKey",
            ], "strict native POST")
        session.failed(.offline)
        let replay = try session.retry()
        try require(
            replay.body == request.body && replay.idempotencyKey == request.idempotencyKey
                && replay.isRetry,
            "response loss preserves bytes/key")
        let operation = UUID()
        let pending = try HealthKitWorkoutDeregistrationReceipt.parse(
            data(operation, "pending_cleanup"), minimumRevision: 3)
        try session.acknowledged(pending, generation: generation)
        try require(
            session.state == .pendingCleanup && session.resultCount == nil
                && session.registeredCount == nil,
            "ACK never success")
        try reject("POST never repeated after ACK") { _ = try session.retry() }
        try reject("target still active") {
            try session.refreshed(
                .init(registryRevision: 4, claims: [claim]), generation: generation)
        }
        try reject("registry moves backwards") {
            try session.refreshed(.init(registryRevision: 3, claims: []), generation: generation)
        }
        try session.refreshed(.init(registryRevision: 4, claims: [other]), generation: generation)
        try require(
            session.registeredCount == 1 && session.resultCount == nil && session.selected == nil,
            "pending removed from collector eligible list but no release")
        let released = try HealthKitWorkoutDeregistrationReceipt.parse(
            data(operation, "released", revision: 5), minimumRevision: 4, operationId: operation)
        try session.acknowledged(released, generation: generation)
        try require(
            session.resultCount == nil, "release ACK still awaits complete list and collector seam")
        try reject("fresh re-registration cannot be mistaken for removal") {
            try session.refreshed(
                .init(
                    registryRevision: 5,
                    claims: [.init(sampleId: claim.sampleId, claimEpoch: UUID())]),
                generation: generation)
        }
        try session.refreshed(.init(registryRevision: 5, claims: [other]), generation: generation)
        try require(
            session.state == .released && session.resultCount == 1 && session.registeredCount == 1,
            "release completion")
        let status = session.status
        try require(
            Set(status.keys) == ["state", "registeredCount", "selectedCount", "resultCount"],
            "status allowlist")
        let text = String(
            decoding: try JSONSerialization.data(withJSONObject: status), as: UTF8.self
        )
        .lowercased()
        for value in [
            claim.sampleId.uuidString, claim.claimEpoch.uuidString, operation.uuidString,
            handle.uuidString,
            context.ownerAthleteId, context.sessionId,
        ] {
            try require(
                !text.contains(value.lowercased()), "native private identifiers absent from bridge")
        }
        session.failed(.offline)
        try require(
            session.resultCount == nil && session.registeredCount == nil, "offline clears success")
        try reject("operation membership mismatch") {
            _ = try HealthKitWorkoutDeregistrationReceipt.parse(
                data(UUID(), "released"), minimumRevision: 3, operationId: operation)
        }
        try reject("release cannot regress") {
            try session.acknowledged(pending, generation: generation)
        }
        for status in ["registering", "choosing", "idle", "unknown"] {
            try reject("finite server states") {
                _ = try HealthKitWorkoutDeregistrationReceipt.parse(
                    data(operation, status), minimumRevision: 3)
            }
        }
        for revision: Any in [true, 4.5, 2, 2_147_483_648] {
            try reject("invalid numeric revision") {
                _ = try HealthKitWorkoutDeregistrationReceipt.parse(
                    data(operation, "released", revision: revision), minimumRevision: 3)
            }
        }
        try reject("byte cap") {
            _ = try HealthKitWorkoutDeregistrationReceipt.parse(
                Data(repeating: 32, count: 4097), minimumRevision: 3)
        }
        guard
            var extra = try JSONSerialization.jsonObject(with: data(operation, "released"))
                as? [String: Any]
        else { throw ManagementFailure.failed("receipt fixture") }
        extra["sampleId"] = claim.sampleId.uuidString
        try reject("extra server field") {
            _ = try HealthKitWorkoutDeregistrationReceipt.parse(
                JSONSerialization.data(withJSONObject: extra), minimumRevision: 3)
        }
        let otherContext = HealthKitWorkoutSelectionContext(
            ownerAthleteId: "synthetic_b", sessionId: context.sessionId,
            consentRevision: context.consentRevision, credentialIdentity: context.credentialIdentity
        )
        try require(!session.current(otherContext, generation: generation), "account fence")
        let replacement = HealthKitWorkoutSelectionContext(
            ownerAthleteId: context.ownerAthleteId, sessionId: context.sessionId,
            consentRevision: context.consentRevision, credentialIdentity: UUID())
        try require(
            !session.current(replacement, generation: generation), "credential replacement fence")
        session.invalidate(.cancelled)
        try require(
            session.context == nil && session.pending == nil && session.receipt == nil
                && session.claims.isEmpty,
            "cancel discards private memory only")
        try require(
            !session.current(context, generation: generation) && !session.permits(handle),
            "cancel fences delayed callback")
        try reject("stale ACK") { try session.acknowledged(released, generation: generation) }
        try require(
            session.managementId == handle && session.state == .cancelled,
            "cancelled state pollable by original handle")
        let next = session.begin(context)
        try require(
            next > generation && session.managementId != handle && !session.permits(handle),
            "new UI lifetime fences old buttons")
        session.failed(.legacyBlocked)
        try require(
            session.state == .legacyBlocked && session.resultCount == nil,
            "legacy receipt blocked never auto deletes")
        let legacy = try JSONSerialization.data(withJSONObject: [
            "error": ["code": "RECEIPT_MEMBERSHIP_REQUIRED"], "requestId": UUID().uuidString,
        ])
        try require(
            HealthKitWorkoutManagementError.isLegacyBlocked(legacy),
            "real API nested private legacy error")
        try require(
            !HealthKitWorkoutManagementError.isLegacyBlocked(
                try JSONSerialization.data(withJSONObject: ["code": "RECEIPT_MEMBERSHIP_REQUIRED"])),
            "malformed legacy error does not classify")
        try require(
            !HealthKitWorkoutManagementError.isLegacyBlocked(Data(repeating: 32, count: 4097)),
            "legacy error byte cap")
        func prepared() throws -> HealthKitWorkoutManagementSession {
            var value = HealthKitWorkoutManagementSession()
            let g = value.begin(context)
            try value.loaded(.init(registryRevision: 3, claims: [claim]), generation: g)
            try value.select(claim.sampleId)
            try value.showConfirmation()
            _ = try value.confirm(deletionDeclared: true)
            return value
        }
        var beforeSend = try prepared()
        let beforeGeneration = beforeSend.generation
        beforeSend.close()
        try require(
            beforeSend.state == .cancelled && beforeSend.pending == nil
                && beforeSend.context == nil,
            "close during credential/registry precheck cancels without preserving unsent body")
        try require(
            !beforeSend.current(context, generation: beforeGeneration),
            "pre-send callback fence rejects late send")
        try reject("pre-send close never recreates POST") { _ = try beforeSend.retry() }
        try reject("pre-send marker cannot revive closed UI") { try beforeSend.markTransmitted() }
        var sent = try prepared()
        let sentBody = sent.pending?.body
        let sentHandle = sent.managementId
        let sentGeneration = sent.generation
        try sent.markTransmitted()
        sent.close()
        try require(
            sent.transmitted && sent.state == .offline && sent.pending?.body == sentBody
                && sent.context == context,
            "response-loss close preserves only actually attempted bytes/key/context")
        try require(
            sent.managementId == sentHandle && sent.resultCount == nil
                && sent.registeredCount == nil,
            "closed sent operation remains status-addressable with unknown outcome")
        try require(
            !sent.current(context, generation: sentGeneration),
            "closed operation fences late network response")
        try reject("another account cannot resume") { _ = try sent.resume(otherContext) }
        let resumed = try sent.resume(context)
        try require(
            sent.managementId != sentHandle && resumed > sentGeneration
                && sent.pending?.body == sentBody,
            "same account reopen gets fresh UI handle and original operation bytes")
        let sentRetry = try sent.retry()
        try require(
            sentRetry.isRetry && sentRetry.body == sentBody,
            "status response-loss retry uses original payload")
        try sent.acknowledged(pending, generation: resumed)
        sent.close()
        let closedGeneration = sent.generation
        try require(
            sent.state == .pendingCleanup && sent.receipt?.operationId == operation
                && sent.canResume,
            "committed pending close preserves exact GET operation")
        try sent.acknowledged(released, generation: closedGeneration)
        try require(
            sent.resultCount == nil && sent.canResume,
            "released ACK without full list remains resumable")
        try sent.refreshed(.init(registryRevision: 5, claims: []), generation: closedGeneration)
        try require(
            sent.resultCount == 1 && sent.state == .released && !sent.canResume,
            "closed handle can observe completed cleanup after fresh list")
        sent.invalidate(.unauthorized)
        try require(
            sent.context == nil && sent.receipt == nil && sent.pending == nil && !sent.transmitted,
            "logout purges retained operation and original replay")

        // Exercise the same single-flight implementation used by real UIKit and managementStatus.
        let flight = HealthKitWorkoutManagementWork()
        var getCount = 0
        var release: CheckedContinuation<Void, Never>?
        try require(
            flight.start {
                getCount += 1
                await withCheckedContinuation { release = $0 }
            }, "first pending operation refresh starts")
        await Task.yield()
        try require(
            !flight.start { getCount += 1 }, "concurrent web and UIKit refresh share one GET")
        try require(getCount == 1 && flight.isRunning, "only one bounded request in flight")
        release?.resume()
        release = nil
        await flight.wait()
        try require(
            !flight.isRunning && flight.task == nil, "completed work cleared for next host poll")
        var oldRelease: CheckedContinuation<Void, Never>?
        var newRelease: CheckedContinuation<Void, Never>?
        try require(
            flight.start { await withCheckedContinuation { oldRelease = $0 } },
            "old operation starts")
        await Task.yield()
        let oldTask = flight.task
        flight.cancel()
        try require(!flight.isRunning, "UI close invalidates old operation token")
        try require(
            flight.start {
                getCount += 1
                await withCheckedContinuation { newRelease = $0 }
            }, "new lifetime operation starts")
        await Task.yield()
        oldRelease?.resume()
        oldRelease = nil
        await oldTask?.value
        try require(
            flight.isRunning && getCount == 2, "old completion cannot clear new account operation")
        newRelease?.resume()
        newRelease = nil
        await flight.wait()
        try require(!flight.isRunning, "new request finishes normally")
        print(
            "HealthKitWorkoutManagement harness passed: \(checks) assertions; synthetic only; no HealthKit/API I/O"
        )
    }
}
