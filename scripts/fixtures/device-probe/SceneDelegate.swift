import Capacitor
import UIKit
import WebKit

// M0-06c physical-device feasibility probe: lifecycle, safe-area, keyboard and WKWebView
// input/IME/scroll observation of the shared Vite mobile-web bundle. Records fixed
// operation and route classes, lengths and counts only; typed text is never stored.

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
  private var backAvailabilityObservation: NSKeyValueObservation?
  private var keyboardObservers: [NSObjectProtocol] = []
  private var latestKeyboardFrame: CGRect?
  private var originalScrollInset: UIEdgeInsets?
  private var originalIndicatorInset: UIEdgeInsets?
  private var backButton: UIButton?
  private static let allowedKinds: Set<String> = [
    "page", "focus", "blur", "composition", "input", "scroll", "viewport", "visibility",
    "pagehide", "pageshow", "popstate", "click", "memoState",
  ]
  private static let allowedStrings: [String: Set<String>] = [
    "focus.operation": ["memo-input", "other-input", "button", "link", "other-control"],
    "blur.operation": ["memo-input", "other-input", "button", "link", "other-control"],
    "input.operation": ["memo-input", "other-input", "button", "link", "other-control"],
    "click.operation": ["button", "link"],
    "input.inputType": [
      "none", "insertText", "insertCompositionText", "insertFromComposition", "insertFromPaste",
      "deleteContentBackward", "deleteContentForward", "deleteByCut", "historyUndo", "historyRedo",
      "other",
    ],
    "composition.phase": ["compositionstart", "compositionupdate", "compositionend"],
    "visibility.state": ["visible", "hidden", "prerender"],
    "page.route": ["home", "activities", "account", "other"],
    "pageshow.route": ["home", "activities", "account", "other"],
    "popstate.route": ["home", "activities", "account", "other"],
  ]
  private static let allowedNumbers: Set<String> = [
    "innerWidth", "innerHeight", "headingTop", "headingLeft", "scrollWidth", "dataLength",
    "length", "scrollY", "maxScroll", "height", "width", "offsetTop", "focusedBottom",
    "focusedTop",
  ]
  private static let allowedBooleans: Set<String> = [
    "memoPresent", "isComposing", "matchesExpected", "persisted", "present",
  ]
  private static let allowedNumberArrays: Set<String> = ["insets"]
  private static let allowedRoutes: [String: String] = [
    "/": "home", "/activities": "activities", "/account": "account",
  ]

  private static func routeClass(_ path: String?) -> String {
    allowedRoutes[path ?? ""] ?? "other"
  }

  override func capacitorDidLoad() {
    guard let webView else { return }
    // The native probe owns Back so it can check unsaved input before navigation.
    webView.allowsBackForwardNavigationGestures = false
    let backSwipe = UIScreenEdgePanGestureRecognizer(
      target: self, action: #selector(handleBackSwipe(_:)))
    backSwipe.edges = .left
    webView.addGestureRecognizer(backSwipe)
    let button = UIButton(type: .system)
    button.setTitle("뒤로", for: .normal)
    button.accessibilityLabel = "뒤로 가기"
    button.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.9)
    button.layer.cornerRadius = 12
    button.addTarget(self, action: #selector(handleBackButton), for: .touchUpInside)
    view.addSubview(button)
    button.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      button.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 8),
      button.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -8),
      button.widthAnchor.constraint(greaterThanOrEqualToConstant: 56),
      button.heightAnchor.constraint(equalToConstant: 44),
    ])
    backButton = button
    backAvailabilityObservation = webView.observe(\.canGoBack, options: [.initial, .new]) {
      [weak self] webView, _ in
      self?.backButton?.isEnabled = webView.canGoBack
    }
    originalScrollInset = webView.scrollView.contentInset
    originalIndicatorInset = webView.scrollView.scrollIndicatorInsets
    webView.configuration.userContentController.add(self, name: "wmDeviceProbe")
    webView.configuration.userContentController.addUserScript(
      WKUserScript(source: Self.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    urlObservation = webView.observe(\.url, options: [.new]) { view, _ in
      let scheme = view.url?.scheme ?? ""
      ProbeLog.shared.record(
        "webUrl",
        [
          "route": Self.routeClass(view.url?.path),
          "scheme": ["capacitor", "https", "http"].contains(scheme) ? scheme : "other",
        ])
    }
    for (name, event) in [
      (UIResponder.keyboardWillChangeFrameNotification, "willChangeFrame"),
      (UIResponder.keyboardDidChangeFrameNotification, "didChangeFrame"),
      (UIResponder.keyboardDidShowNotification, "didShow"),
      (UIResponder.keyboardWillHideNotification, "willHide"),
      (UIResponder.keyboardDidHideNotification, "didHide"),
    ] {
      let observer = NotificationCenter.default.addObserver(
        forName: name, object: nil, queue: .main
      ) {
        [weak self] note in
        let frame =
          (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
          ?? .zero
        ProbeLog.shared.record(
          "keyboard",
          [
            "event": event, "frame": [frame.origin.x, frame.origin.y, frame.width, frame.height],
          ])
        self?.updateKeyboardAvoidance(frame: frame, event: event)
      }
      keyboardObservers.append(observer)
    }
  }

  deinit {
    for observer in keyboardObservers { NotificationCenter.default.removeObserver(observer) }
  }

  private func updateKeyboardAvoidance(frame: CGRect, event: String) {
    guard let webView else { return }
    let keyboardRect = webView.convert(frame, from: nil)
    let overlap = webView.bounds.intersection(keyboardRect)
    let coveredHeight =
      event == "willHide" || event == "didHide" || overlap.isNull
      ? 0 : max(0, overlap.height)
    latestKeyboardFrame = coveredHeight > 0 ? frame : nil
    var inset = originalScrollInset ?? .zero
    inset.bottom = max(inset.bottom, coveredHeight)
    webView.scrollView.contentInset = inset
    var indicatorInset = originalIndicatorInset ?? .zero
    indicatorInset.bottom = max(indicatorInset.bottom, coveredHeight)
    webView.scrollView.scrollIndicatorInsets = indicatorInset
    ProbeLog.shared.record("keyboardAvoidance", ["event": event, "coveredHeight": coveredHeight])
    guard coveredHeight > 0,
      event == "didShow" || event == "didChangeFrame" || event == "willChangeFrame"
    else { return }
    let visibleBottom = max(0, min(webView.bounds.height, keyboardRect.minY))
    if event != "willChangeFrame" { revealFocusedInput(visibleBottom: visibleBottom) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
      guard let self, let webView = self.webView, let currentFrame = self.latestKeyboardFrame else {
        return
      }
      let currentRect = webView.convert(currentFrame, from: nil)
      self.revealFocusedInput(visibleBottom: max(0, min(webView.bounds.height, currentRect.minY)))
    }
  }

  private func revealFocusedInput(visibleBottom: CGFloat) {
    guard let webView else { return }
    let bottom = Int(visibleBottom.rounded(.down))
    guard bottom > 0 else { return }
    let script = """
      (() => {
        const field = document.activeElement;
        if (!field || !field.matches('input, textarea, [contenteditable="true"]')) return false;
        const viewport = window.visualViewport;
        const top = Math.max(0, viewport?.offsetTop ?? 0);
        const bottom = Math.min(\(bottom), top + (viewport?.height ?? innerHeight));
        const rect = field.getBoundingClientRect();
        const padding = 12;
        if (rect.bottom > bottom - padding) {
          window.scrollBy(0, rect.bottom - bottom + padding);
          return true;
        }
        if (rect.top < top + padding) {
          window.scrollBy(0, rect.top - top - padding);
          return true;
        }
        return false;
      })();
      """
    webView.evaluateJavaScript(script) { result, _ in
      ProbeLog.shared.record("keyboardFocusReveal", ["scrolled": result as? Bool ?? false])
    }
  }

  @objc private func handleBackSwipe(_ gesture: UIScreenEdgePanGestureRecognizer) {
    guard gesture.state == .ended,
      gesture.translation(in: view).x > 60,
      gesture.velocity(in: view).x > 0
    else { return }
    requestBack()
  }

  @objc private func handleBackButton() { requestBack() }

  private func requestBack() {
    guard let webView, webView.canGoBack, presentedViewController == nil else { return }
    webView.evaluateJavaScript(Self.unsavedInputScript) { [weak self, weak webView] result, error in
      guard let self, let webView, error == nil else { return }
      guard let hasUnsavedInput = result as? Bool else { return }
      ProbeLog.shared.record("back", ["unsavedInput": hasUnsavedInput])
      if !hasUnsavedInput {
        webView.goBack()
        return
      }
      let alert = UIAlertController(
        title: "저장되지 않은 변경사항", message: "변경사항을 버리고 뒤로 이동할까요?", preferredStyle: .alert)
      alert.addAction(
        UIAlertAction(title: "계속 편집", style: .cancel) { _ in
          ProbeLog.shared.record("backDecision", ["move": false])
        })
      alert.addAction(
        UIAlertAction(title: "뒤로 이동", style: .destructive) { [weak webView] _ in
          ProbeLog.shared.record("backDecision", ["move": true])
          webView?.goBack()
        })
      self.present(alert, animated: true)
    }
  }

  // Probe-only check. Product draft/save semantics belong to the M3-01 native host.
  private static let unsavedInputScript = """
    (() => globalThis.__wmProbeHasUnsavedInput?.())();
    """

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
    var fields: [String: Any] = [:]
    for (key, value) in body where key != "kind" {
      let field = kind + "." + key
      if let text = value as? String, Self.allowedStrings[field]?.contains(text) == true {
        fields[key] = text
      } else if Self.allowedNumbers.contains(key), let number = value as? NSNumber {
        fields[key] = number
      } else if Self.allowedBooleans.contains(key), let boolean = value as? Bool {
        fields[key] = boolean
      } else if Self.allowedNumberArrays.contains(key),
        let values = value as? [NSNumber], values.count <= 4
      {
        fields[key] = values
      }
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
      const memo = () => document.querySelector('#workspace-note');
      const inputBaselines = new WeakMap();
      const changedWithoutBaseline = new WeakSet();
      const isField = (element) => element?.tagName === 'INPUT' || element?.tagName === 'TEXTAREA';
      const rememberInput = (element) => {
        if (isField(element) && !inputBaselines.has(element))
          inputBaselines.set(element, { value: element.value, checked: element.checked });
      };
      Object.defineProperty(globalThis, '__wmProbeHasUnsavedInput', {
        value: () => [...document.querySelectorAll('input, textarea')].some((field) => {
          if (field.type === 'hidden' || field.disabled || field.readOnly) return false;
          if (changedWithoutBaseline.has(field)) return true;
          const baseline = inputBaselines.get(field);
          if (!baseline) return false;
          return field.type === 'checkbox' || field.type === 'radio'
            ? field.checked !== baseline.checked : field.value !== baseline.value;
        }),
      });
      const operationOf = (element) => {
        if (element?.id === 'workspace-note') return 'memo-input';
        if (element?.tagName === 'INPUT' || element?.tagName === 'TEXTAREA') return 'other-input';
        if (element?.tagName === 'BUTTON') return 'button';
        if (element?.tagName === 'A') return 'link';
        return 'other-control';
      };
      const routeClass = () => ({ '/': 'home', '/activities': 'activities', '/account': 'account' })[location.pathname] ?? 'other';
      const inputTypeOf = (value) => new Set([
        'insertText', 'insertCompositionText', 'insertFromComposition', 'insertFromPaste',
        'deleteContentBackward', 'deleteContentForward', 'deleteByCut', 'historyUndo', 'historyRedo',
      ]).has(value) ? value : 'other';
      const page = () => {
        const heading = document.querySelector('h1');
        const rect = heading?.getBoundingClientRect();
        post('page', {
          route: routeClass(), insets: insets(), innerWidth, innerHeight,
          headingTop: rect ? rect.top : -1, headingLeft: rect ? rect.left : -1,
          scrollWidth: document.documentElement.scrollWidth, memoPresent: Boolean(memo()),
        });
      };
      addEventListener('load', () => setTimeout(page, 800));
      addEventListener('orientationchange', () => setTimeout(page, 800));
      addEventListener('focusin', (event) => {
        rememberInput(event.target);
        post('focus', { operation: operationOf(event.target) });
      });
      addEventListener('pointerdown', (event) => rememberInput(event.target), true);
      addEventListener('focusout', (event) => post('blur', { operation: operationOf(event.target) }));
      for (const phase of ['compositionstart', 'compositionupdate', 'compositionend'])
        addEventListener(phase, (event) => post('composition', { phase, dataLength: (event.data ?? '').length }), true);
      addEventListener('input', (event) => {
        if (isField(event.target) && !inputBaselines.has(event.target)) changedWithoutBaseline.add(event.target);
        const value = event.target.value ?? '';
        post('input', { inputType: inputTypeOf(event.inputType), isComposing: Boolean(event.isComposing), length: value.length, matchesExpected: value === expected, operation: operationOf(event.target) });
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
      addEventListener('pageshow', (event) => post('pageshow', { persisted: event.persisted, route: routeClass() }));
      addEventListener('popstate', () => post('popstate', { route: routeClass() }));
      addEventListener('click', (event) => {
        const target = event.target.closest?.('button, a');
        if (!target) return;
        post('click', { operation: operationOf(target) });
        setTimeout(() => { const field = memo(); post('memoState', { present: Boolean(field), length: field ? field.value.length : -1, matchesExpected: field ? field.value === expected : false }); }, 600);
      }, true);
    })();
    """
}
