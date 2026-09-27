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
    private var keyboardObservers: [NSObjectProtocol] = []
    private var keyboardFrame: CGRect?
    private var originalContentInset: UIEdgeInsets?
    private var originalIndicatorInset: UIEdgeInsets?
    private var lastWebViewSize: CGSize = .zero
    private var focusRevealGeneration = 0

    deinit {
        for observer in keyboardObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

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

        configureKeyboardAvoidance(for: webView)
        webView.allowsBackForwardNavigationGestures = false
        let backGesture = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleBackGesture(_:)))
        backGesture.edges = .left
        webView.addGestureRecognizer(backGesture)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard let webView, webView.bounds.size != lastWebViewSize else { return }
        lastWebViewSize = webView.bounds.size
        if let keyboardFrame {
            updateKeyboardAvoidance(frame: keyboardFrame, revealFocus: true)
        }
    }

    func notifySceneDidBecomeActive() {
        dispatchLocalEvent("workout:native-foreground")
    }

    private func configureKeyboardAvoidance(for webView: WKWebView) {
        originalContentInset = webView.scrollView.contentInset
        originalIndicatorInset = webView.scrollView.verticalScrollIndicatorInsets
        lastWebViewSize = webView.bounds.size

        for name in [
            UIResponder.keyboardWillChangeFrameNotification,
            UIResponder.keyboardDidChangeFrameNotification,
            UIResponder.keyboardDidShowNotification,
            UIResponder.keyboardWillHideNotification,
            UIResponder.keyboardDidHideNotification
        ] {
            let observer = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) {
                [weak self] notification in
                let isHiding = name == UIResponder.keyboardWillHideNotification ||
                    name == UIResponder.keyboardDidHideNotification
                let frame = (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
                self?.updateKeyboardAvoidance(frame: isHiding ? nil : frame, revealFocus: !isHiding)
            }
            keyboardObservers.append(observer)
        }
    }

    private func updateKeyboardAvoidance(frame: CGRect?, revealFocus: Bool) {
        guard let webView else { return }
        focusRevealGeneration += 1
        let generation = focusRevealGeneration
        let keyboardInWebView: CGRect
        if let frame, let window = webView.window {
            keyboardInWebView = webView.convert(window.convert(frame, from: nil), from: window)
        } else {
            keyboardInWebView = .null
        }
        let overlap = webView.bounds.intersection(keyboardInWebView)
        let coveredHeight = overlap.isNull ? 0 : max(0, overlap.height)
        keyboardFrame = coveredHeight > 0 ? frame : nil

        var contentInset = originalContentInset ?? .zero
        contentInset.bottom = max(contentInset.bottom, coveredHeight)
        webView.scrollView.contentInset = contentInset
        var indicatorInset = originalIndicatorInset ?? .zero
        indicatorInset.bottom = max(indicatorInset.bottom, coveredHeight)
        webView.scrollView.verticalScrollIndicatorInsets = indicatorInset

        guard revealFocus, coveredHeight > 0 else { return }
        revealFocusedInput(visibleBottom: keyboardInWebView.minY)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self, generation == self.focusRevealGeneration,
                  let webView = self.webView, let currentFrame = self.keyboardFrame,
                  let window = webView.window else { return }
            let currentRect = webView.convert(window.convert(currentFrame, from: nil), from: window)
            self.revealFocusedInput(visibleBottom: currentRect.minY)
        }
    }

    private func revealFocusedInput(visibleBottom: CGFloat) {
        guard let webView, isLocalAppURL(webView.url) else { return }
        let bottom = Int(max(0, min(webView.bounds.height, visibleBottom)).rounded(.down))
        guard bottom > 0 else { return }
        let script = """
            (() => {
              const field = document.activeElement;
              if (!field || !field.matches('input, textarea, [contenteditable="true"]')) return;
              field.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              const viewport = window.visualViewport;
              const top = Math.max(0, viewport?.offsetTop ?? 0);
              const bottom = Math.min(\(bottom), top + (viewport?.height ?? innerHeight));
              const rect = field.getBoundingClientRect();
              const padding = 12;
              if (rect.bottom > bottom - padding) window.scrollBy(0, rect.bottom - bottom + padding);
              else if (rect.top < top + padding) window.scrollBy(0, rect.top - top - padding);
            })();
            """
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    @objc private func handleBackGesture(_ gesture: UIScreenEdgePanGestureRecognizer) {
        guard gesture.state == .ended,
              gesture.translation(in: view).x > 60,
              gesture.velocity(in: view).x > 0 else { return }
        dispatchLocalEvent("workout:native-back")
    }

    private func dispatchLocalEvent(_ name: String) {
        guard let webView, isLocalAppURL(webView.url) else { return }
        let script = "window.dispatchEvent(new Event('\(name)'));"
        webView.evaluateJavaScript(script, completionHandler: nil)
    }
}
