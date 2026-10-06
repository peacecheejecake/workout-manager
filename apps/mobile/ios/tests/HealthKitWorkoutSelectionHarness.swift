import Foundation

private enum SelectionHarnessFailure: Error { case failed(String) }

@main
struct HealthKitWorkoutSelectionHarness {
    static var checks = 0
    static func require(_ value: Bool, _ label: String) throws {
        checks += 1
        if !value { throw SelectionHarnessFailure.failed(label) }
    }
    static func reject(
        _ label: String, expected: HealthKitWorkoutSelectionError = .invalidInput, _ action: () throws -> Void
    ) throws {
        do { try action() } catch let error as HealthKitWorkoutSelectionError {
            try require(error == expected, label + " exact error")
            return
        }
        throw SelectionHarnessFailure.failed(label)
    }
    static let context = HealthKitWorkoutSelectionContext(
        ownerAthleteId: "synthetic_a", sessionId: "synthetic_session_a", consentRevision: 1, credentialIdentity: UUID())
    static let from = Date(timeIntervalSince1970: 1_750_000_000)
    static let through = from.addingTimeInterval(30 * 86_400)
    static func candidate(_ id: UUID = UUID()) -> HealthKitWorkoutCandidate {
        .init(
            sampleId: id, activityType: 37, start: from.addingTimeInterval(60), end: from.addingTimeInterval(120),
            duration: 60)
    }
    static func choosing(_ values: [HealthKitWorkoutCandidate]) throws -> HealthKitWorkoutSelectionSession {
        var session = HealthKitWorkoutSelectionSession()
        let generation = session.begin(context)
        try session.loaded(
            values, snapshot: .init(registryRevision: 3, claims: []), from: from, through: through,
            generation: generation)
        return session
    }
    static func reply(_ claims: [HealthKitWorkoutClaim], revision: Int = 4) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1, "registryRevision": revision,
            "claims": claims.map { ["sampleId": $0.sampleId.uuidString, "claimEpoch": $0.claimEpoch.uuidString] },
        ])
    }
    static func main() throws {
        let candidates = (0..<200).map { _ in candidate() }
        var session = HealthKitWorkoutSelectionSession()
        try require(
            session.state == .idle && session.registeredCount == nil && session.resultCount == nil,
            "initial counts unknown")
        let generation = session.begin(context)
        guard let handle = session.selectionId else { throw SelectionHarnessFailure.failed("native handle") }
        try require(!candidates.map(\.sampleId).contains(handle), "opaque UI handle distinct from sample IDs")
        var posts = 0
        var collectorRefreshes = 0
        try reject("cannot declare before choosing") { _ = try session.confirm(accountAttributionDeclared: true) }
        try session.loaded(
            candidates, snapshot: .init(registryRevision: 3, claims: []), from: from, through: through,
            generation: generation)
        try require(
            session.state == .choosing && session.registeredCount == 0 && session.pending == nil && posts == 0,
            "candidate load never POSTs")
        try reject("foreign candidate cannot select") { try session.toggle(UUID()) }
        for c in candidates.prefix(50) { try session.toggle(c.sampleId) }
        try require(session.selected.count == 50, "selection 50 cap")
        try reject("51st selection rejected") { try session.toggle(candidates[50].sampleId) }
        try session.toggle(candidates[0].sampleId)
        try require(session.selected.count == 49, "toggle is explicit deselection")
        try session.toggle(candidates[0].sampleId)
        try require(session.pending == nil && posts == 0, "selection alone is not registration")
        try session.showConfirmation()
        try require(
            session.state == .confirming && session.pending == nil && posts == 0, "confirmation display never POSTs")
        try reject("declaration must be true") { _ = try session.confirm(accountAttributionDeclared: false) }
        session.continueChoosing()
        try require(session.state == .choosing && session.selected.count == 50, "continue editing keeps selection")
        try session.showConfirmation()
        let request = try session.confirm(accountAttributionDeclared: true)
        try require(session.state == .registering && request.sampleIds.count == 50, "declared stable request")
        guard let body = try JSONSerialization.jsonObject(with: request.body) as? [String: Any] else {
            throw SelectionHarnessFailure.failed("request DTO")
        }
        try require(
            Set(body.keys) == [
                "schemaVersion", "sampleIds", "accountAttributionDeclared", "expectedConsentRevision",
                "expectedRegistryRevision", "idempotencyKey",
            ], "exact fixed POST DTO")
        try require(
            body["accountAttributionDeclared"] as? Bool == true && body["expectedRegistryRevision"] as? Int == 3
                && body["expectedConsentRevision"] as? Int == 1, "declaration and revisions")
        try require(
            body["athleteId"] == nil && body["accessToken"] == nil && body["sessionId"] == nil,
            "auth and owner not client body")
        session.markTransmitted()
        posts += 1
        session.failed(.offline)
        try require(
            session.state == .offline && session.registeredCount == nil && session.resultCount == nil
                && collectorRefreshes == 0, "response loss is uncertain, no collection")
        let retry = try session.retry()
        try require(!request.isRetry && retry.isRetry, "only response-loss retry skips optimistic head precheck")
        try require(
            retry.body == request.body && retry.idempotencyKey == request.idempotencyKey
                && retry.context == request.context, "response loss retries exact same bytes/key/context")
        session.markTransmitted()
        posts += 1
        let claims = retry.sampleIds.map { HealthKitWorkoutClaim(sampleId: $0, claimEpoch: UUID()) }
        let ack = try retry.validatedReply(reply(claims))
        try session.acknowledged(ack, generation: generation)
        try require(
            session.state == .refresh_pending && session.resultCount == 50 && session.registeredCount == nil
                && collectorRefreshes == 0, "ACK alone cannot resume collection")
        session.failed(.offline)
        try require(
            session.state == .refresh_pending && session.resultCount == 50 && session.pending?.body == retry.body,
            "fresh list failure keeps verified registration separate")
        try reject("cannot repeat POST after verified ACK") { _ = try session.retry() }
        try reject("missing ACK claim in full list", expected: .conflict) {
            try session.refreshed(.init(registryRevision: 4, claims: Array(claims.dropLast())), generation: generation)
        }
        let wrongEpoch =
            [HealthKitWorkoutClaim(sampleId: claims[0].sampleId, claimEpoch: UUID())] + Array(claims.dropFirst())
        try reject("fresh epoch mismatch", expected: .conflict) {
            try session.refreshed(.init(registryRevision: 4, claims: wrongEpoch), generation: generation)
        }
        try require(
            session.state == .refresh_pending && collectorRefreshes == 0, "failed list validation cannot open collector"
        )
        try session.refreshed(.init(registryRevision: 4, claims: claims), generation: generation)
        collectorRefreshes += 1
        try require(
            session.state == .registered && session.registeredCount == 50 && session.resultCount == 50
                && session.candidates.isEmpty && session.selected.isEmpty && session.pending == nil
                && collectorRefreshes == 1, "fresh ACK membership permits collection and clears candidate memory")
        let status = session.status
        try require(
            Set(status.keys) == ["state", "registeredCount", "selectedCount", "resultCount"], "status exact allowlist")
        let statusText = String(decoding: try JSONSerialization.data(withJSONObject: status), as: UTF8.self)
        try require(
            !statusText.contains(context.ownerAthleteId) && !statusText.contains(context.sessionId)
                && !statusText.contains(handle.uuidString), "status carries no account/session/handle")
        for claim in claims {
            try require(
                !statusText.lowercased().contains(claim.sampleId.uuidString.lowercased())
                    && !statusText.lowercased().contains(claim.claimEpoch.uuidString.lowercased()),
                "no raw sample or epoch in bridge status")
        }

        var lifetime = HealthKitWorkoutSelectionExchangeLifetime()
        lifetime.record(requestId: "old_exchange", selectionId: handle)
        let secondGeneration = session.begin(context)
        guard let secondHandle = session.selectionId else { throw SelectionHarnessFailure.failed("second handle") }
        lifetime.record(requestId: "new_exchange", selectionId: secondHandle)
        try require(handle != secondHandle && secondGeneration > generation, "new native UI lifetime")
        try require(lifetime.cancelRequest("old_exchange") == nil, "old exchange timeout cannot cancel newer sheet")
        try require(!session.permitsUI(selectionId: handle), "old native UI button cannot confirm newer sheet")
        try require(
            session.permitsUI(selectionId: secondHandle, generation: secondGeneration),
            "current sheet action bound to handle and generation")
        session.cancel(selectionId: handle)
        try require(
            session.state == .loading && session.selectionId == secondHandle, "old UI handle cancel is harmless")
        try require(
            lifetime.cancelRequest("new_exchange") == secondHandle, "lost open ACK cancellation targets exact sheet")
        session.cancel(selectionId: secondHandle)
        try require(
            session.state == .cancelled && session.context == nil && session.candidates.isEmpty
                && session.selected.isEmpty && session.pending == nil, "cancellation clears private native state")
        try reject("stale query after cancel") {
            try session.loaded(
                [candidate()], snapshot: .init(registryRevision: 3, claims: []), from: from, through: through,
                generation: secondGeneration)
        }
        try require(!session.current(context, generation: secondGeneration), "cancelled generation refuses callbacks")

        var reload = try choosing([candidate()])
        let reloadHandle = reload.selectionId
        let oldReloadGeneration = reload.generation
        let reloadGeneration = try reload.reload()
        if let reloadHandle {
            try require(
                !reload.permitsUI(selectionId: reloadHandle, generation: oldReloadGeneration),
                "old confirmation callback fenced after reload")
        }
        try require(
            reload.selectionId == reloadHandle && reloadGeneration > oldReloadGeneration,
            "date reload preserves opaque handle and fences old query")
        try reject("prior date page cannot mutate new range") {
            try reload.loaded(
                [candidate()], snapshot: .init(registryRevision: 3, claims: []), from: from, through: through,
                generation: oldReloadGeneration)
        }
        try reload.loaded(
            [], snapshot: .init(registryRevision: 3, claims: []), from: from, through: through,
            generation: reloadGeneration)
        try require(
            reload.state == .choosing && reload.candidates.isEmpty && reload.registeredCount == 0
                && reload.pending == nil, "empty read is choosing, not permission/absence proof")
        try reject("empty candidate confirmation") { try reload.showConfirmation() }

        for values in [Array(candidates.prefix(1)) + Array(candidates.prefix(1)), candidates + [candidate()]] {
            var bad = HealthKitWorkoutSelectionSession()
            let g = bad.begin(context)
            try reject("duplicate or >200 candidates") {
                try bad.loaded(
                    values, snapshot: .init(registryRevision: 3, claims: []), from: from, through: through,
                    generation: g)
            }
        }
        var badRange = HealthKitWorkoutSelectionSession()
        let badGeneration = badRange.begin(context)
        try reject("unbounded date range") {
            try badRange.loaded(
                [], snapshot: .init(registryRevision: 3, claims: []), from: from,
                through: from.addingTimeInterval(367 * 86_400), generation: badGeneration)
        }
        try reject("reverse range") {
            try badRange.loaded(
                [], snapshot: .init(registryRevision: 3, claims: []), from: through, through: from,
                generation: badGeneration)
        }
        try reject("sample outside explicit range") {
            try badRange.loaded(
                [candidate()], snapshot: .init(registryRevision: 3, claims: []), from: through,
                through: through.addingTimeInterval(60), generation: badGeneration)
        }
        var already = HealthKitWorkoutSelectionSession()
        let alreadyGeneration = already.begin(context)
        try already.loaded(
            [candidates[0]],
            snapshot: .init(registryRevision: 3, claims: [.init(sampleId: candidates[0].sampleId, claimEpoch: UUID())]),
            from: from, through: through, generation: alreadyGeneration)
        try require(
            already.candidates.isEmpty && already.registeredCount == 1, "already registered own candidates excluded")

        for changedContext in [
            HealthKitWorkoutSelectionContext(
                ownerAthleteId: "synthetic_b", sessionId: context.sessionId, consentRevision: 1,
                credentialIdentity: context.credentialIdentity),
            HealthKitWorkoutSelectionContext(
                ownerAthleteId: context.ownerAthleteId, sessionId: "new_session", consentRevision: 1,
                credentialIdentity: context.credentialIdentity),
            HealthKitWorkoutSelectionContext(
                ownerAthleteId: context.ownerAthleteId, sessionId: context.sessionId, consentRevision: 2,
                credentialIdentity: context.credentialIdentity),
            HealthKitWorkoutSelectionContext(
                ownerAthleteId: context.ownerAthleteId, sessionId: context.sessionId, consentRevision: 1,
                credentialIdentity: UUID()),
        ] {
            var stale = try choosing([candidate()])
            try require(
                !stale.current(changedContext, generation: stale.generation),
                "owner/session/consent/same-session replacement fenced")
            stale.invalidate(.unauthorized)
            try require(
                stale.state == .unauthorized && stale.context == nil && stale.candidates.isEmpty
                    && stale.pending == nil, "auth invalidation discards private candidates/retry")
        }
        var uncertain = try choosing([candidate()])
        try uncertain.toggle(uncertain.candidates[0].sampleId)
        try uncertain.showConfirmation()
        _ = try uncertain.confirm(accountAttributionDeclared: true)
        uncertain.markTransmitted()
        guard let uncertainId = uncertain.selectionId else { throw SelectionHarnessFailure.failed("uncertain handle") }
        uncertain.cancel(selectionId: uncertainId)
        try require(
            uncertain.state == .refresh_pending && uncertain.registeredCount == nil && uncertain.resultCount == nil
                && uncertain.pending == nil, "cancel after transmit does not pretend server undo")

        let one = try HealthKitWorkoutRegistrationRequest(context: context, sampleIds: [UUID()], registryRevision: 3)
        let oneClaim = HealthKitWorkoutClaim(sampleId: one.sampleIds[0], claimEpoch: UUID())
        try reject("partial ACK", expected: .invalidReply) { _ = try one.validatedReply(reply([])) }
        try reject("foreign ACK UUID", expected: .invalidReply) {
            _ = try one.validatedReply(reply([.init(sampleId: UUID(), claimEpoch: UUID())]))
        }
        try reject("backward ACK revision", expected: .invalidReply) {
            _ = try one.validatedReply(reply([oneClaim], revision: 2))
        }
        try reject("truncated ACK", expected: .invalidReply) { _ = try one.validatedReply(Data("{".utf8)) }
        try reject("bounded ACK bytes", expected: .invalidReply) {
            _ = try one.validatedReply(Data(repeating: 32, count: 16_385))
        }
        var invalidAck: [String: Any] = [
            "schemaVersion": 1, "registryRevision": 4,
            "claims": [["sampleId": oneClaim.sampleId.uuidString, "claimEpoch": oneClaim.claimEpoch.uuidString]],
        ]
        invalidAck["unexpected"] = true
        try reject("extra ACK field", expected: .invalidReply) {
            _ = try one.validatedReply(JSONSerialization.data(withJSONObject: invalidAck))
        }
        invalidAck.removeValue(forKey: "unexpected")
        invalidAck["schemaVersion"] = true
        try reject("Boolean ACK version", expected: .invalidReply) {
            _ = try one.validatedReply(JSONSerialization.data(withJSONObject: invalidAck))
        }
        invalidAck["schemaVersion"] = 1
        invalidAck["registryRevision"] = 4.5
        try reject("fractional ACK revision", expected: .invalidReply) {
            _ = try one.validatedReply(JSONSerialization.data(withJSONObject: invalidAck))
        }
        invalidAck["registryRevision"] = 4
        invalidAck["claims"] = [["sampleId": oneClaim.sampleId.uuidString]]
        try reject("missing claim epoch", expected: .invalidReply) {
            _ = try one.validatedReply(JSONSerialization.data(withJSONObject: invalidAck))
        }
        for ids in [[], [one.sampleIds[0], one.sampleIds[0]], (0..<51).map { _ in UUID() }] {
            try reject("POST candidate bound/duplicate") {
                _ = try HealthKitWorkoutRegistrationRequest(context: context, sampleIds: ids, registryRevision: 3)
            }
        }
        try reject("invalid idempotency key") {
            _ = try HealthKitWorkoutRegistrationRequest(
                context: context, sampleIds: one.sampleIds, registryRevision: 3, idempotencyKey: "unsafe/path")
        }
        for failure in [HealthKitWorkoutSelectionState.conflict, .consent_required, .unauthorized, .unavailable] {
            var failed = try choosing([candidate()])
            failed.failed(failure)
            try require(
                failed.state == failure && failed.registeredCount == nil, "safe failure state has unknown count")
        }
        print(
            "HealthKitWorkoutSelection harness passed: \(checks) assertions; synthetic only; \(posts) simulated sends, \(collectorRefreshes) validated refresh"
        )
    }
}
