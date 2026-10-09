import Foundation

private enum PageHarnessFailure: Error { case failed(String) }
@main
struct HealthKitRegisteredWorkoutPagesHarness {
    static var checks = 0
    static func require(_ value: Bool, _ label: String) throws {
        checks += 1
        if !value { throw PageHarnessFailure.failed(label) }
    }
    static func page(_ ids: [UUID], revision: Int = 1, next: String? = nil) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1, "registryRevision": revision,
            "claims": ids.map { ["sampleId": $0.uuidString, "claimEpoch": UUID().uuidString] },
            "nextCursor": next as Any? ?? NSNull(),
        ])
    }
    static func reject(_ label: String, _ action: () throws -> Void) throws {
        do { try action() } catch HealthKitWorkoutUploadError.invalidReply {
            checks += 1
            return
        }
        throw PageHarnessFailure.failed(label)
    }
    static func main() throws {
        var complete = HealthKitRegisteredWorkoutPages()
        let first = UUID()
        try require(
            try complete.append(page([first], next: "opaque_a")) == nil, "partial list unavailable")
        try require(complete.nextCursor == "opaque_a", "native opaque cursor")
        let result = try complete.append(page([UUID()]))
        try require(
            result?.claims.count == 2 && result?.registryRevision == 1, "terminal complete result")
        try reject("completion immutable") { _ = try complete.append(page([])) }
        var mixed = HealthKitRegisteredWorkoutPages()
        _ = try mixed.append(page([UUID()], next: "opaque_a"))
        try reject("mixed registry revisions") { _ = try mixed.append(page([UUID()], revision: 2)) }
        try require(mixed.nextCursor == "opaque_a", "failed page does not mutate accumulator")
        var duplicate = HealthKitRegisteredWorkoutPages()
        _ = try duplicate.append(page([first], next: "opaque_a"))
        try reject("duplicate cross page UUID") { _ = try duplicate.append(page([first])) }
        var localDuplicate = HealthKitRegisteredWorkoutPages()
        try reject("duplicate within page") { _ = try localDuplicate.append(page([first, first])) }
        var cyclic = HealthKitRegisteredWorkoutPages()
        _ = try cyclic.append(page([UUID()], next: "opaque_a"))
        try reject("repeated cursor loop") { _ = try cyclic.append(page([UUID()], next: "opaque_a")) }
        var malformed = HealthKitRegisteredWorkoutPages()
        try reject("truncated JSON") { _ = try malformed.append(Data("{\"claims\":".utf8)) }
        try reject("error envelope cannot become empty list") {
            _ = try malformed.append(
                JSONSerialization.data(withJSONObject: ["error": ["code": "CONSENT_REQUIRED"]]))
        }
        try reject("page item bound") { _ = try malformed.append(page((0..<101).map { _ in UUID() })) }
        try reject("empty page with continuation") { _ = try malformed.append(page([], next: "again")) }
        try reject("unsafe cursor") {
            _ = try malformed.append(page([UUID()], next: "https://other.invalid/"))
        }
        try reject("body byte bound") { _ = try malformed.append(Data(repeating: 32, count: 32_769)) }
        var bounded = HealthKitRegisteredWorkoutPages()
        for i in 0..<99 {
            try require(
                try bounded.append(page([UUID()], next: "cursor_\(i)")) == nil, "bounded partial page")
        }
        try reject("100th continuation denied") {
            _ = try bounded.append(page([UUID()], next: "cursor_99"))
        }
        try require(try bounded.append(page([UUID()]))?.claims.count == 100, "100th terminal accepted")
        var empty = HealthKitRegisteredWorkoutPages()
        try require(
            try empty.append(page([], revision: 0))?.claims.isEmpty == true, "genuine empty registry")
        print("HealthKit registered pages harness passed: \(checks) assertions; no external requests")
    }
}
