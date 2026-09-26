import Capacitor
import UIKit
import WebKit

// M0-06c physical-device feasibility probe: lifecycle, safe-area, keyboard and WKWebView
// input/IME/scroll observation of the shared Vite mobile-web bundle. Records UI labels,
// lengths and counts only; typed text is compared to a fixed test phrase and never stored.

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene, willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    ProbeLog.shared.record("scene", ["event": "willConnect"])
    window = UIWindow(windowScene: windowScene)
    window?.rootViewController = ProbeBridgeViewController()
    window?.makeKeyAndVisible()
    SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    ProbeLog.shared.record("scene", ["event": "didBecomeActive"])
    ProbeRunner.shared.runLaunchStepOnce()
  }
  func sceneWillResignActive(_ scene: UIScene) {
    ProbeLog.shared.record("scene", ["event": "willResignActive"])
  }
  func sceneDidEnterBackground(_ scene: UIScene) {
    ProbeLog.shared.record("scene", ["event": "didEnterBackground"])
  }
  func sceneWillEnterForeground(_ scene: UIScene) {
    ProbeLog.shared.record("scene", ["event": "willEnterForeground"])
  }
  func sceneDidDisconnect(_ scene: UIScene) {
    ProbeLog.shared.record("scene", ["event": "didDisconnect"])
    ProbeLog.shared.flush()
  }
  func scene(_ scene: UIScene, openURLContexts urlContexts: Set<UIOpenURLContext>) {
    SceneDelegateProxy.shared.scene(scene, openURLContexts: urlContexts)
  }
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    SceneDelegateProxy.shared.scene(scene, continue: userActivity)
  }
}

final class ProbeBridgeViewController: CAPBridgeViewController, WKScriptMessageHandler {
  private var urlObservation: NSKeyValueObservation?
  private static let allowedKinds: Set<String> = [
    "page", "focus", "blur", "composition", "input", "scroll", "viewport", "visibility",
    "pagehide", "pageshow", "popstate", "click", "memoState",
  ]

  override func capacitorDidLoad() {
    guard let webView else { return }
    // Probe choice (not a product decision): allow the WKWebView edge-swipe history gesture.
    webView.allowsBackForwardNavigationGestures = true
    webView.configuration.userContentController.add(self, name: "wmDeviceProbe")
    webView.configuration.userContentController.addUserScript(
      WKUserScript(source: Self.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    urlObservation = webView.observe(\.url, options: [.new]) { view, _ in
      ProbeLog.shared.record(
        "webUrl", ["path": view.url?.path ?? "none", "scheme": view.url?.scheme ?? "none"])
    }
    for (name, event) in [
      (UIResponder.keyboardDidShowNotification, "didShow"),
      (UIResponder.keyboardDidHideNotification, "didHide"),
    ] {
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { note in
        let frame =
          (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
          ?? .zero
        ProbeLog.shared.record(
          "keyboard",
          [
            "event": event, "frame": [frame.origin.x, frame.origin.y, frame.width, frame.height],
          ])
      }
    }
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    let inset = view.safeAreaInsets
    let bounds = view.bounds
    ProbeLog.shared.record(
      "safeArea",
      [
        "insets": [inset.top, inset.right, inset.bottom, inset.left],
        "bounds": [bounds.width, bounds.height],
        "orientation": (view.window?.windowScene?.interfaceOrientation.isLandscape ?? false)
          ? "landscape" : "portrait",
      ])
  }

  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard message.frameInfo.isMainFrame,
      message.frameInfo.request.url?.scheme == "capacitor",
      message.frameInfo.request.url?.host == "localhost",
      let body = message.body as? [String: Any],
      let kind = body["kind"] as? String, Self.allowedKinds.contains(kind),
      body.count <= 16, JSONSerialization.isValidJSONObject(body)
    else {
      ProbeLog.shared.record("webMessageRejected")
      return
    }
    var fields = body
    fields.removeValue(forKey: "kind")
    for (key, value) in fields {
      if let text = value as? String, text.count > 60 { fields[key] = String(text.prefix(60)) }
    }
    ProbeLog.shared.record("web." + kind, fields)
  }

  // Fixed phrase the tester types with the Korean keyboard; only equality is recorded.
  static let script = """
    (() => {
      const expected = '운동 메모 테스트';
      const post = (kind, fields) => { try { webkit.messageHandlers.wmDeviceProbe.postMessage({ kind, ...fields }); } catch {} };
      const insets = () => {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
        document.documentElement.append(probe);
        const style = getComputedStyle(probe);
        const value = ['Top','Right','Bottom','Left'].map((side) => parseFloat(style['padding' + side]) || 0);
        probe.remove();
        return value;
      };
      const labelOf = (element) => {
        if (!element) return 'none';
        const label = element.labels?.[0]?.textContent ?? element.getAttribute?.('aria-label') ?? '';
        return (label || element.textContent || '').trim().slice(0, 40);
      };
      const memo = () => [...document.querySelectorAll('textarea, input')].find((element) => labelOf(element).startsWith('작업 메모'));
      const page = () => {
        const heading = document.querySelector('h1');
        const rect = heading?.getBoundingClientRect();
        post('page', {
          path: location.pathname, insets: insets(), innerWidth, innerHeight,
          headingTop: rect ? rect.top : -1, headingLeft: rect ? rect.left : -1,
          scrollWidth: document.documentElement.scrollWidth, memoPresent: Boolean(memo()),
        });
      };
      addEventListener('load', () => setTimeout(page, 800));
      addEventListener('orientationchange', () => setTimeout(page, 800));
      addEventListener('focusin', (event) => post('focus', { tag: event.target.tagName, label: labelOf(event.target) }));
      addEventListener('focusout', (event) => post('blur', { tag: event.target.tagName, label: labelOf(event.target) }));
      for (const phase of ['compositionstart', 'compositionupdate', 'compositionend'])
        addEventListener(phase, (event) => post('composition', { phase, dataLength: (event.data ?? '').length }), true);
      addEventListener('input', (event) => {
        const value = event.target.value ?? '';
        post('input', { inputType: event.inputType ?? 'none', isComposing: Boolean(event.isComposing), length: value.length, matchesExpected: value === expected, label: labelOf(event.target) });
      }, true);
      let scrollTimer;
      addEventListener('scroll', () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => post('scroll', { scrollY, maxScroll: document.documentElement.scrollHeight - innerHeight }), 250);
      }, { passive: true });
      let viewportTimer;
      visualViewport?.addEventListener('resize', () => {
        clearTimeout(viewportTimer);
        viewportTimer = setTimeout(() => {
          const focused = document.activeElement?.getBoundingClientRect?.();
          post('viewport', { height: visualViewport.height, width: visualViewport.width, offsetTop: visualViewport.offsetTop, focusedBottom: focused ? focused.bottom : -1, focusedTop: focused ? focused.top : -1 });
        }, 300);
      });
      document.addEventListener('visibilitychange', () => post('visibility', { state: document.visibilityState }));
      addEventListener('pagehide', (event) => post('pagehide', { persisted: event.persisted }));
      addEventListener('pageshow', (event) => post('pageshow', { persisted: event.persisted, path: location.pathname }));
      addEventListener('popstate', () => post('popstate', { path: location.pathname }));
      addEventListener('click', (event) => {
        const target = event.target.closest?.('button, a');
        if (!target) return;
        post('click', { tag: target.tagName, text: labelOf(target) });
        setTimeout(() => { const field = memo(); post('memoState', { present: Boolean(field), length: field ? field.value.length : -1, matchesExpected: field ? field.value === expected : false }); }, 600);
      }, true);
    })();
    """
}
