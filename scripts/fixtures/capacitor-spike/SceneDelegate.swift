import Capacitor
import CoreFoundation
import UIKit
import WebKit

// Disposable Simulator feasibility instrumentation, not a product host or health bridge.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  func scene(
    _ scene: UIScene, willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let scene = scene as? UIWindowScene else { return }
    window = UIWindow(windowScene: scene)
    window?.rootViewController = FeasibilityViewController()
    window?.makeKeyAndVisible()
  }
}

final class FeasibilityViewController: CAPBridgeViewController, WKScriptMessageHandler {
  private var recorded = false
  private var started = false
  private var stage = "portrait"
  private var deadline = Date()
  private var stableGeometry: Data?
  private var requestedMask: UIInterfaceOrientationMask = .portrait
  private var buttonCount = 0
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask { requestedMask }
  override var shouldAutorotate: Bool { true }
  private var directory: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
  }

  override func capacitorDidLoad() {
    guard let webView else { return }
    webView.configuration.userContentController.add(self, name: "feasibilityEvidence")
    let script = """
      (() => {
        let sent = false;
        const inspect = () => {
          const heading = document.querySelector('h1')?.textContent;
          const buttons = document.querySelectorAll('button').length;
          if (!sent && heading === 'Workout Manager · Mobile Web' && buttons > 0 && window.Capacitor?.isNativePlatform?.() === true && window.Capacitor?.getPlatform?.() === 'ios') {
            sent = true; observer.disconnect();
            webkit.messageHandlers.feasibilityEvidence.postMessage({heading, buttons, native:true, platform:'ios', demoDisclaimerVisible:document.body.textContent.includes('서버 저장 및 실제 로그인이 연결되지 않았습니다.')});
          }
        };
        const observer = new MutationObserver(inspect);
        observer.observe(document.documentElement, {childList:true, subtree:true}); inspect();
      })();
      """
    webView.configuration.userContentController.addUserScript(
      WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    DispatchQueue.main.asyncAfter(deadline: .now() + 55) { [weak self] in self?.fail("timeout") }
  }
  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard !started, !recorded, message.frameInfo.isMainFrame,
      message.frameInfo.request.url?.scheme == "capacitor",
      message.frameInfo.request.url?.host == "localhost",
      let body = message.body as? [String: Any], body.count == 5,
      body["heading"] as? String == "Workout Manager · Mobile Web",
      body["platform"] as? String == "ios",
      body["native"] as? Bool == true, body["demoDisclaimerVisible"] as? Bool == true,
      let buttons = body["buttons"] as? Int, buttons > 0
    else { return }
    started = true
    buttonCount = buttons
    begin("portrait")
  }
  private func begin(_ name: String) {
    guard !recorded else { return }
    stage = name
    deadline = Date().addingTimeInterval(10)
    stableGeometry = nil
    requestedMask = name == "landscape" ? .landscapeLeft : .portrait
    guard #available(iOS 16.0, *), let scene = view.window?.windowScene else {
      fail("orientation_request_failed")
      return
    }
    setNeedsUpdateOfSupportedInterfaceOrientations()
    scene.requestGeometryUpdate(.iOS(interfaceOrientations: requestedMask)) { [weak self] _ in
      self?.fail("orientation_request_failed")
    }
    inspect()
  }
  private func later(_ action: @escaping () -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: action)
  }
  private func inspect() {
    guard !recorded else { return }
    guard Date() < deadline else {
      fail("geometry_timeout")
      return
    }
    guard let webView, let window = view.window, let scene = window.windowScene,
      webView.url?.scheme == "capacitor", webView.url?.host == "localhost"
    else {
      fail("invalid_geometry")
      return
    }
    let orientation = scene.interfaceOrientation
    let matches = stage == "landscape" ? orientation.isLandscape : orientation == .portrait
    guard matches else {
      later { [weak self] in self?.inspect() }
      return
    }
    let script = """
      (() => {
        const h = document.querySelector('h1'), v = window.visualViewport;
        if (!h || !v) return null;
        const r = h.getBoundingClientRect(), style = getComputedStyle(h.parentElement);
        return {innerWidth,innerHeight,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,bodyScrollWidth:document.body.scrollWidth,scrollX,scrollY,
          visualViewport:{width:v.width,height:v.height,offsetLeft:v.offsetLeft,offsetTop:v.offsetTop,scale:v.scale},
          heading:{x:r.x,y:r.y,width:r.width,height:r.height},padding:{top:parseFloat(style.paddingTop),right:parseFloat(style.paddingRight),bottom:parseFloat(style.paddingBottom),left:parseFloat(style.paddingLeft)}};
      })()
      """
    let expectedStage = stage
    webView.evaluateJavaScript(script) { [weak self] value, error in
      guard let self, !self.recorded, self.stage == expectedStage else { return }
      guard error == nil, let dom = value as? [String: Any],
        let geometry = self.geometry(dom, window: window, webView: webView)
      else {
        self.fail("invalid_geometry")
        return
      }
      // Confirm the scene still has the requested actual orientation after the asynchronous DOM read.
      let actual = scene.interfaceOrientation
      let orientationMatches = self.stage == "landscape" ? actual.isLandscape : actual == .portrait
      guard orientationMatches,
        let signature = try? JSONSerialization.data(
          withJSONObject: geometry, options: [.sortedKeys])
      else {
        self.stableGeometry = nil
        self.later { [weak self] in self?.inspect() }
        return
      }
      guard self.stableGeometry == signature else {
        self.stableGeometry = signature
        self.later { [weak self] in self?.inspect() }
        return
      }
      guard let checks = self.checks(geometry) else {
        self.finish([
          "outcome": "failed", "reason": "invalid_geometry", "stage": self.stage,
          "geometry": geometry,
        ])
        return
      }
      guard checks.values.allSatisfy({ $0 }) else {
        self.finish([
          "outcome": "failed", "reason": "geometry_check_failed", "stage": self.stage,
          "geometry": geometry, "checks": checks,
        ])
        return
      }
      let orientationName =
        actual == .portrait
        ? "portrait" : actual == .landscapeLeft ? "landscapeLeft" : "landscapeRight"
      guard
        self.write(
          [
            "stage": self.stage, "outcome": "passed", "orientation": orientationName,
            "geometry": geometry, "checks": checks,
          ], name: "capacitor-probe-\(self.stage).json")
      else {
        self.fail("write_failed")
        return
      }
      if self.stage == "restored" {
        self.finish([
          "outcome": "passed", "headingRendered": true,
          "sharedWorkspaceButtonCount": self.buttonCount, "capacitorPlatform": "ios",
          "nativePlatform": true, "demoDisclaimerVisible": true, "localOriginVerified": true,
          "orientationStages": ["portrait", "landscape", "restored"],
        ])
      } else {
        self.deadline = Date().addingTimeInterval(10)
        self.waitForAck()
      }
    }
  }
  private func number(_ object: [String: Any], _ key: String) -> Double? {
    guard let value = object[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
      value.doubleValue.isFinite
    else { return nil }
    return value.doubleValue
  }
  private func rect(_ value: CGRect) -> [String: Double] {
    ["x": value.minX, "y": value.minY, "width": value.width, "height": value.height]
  }
  private func geometry(_ dom: [String: Any], window: UIWindow, webView: WKWebView) -> [String:
    Any]?
  {
    guard let viewport = dom["visualViewport"] as? [String: Any],
      let heading = dom["heading"] as? [String: Any],
      let padding = dom["padding"] as? [String: Any],
      let width = number(viewport, "width"), let height = number(viewport, "height"), width > 0,
      height > 0,
      let left = number(viewport, "offsetLeft"), let top = number(viewport, "offsetTop"),
      let scale = number(viewport, "scale"), scale > 0,
      let hx = number(heading, "x"), let hy = number(heading, "y"),
      let hw = number(heading, "width"), let hh = number(heading, "height"), hw > 0, hh > 0,
      [
        "innerWidth", "innerHeight", "clientWidth", "scrollWidth", "bodyScrollWidth", "scrollX",
        "scrollY",
      ].allSatisfy({ number(dom, $0) != nil }),
      ["top", "right", "bottom", "left"].allSatisfy({ number(padding, $0) != nil })
    else { return nil }
    let frame = webView.convert(webView.bounds, to: window)
    let ratio = frame.width / width
    let headingFrame = CGRect(
      x: frame.minX + (hx - left) * ratio, y: frame.minY + (hy - top) * ratio, width: hw * ratio,
      height: hh * ratio)
    let safe = window.safeAreaInsets
    let native: [String: Any] = [
      "window": rect(window.bounds), "view": rect(view.convert(view.bounds, to: window)),
      "webView": rect(frame),
      "safeAreaInsets": [
        "top": safe.top, "right": safe.right, "bottom": safe.bottom, "left": safe.left,
      ], "safeRect": rect(window.bounds.inset(by: safe)), "headingInWindow": rect(headingFrame),
      "dom": dom,
    ]
    return JSONSerialization.isValidJSONObject(native) ? native : nil
  }
  private func checks(_ geometry: [String: Any]) -> [String: Bool]? {
    guard let safe = geometry["safeRect"] as? [String: Double],
      let h = geometry["headingInWindow"] as? [String: Double],
      let dom = geometry["dom"] as? [String: Any],
      let x = safe["x"], let y = safe["y"], let w = safe["width"], let height = safe["height"],
      let hx = h["x"], let hy = h["y"], let hw = h["width"], let hh = h["height"],
      let viewportWidth = number(dom, "innerWidth"), let scrollWidth = number(dom, "scrollWidth"),
      let bodyWidth = number(dom, "bodyScrollWidth")
    else { return nil }
    return [
      "orientationMatches": true,
      "headingWithinSafeArea": hx >= x - 0.5 && hy >= y - 0.5 && hx + hw <= x + w + 0.5
        && hy + hh <= y + height + 0.5,
      "noHorizontalOverflow": scrollWidth <= viewportWidth + 1 && bodyWidth <= viewportWidth + 1,
    ]
  }
  private func waitForAck() {
    guard !recorded else { return }
    guard Date() < deadline else {
      fail("ack_timeout")
      return
    }
    if FileManager.default.fileExists(
      atPath: directory.appendingPathComponent("capacitor-probe-continue-\(stage)").path)
    {
      begin(stage == "portrait" ? "landscape" : "restored")
    } else {
      later { [weak self] in self?.waitForAck() }
    }
  }
  private func write(_ result: [String: Any], name: String) -> Bool {
    do {
      let data = try JSONSerialization.data(
        withJSONObject: result, options: [.sortedKeys, .prettyPrinted])
      try data.write(to: directory.appendingPathComponent(name), options: .atomic)
      return true
    } catch { return false }
  }
  private func fail(_ reason: String) {
    finish(["outcome": "failed", "reason": reason, "stage": stage])
  }
  private func finish(_ result: [String: Any]) {
    guard !recorded else { return }
    recorded = true
    if !write(result, name: "capacitor-probe.json") { NSLog("CAPACITOR_PROBE_WRITE_FAILED") }
  }
}
