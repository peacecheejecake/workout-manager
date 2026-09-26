import Capacitor
import CryptoKit
import HealthKit
import UIKit

// M0-06c physical-device feasibility probe. Not a product host, not a health collector.
// It writes, reads and deletes ONLY synthetic samples it wrote itself (own source, tagged
// metadata, dated 2001-01-01) and never reads or exports any other health record.

let probeTag = "M0-06c"
let probeTagKey = "WMSyntheticProbe"
let probeRunKey = "WMProbeRunID"

/// Append-only JSON-lines evidence log in the app's Documents container.
final class ProbeLog {
  static let shared = ProbeLog()
  let launchId = UUID().uuidString
  private let queue = DispatchQueue(label: "wm.probe.log")
  private var sequence = 0
  let directory: URL = {
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("wm-device-probe", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }()

  func record(_ kind: String, _ fields: [String: Any] = [:]) {
    let at = ISO8601DateFormatter().string(from: Date())
    queue.async {
      self.sequence += 1
      var entry = fields
      entry["kind"] = kind
      entry["at"] = at
      entry["launchId"] = self.launchId
      entry["sequence"] = self.sequence
      guard JSONSerialization.isValidJSONObject(entry),
        var line = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys])
      else { return }
      line.append(0x0A)
      let url = self.directory.appendingPathComponent("events.jsonl")
      if let handle = try? FileHandle(forWritingTo: url) {
        handle.seekToEndOfFile()
        handle.write(line)
        try? handle.synchronize()
        try? handle.close()
      } else {
        try? line.write(to: url, options: .atomic)
      }
    }
  }

  /// Wait until every queued line is on disk (used before an injected kill).
  func flush() { queue.sync {} }
}

/// Durable collector state: anchors and outbox are committed together in one atomic write.
struct ProbeState: Codable {
  var schemaVersion = 2
  var anchors: [String: Data] = [:]
  var outbox: [OutboxEntry] = []
  var backgroundDeliveryEnabled = false
}

struct OutboxEntry: Codable, Equatable {
  let key: String
  let type: String
  let uuid: String
  let op: String
  var attempts: Int
}

/// Local stand-in for an idempotent server receiver. Not a server acknowledgement.
struct LocalSink: Codable {
  var receipts: [String: Int] = [:]
}

enum ProbeFiles {
  static func url(_ name: String) -> URL { ProbeLog.shared.directory.appendingPathComponent(name) }
  static func load<T: Decodable>(_ type: T.Type, _ name: String, fallback: T) -> T {
    guard let data = try? Data(contentsOf: url(name)) else { return fallback }
    return (try? JSONDecoder().decode(type, from: data)) ?? fallback
  }
  static func save<T: Encodable>(_ value: T, _ name: String) throws {
    try JSONEncoder().encode(value).write(to: url(name), options: [.atomic])
  }
}

func digest(_ data: Data?) -> String {
  guard let data else { return "none" }
  return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined().prefix(16)
    .description
}

func describe(_ error: Error) -> [String: Any] {
  let value = error as NSError
  return ["errorDomain": value.domain, "errorCode": value.code]
}

func appStateName() -> String {
  switch UIApplication.shared.applicationState {
  case .active: return "active"
  case .inactive: return "inactive"
  case .background: return "background"
  @unknown default: return "unknown"
  }
}

final class HealthProbe {
  static let shared = HealthProbe()
  let store = HKHealthStore()
  let heartRate = HKQuantityType.quantityType(forIdentifier: .heartRate)!
  let workout = HKObjectType.workoutType()
  var sampleTypes: [HKSampleType] { [heartRate, workout] }
  private var observers: [HKObserverQuery] = []
  private let ownSource = HKQuery.predicateForObjects(from: HKSource.default())

  func loadState() -> ProbeState {
    var state = ProbeFiles.load(ProbeState.self, "state.json", fallback: ProbeState())
    if state.schemaVersion == 1 {
      // v1 anchored every own-source sample; its anchors/outbox cannot be reused for tagged-only reads.
      state.schemaVersion = 2
      state.anchors = [:]
      state.outbox = []
    }
    return state
  }

