import Foundation
import HealthKit
import UIKit

@MainActor
final class HealthKitWorkoutManagementCoordinator {
    static let shared = HealthKitWorkoutManagementCoordinator()
    private var session = HealthKitWorkoutManagementSession()
    private weak var sheet: HealthKitWorkoutManagementViewController?
    private let work = HealthKitWorkoutManagementWork()
    private var summaries: Task<Void, Never>?
    private var opening = false
    private var observer: NSObjectProtocol?
    private let store = HKHealthStore()
    init() {
        observer = NotificationCenter.default.addObserver(
            forName: .nativeAuthCredentialInvalidated,
            object: nil, queue: .main
        ) { [weak self] _ in Task { @MainActor in self?.invalidate(.unauthorized) } }
    }
    deinit {
        // The work owner cancels its task in its own deinit.
        summaries?.cancel()
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }
    func open() async throws -> UUID {
        guard !opening, sheet == nil, !work.isRunning, NativeAuth.isConfigured else {
            throw HealthKitWorkoutSelectionError.unavailable
        }
        opening = true
        defer { opening = false }
        let context = try await NativeAuth.shared.healthKitSelectionContext()
        try Task.checkCancellation()
        guard
            let root = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
                .flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController
        else {
            throw HealthKitWorkoutSelectionError.unavailable
        }
        var presenter = root
        while let next = presenter.presentedViewController { presenter = next }
        guard !presenter.isBeingDismissed else { throw HealthKitWorkoutSelectionError.unavailable }
        let resuming = session.canResume && session.context == context
        let generation = resuming ? try session.resume(context) : session.begin(context)
        guard let id = session.managementId else {
            throw HealthKitWorkoutSelectionError.unavailable
        }
        let controller = HealthKitWorkoutManagementViewController(
            coordinator: self, owner: context.ownerAthleteId)
        sheet = controller
        presenter.present(controller, animated: true)
        controller.render(session)
        if resuming {
            refreshPending()
            return id
        }
        work.start { [self] in
            do {
                let snapshot = try await NativeAuth.shared.fetchHealthKitRegisteredWorkouts(
                    ownerAthleteId: context.ownerAthleteId, consentRevision: context.consentRevision
                )
                try await NativeAuth.shared.validateHealthKitSelectionContext(context)
                try Task.checkCancellation()
                guard session.current(context, generation: generation) else { return }
                try session.loaded(snapshot, generation: generation)
                sheet?.render(session)
            } catch { handle(error, context: context, generation: generation) }
        }
        return id
    }
    func status(managementId: UUID) async throws -> [String: Any] {
        guard session.managementId == managementId else {
            throw HealthKitWorkoutSelectionError.stale
        }
        if let context = session.context {
            do { try await NativeAuth.shared.validateHealthKitSelectionContext(context) } catch {
                guard session.managementId == managementId, session.context == context else {
                    throw HealthKitWorkoutSelectionError.stale
                }
                if error is CancellationError { throw error }
                if let failure = error as? HealthKitWorkoutSelectionError,
                    [.unauthorized, .consentRequired].contains(failure)
                {
                    invalidate(failure == .consentRequired ? .consentRequired : .unauthorized)
                } else {
                    return [
                        "state": "offline", "registeredCount": NSNull(),
                        "selectedCount": session.selected == nil ? 0 : 1, "resultCount": NSNull(),
                    ]
                }
            }
        }
        try Task.checkCancellation()
        guard session.managementId == managementId else {
            throw HealthKitWorkoutSelectionError.stale
        }
        if session.pending != nil,
            [.pendingCleanup, .offline, .unavailable].contains(session.state),
            session.permits(managementId)
        {
            refreshPending()
            await work.wait()
            try Task.checkCancellation()
            guard session.managementId == managementId else {
                throw HealthKitWorkoutSelectionError.stale
            }
        }
        return session.status
    }
    func consentDidChange(granted: Bool, revision: Int) {
        if let context = session.context, !granted || revision != context.consentRevision {
            invalidate(.consentRequired)
        }
    }
    func cancel(managementId: UUID) {
        guard session.managementId == managementId else { return }
        work.cancel()
        summaries?.cancel()
        summaries = nil
        session.close()
        let controller = sheet
        sheet = nil
        controller?.clearPrivateView()
        controller?.dismiss(animated: true)
    }
    private func invalidate(_ state: HealthKitWorkoutManagementState) {
        work.cancel()
        summaries?.cancel()
        summaries = nil
        session.invalidate(state)
        let controller = sheet
        sheet = nil
        controller?.clearPrivateView()
        controller?.dismiss(animated: true)
    }
    func select(_ id: UUID, handle: UUID) {
        guard session.permits(handle) else { return }
        do {
            try session.select(id)
            sheet?.render(session)
        } catch {}
    }
    func proceed(handle: UUID) {
        guard session.permits(handle) else { return }
        if session.state == .choosing {
            do {
                try session.showConfirmation()
                sheet?.render(session)
                sheet?.confirm(handle: handle, generation: session.generation)
            } catch {}
        } else {
            refreshPending()
        }
    }
    private func refreshPending() {
        guard !work.isRunning, let pending = session.pending else { return }
        if session.receipt != nil {
            submit(pending, poll: true)
        } else {
            do { submit(try session.retry(), poll: false) } catch {}
        }
    }
    func continueChoosing(handle: UUID, generation: Int) {
        guard session.permits(handle, generation: generation) else { return }
        session.continueChoosing()
        sheet?.render(session)
    }
    func confirmed(handle: UUID, generation: Int) {
        guard session.permits(handle, generation: generation) else { return }
        do { submit(try session.confirm(deletionDeclared: true), poll: false) } catch {}
    }
    private func submit(_ request: HealthKitWorkoutDeregistrationRequest, poll: Bool) {
        guard !work.isRunning else { return }
        let generation = session.generation
        sheet?.render(session)
        work.start { [self] in
            do {
                let receipt: HealthKitWorkoutDeregistrationReceipt
                if poll, let prior = session.receipt {
                    receipt = try await NativeAuth.shared.healthKitDeregistrationStatus(
                        request, receipt: prior)
                } else {
                    receipt = try await NativeAuth.shared.deregisterHealthKitWorkout(request) {
                        [self] in
                        try Task.checkCancellation()
                        guard session.current(request.context, generation: generation) else {
                            throw CancellationError()
                        }
                        try session.markTransmitted()
                    }
                }
                try Task.checkCancellation()
                guard session.current(request.context, generation: generation) else { return }
                try session.acknowledged(receipt, generation: generation)
                // Stop stale callbacks/outbox eligibility immediately after committed pending/released ACK.
                try HealthKitWorkoutCollector.shared.registrationsDidChange(
                    ownerAthleteId: request.context.ownerAthleteId,
                    consentRevision: request.context.consentRevision)
                let registry = try await NativeAuth.shared.fetchHealthKitRegisteredWorkouts(
                    ownerAthleteId: request.context.ownerAthleteId,
                    consentRevision: request.context.consentRevision)
                try await NativeAuth.shared.validateHealthKitSelectionContext(request.context)
                try Task.checkCancellation()
                guard session.current(request.context, generation: generation) else { return }
                try HealthKitWorkoutCollector.shared.registrationsDidChange(
                    ownerAthleteId: request.context.ownerAthleteId,
                    consentRevision: request.context.consentRevision)
                try session.refreshed(registry, generation: generation)
                sheet?.render(session)
            } catch { handle(error, context: request.context, generation: generation) }
        }
    }
    private func handle(_ error: Error, context: HealthKitWorkoutSelectionContext, generation: Int)
    {
        guard session.current(context, generation: generation), !(error is CancellationError) else {
            return
        }
        if error is HealthKitWorkoutManagementError {
            session.failed(.legacyBlocked)
        } else {
            switch error as? HealthKitWorkoutSelectionError {
            case .consentRequired: invalidate(.consentRequired)
            case .unauthorized, .stale: invalidate(.unauthorized)
            case .conflict: session.failed(.conflict)
            case .invalidInput, .invalidReply, .unavailable: session.failed(.unavailable)
            default: session.failed(.offline)
            }
        }
        sheet?.render(session)
    }
    /// Optional summaries are constrained to the native screen's visible registered UUID page; no unregistered query.
    func loadSummaries(ids: [UUID], handle: UUID, page: Int) {
        summaries?.cancel()
        guard ids.count <= 20, session.permits(handle), let context = session.context else {
            return
        }
        let generation = session.generation
        summaries = Task { @MainActor in
            do {
                try await NativeAuth.shared.validateHealthKitSelectionContext(context)
                #if DEBUG
                    let values: [UUID: String] = [:]  // Personal HealthKit reads disabled.
                #else
                    let values = try await readSummaries(ids)
                #endif
                try Task.checkCancellation()
                try await NativeAuth.shared.validateHealthKitSelectionContext(context)
                guard session.current(context, generation: generation) else { return }
                sheet?.applySummaries(values, handle: handle, page: page)
            } catch {
                // Missing summary is neither permission nor absence evidence.
            }
        }
    }
    private func readSummaries(_ ids: [UUID]) async throws -> [UUID: String] {
        guard !ids.isEmpty, ids.count <= 20, HKHealthStore.isHealthDataAvailable() else {
            return [:]
        }
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: HKObjectType.workoutType(),
                predicate: HKQuery.predicateForObjects(with: Set(ids)), limit: 20,
                sortDescriptors: nil
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let workouts = samples as? [HKWorkout], workouts.count <= 20,
                    workouts.allSatisfy({ ids.contains($0.uuid) })
                else {
                    continuation.resume(throwing: HealthKitWorkoutSelectionError.invalidReply)
                    return
                }
                let formatter = DateFormatter()
                formatter.dateStyle = .medium
                formatter.timeStyle = .short
                var result: [UUID: String] = [:]
                for workout in workouts {
                    let type: String
                    switch workout.workoutActivityType {
                    case .running: type = "달리기"
                    case .walking: type = "걷기"
                    case .cycling: type = "자전거"
                    case .swimming: type = "수영"
                    case .traditionalStrengthTraining: type = "근력 운동"
                    default: type = "기타 운동"
                    }
                    guard workout.duration.isFinite, (0...2_678_400).contains(workout.duration)
                    else {
                        continue
                    }
                    result[workout.uuid] =
                        "\(type) · \(formatter.string(from: workout.startDate)) · \(Int(workout.duration / 60))분"
                }
                continuation.resume(returning: result)
            }
            store.execute(query)
        }
    }
}

