import UIKit
import WebKit
import Capacitor

// Temporary feasibility instrumentation; not the product's native host or bridge.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = FeasibilityViewController()
        window?.makeKeyAndVisible()
    }
}

final class FeasibilityViewController: CAPBridgeViewController, WKScriptMessageHandler {
    private var recorded = false
    override func capacitorDidLoad() {
        guard let webView else { return }
        webView.configuration.userContentController.add(self, name: "feasibilityEvidence")
        let script = """
        (() => {
          let sent = false;
          const inspect = () => {
            const heading = document.querySelector('h1')?.textContent;
            const buttons = document.querySelectorAll('button').length;
            const native = window.Capacitor?.isNativePlatform?.();
            const platform = window.Capacitor?.getPlatform?.();
            if (!sent && heading === 'Workout Manager · Mobile Web' && buttons > 0 && native === true && platform === 'ios') {
              sent = true;
              observer.disconnect();
              requestAnimationFrame(() => requestAnimationFrame(() => {
                webkit.messageHandlers.feasibilityEvidence.postMessage({
                  heading, buttons, native, platform,
                  demoDisclaimerVisible: document.body.textContent.includes('서버 저장 및 실제 로그인이 연결되지 않았습니다.')
                });
              }));
            }
          };
          const observer = new MutationObserver(inspect);
          observer.observe(document.documentElement, { childList: true, subtree: true });
          inspect();
        })();
        """
        webView.configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            self?.record(["outcome": "timeout"])
        }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.scheme == "capacitor",
              message.frameInfo.request.url?.host == "localhost",
              let body = message.body as? [String: Any], body.count == 5,
              body["heading"] as? String == "Workout Manager · Mobile Web",
              body["platform"] as? String == "ios",
              body["native"] as? Bool == true,
              body["demoDisclaimerVisible"] as? Bool == true,
              let buttons = body["buttons"] as? Int, buttons > 0 else { return }
        record(["outcome": "passed", "headingRendered": true, "sharedWorkspaceButtonCount": buttons,
                "capacitorPlatform": "ios", "nativePlatform": true, "demoDisclaimerVisible": true,
                "localOriginVerified": true])
    }
    private func record(_ result: [String: Any]) {
        guard !recorded else { return }
        recorded = true
        do {
            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys, .prettyPrinted])
            try data.write(to: directory.appendingPathComponent("capacitor-probe.json"), options: .atomic)
        } catch { NSLog("CAPACITOR_PROBE_WRITE_FAILED") }
    }
}