  private var probeOnly: NSPredicate {
    taggedPredicate(runId: nil)
  }

  private func taggedPredicate(runId: String?) -> NSPredicate {
    var predicates: [NSPredicate] = [
      ownSource,
      HKQuery.predicateForObjects(withMetadataKey: probeTagKey, allowedValues: [probeTag]),
    ]
    if let runId {
      predicates.append(
        HKQuery.predicateForObjects(withMetadataKey: probeRunKey, allowedValues: [runId]))
    }
    return NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
  }

  func status() async -> [String: Any] {
    var result: [String: Any] = ["healthDataAvailable": HKHealthStore.isHealthDataAvailable()]
    var share: [String: String] = [:]
    for type in sampleTypes {
      switch store.authorizationStatus(for: type) {
      case .notDetermined: share[type.identifier] = "notDetermined"
      case .sharingDenied: share[type.identifier] = "sharingDenied"
      case .sharingAuthorized: share[type.identifier] = "sharingAuthorized"
      @unknown default: share[type.identifier] = "unknown"
      }
    }
    result["shareStatus"] = share
    let request = await withCheckedContinuation { continuation in
      store.getRequestStatusForAuthorization(toShare: Set(sampleTypes), read: Set(sampleTypes)) {
        status, _ in continuation.resume(returning: status)
      }
    }
    result["requestStatus"] =
      request == .unnecessary
      ? "unnecessary" : request == .shouldRequest ? "shouldRequest" : "unknown"
    return result
  }

  func authorize() async -> [String: Any] {
    do {
      try await store.requestAuthorization(toShare: Set(sampleTypes), read: Set(sampleTypes))
      return ["requestCompleted": true]
    } catch { return ["requestCompleted": false].merging(describe(error)) { $1 } }
  }

  /// Count own-source probe samples matching a fresh run id: must be an empty result.
  func emptyQuery() async -> [String: Any] {
    let run = UUID().uuidString
    var counts: [String: Int] = [:]
    for type in sampleTypes {
      let predicate = taggedPredicate(runId: run)
      counts[type.identifier] = (try? await samples(type, predicate).count) ?? -1
    }
    var ownProbe: [String: Int] = [:]
    for type in sampleTypes {
      ownProbe[type.identifier] = (try? await samples(type, probeOnly).count) ?? -1
    }
    return ["freshRunCounts": counts, "ownProbeSampleCounts": ownProbe]
  }

  private func samples(_ type: HKSampleType, _ predicate: NSPredicate) async throws -> [HKSample] {
    try await withCheckedThrowingContinuation { continuation in
      store.execute(
        HKSampleQuery(
          sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil
        ) {
          _, results, error in
          if let error {
            continuation.resume(throwing: error)
          } else {
            continuation.resume(returning: results ?? [])
          }
        })
    }
  }

  /// Write one synthetic heart-rate sample and one synthetic workout, both dated 2001-01-01 UTC.
  func addSynthetic() async -> [String: Any] {
    let run = UUID().uuidString
    let metadata: [String: Any] = [probeTagKey: probeTag, probeRunKey: run]
    let start = Date(timeIntervalSinceReferenceDate: 0)
    var result: [String: Any] = ["runId": run]
    do {
      let sample = HKQuantitySample(
        type: heartRate,
        quantity: HKQuantity(unit: .count().unitDivided(by: .minute()), doubleValue: 61),
        start: start, end: start, metadata: metadata)
      try await store.save(sample)
      result["heartRateUUID"] = sample.uuid.uuidString
      let configuration = HKWorkoutConfiguration()
      configuration.activityType = .walking
      configuration.locationType = .outdoor
      let builder = HKWorkoutBuilder(healthStore: store, configuration: configuration, device: nil)
      try await builder.beginCollection(at: start)
      try await builder.addMetadata(metadata)
      try await builder.endCollection(at: start.addingTimeInterval(600))
      let saved = try await builder.finishWorkout()
      guard let saved else {
        result["saved"] = false
        result["workoutMissing"] = true
        result["cleanup"] = await deleteSynthetic(runId: run)
        return result
      }
      result["workoutUUID"] = saved.uuid.uuidString
      result["saved"] = true
    } catch {
      result["saved"] = false
      result.merge(describe(error)) { $1 }
      // A failed workout save can leave the earlier heart-rate sample behind.
      result["cleanup"] = await deleteSynthetic(runId: run)
    }
    return result
  }

