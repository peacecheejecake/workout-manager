import CoreFoundation
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

/// The native collector supplies a durable, immutable batch. This boundary never accepts a URL or bearer from WebView.
enum HealthKitWorkoutUploader {
    static let path = "/bff/v1/healthkit/workout-batches"
    private static let requestLimit = 65_536

    /** Shared by the native transport and synthetic boundary checks; absence never supplies a default. */
    static func acceptsConsentRevision(_ value: Any?) -> Bool {
        guard let revision = number(value), revision.rounded() == revision else { return false }
        return (0...2_147_483_647).contains(revision)
    }

    static func acceptsBody(
        _ body: Data, installationId: UUID, batchId: UUID,
        eventCount: Int
    ) -> Bool {
        guard !body.isEmpty, body.count <= requestLimit, (1...100).contains(eventCount),
            let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            Set(object.keys) == ["schemaVersion", "installationId", "batchId", "events"],
            let version = object["schemaVersion"] as? Int, version == 2,
            let installation = object["installationId"] as? String,
            UUID(uuidString: installation) == installationId,
            let batch = object["batchId"] as? String,
            UUID(uuidString: batch) == batchId,
            let events = object["events"] as? [Any], events.count == eventCount
        else {
            return false
        }
        var ids = Set<UUID>()
        return events.allSatisfy { value in
            guard let event = value as? [String: Any],
                let id = event["sampleId"] as? String, let sample = UUID(uuidString: id),
                let epoch = event["claimEpoch"] as? String, UUID(uuidString: epoch) != nil,
                ids.insert(sample).inserted
            else { return false }
            if event["kind"] as? String == "delete" {
                return Set(event.keys) == ["kind", "sampleId", "claimEpoch"]
            }
            guard event["kind"] as? String == "upsert",
                Set(event.keys) == [
                    "kind", "sampleId", "claimEpoch", "sourceBundleId", "sourceVersion", "activityType",
                    "observedFrom", "observedTo", "durationSeconds", "distanceMeters", "energyKilocalories",
                ],
                validText(event["sourceBundleId"], limit: 255),
                event["sourceVersion"] is NSNull || validText(event["sourceVersion"], limit: 128),
                let activity = number(event["activityType"]), activity.rounded() == activity,
                (0...1_000_000).contains(activity),
                let duration = number(event["durationSeconds"]), (0...2_678_400).contains(duration),
                validMetric(event["distanceMeters"]), validMetric(event["energyKilocalories"]),
                let from = instant(event["observedFrom"]), let to = instant(event["observedTo"]), to >= from
            else { return false }
            return true
        }
    }

    private static func validText(_ value: Any?, limit: Int) -> Bool {
        guard let text = value as? String else { return false }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && text.utf16.count <= limit
    }
    static func number(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite
        else { return nil }
        return n.doubleValue
    }
    private static func validMetric(_ value: Any?) -> Bool {
        if value is NSNull { return true }
        guard let n = number(value) else { return false }
        return (0...1_000_000_000).contains(n)
    }
    private static func instant(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return parser.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    static func outcome(
        status: Int, body: Data, installationId: UUID, batchId: UUID,
        eventCount: Int
    ) throws -> HealthKitWorkoutUploadOutcome {
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
                ack.schemaVersion == 2, ack.installationId == installationId,
                ack.batchId == batchId, ack.acceptedCount == eventCount
            else {
                throw HealthKitWorkoutUploadError.invalidReply
            }
            return .accepted
        case 401:
            return .authenticationRequired
        case 403:
            guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                let error = object["error"] as? [String: Any],
                error["code"] as? String == "CONSENT_REQUIRED"
            else {
                return .forbidden
            }
            return .consentRequired
        case 409:
            if let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                let error = object["error"] as? [String: Any],
                error["code"] as? String == "CONSENT_EPOCH_EXPIRED"
            {
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

/// Completeness is established only by the terminal page; errors never yield a partial snapshot.
struct HealthKitRegisteredWorkoutPages {
    private(set) var nextCursor: String?
    private var revision: Int?
    private var claims: [HealthKitWorkoutClaim] = []
    private var samples = Set<UUID>()
    private var cursors = Set<String>()
    private var pages = 0
    private var completed = false

    mutating func append(_ data: Data) throws -> HealthKitWorkoutRegistrationSnapshot? {
        guard !completed, pages < 100, data.count <= 32_768,
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            Set(json.keys) == ["schemaVersion", "claims", "registryRevision", "nextCursor"],
            HealthKitWorkoutUploader.number(json["schemaVersion"]) == 1,
            let n = HealthKitWorkoutUploader.number(json["registryRevision"]),
            n.rounded() == n, (0...2_147_483_647).contains(n),
            revision == nil || revision == Int(n),
            let page = json["claims"] as? [[String: Any]], page.count <= 100
        else {
            throw HealthKitWorkoutUploadError.invalidReply
        }
        var additions: [HealthKitWorkoutClaim] = []
        var pageIds = Set<UUID>()
        for claim in page {
            guard Set(claim.keys) == ["sampleId", "claimEpoch"],
                let sample = claim["sampleId"] as? String, let id = UUID(uuidString: sample),
                let text = claim["claimEpoch"] as? String, let epoch = UUID(uuidString: text),
                !samples.contains(id), pageIds.insert(id).inserted
            else { throw HealthKitWorkoutUploadError.invalidReply }
            additions.append(HealthKitWorkoutClaim(sampleId: id, claimEpoch: epoch))
        }
        let cursor: String?
        if json["nextCursor"] is NSNull {
            cursor = nil
        } else {
            guard let text = json["nextCursor"] as? String, (1...256).contains(text.utf8.count),
                text.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
                !cursors.contains(text), !page.isEmpty, pages < 99
            else { throw HealthKitWorkoutUploadError.invalidReply }
            cursor = text
        }
        guard claims.count + additions.count <= 10_000 else {
            throw HealthKitWorkoutUploadError.invalidReply
        }
        revision = Int(n)
        claims += additions
        samples.formUnion(pageIds)
        pages += 1
        nextCursor = cursor
        if let cursor {
            cursors.insert(cursor)
            return nil
        }
        completed = true
        return HealthKitWorkoutRegistrationSnapshot(registryRevision: Int(n), claims: claims)
    }
}
