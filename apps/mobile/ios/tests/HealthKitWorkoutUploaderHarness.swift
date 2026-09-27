import Foundation

private enum HarnessFailure: Error { case failed(String) }

@main
struct HealthKitWorkoutUploaderHarness {
    static func main() throws {
        let installationId = UUID()
        let batchId = UUID()
        let event = ["kind": "delete", "sampleId": UUID().uuidString.lowercased()]
        let batch: [String: Any] = [
            "schemaVersion": 1,
            "installationId": installationId.uuidString.lowercased(),
            "batchId": batchId.uuidString.lowercased(),
            "events": [event],
        ]
        let body = try JSONSerialization.data(withJSONObject: batch)
        try require(HealthKitWorkoutUploader.acceptsBody(body, installationId: installationId,
                                                         batchId: batchId, eventCount: 1), "valid batch")
        try require(!HealthKitWorkoutUploader.acceptsBody(body, installationId: installationId,
                                                          batchId: UUID(), eventCount: 1), "batch identity")
        try require(!HealthKitWorkoutUploader.acceptsBody(Data(repeating: 0x20, count: 65_537),
                                                          installationId: installationId,
                                                          batchId: batchId, eventCount: 1), "body bound")

        let ack: [String: Any] = [
            "schemaVersion": 1,
            "installationId": installationId.uuidString.lowercased(),
            "batchId": batchId.uuidString.lowercased(),
            "acceptedCount": 1,
        ]
        let ackBody = try JSONSerialization.data(withJSONObject: ack)
        try require(try HealthKitWorkoutUploader.outcome(status: 200, body: ackBody,
                                                         installationId: installationId,
                                                         batchId: batchId, eventCount: 1) == .accepted,
                    "matching ACK")
        do {
            _ = try HealthKitWorkoutUploader.outcome(status: 200, body: ackBody,
                                                     installationId: installationId,
                                                     batchId: UUID(), eventCount: 1)
            throw HarnessFailure.failed("mismatched ACK accepted")
        } catch HealthKitWorkoutUploadError.invalidReply { }

        let consent = try JSONSerialization.data(withJSONObject: ["error": ["code": "CONSENT_REQUIRED"]])
        try require(try HealthKitWorkoutUploader.outcome(status: 401, body: Data(),
                                                         installationId: installationId,
                                                         batchId: batchId, eventCount: 1) == .authenticationRequired,
                    "401")
        try require(try HealthKitWorkoutUploader.outcome(status: 403, body: consent,
                                                         installationId: installationId,
                                                         batchId: batchId, eventCount: 1) == .consentRequired,
                    "consent withdrawal")
        try require(try HealthKitWorkoutUploader.outcome(status: 403, body: Data(),
                                                         installationId: installationId,
                                                         batchId: batchId, eventCount: 1) == .forbidden,
                    "other forbidden")
        try require(try HealthKitWorkoutUploader.outcome(status: 409, body: Data(),
                                                         installationId: installationId,
                                                         batchId: batchId, eventCount: 1) == .conflict,
                    "conflict")
        try require(try HealthKitWorkoutUploader.outcome(status: 400, body: Data(),
                                                         installationId: installationId,
                                                         batchId: batchId, eventCount: 1) == .rejected,
                    "permanent rejection")
        do {
            _ = try HealthKitWorkoutUploader.outcome(status: 429, body: Data(),
                                                     installationId: installationId,
                                                     batchId: batchId, eventCount: 1)
            throw HarnessFailure.failed("rate limit treated as permanent")
        } catch HealthKitWorkoutUploadError.unavailable { }
        print("HealthKitWorkoutUploader harness passed: body, ACK, consent, permanent/transient status")
    }

    private static func require(_ condition: Bool, _ label: String) throws {
        if !condition { throw HarnessFailure.failed(label) }
    }
}