  func deleteSynthetic(runId: String? = nil) async -> [String: Any] {
    var deleted: [String: Int] = [:]
    var result: [String: Any] = [:]
    let predicate = taggedPredicate(runId: runId)
    for type in sampleTypes {
      do {
        deleted[type.identifier] = try await withCheckedThrowingContinuation { continuation in
          store.deleteObjects(of: type, predicate: predicate) { _, count, error in
            if let error {
              continuation.resume(throwing: error)
            } else {
              continuation.resume(returning: count)
            }
          }
        }
      } catch {
        deleted[type.identifier] = -1
        result[type.identifier + ".error"] = describe(error)
      }
    }
    result["deletedCounts"] = deleted
    var remaining: [String: Int] = [:]
    for type in sampleTypes {
      do {
        remaining[type.identifier] = try await samples(type, predicate).count
      } catch {
        remaining[type.identifier] = -1
        result[type.identifier + ".verifyError"] = describe(error)
      }
    }
    result["remainingTaggedCounts"] = remaining
    result["deleteCallsSucceeded"] = deleted.values.allSatisfy { $0 >= 0 }
    // HealthKit hides read authorization, so an empty query cannot prove that deletion finished.
    result["taggedQueryEmpty"] = remaining.values.allSatisfy { $0 == 0 }
    return result
  }

