import Foundation

// Link-only stand-ins; the harness exercises pure scope gates, never app auth or HealthKit I/O.
extension Notification.Name {
    static let nativeAuthCredentialInvalidated = Notification.Name("test.credentialInvalidated")
}

@MainActor
final class NativeAuth {
    static let shared = NativeAuth()
    func currentSession() async throws -> [String: String] { ["state": "signed_out"] }
}

@main
struct HealthKitWorkoutDebugProbeHarness {
    static func main() {
        let firstMarker = UUID().uuidString.lowercased()
        let secondMarker = UUID().uuidString.lowercased()
        let ownId = UUID()
        let otherId = UUID()
        let ownSource = "org.workoutmanager.app"
        let account = "athlete_one"

        precondition(UUID(uuidString: firstMarker) != nil)
        precondition(HealthKitWorkoutDebugProbe.hasExactScope(marker: firstMarker, sampleId: ownId))
        precondition(HealthKitWorkoutDebugProbe.queryPredicate(sampleId: nil) == nil,
                     "no known UUID means no HealthKit query")
        precondition(HealthKitWorkoutDebugProbe.queryPredicate(sampleId: ownId) != nil)
        precondition(!HealthKitWorkoutDebugProbe.hasExactScope(marker: firstMarker, sampleId: nil),
                     "observer/query scope requires the known UUID")
        precondition(!HealthKitWorkoutDebugProbe.hasExactScope(marker: "", sampleId: ownId))
        precondition(firstMarker != secondMarker, "new runs must rotate the marker")
        precondition(HealthKitWorkoutDebugProbe.acceptsSample(
            ownId, knownId: ownId, sourceBundleId: ownSource, ownBundleId: ownSource,
            metadataMarker: firstMarker, marker: firstMarker))
        precondition(!HealthKitWorkoutDebugProbe.acceptsSample(
            otherId, knownId: ownId, sourceBundleId: ownSource, ownBundleId: ownSource,
            metadataMarker: firstMarker, marker: firstMarker))
        precondition(!HealthKitWorkoutDebugProbe.acceptsSample(
            ownId, knownId: ownId, sourceBundleId: "org.other.app", ownBundleId: ownSource,
            metadataMarker: firstMarker, marker: firstMarker))
        precondition(!HealthKitWorkoutDebugProbe.acceptsSample(
            ownId, knownId: ownId, sourceBundleId: ownSource, ownBundleId: ownSource,
            metadataMarker: secondMarker, marker: firstMarker))
        precondition(HealthKitWorkoutDebugProbe.acceptsDeletion(ownId, knownId: ownId))
        precondition(!HealthKitWorkoutDebugProbe.acceptsDeletion(otherId, knownId: ownId))
        precondition(!HealthKitWorkoutDebugProbe.acceptsDeletion(ownId, knownId: nil))
        precondition(!HealthKitWorkoutDebugProbe.mayResumeRead(
            readOptedIn: false, sampleId: ownId), "write-only run must not start a read")
        precondition(HealthKitWorkoutDebugProbe.matchesAccount(
            runAccountId: account, sessionAccountId: account))
        precondition(!HealthKitWorkoutDebugProbe.matchesAccount(
            runAccountId: account, sessionAccountId: "athlete_two"),
            "account switch must reject previous run")
        precondition(!HealthKitWorkoutDebugProbe.matchesAccount(
            runAccountId: account, sessionAccountId: nil),
            "logout must reject previous run")
        precondition(!HealthKitWorkoutDebugProbe.mayResumeRead(
            readOptedIn: true, sampleId: nil), "no owned sample must not start a read")
        let upsertAnchor = Data([1])
        let deniedAnchor = Data([2])
        let tombstoneAnchor = Data([3])
        var cursor: Data? = nil
        var deletionConfirmed = false
        // A denied initial read returns an empty page, then the exact scoped delete succeeds.
        cursor = HealthKitWorkoutDebugProbe.anchorAfterFilteredPage(
            currentAnchor: cursor, nextAnchor: deniedAnchor,
            sawUpsert: false, sawDeletion: false)
        precondition(cursor == nil, "denied empty read must not advance a cursor")
        deletionConfirmed = true
        cursor = HealthKitWorkoutDebugProbe.anchorAfterFilteredPage(
            currentAnchor: cursor, nextAnchor: deniedAnchor,
            sawUpsert: false, sawDeletion: false)
        precondition(deletionConfirmed && cursor == nil,
                     "denied post-delete read must leave tombstone replay possible")
        cursor = HealthKitWorkoutDebugProbe.anchorAfterExplicitReadRequest(cursor)
        precondition(cursor == nil, "explicit retry must start from nil after denied deletion")
        precondition(HealthKitWorkoutDebugProbe.canReportCurrentRead(
            deletionConfirmed: deletionConfirmed, sawUpsert: false, sawDeletion: true))
        cursor = HealthKitWorkoutDebugProbe.anchorAfterFilteredPage(
            currentAnchor: cursor, nextAnchor: tombstoneAnchor,
            sawUpsert: false, sawDeletion: true)
        precondition(cursor == tombstoneAnchor, "observed tombstone may advance the cursor")

        // A previously observed upsert may leave a useful cursor. Denial after deletion
        // cannot replace it, and the next informed retry must still reconcile from nil.
        cursor = HealthKitWorkoutDebugProbe.anchorAfterFilteredPage(
            currentAnchor: nil, nextAnchor: upsertAnchor,
            sawUpsert: true, sawDeletion: false)
        precondition(cursor == upsertAnchor)
        precondition(HealthKitWorkoutDebugProbe.anchorAfterExplicitReadRequest(cursor) == nil,
                     "explicit read before deletion also starts from nil")
        cursor = HealthKitWorkoutDebugProbe.anchorAfterFilteredPage(
            currentAnchor: cursor, nextAnchor: deniedAnchor,
            sawUpsert: false, sawDeletion: false)
        precondition(cursor == upsertAnchor, "empty post-delete page must not advance anchor")
        cursor = HealthKitWorkoutDebugProbe.anchorAfterExplicitReadRequest(cursor)
        precondition(cursor == nil, "confirmed deletion must not skip explicit reconciliation")
        precondition(!HealthKitWorkoutDebugProbe.canReportCurrentRead(
            deletionConfirmed: deletionConfirmed, sawUpsert: false, sawDeletion: false),
            "authorization callback plus empty page cannot claim tombstone")
        precondition(!HealthKitWorkoutDebugProbe.canReportCurrentRead(
            deletionConfirmed: false, sawUpsert: false, sawDeletion: false),
            "stale pending events cannot prove the current read")
        precondition(HealthKitWorkoutDebugProbe.canReportCurrentRead(
            deletionConfirmed: false, sawUpsert: true, sawDeletion: false))
        precondition(!HealthKitWorkoutDebugProbe.canReportCurrentRead(
            deletionConfirmed: true, sawUpsert: true, sawDeletion: false),
            "a prior upsert cannot prove the current tombstone")
        precondition(HealthKitWorkoutDebugProbe.mayResumeRead(
            readOptedIn: true, sampleId: ownId), "explicit read may resume only its known sample")
        precondition(HealthKitWorkoutDebugProbe.acceptsCompletedRead(
            startedMarker: firstMarker, startedSampleId: ownId,
            latestMarker: firstMarker, latestSampleId: ownId))
        precondition(!HealthKitWorkoutDebugProbe.acceptsCompletedRead(
            startedMarker: firstMarker, startedSampleId: ownId,
            latestMarker: secondMarker, latestSampleId: ownId))
        precondition(!HealthKitWorkoutDebugProbe.acceptsCompletedRead(
            startedMarker: firstMarker, startedSampleId: ownId,
            latestMarker: firstMarker, latestSampleId: nil))
        print("HealthKit DEBUG probe harness passed: scope, ownership, and denied-read deletion retry")
    }
}
