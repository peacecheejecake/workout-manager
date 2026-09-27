import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  private var ran = false

  func scene(
    _ scene: UIScene, willConnectTo session: UISceneSession,
    options: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    window = UIWindow(windowScene: windowScene)
    let controller = UIViewController()
    controller.view.backgroundColor = .systemBackground
    let label = UILabel()
    label.text = "WM Wake Writer · 합성 표본 시험용"
    label.textAlignment = .center
    label.translatesAutoresizingMaskIntoConstraints = false
    controller.view.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: controller.view.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor),
    ])
    window?.rootViewController = controller
    window?.makeKeyAndVisible()
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    guard !ran else { return }
    ran = true
    let step = UserDefaults.standard.string(forKey: "wmProbeStep") ?? "none"
    Task { @MainActor in
      WriterLog.shared.record("stepStarted", ["step": step])
      let result: [String: Any]
      switch step {
      case "authorize": result = await WriterProbe.shared.authorize()
      case "add": result = await WriterProbe.shared.add()
      case "cleanup": result = await WriterProbe.shared.cleanup()
      default: result = ["noOp": true]
      }
      WriterLog.shared.record("stepCompleted", ["step": step, "result": result])
    }
  }
}