  /// Anchored own-source query → outbox, committing new anchors only together with the outbox.
  func collect(crashBeforePersist: Bool) async -> [String: Any] {
    var state = loadState()
    var perType: [String: Any] = [:]
    var anchors = state.anchors
    for type in sampleTypes {
      let stored = state.anchors[type.identifier].flatMap {
        try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0)
      }
      do {
        let (added, deleted, anchor) = try await anchored(type, stored)
        let newAnchor = anchor.flatMap {
          try? NSKeyedArchiver.archivedData(withRootObject: $0, requiringSecureCoding: true)
        }
        var entries: [OutboxEntry] = []
        let probeAdded = added.filter { ($0.metadata?[probeTagKey] as? String) == probeTag }
        let probeDeleted = deleted.filter { ($0.metadata?[probeTagKey] as? String) == probeTag }
        for sample in probeAdded {
          entries.append(
            OutboxEntry(
              key: "\(type.identifier)|\(sample.uuid.uuidString)|upsert", type: type.identifier,
              uuid: sample.uuid.uuidString, op: "upsert", attempts: 0))
        }
        for object in probeDeleted {
          entries.append(
            OutboxEntry(
              key: "\(type.identifier)|\(object.uuid.uuidString)|tombstone", type: type.identifier,
              uuid: object.uuid.uuidString, op: "tombstone", attempts: 0))
        }
        for entry in entries where !state.outbox.contains(where: { $0.key == entry.key }) {
          state.outbox.append(entry)
        }
        if let newAnchor { anchors[type.identifier] = newAnchor }
        perType[type.identifier] = [
          "fromAnchor": digest(state.anchors[type.identifier]), "toAnchor": digest(newAnchor),
          "added": probeAdded.map { $0.uuid.uuidString },
          "rejectedUntaggedAdded": added.count - probeAdded.count,
          "deleted": probeDeleted.map { $0.uuid.uuidString },
          "rejectedUntaggedDeleted": deleted.count - probeDeleted.count,
        ]
      } catch {
        perType[type.identifier] = describe(error)
      }
    }
    if crashBeforePersist {
      ProbeLog.shared.record("injectedKill", ["point": "collectBeforePersist", "result": perType])
      ProbeLog.shared.flush()
      kill(getpid(), SIGKILL)
    }
    state.anchors = anchors
    do {
      try ProbeFiles.save(state, "state.json")
    } catch {
      return ["perType": perType, "persisted": false].merging(describe(error)) { $1 }
    }
    return ["perType": perType, "persisted": true, "outbox": state.outbox.map { $0.key }]
  }

  private func anchored(_ type: HKSampleType, _ anchor: HKQueryAnchor?) async throws
    -> ([HKSample], [HKDeletedObject], HKQueryAnchor?)
  {
    try await withCheckedThrowingContinuation { continuation in
      store.execute(
        HKAnchoredObjectQuery(
          type: type, predicate: probeOnly, anchor: anchor, limit: 100
        ) {
          _, added, deleted, newAnchor, error in
          if let error {
            continuation.resume(throwing: error)
          } else {
            continuation.resume(returning: (added ?? [], deleted ?? [], newAnchor))
          }
        })
    }
  }

  /// Deliver outbox entries to the local stand-in sink, then acknowledge (remove) them.
  func send(crashBeforeAck: Bool) -> [String: Any] {
    var state = loadState()
    var sink = ProbeFiles.load(LocalSink.self, "sink.json", fallback: LocalSink())
    let sending = state.outbox.map { entry -> OutboxEntry in
      var copy = entry
      copy.attempts += 1
      return copy
    }
    for entry in sending { sink.receipts[entry.key, default: 0] += 1 }
    do { try ProbeFiles.save(sink, "sink.json") } catch {
      return ["sent": false].merging(describe(error)) { $1 }
    }
    if crashBeforeAck {
      state.outbox = sending
      try? ProbeFiles.save(state, "state.json")
      ProbeLog.shared.record(
        "injectedKill",
        [
          "point": "sendBeforeAck",
          "sent": sending.map { ["key": $0.key, "attempts": $0.attempts] },
        ])
      ProbeLog.shared.flush()
      kill(getpid(), SIGKILL)
    }
    state.outbox = []
    do { try ProbeFiles.save(state, "state.json") } catch {
      return ["sent": true, "acked": false].merging(describe(error)) { $1 }
    }
    return [
      "sent": sending.map { ["key": $0.key, "attempts": $0.attempts] }, "acked": true,
      "sinkReceipts": sink.receipts, "sinkUniqueKeys": sink.receipts.count,
    ]
  }

  func setBackgroundDelivery(_ enabled: Bool) async -> [String: Any] {
    var result: [String: Any] = [:]
    var succeeded = true
    var rollbackSucceeded = true
    for type in sampleTypes {
      do {
        if enabled {
          try await store.enableBackgroundDelivery(for: type, frequency: .immediate)
        } else {
          try await store.disableBackgroundDelivery(for: type)
        }
        result[type.identifier] = "ok"
      } catch {
        succeeded = false
        result[type.identifier] = describe(error)
      }
    }
    if enabled && !succeeded {
      // Never leave one type registered while local state claims both are enabled.
      var rollback: [String: Any] = [:]
      for type in sampleTypes {
        do {
          try await store.disableBackgroundDelivery(for: type)
          rollback[type.identifier] = "ok"
        } catch {
          rollbackSucceeded = false
          rollback[type.identifier] = describe(error)
        }
      }
      result["rollback"] = rollback
    }
    var state = loadState()
    // A failed disable or rollback can leave OS delivery active; retry cleanup on next launch.
    state.backgroundDeliveryEnabled = enabled ? succeeded || !rollbackSucceeded : !succeeded
    do {
      try ProbeFiles.save(state, "state.json")
    } catch {
      result["persisted"] = false
      result["persistError"] = describe(error)
      if enabled {
        for type in sampleTypes { try? await store.disableBackgroundDelivery(for: type) }
      }
      return result
    }
    result["persisted"] = true
    result["enabled"] = enabled && succeeded
    result["cleanupRequired"] = state.backgroundDeliveryEnabled && !(enabled && succeeded)
    if state.backgroundDeliveryEnabled { registerObservers() }
    if !state.backgroundDeliveryEnabled {
      for observer in observers { store.stop(observer) }
      observers.removeAll()
    }
    return result
  }

  /// Idempotent final cleanup for the probe's own tagged samples and delivery registration.
  func cleanup() async -> [String: Any] {
    let delivery = await setBackgroundDelivery(false)
    let samples = await deleteSynthetic()
    let deliveryClean =
      delivery["persisted"] as? Bool == true
      && delivery["cleanupRequired"] as? Bool == false
      && sampleTypes.allSatisfy { delivery[$0.identifier] as? String == "ok" }
    return [
      "backgroundDelivery": delivery,
      "taggedSamples": samples,
      "cleanupCallsSucceeded": deliveryClean && samples["deleteCallsSucceeded"] as? Bool == true,
    ]
  }

  /// Observer queries must be registered on every launch, including background wake-ups.
  func registerObservers() {
    guard observers.isEmpty,
      loadState().backgroundDeliveryEnabled
    else { return }
    for type in sampleTypes {
      let query = HKObserverQuery(sampleType: type, predicate: probeOnly) { _, completion, error in
        // Only tagged, own-source changes can trigger the callback or follow-up query.
        DispatchQueue.main.async {
          var fields: [String: Any] = ["type": type.identifier, "appState": appStateName()]
          if let error { fields.merge(describe(error)) { $1 } }
          ProbeLog.shared.record("observerCallback", fields)
          Task {
            let collected = await self.collect(crashBeforePersist: false)
            ProbeLog.shared.record("observerCollect", collected)
            completion()
          }
        }
      }
      store.execute(query)
      observers.append(query)
    }
    ProbeLog.shared.record("observersRegistered", ["types": sampleTypes.map { $0.identifier }])
  }
}

