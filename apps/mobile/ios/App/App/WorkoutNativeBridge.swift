import Capacitor
import Foundation
import UIKit

@objc(WorkoutNativeBridge)
final class WorkoutNativeBridge: CAPInstancePlugin, CAPBridgedPlugin {
    let identifier = "WorkoutNativeBridge"
    let jsName = "WorkoutNativeBridge"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "exchange", returnType: CAPPluginReturnPromise)
    ]

    private let protocolVersion = 2
    @objc func exchange(_ call: CAPPluginCall) {
        guard Set(call.options.keys) == Set(["request"]),
              let request = call.getObject("request"),
              let id = request["id"] as? String,
              id.utf16.count <= 128,
              id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else {
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
                  ["app.openSettings", "auth.signIn", "auth.session", "auth.signOut"].contains(method) else {
                resolveError(call, id: id, code: "UNSUPPORTED_METHOD")
                return
            }
            guard Set(request.keys) == Set(["kind", "version", "id", "method", "payload"]),
                  let payload = request["payload"] as? [String: Any],
                  payload.isEmpty else {
                resolveError(call, id: id, code: "INVALID_REQUEST")
                return
            }
            if method != "app.openSettings" {
                DispatchQueue.main.async {
                    Task { @MainActor in
                        do {
                            let reply: [String: Any]
                            switch method {
                            case "auth.signIn":
                                let session = try await NativeAuth.shared.signIn()
                                reply = ["session": session]
                            case "auth.session":
                                reply = ["session": try NativeAuth.shared.currentSession()]
                            case "auth.signOut":
                                try await NativeAuth.shared.signOut()
                                reply = ["status": "signed_out"]
                            default:
                                self.resolveError(call, id: id, code: "UNSUPPORTED_METHOD")
                                return
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
