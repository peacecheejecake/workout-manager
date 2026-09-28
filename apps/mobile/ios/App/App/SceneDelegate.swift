import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    #if DEBUG
    private var healthKitDebugButton: UIButton?
    #endif

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = LocalBridgeViewController()
        window?.makeKeyAndVisible()
        #if DEBUG
        installHealthKitDebugControl()
        #endif

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        (window?.rootViewController as? LocalBridgeViewController)?.notifySceneDidBecomeActive()
        Task { @MainActor in HealthKitWorkoutCollector.shared.sceneDidBecomeActive() }
        #if DEBUG
        Task { @MainActor in await HealthKitWorkoutDebugProbe.shared.resumeScopedRunIfNeeded() }
        #endif
    }

    #if DEBUG
    private func installHealthKitDebugControl() {
        guard let window else { return }
        let button = UIButton(type: .system)
        button.setTitle("DEBUG 합성 운동", for: .normal)
        button.backgroundColor = .systemBackground
        button.layer.cornerRadius = 8
        button.accessibilityIdentifier = "healthkit-synthetic-debug-control"
        button.addTarget(self, action: #selector(showHealthKitDebugActions), for: .touchUpInside)
        button.translatesAutoresizingMaskIntoConstraints = false
        window.addSubview(button)
        NSLayoutConstraint.activate([
            button.trailingAnchor.constraint(equalTo: window.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            button.bottomAnchor.constraint(equalTo: window.safeAreaLayoutGuide.bottomAnchor, constant: -12),
            button.widthAnchor.constraint(greaterThanOrEqualToConstant: 136),
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
        healthKitDebugButton = button
    }

    @objc private func showHealthKitDebugActions() {
        let alert = UIAlertController(title: "DEBUG 합성 운동",
                                      message: "생성은 운동 쓰기 권한만 요청합니다. 읽기 확인은 별도 선택입니다.",
                                      preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "합성 운동 1개 생성", style: .default) { [weak self] _ in
            Task { @MainActor in
                await self?.runHealthKitDebugAction { try await HealthKitWorkoutDebugProbe.shared.createOneSyntheticWorkout() }
            }
        })
        alert.addAction(UIAlertAction(title: "표식 운동 읽기 확인", style: .default) { [weak self] _ in
            self?.confirmHealthKitReadScope()
        })
        alert.addAction(UIAlertAction(title: "합성 운동 삭제·정리 재시도", style: .destructive) { [weak self] _ in
            Task { @MainActor in
                await self?.runHealthKitDebugAction { try await HealthKitWorkoutDebugProbe.shared.deleteOwnedSyntheticWorkout() }
            }
        })
        alert.addAction(UIAlertAction(title: "삭제 기록 종료", style: .default) { [weak self] _ in
            self?.confirmDeletionFinalization()
        })
        alert.addAction(UIAlertAction(title: "취소", style: .cancel))
        window?.rootViewController?.present(alert, animated: true)
    }

    private func confirmHealthKitReadScope() {
        let alert = UIAlertController(
            title: "운동 읽기 권한 범위",
            message: "iPhone의 HealthKit 읽기 권한은 기기에 저장된 모든 운동 기록에 적용됩니다. 이 DEBUG 앱의 조회 코드는 이 앱이 만든 표식 운동 1개로만 제한됩니다. 권한을 요청할까요?",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "읽기 권한 요청", style: .default) { [weak self] _ in
            Task { @MainActor in
                await self?.runHealthKitDebugAction {
                    try await HealthKitWorkoutDebugProbe.shared.requestScopedReadFromExplicitAction()
                }
            }
        })
        alert.addAction(UIAlertAction(title: "취소", style: .cancel))
        window?.rootViewController?.present(alert, animated: true)
    }

    private func confirmDeletionFinalization() {
        let alert = UIAlertController(
            title: "삭제 기록 종료",
            message: "삭제 이벤트가 아직 확인되지 않았다면 미실행으로 남깁니다. 삭제 API가 1개 삭제했다고 확인한 기록만 종료할 수 있습니다.",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "기록 종료", style: .default) { [weak self] _ in
            Task { @MainActor in
                await self?.runHealthKitDebugAction {
                    try await HealthKitWorkoutDebugProbe.shared.finalizeConfirmedDeletion()
                }
            }
        })
        alert.addAction(UIAlertAction(title: "취소", style: .cancel))
        window?.rootViewController?.present(alert, animated: true)
    }

    private func runHealthKitDebugAction(_ action: () async throws -> String) async {
        let message: String
        do { message = try await action() }
        catch { message = "검증이 완료되지 않았습니다. DEBUG 범위의 상태를 확인하세요." }
        let alert = UIAlertController(title: "DEBUG HealthKit", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "확인", style: .default))
        window?.rootViewController?.present(alert, animated: true)
    }
    #endif
}
