import Foundation

private enum HarnessFailure: Error { case failed(String) }

@main
struct HealthKitWorkoutUploaderHarness {
    static func main() throws {
        let installationId = UUID()
        let batchId = UUID()
        let event = [
            "kind": "delete", "sampleId": UUID().uuidString.lowercased(),
            "claimEpoch": UUID().uuidString.lowercased(),
        ]
        let batch: [String: Any] = [
            "schemaVersion": 2,
            "installationId": installationId.uuidString.lowercased(),
            "batchId": batchId.uuidString.lowercased(),
            "events": [event],
        ]
        let body = try JSONSerialization.data(withJSONObject: batch)
        try require(
            HealthKitWorkoutUploader.acceptsBody(
                body, installationId: installationId,
                batchId: batchId, eventCount: 1), "valid batch")
        try require(
            !HealthKitWorkoutUploader.acceptsBody(
                body, installationId: installationId,
                batchId: UUID(), eventCount: 1), "batch identity")
        try require(
            !HealthKitWorkoutUploader.acceptsBody(
                Data(repeating: 0x20, count: 65_537),
                installationId: installationId,
                batchId: batchId, eventCount: 1), "body bound")

        let ack: [String: Any] = [
            "schemaVersion": 2,
            "installationId": installationId.uuidString.lowercased(),
            "batchId": batchId.uuidString.lowercased(),
            "acceptedCount": 1,
        ]
        let ackBody = try JSONSerialization.data(withJSONObject: ack)
        try require(
            try HealthKitWorkoutUploader.outcome(
                status: 200, body: ackBody,
                installationId: installationId,
                batchId: batchId, eventCount: 1) == .accepted,
            "matching ACK")
        do {
            _ = try HealthKitWorkoutUploader.outcome(
                status: 200, body: ackBody,
                installationId: installationId,
                batchId: UUID(), eventCount: 1)
            throw HarnessFailure.failed("mismatched ACK accepted")
        } catch HealthKitWorkoutUploadError.invalidReply {}

        let consent = try JSONSerialization.data(withJSONObject: ["error": ["code": "CONSENT_REQUIRED"]]
        )
        try require(
            try HealthKitWorkoutUploader.outcome(
                status: 401, body: Data(),
                installationId: installationId,
                batchId: batchId, eventCount: 1) == .authenticationRequired,
            "401")
        try require(
            try HealthKitWorkoutUploader.outcome(
                status: 403, body: consent,
                installationId: installationId,
                batchId: batchId, eventCount: 1) == .consentRequired,
            "consent withdrawal")
        try require(
            try HealthKitWorkoutUploader.outcome(
                status: 403, body: Data(),
                installationId: installationId,
                batchId: batchId, eventCount: 1) == .forbidden,
            "other forbidden")
        try require(
            try HealthKitWorkoutUploader.outcome(
                status: 409, body: Data(),
                installationId: installationId,
                batchId: batchId, eventCount: 1) == .conflict,
            "conflict")
        let expired = try JSONSerialization.data(withJSONObject: [
            "error": ["code": "CONSENT_EPOCH_EXPIRED"]
        ])
        try require(
            try HealthKitWorkoutUploader.outcome(
                status: 409, body: expired,
                installationId: installationId,
                batchId: batchId, eventCount: 1) == .consentEpochExpired,
            "only explicit consent epoch error permits queue reset")
        try require(
            try HealthKitWorkoutUploader.outcome(
                status: 400, body: Data(),
                installationId: installationId,
                batchId: batchId, eventCount: 1) == .rejected,
            "permanent rejection")
        do {
            _ = try HealthKitWorkoutUploader.outcome(
                status: 429, body: Data(),
                installationId: installationId,
                batchId: batchId, eventCount: 1)
            throw HarnessFailure.failed("rate limit treated as permanent")
        } catch HealthKitWorkoutUploadError.unavailable {}
        for code in [
            "REGISTRATION_REQUIRED", "CLAIM_EPOCH_EXPIRED", "DEREGISTRATION_PENDING",
            "LEGACY_BATCH_UNSUPPORTED", "RECEIPT_MEMBERSHIP_REQUIRED",
        ] {
            let reply = try JSONSerialization.data(withJSONObject: ["error": ["code": code]])
            try require(
                try HealthKitWorkoutUploader.outcome(
                    status: 409, body: reply, installationId: installationId, batchId: batchId, eventCount: 1)
                    == .conflict, "registry conflict must retain queue")
        }
        var legacy = batch
        legacy["schemaVersion"] = 1
        try require(
            !HealthKitWorkoutUploader.acceptsBody(
                JSONSerialization.data(withJSONObject: legacy), installationId: installationId,
                batchId: batchId, eventCount: 1), "legacy v1 upload blocked")
        var noEpoch = batch
        noEpoch["events"] = [["kind": "delete", "sampleId": UUID().uuidString]]
        try require(
            !HealthKitWorkoutUploader.acceptsBody(
                JSONSerialization.data(withJSONObject: noEpoch), installationId: installationId,
                batchId: batchId, eventCount: 1), "missing claim epoch")
        var duplicates = batch
        duplicates["events"] = [event, event]
        try require(
            !HealthKitWorkoutUploader.acceptsBody(
                JSONSerialization.data(withJSONObject: duplicates), installationId: installationId,
                batchId: batchId, eventCount: 2), "duplicate UUID rejected")
        var oldAck = ack
        oldAck["schemaVersion"] = 1
        do {
            _ = try HealthKitWorkoutUploader.outcome(
                status: 200, body: JSONSerialization.data(withJSONObject: oldAck),
                installationId: installationId, batchId: batchId, eventCount: 1)
            throw HarnessFailure.failed("legacy ACK accepted")
        } catch HealthKitWorkoutUploadError.invalidReply { checks += 1 }
        try require(HealthKitWorkoutUploader.acceptsConsentRevision(2_147_483_647), "maximum native upload consent revision accepted")
        try require(!HealthKitWorkoutUploader.acceptsConsentRevision(2_147_483_648), "above maximum rejected")
        try require(HealthKitWorkoutUploader.acceptsConsentRevision(0), "existing zero boundary preserved")
        for invalid: Any? in [nil, NSNull(), true, "2147483647", -1, 1.5, Double.nan, Double.infinity] {
            try require(!HealthKitWorkoutUploader.acceptsConsentRevision(invalid), "missing or invalid numeric revision rejected without default")
        }
        var incomplete = batch
        incomplete.removeValue(forKey: "schemaVersion")
        try require(!HealthKitWorkoutUploader.acceptsBody(JSONSerialization.data(withJSONObject: incomplete), installationId: installationId, batchId: batchId, eventCount: 1), "missing batch schema has no default")
        print(
            "HealthKitWorkoutUploader harness passed: \(checks) assertions; v2 body, ACK, consent and registry fences"
        )
    }

    private static var checks = 2  // Mismatched ACK and transient 429 rejection above.
    private static func require(_ condition: Bool, _ label: String) throws {
        checks += 1
        if !condition { throw HarnessFailure.failed(label) }
    }
}
