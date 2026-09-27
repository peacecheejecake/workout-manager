import HealthKit
import UIKit

// Test-only HealthKit writer. It never requests read access or queries existing records.
private let markerKey = "WMWakeWriter"
private let markerValue = "M0-06c"
private let sampleDate = Date(timeIntervalSinceReferenceDate: 0)

final class WriterLog {
  static let shared = WriterLog()
  let launchId = UUID().uuidString
  private let queue = DispatchQueue(label: "wm.writer.log")
  let directory: URL = {
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("wm-device-writer", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }()

  func record(_ kind: String, _ fields: [String: Any] = [:]) {
    let at = ISO8601DateFormatter().string(from: Date())
    queue.async {
      var entry = fields
      entry["kind"] = kind
      entry["at"] = at
      entry["launchId"] = self.launchId
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
}

final class WriterProbe {
  static let shared = WriterProbe()
  private let store = HKHealthStore()
  private let heartRate = HKQuantityType.quantityType(forIdentifier: .heartRate)!
  private var ownTagged: NSPredicate {
    NSCompoundPredicate(andPredicateWithSubpredicates: [
      HKQuery.predicateForObjects(from: HKSource.default()),
      HKQuery.predicateForObjects(withMetadataKey: markerKey, allowedValues: [markerValue]),
    ])
  }

  func authorize() async -> [String: Any] {
    do {
      try await store.requestAuthorization(toShare: [heartRate], read: [])
      return ["requestCompleted": true]
    } catch {
      return ["requestCompleted": false, "errorCode": (error as NSError).code]
    }
  }

  func add() async -> [String: Any] {
    let sample = HKQuantitySample(
      type: heartRate,
      quantity: HKQuantity(unit: .count().unitDivided(by: .minute()), doubleValue: 61),
      start: sampleDate, end: sampleDate,
      metadata: [markerKey: markerValue])
    do {
      try await store.save(sample)
      return ["saved": true, "marker": markerValue]
    } catch {
      return ["saved": false, "errorCode": (error as NSError).code]
    }
  }

  func cleanup() async -> [String: Any] {
    do {
      let count = try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<Int, Error>) in
        store.deleteObjects(of: heartRate, predicate: ownTagged) { _, count, error in
          if let error {
            continuation.resume(throwing: error)
          } else {
            continuation.resume(returning: count)
          }
        }
      }
      return ["deleteCallSucceeded": true, "deletedCount": count]
    } catch {
      return ["deleteCallSucceeded": false, "errorCode": (error as NSError).code]
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
    WriterLog.shared.record("launch", ["appState": "\(application.applicationState.rawValue)"])
    return true
  }

  func application(
    _ application: UIApplication, configurationForConnecting session: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let config = UISceneConfiguration(name: "Default Configuration", sessionRole: session.role)
    config.delegateClass = SceneDelegate.self
    return config
  }
}