@MainActor
final class HealthKitWorkoutManagementViewController: UIViewController, UITableViewDataSource,
    UITableViewDelegate,
    UIAdaptivePresentationControllerDelegate
{
    private let coordinator: HealthKitWorkoutManagementCoordinator
    private let owner: String
    private let summary = UILabel()
    private let table = UITableView(frame: .zero, style: .plain)
    private let action = UIButton(type: .system)
    private let pages = UIButton(type: .system)
    private var claims: [HealthKitWorkoutClaim] = []
    private var selected: UUID?
    private var handle: UUID?
    private var state: HealthKitWorkoutManagementState = .idle
    private var page = 0
    private var labels: [UUID: String] = [:]
    init(coordinator: HealthKitWorkoutManagementCoordinator, owner: String) {
        self.coordinator = coordinator
        self.owner = owner
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
    }
    required init?(coder: NSCoder) { nil }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        presentationController?.delegate = self
        summary.numberOfLines = 0
        summary.font = .preferredFont(forTextStyle: .body)
        summary.adjustsFontForContentSizeCategory = true
        let close = UIButton(type: .system)
        close.setTitle("닫기", for: .normal)
        close.addTarget(self, action: #selector(closeSheet), for: .touchUpInside)
        action.addTarget(self, action: #selector(proceed), for: .touchUpInside)
        pages.setTitle("다음 등록 운동 20개 (마지막 뒤 처음)", for: .normal)
        pages.addTarget(self, action: #selector(nextPage), for: .touchUpInside)
        for button in [close, action, pages] {
            button.titleLabel?.font = .preferredFont(forTextStyle: .body)
            button.titleLabel?.adjustsFontForContentSizeCategory = true
            button.titleLabel?.numberOfLines = 0
        }
        table.dataSource = self
        table.delegate = self
        table.rowHeight = UITableView.automaticDimension
        table.estimatedRowHeight = 90
        let stack = UIStackView(arrangedSubviews: [close, summary, pages, table, action])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(
                equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -12),
            stack.leadingAnchor.constraint(
                equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(
                equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -16),
            stack.widthAnchor.constraint(
                equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -32),
            table.heightAnchor.constraint(equalToConstant: 260),
        ])
    }
    private var visible: [HealthKitWorkoutClaim] { Array(claims.dropFirst(page * 20).prefix(20)) }
    func render(_ session: HealthKitWorkoutManagementSession) {
        loadViewIfNeeded()
        state = session.state
        selected = session.selected
        handle = session.managementId
        let changed = claims.map(\.sampleId) != session.claims.map(\.sampleId)
        claims = session.claims
        if changed {
            page = 0
            labels = [:]
        }
        let message: String
        switch state {
        case .loading: message = "전체 등록 목록 확인 중"
        case .choosing:
            message =
                "등록 \(claims.count)개. 운동 하나를 선택해 등록 해제와 관련 기록 삭제를 확인하세요. 요약을 읽을 수 없으면 네이티브 식별자로 확인하세요. 요약 없음은 권한이나 원본 부재의 증거가 아닙니다."
        case .confirming: message = "관련 기록 삭제 확인이 필요합니다."
        case .deregistering: message = "서버 처리 결과 확인 중. 닫기는 이미 보낸 요청을 되돌리지 않습니다."
        case .pendingCleanup:
            message =
                "등록 운동은 수집 대상에서 제외됐습니다. 관련 자료 정리가 끝나기 전에는 다른 계정에 재등록할 수 없습니다. 결과 다시 확인을 눌러 주세요."
        case .released:
            message = "관련 자료 정리와 등록 해제, 전체 등록 목록 확인을 마쳤습니다. 다른 계정에서 다시 명시적으로 선택·등록할 수 있습니다."
        case .legacyBlocked: message = "과거 자료의 운동 귀속을 확인할 수 없어 등록 해제를 차단했습니다. 자동 정리하지 않았습니다."
        case .offline: message = "연결 확인이 필요합니다. 보낸 요청의 결과가 불확실할 수 있습니다. 같은 요청 또는 작업 상태를 다시 확인하세요."
        case .conflict: message = "등록 상태가 바뀌었습니다. 닫고 다시 확인하세요."
        case .consentRequired: message = "HealthKit 동의를 다시 확인하세요."
        case .unauthorized: message = "로그인 계정이 바뀌었습니다."
        case .unavailable: message = "현재 결과를 확인할 수 없습니다. 보낸 요청은 처리됐을 수 있습니다."
        case .idle, .cancelled: message = "관리를 닫았습니다. 이미 보낸 요청은 처리됐을 수 있습니다."
        }
        summary.text = "현재 계정: \(owner)\n\(message)"
        action.setTitle(state == .choosing ? "선택한 운동 등록 해제·삭제 확인" : "결과 다시 확인", for: .normal)
        action.isEnabled =
            (state == .choosing && selected != nil)
            || ([.pendingCleanup, .offline, .unavailable].contains(state)
                && session.pending != nil)
        pages.isEnabled = state == .choosing && claims.count > 20
        table.reloadData()
        if changed { refreshSummaries() }
    }
    private func refreshSummaries() {
        if let handle {
            coordinator.loadSummaries(ids: visible.map(\.sampleId), handle: handle, page: page)
        }
    }
    func applySummaries(_ values: [UUID: String], handle: UUID, page: Int) {
        guard self.handle == handle, self.page == page else { return }
        let visibleIds = Set(visible.map(\.sampleId))
        labels = values.filter { visibleIds.contains($0.key) }
        table.reloadData()
    }
    func clearPrivateView() {
        claims = []
        labels = [:]
        selected = nil
        handle = nil
        table.isHidden = true
        action.isEnabled = false
        pages.isEnabled = false
        summary.text = "관리를 닫았습니다."
        (presentedViewController as? UIAlertController)?.message = "관리를 닫았습니다."
        table.reloadData()
    }
    @objc private func closeSheet() { if let handle { coordinator.cancel(managementId: handle) } }
    @objc private func proceed() { if let handle { coordinator.proceed(handle: handle) } }
    @objc private func nextPage() {
        guard state == .choosing else { return }
        page = (page + 1) % max(1, (claims.count + 19) / 20)
        labels = [:]
        table.reloadData()
        refreshSummaries()
    }
    func confirm(handle: UUID, generation: Int) {
        guard let selected else { return }
        let alert = UIAlertController(
            title: "등록 해제와 관련 기록 삭제",
            message:
                "\(labels[selected] ?? "원본 요약 확인 불가")\n현재 계정 \(owner)의 운동 \(selected.uuidString.lowercased())을 해제하고 이 HealthKit 원본에서 생성된 앱 기록과 관련 자료를 삭제합니다. 독립된 수동·FIT·Garmin 기록과 Apple 건강의 원본 운동은 보존합니다. 정리 완료 후 다른 계정에서 재등록할 수 있습니다. 삭제하시겠습니까?",
            preferredStyle: .alert)
        alert.addAction(
            UIAlertAction(title: "계속 선택", style: .cancel) { [weak self] _ in
                self?.coordinator.continueChoosing(handle: handle, generation: generation)
            })
        alert.addAction(
            UIAlertAction(title: "관련 기록 삭제·등록 해제", style: .destructive) { [weak self] _ in
                self?.coordinator.confirmed(handle: handle, generation: generation)
            })
        present(alert, animated: true)
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        closeSheet()
    }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        visible.count
    }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let claim = visible[indexPath.row]
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        cell.textLabel?.text = labels[claim.sampleId] ?? "원본 요약 확인 불가"
        cell.detailTextLabel?.text = "등록 운동 식별자: \(claim.sampleId.uuidString.lowercased())"
        for label in [cell.textLabel, cell.detailTextLabel] {
            label?.numberOfLines = 0
            label?.adjustsFontForContentSizeCategory = true
        }
        cell.textLabel?.font = .preferredFont(forTextStyle: .body)
        cell.detailTextLabel?.font = .preferredFont(forTextStyle: .caption1)
        cell.accessoryType = selected == claim.sampleId ? .checkmark : .none
        cell.accessibilityTraits = selected == claim.sampleId ? [.button, .selected] : .button
        return cell
    }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        if state == .choosing, let handle {
            coordinator.select(visible[indexPath.row].sampleId, handle: handle)
        }
        tableView.deselectRow(at: indexPath, animated: false)
    }
}
