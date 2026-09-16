import Foundation
import CoreFoundation
import HealthKit
import UIKit
import WebKit

// This disposable probe never requests authorization, queries samples, or uploads data.
final class LocalPages: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }
        let body: String
        if url.host == "foreign" {
            body = "<script>webkit.messageHandlers.status.postMessage({version:1,kind:'status',requestId:'foreign'})</script>"
        } else {
            body = """
            <!doctype html><meta name="viewport" content="width=device-width"><title>Native feasibility probe</title>
            <p>Local synthetic bridge probe. No health access requested.</p>
            <script>
            window.receiveNative = function(value) {
              if (value.version === 1 && value.requestId === 'valid' &&
                  typeof value.healthKitAvailable === 'boolean' && Object.keys(value).length === 3) {
                webkit.messageHandlers.status.postMessage({version:1,kind:'ack',requestId:'valid'});
              }
            };
            webkit.messageHandlers.status.postMessage({version:99,kind:'status',requestId:'invalid'});
            webkit.messageHandlers.status.postMessage({version:true,kind:'status',requestId:'valid'});
            webkit.messageHandlers.status.postMessage({version:1,kind:'status',requestId:'valid'});
            </script><iframe src="spikeapp://foreign/frame"></iframe>
            """
        }
        let data = Data(body.utf8)
        urlSchemeTask.didReceive(URLResponse(url: url, mimeType: "text/html", expectedContentLength: data.count, textEncodingName: "utf-8"))
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

@main
final class Probe: UIResponder, UIApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: UIWindow?
    private var webView: WKWebView!
    private let pages = LocalPages()
    private let available = HKHealthStore.isHealthDataAvailable()
    private var checks = Set<String>()
    private var navigationRequested = false
    private var foreignOriginRequested = false
    private var finished = false

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(pages, forURLScheme: "spikeapp")
        configuration.userContentController.add(self, name: "status")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        let controller = UIViewController()
        controller.view = webView
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = controller
        window?.makeKeyAndVisible()
        webView.load(URLRequest(url: URL(string: "spikeapp://local/index")!))
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in self?.finish(outcome: "timeout") }
        return true
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Both sender frame and local origin are verified before inspecting any payload.
        guard message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.scheme == "spikeapp",
              message.frameInfo.request.url?.host == "local" else {
            if message.frameInfo.request.url?.host == "foreign" {
                checks.insert(message.frameInfo.isMainFrame ? "foreign_main_origin_rejected" : "foreign_frame_rejected")
            }
            advance()
            return
        }
        guard let body = message.body as? [String: Any], body.count == 3,
              let version = body["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version == NSNumber(value: 1),
              let kind = body["kind"] as? String,
              let requestId = body["requestId"] as? String, requestId == "valid",
              kind == "status" || kind == "ack" else {
            if let body = message.body as? [String: Any],
               let version = body["version"] as? NSNumber,
               CFGetTypeID(version) == CFBooleanGetTypeID() {
                checks.insert("boolean_version_rejected")
            } else {
                checks.insert("invalid_message_rejected")
            }
            advance()
            return
        }
        if kind == "status" {
            checks.insert("valid_local_message_received")
            let response: [String: Any] = ["version": 1, "requestId": requestId, "healthKitAvailable": available]
            guard let data = try? JSONSerialization.data(withJSONObject: response),
                  let json = String(data: data, encoding: .utf8) else { finish(outcome: "serialization_failed"); return }
            webView.evaluateJavaScript("window.receiveNative(\(json))") { [weak self] _, error in
                if error != nil { self?.finish(outcome: "roundtrip_failed") }
            }
        } else {
            checks.insert("allowlisted_status_roundtrip_acknowledged")
        }
        advance()
    }

    private func advance() {
        if checks.count >= 5 && !foreignOriginRequested {
            foreignOriginRequested = true
            webView.load(URLRequest(url: URL(string: "spikeapp://foreign/main")!))
        }
        if checks.count >= 6 && !navigationRequested {
            navigationRequested = true
            webView.evaluateJavaScript("window.location.href='https://blocked.invalid/'")
        }
        if checks.contains("external_navigation_cancelled") { finish(outcome: "passed") }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.scheme == "spikeapp", ["local", "foreign"].contains(url.host ?? "") {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if navigationAction.request.url?.absoluteString == "https://blocked.invalid/" {
                checks.insert("external_navigation_cancelled")
                advance()
            }
        }
    }

    private func finish(outcome: String) {
        guard !finished else { return }
        finished = true
        let result: [String: Any] = [
            "outcome": outcome, "healthKitAvailable": available,
            "healthAuthorizationRequested": false, "healthQueriesExecuted": false,
            "checks": checks.sorted(), "operatingSystem": ProcessInfo.processInfo.operatingSystemVersionString
        ]
        do {
            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: directory.appendingPathComponent("probe-result.json"), options: .atomic)
        } catch {
            NSLog("NATIVE_PROBE_RESULT_WRITE_FAILED")
        }
    }
}