/// Runs the single step named by the `-wmProbeStep` launch argument once the scene is active.
final class ProbeRunner {
  static let shared = ProbeRunner()
  private var ran = false
  func runLaunchStepOnce() {
    guard !ran else { return }
    ran = true
    let defaults = UserDefaults.standard
    guard let step = defaults.string(forKey: "wmProbeStep") else {
      ProbeLog.shared.record("step", ["step": "none"])
      return
    }
    let crash = defaults.string(forKey: "wmProbeCrash") ?? "none"
    let probe = HealthProbe.shared
    Task { @MainActor in
      ProbeLog.shared.record("stepStarted", ["step": step, "crash": crash])
      var result: [String: Any]
      switch step {
      case "status": result = await probe.status()
      case "authorize":
        result = await probe.authorize()
        result["after"] = await probe.status()
      case "empty": result = await probe.emptyQuery()
      case "add": result = await probe.addSynthetic()
      case "collect":
        result = await probe.collect(crashBeforePersist: crash == "collectBeforePersist")
      case "send": result = probe.send(crashBeforeAck: crash == "sendBeforeAck")
      case "delete": result = await probe.deleteSynthetic()
      case "cleanup": result = await probe.cleanup()
      case "enableBackground": result = await probe.setBackgroundDelivery(true)
      case "disableBackground": result = await probe.setBackgroundDelivery(false)
      case "state":
        let state = probe.loadState()
        result = [
          "outbox": state.outbox.map { $0.key }, "anchors": state.anchors.mapValues { digest($0) },
          "backgroundDeliveryEnabled": state.backgroundDeliveryEnabled,
        ]
      default: result = ["error": "UNKNOWN_STEP"]
      }
      ProbeLog.shared.record("stepCompleted", ["step": step, "result": result])
    }
  }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    ProbeLog.shared.record(
      "launch",
      [
        "appState": appStateName(),
        "protectedDataAvailable": application.isProtectedDataAvailable,
        "optionKeys": (launchOptions ?? [:]).keys.map { $0.rawValue }.sorted(),
      ])
    HealthProbe.shared.registerObservers()
    return true
  }

  func applicationWillTerminate(_ application: UIApplication) {
    ProbeLog.shared.record("applicationWillTerminate")
    ProbeLog.shared.flush()
  }

  func application(
    _ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    ApplicationDelegateProxy.shared.application(app, open: url, options: options)
  }

  func application(
    _ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let config = UISceneConfiguration(
      name: "Default Configuration", sessionRole: connectingSceneSession.role)
    config.delegateClass = SceneDelegate.self
    return config
  }
}
