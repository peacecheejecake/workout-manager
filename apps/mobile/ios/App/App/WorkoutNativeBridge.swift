import Capacitor
import Foundation
import UIKit

@objc(WorkoutNativeBridge)
final class WorkoutNativeBridge: CAPInstancePlugin, CAPBridgedPlugin {
    let identifier = "WorkoutNativeBridge"
    let jsName = "WorkoutNativeBridge"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "exchange", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    private let protocolVersion = 2
    @MainActor private var activeTasks: [String: Task<Void, Never>] = [:]
    @MainActor private var pendingCancels = Set<String>()

    @objc func cancel(_ call: CAPPluginCall) {
        guard Set(call.options.keys) == Set(["id"]),
              let id = call.getString("id"), Self.validID(id) else {
            call.reject("Invalid bridge request", "INVALID_REQUEST")
            return
        }
        Task { @MainActor in
            if let task = self.activeTasks[id] {
                task.cancel()
                await task.value
            } else {
                // The sideband call can reach the main actor before exchange registers.
                // Keep only a bounded number of short-lived request IDs.
                if self.pendingCancels.count >= 256 { self.pendingCancels.removeFirst() }
                self.pendingCancels.insert(id)
            }
            call.resolve(["status": "cancelled"])
        }
    }

    private static func validID(_ id: String) -> Bool {
        id.utf16.count <= 128 &&
            id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
    }

    @objc func exchange(_ call: CAPPluginCall) {
        guard Set(call.options.keys) == Set(["request"]),
              let request = call.getObject("request"),
              let id = request["id"] as? String,
              Self.validID(id) else {
            call.reject("Invalid bridge request", "INVALID_REQUEST")
            return
        }

        guard let version = request["version"] as? Int,
              version == protocolVersion else {
            resolveError(call, id: id, code: "UNSUPPORTED_VERSION")
            return
        }

        switch request["kind"] as? String {
        case "hello":
            guard Set(request.keys) == Set(["kind", "version", "id"]) else {
                resolveError(call, id: id, code: "INVALID_REQUEST")
                return
            }
            call.resolve(["reply": [
                "kind": "hello.result",
                "version": protocolVersion,
                "id": id,
                "capabilities": [
                    "app.openSettings": true,
                    "healthkit.read": false,
                    "auth.transport": NativeAuth.isConfigured
                ]
            ]])

        case "command":
            guard let method = request["method"] as? String,
                  ["app.openSettings", "auth.signIn", "auth.session", "auth.signOut", "api.read"].contains(method) else {
                resolveError(call, id: id, code: "UNSUPPORTED_METHOD")
                return
            }
            guard Set(request.keys) == Set(["kind", "version", "id", "method", "payload"]),
                  let payload = request["payload"] as? [String: Any] else {
                resolveError(call, id: id, code: "INVALID_REQUEST")
                return
            }
            if method == "api.read" {
                guard Set(payload.keys) == Set(["path"]),
                      let path = payload["path"] as? String,
                      ["/bff/v1/session", "/bff/v1/consents/ai"].contains(path) else {
                    resolveError(call, id: id, code: "INVALID_REQUEST")
                    return
                }
            } else if !payload.isEmpty {
                resolveError(call, id: id, code: "INVALID_REQUEST")
                return
            }
            if method != "app.openSettings" {
                Task { @MainActor in
                    if self.pendingCancels.remove(id) != nil {
                        self.resolveError(call, id: id, code: "CANCELLED")
                        return
                    }
                    guard self.activeTasks[id] == nil else {
                        self.resolveError(call, id: id, code: "INVALID_REQUEST")
                        return
                    }
                    let task = Task { @MainActor in
                        defer { self.activeTasks.removeValue(forKey: id) }
                        do {
                            let reply: [String: Any]
                            var completedSignInSessionID: String?
                            switch method {
                            case "auth.signIn":
                                let result = try await NativeAuth.shared.signIn()
                                completedSignInSessionID = result.sessionID
                                reply = ["session": result.session]
                            case "auth.session":
                                reply = ["session": try await NativeAuth.shared.currentSession()]
                            case "auth.signOut":
                                try await NativeAuth.shared.signOut()
                                reply = ["status": "signed_out"]
                            case "api.read":
                                guard let path = payload["path"] as? String else {
                                    self.resolveError(call, id: id, code: "INVALID_REQUEST")
                                    return
                                }
                                reply = try await NativeAuth.shared.readAPI(path)
                            default:
                                self.resolveError(call, id: id, code: "UNSUPPORTED_METHOD")
                                return
                            }
                            do {
                                try Task.checkCancellation()
                            } catch {
                                if let completedSignInSessionID {
                                    await NativeAuth.shared.cancelCompletedSignIn(sessionID: completedSignInSessionID)
                                }
                                throw error
                            }
                            call.resolve(["reply": [
                                "kind": "command.result",
                                "version": self.protocolVersion,
                                "id": id,
                                "method": method
                            ].merging(reply) { _, new in new }])
                        } catch {
                            self.resolveError(call, id: id, code: NativeAuth.bridgeCode(for: error))
                        }
                    }
                    self.activeTasks[id] = task
                }
                return
            }
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                resolveError(call, id: id, code: "UNAVAILABLE")
                return
            }
            DispatchQueue.main.async {
                UIApplication.shared.open(url, options: [:]) { opened in
                    if opened {
                        call.resolve(["reply": [
                            "kind": "command.result",
                            "version": self.protocolVersion,
                            "id": id,
                            "method": "app.openSettings",
                            "status": "opened"
                        ]])
                    } else {
                        self.resolveError(call, id: id, code: "UNAVAILABLE")
                    }
                }
            }

        default:
            resolveError(call, id: id, code: "INVALID_REQUEST")
        }
    }

    private func resolveError(_ call: CAPPluginCall, id: String, code: String) {
        call.resolve(["reply": [
            "kind": "error",
            "version": protocolVersion,
            "id": id,
            "code": code
        ]])
    }
}
