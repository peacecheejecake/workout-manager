import Capacitor
import Foundation
import UIKit
import WebKit

private func isLocalAppURL(_ url: URL?) -> Bool {
    guard let url else { return false }
    return url.scheme == "capacitor" && url.host == "localhost" &&
        url.port == nil && url.user == nil && url.password == nil
}

private final class LocalFrameMessageHandler: NSObject, WKScriptMessageHandler {
    private let original: WKScriptMessageHandler
    private weak var webView: WKWebView?

    init(original: WKScriptMessageHandler, webView: WKWebView) {
        self.original = original
        self.webView = webView
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == "capacitor",
              message.frameInfo.securityOrigin.host == "localhost",
              message.frameInfo.securityOrigin.port == 0,
              message.webView === webView,
              isLocalAppURL(webView?.url),
              let body = message.body as? [String: Any],
              body["type"] as? String == "message",
              body["pluginId"] as? String == "WorkoutNativeBridge",
              body["methodName"] as? String == "exchange" else { return }
        original.userContentController(userContentController, didReceive: message)
    }
}

private final class LocalNavigationDelegate: NSObject, WKNavigationDelegate {
    private let original: WebViewDelegationHandler

    init(original: WebViewDelegationHandler) {
        self.original = original
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, isLocalAppURL(url) else {
            if action.targetFrame == nil || action.targetFrame?.isMainFrame == true,
               let url = action.request.url,
               url.scheme == "https" || url.scheme == "http" {
                UIApplication.shared.open(url, options: [:])
            }
            decisionHandler(.cancel)
            return
        }
        original.webView(webView, decidePolicyFor: action, decisionHandler: decisionHandler)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        original.webView(webView, didStartProvisionalNavigation: navigation)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        original.webView(webView, didFinish: navigation)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        original.webView(webView, didFail: navigation, withError: error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        original.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        original.webViewWebContentProcessDidTerminate(webView)
    }

    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping @MainActor (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        original.webView(webView, didReceive: challenge, completionHandler: completionHandler)
    }
}

private final class LocalUIDelegate: NSObject, WKUIDelegate {
    private let original: WebViewDelegationHandler

    init(original: WebViewDelegationHandler) {
        self.original = original
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url,
           action.sourceFrame.isMainFrame,
           isLocalAppURL(action.sourceFrame.request.url),
           url.scheme == "https" || url.scheme == "http" {
            UIApplication.shared.open(url, options: [:])
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        original.webView(webView, runJavaScriptAlertPanelWithMessage: message,
                         initiatedByFrame: frame, completionHandler: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        original.webView(webView, runJavaScriptConfirmPanelWithMessage: message,
                         initiatedByFrame: frame, completionHandler: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        original.webView(webView, runJavaScriptTextInputPanelWithPrompt: prompt,
                         defaultText: defaultText, initiatedByFrame: frame,
                         completionHandler: completionHandler)
    }
}

final class LocalBridgeViewController: CAPBridgeViewController {
    private var messageGuard: LocalFrameMessageHandler?
    private var navigationGuard: LocalNavigationDelegate?
    private var uiGuard: LocalUIDelegate?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(WorkoutNativeBridge())
        guard let webView,
              let original = webView.navigationDelegate as? WebViewDelegationHandler else {
            return
        }
        let contentController = webView.configuration.userContentController
        let guardedMessages = LocalFrameMessageHandler(original: original, webView: webView)
        contentController.removeScriptMessageHandler(forName: "bridge")
        contentController.add(guardedMessages, name: "bridge")
        messageGuard = guardedMessages

        let guardedNavigation = LocalNavigationDelegate(original: original)
        webView.navigationDelegate = guardedNavigation
        navigationGuard = guardedNavigation

        let guardedUI = LocalUIDelegate(original: original)
        webView.uiDelegate = guardedUI
        uiGuard = guardedUI
    }
}
