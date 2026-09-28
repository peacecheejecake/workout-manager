import Foundation

enum HealthKitWorkoutUploadOutcome: Equatable {
    case accepted
    case authenticationRequired
    case consentRequired
    case consentEpochExpired
    case forbidden
    case conflict
    case rejected
}

enum HealthKitWorkoutUploadError: Error {
    case invalidReply
    case unavailable
}

/** The native collector supplies a durable, immutable batch. This boundary never accepts a URL or bearer from WebView. */
enum HealthKitWorkoutUploader {
    static let path = "/bff/v1/healthkit/workout-batches"
    private static let requestLimit = 65_536

    static func acceptsBody(_ body: Data, installationId: UUID, batchId: UUID,
                            eventCount: Int) -> Bool {
        guard !body.isEmpty, body.count <= requestLimit, (1...100).contains(eventCount),
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              Set(object.keys) == ["schemaVersion", "installationId", "batchId", "events"],
              let version = object["schemaVersion"] as? Int, version == 1,
              let installation = object["installationId"] as? String,
              UUID(uuidString: installation) == installationId,
              let batch = object["batchId"] as? String,
              UUID(uuidString: batch) == batchId,
              let events = object["events"] as? [Any], events.count == eventCount else {
            return false
        }
        return true
    }

    static func outcome(status: Int, body: Data, installationId: UUID, batchId: UUID,
                        eventCount: Int) throws -> HealthKitWorkoutUploadOutcome {
        switch status {
        case 200:
            struct Ack: Decodable {
                let schemaVersion: Int
                let installationId: UUID
                let batchId: UUID
                let acceptedCount: Int
            }
            guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  Set(object.keys) == ["schemaVersion", "installationId", "batchId", "acceptedCount"],
                  let ack = try? JSONDecoder().decode(Ack.self, from: body),
                  ack.schemaVersion == 1, ack.installationId == installationId,
                  ack.batchId == batchId, ack.acceptedCount == eventCount else {
                throw HealthKitWorkoutUploadError.invalidReply
            }
            return .accepted
        case 401:
            return .authenticationRequired
        case 403:
            guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let error = object["error"] as? [String: Any],
                  error["code"] as? String == "CONSENT_REQUIRED" else {
                return .forbidden
            }
            return .consentRequired
        case 409:
            if let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
               let error = object["error"] as? [String: Any],
               error["code"] as? String == "CONSENT_EPOCH_EXPIRED" {
                return .consentEpochExpired
            }
            return .conflict
        case 400...499 where status != 408 && status != 429:
            return .rejected
        default:
            throw HealthKitWorkoutUploadError.unavailable
        }
    }
}
