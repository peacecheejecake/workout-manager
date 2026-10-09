import Foundation
import HealthKit
import UIKit

/// Owns the native sheet and its operations; candidate identifiers never enter a bridge reply.
@MainActor
final class HealthKitWorkoutSelectionCoordinator {
    static let shared = HealthKitWorkoutSelectionCoordinator()
    private var session = HealthKitWorkoutSelectionSession()
    private weak var sheet: HealthKitWorkoutSelectionViewController?
    private var work: Task<Void, Never>?
    private var opening = false
    private let store = HKHealthStore()
    private let candidateSource: (@MainActor (Date, Date) async throws -> [HealthKitWorkoutCandidate])?
    private var invalidation: NSObjectProtocol?

    init(candidateSource: (@MainActor (Date, Date) async throws -> [HealthKitWorkoutCandidate])? = nil) {
        self.candidateSource = candidateSource
        invalidation = NotificationCenter.default.addObserver(
            forName: .nativeAuthCredentialInvalidated, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.invalidate(.unauthorized) }
        }
    }

    deinit {
        work?.cancel()
        if let invalidation { NotificationCenter.default.removeObserver(invalidation) }
    }

    func open() async throws -> UUID {
        guard !opening, sheet == nil, NativeAuth.isConfigured else { throw HealthKitWorkoutSelectionError.unavailable }
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
        while let presented = presenter.presentedViewController { presenter = presented }
        guard !presenter.isBeingDismissed else { throw HealthKitWorkoutSelectionError.unavailable }
        let generation = session.begin(context)
        guard let handle = session.selectionId else { throw HealthKitWorkoutSelectionError.unavailable }
        let controller = HealthKitWorkoutSelectionViewController(coordinator: self, owner: context.ownerAthleteId)
        sheet = controller
        presenter.present(controller, animated: true)
        controller.render(session)
        load(
            from: Calendar.current.date(byAdding: .day, value: -30, to: Date()) ?? Date(), through: Date(),
            generation: generation)
        return handle
    }

    func status(selectionId: UUID) async throws -> [String: Any] {
        guard session.selectionId == selectionId else { throw HealthKitWorkoutSelectionError.stale }
        if let context = session.context {
            do { try await NativeAuth.shared.validateHealthKitSelectionContext(context) } catch {
                guard session.selectionId == selectionId else { throw HealthKitWorkoutSelectionError.stale }
                guard session.context == context else { return session.status }
                if error is CancellationError { throw error }
                if let value = error as? HealthKitWorkoutSelectionError,
                    value == .consentRequired || value == .unauthorized || value == .stale
                {
                    invalidate(value == .consentRequired ? .consent_required : .unauthorized)
                } else {
                    // A status poll must not rewrite an in-flight transaction's state.
                    return [
                        "state": "offline", "registeredCount": NSNull(), "selectedCount": session.selected.count,
                        "resultCount": session.resultCount as Any? ?? NSNull(),
                    ]
                }
            }
        }
        try Task.checkCancellation()
        guard session.selectionId == selectionId else { throw HealthKitWorkoutSelectionError.stale }
        return session.status
    }

    func consentDidChange(granted: Bool, revision: Int) {
        guard let context = session.context else { return }
        if !granted || context.consentRevision != revision { invalidate(.consent_required) }
    }

    func cancel(selectionId: UUID) {
        guard session.selectionId == selectionId else { return }
        guard session.context != nil || sheet != nil || work != nil else { return }
        work?.cancel()
        work = nil
        if session.state != .registered { session.cancel(selectionId: selectionId) }
        let controller = sheet
        sheet = nil
        controller?.clearPrivateView()
        controller?.dismiss(animated: true)
    }

    func changeDates(from: Date, through: Date, selectionId: UUID) {
        guard session.permitsUI(selectionId: selectionId) else { return }
        guard session.context != nil,
            session.state == .choosing || session.state == .offline || session.state == .unavailable,
            session.pending == nil
        else { return }
        work?.cancel()
        guard let generation = try? session.reload() else { return }
        // A date reload belongs to the same sheet/bridge handle.
        // Restore its handle through a dedicated reload transition instead of opening a second UI lifetime.
        load(from: from, through: through, generation: generation)
    }

    private func load(from: Date, through: Date, generation: Int) {
        guard let context = session.context else { return }
        sheet?.render(session)
        work = Task { @MainActor in
            do {
                guard through >= from, through.timeIntervalSince(from) <= 366 * 86_400 else {
                    throw HealthKitWorkoutSelectionError.invalidInput
                }
                try await NativeAuth.shared.validateHealthKitSelectionContext(context)
                let snapshot = try await NativeAuth.shared.fetchHealthKitRegisteredWorkouts(
                    ownerAthleteId: context.ownerAthleteId, consentRevision: context.consentRevision)
                guard session.current(context, generation: generation) else { return }
                let candidates = try await readCandidates(from: from, through: through, context: context)
                try Task.checkCancellation()
                try await NativeAuth.shared.validateHealthKitSelectionContext(context)
                guard session.current(context, generation: generation) else { return }
                try session.loaded(candidates, snapshot: snapshot, from: from, through: through, generation: generation)
                sheet?.render(session)
            } catch { handle(error, context: context, generation: generation) }
        }
    }

    private func readCandidates(from: Date, through: Date, context: HealthKitWorkoutSelectionContext) async throws
        -> [HealthKitWorkoutCandidate]
    {
        if let candidateSource { return try await candidateSource(from, through) }
        #if DEBUG
            // DEBUG never reads the user's workouts; the pure session harness supplies synthetic candidates.
            throw HealthKitWorkoutSelectionError.unavailable
        #else
            guard HKHealthStore.isHealthDataAvailable() else { throw HealthKitWorkoutSelectionError.unavailable }
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                store.requestAuthorization(toShare: [], read: [HKObjectType.workoutType()]) { success, error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else if success {
                        continuation.resume()
                    } else {
                        continuation.resume(throwing: HealthKitWorkoutSelectionError.unavailable)
                    }
                }
            }
            try Task.checkCancellation()
            try await NativeAuth.shared.validateHealthKitSelectionContext(context)
            // This query is run only by open/reload from an explicit native UI action, never background delivery.
            let predicate = HKQuery.predicateForSamples(
                withStart: from, end: through, options: [.strictStartDate, .strictEndDate])
            return try await withCheckedThrowingContinuation { continuation in
                let query = HKSampleQuery(
                    sampleType: HKObjectType.workoutType(), predicate: predicate, limit: 200,
                    sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]
                ) { _, values, error in
                    if let error {
                        continuation.resume(throwing: error)
                        return
                    }
                    guard let workouts = values as? [HKWorkout], workouts.count <= 200 else {
                        continuation.resume(throwing: HealthKitWorkoutSelectionError.invalidReply)
                        return
                    }
                    continuation.resume(
                        returning: workouts.map {
                            .init(
                                sampleId: $0.uuid, activityType: $0.workoutActivityType.rawValue,
                                start: $0.startDate, end: $0.endDate, duration: $0.duration)
                        })
                }
                store.execute(query)
            }
        #endif
    }

    func toggle(_ id: UUID, selectionId: UUID) {
        guard session.permitsUI(selectionId: selectionId) else { return }
        do {
            try session.toggle(id)
            sheet?.render(session)
        } catch { sheet?.showLimit() }
    }
    func showConfirmation(selectionId: UUID) {
        guard session.permitsUI(selectionId: selectionId) else { return }
        do {
            try session.showConfirmation()
            sheet?.render(session)
            sheet?.confirm(
                account: session.context?.ownerAthleteId ?? "", count: session.selected.count, selectionId: selectionId,
                generation: session.generation)
        } catch { sheet?.showLimit() }
    }
    func continueChoosing(selectionId: UUID, generation: Int) {
        guard session.permitsUI(selectionId: selectionId, generation: generation) else { return }
        session.continueChoosing()
        sheet?.render(session)
    }
    func confirmed(selectionId: UUID, generation: Int) {
        guard session.permitsUI(selectionId: selectionId, generation: generation) else { return }
        do {
            let request = try session.confirm(accountAttributionDeclared: true)
            submit(request)
        } catch {
            session.failed(.unavailable)
            sheet?.render(session)
        }
    }
    func retry(selectionId: UUID) {
        guard session.permitsUI(selectionId: selectionId) else { return }
        if session.state == .refresh_pending, let context = session.context, session.acknowledgement != nil {
            refresh(context, generation: session.generation)
        } else {
            do { submit(try session.retry()) } catch { sheet?.render(session) }
        }
    }
    private func submit(_ request: HealthKitWorkoutRegistrationRequest) {
        let generation = session.generation
        work?.cancel()
        sheet?.render(session)
        work = Task { @MainActor in
            do {
                try await NativeAuth.shared.validateHealthKitSelectionContext(request.context)
                guard session.current(request.context, generation: generation) else { return }
                session.markTransmitted()
                let acknowledgement = try await NativeAuth.shared.registerHealthKitWorkouts(request)
                try Task.checkCancellation()
                guard session.current(request.context, generation: generation) else { return }
                try session.acknowledged(acknowledgement, generation: generation)
                sheet?.render(session)
                refresh(request.context, generation: generation)
            } catch { handle(error, context: request.context, generation: generation) }
        }
    }
    private func refresh(_ context: HealthKitWorkoutSelectionContext, generation: Int) {
        work = Task { @MainActor in
            do {
                try await NativeAuth.shared.validateHealthKitSelectionContext(context)
                let snapshot = try await NativeAuth.shared.fetchHealthKitRegisteredWorkouts(
                    ownerAthleteId: context.ownerAthleteId, consentRevision: context.consentRevision)
                try Task.checkCancellation()
                guard session.current(context, generation: generation) else { return }
                try await NativeAuth.shared.validateHealthKitSelectionContext(context)
                guard session.current(context, generation: generation) else { return }
                try session.refreshed(snapshot, generation: generation)
                try HealthKitWorkoutCollector.shared.registrationsDidChange(
                    ownerAthleteId: context.ownerAthleteId, consentRevision: context.consentRevision)
                sheet?.render(session)
            } catch { handle(error, context: context, generation: generation) }
        }
    }
    private func handle(_ error: Error, context: HealthKitWorkoutSelectionContext, generation: Int) {
        guard session.current(context, generation: generation), !(error is CancellationError) else { return }
        switch error as? HealthKitWorkoutSelectionError {
        case .consentRequired: invalidate(.consent_required)
        case .unauthorized, .stale: invalidate(.unauthorized)
        case .conflict: session.failed(.conflict)
        case .invalidInput, .invalidReply, .unavailable: session.failed(.unavailable)
        default: session.failed(.offline)
        }
        sheet?.render(session)
    }
    private func invalidate(_ state: HealthKitWorkoutSelectionState) {
        work?.cancel()
        work = nil
        session.invalidate(state)
        let controller = sheet
        sheet = nil
        controller?.clearPrivateView()
        controller?.dismiss(animated: true)
    }
}

@MainActor
final class HealthKitWorkoutSelectionViewController: UIViewController, UITableViewDataSource, UITableViewDelegate,
    UIAdaptivePresentationControllerDelegate
{
    private let coordinator: HealthKitWorkoutSelectionCoordinator
    private let owner: String
    private let summary = UILabel()
    private let table = UITableView(frame: .zero, style: .plain)
    private let start = UIDatePicker()
    private let end = UIDatePicker()
    private let action = UIButton(type: .system)
    private var candidates: [HealthKitWorkoutCandidate] = []
    private var selected = Set<UUID>()
    private var state: HealthKitWorkoutSelectionState = .idle
    private var selectionId: UUID?

    init(coordinator: HealthKitWorkoutSelectionCoordinator, owner: String) {
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
        let cancel = UIButton(type: .system)
        cancel.setTitle("닫기 / 선택 취소", for: .normal)
        cancel.addTarget(self, action: #selector(close), for: .touchUpInside)
        for picker in [start, end] {
            picker.datePickerMode = .date
            picker.preferredDatePickerStyle = .compact
            picker.maximumDate = Date()
        }
        start.date = Calendar.current.date(byAdding: .day, value: -30, to: Date()) ?? Date()
        end.date = Date()
        start.accessibilityLabel = "조회 시작일"
        end.accessibilityLabel = "조회 종료일"
        let reload = UIButton(type: .system)
        reload.setTitle("기간 내 운동 다시 조회", for: .normal)
        reload.addTarget(self, action: #selector(reloadDates), for: .touchUpInside)
        action.addTarget(self, action: #selector(proceed), for: .touchUpInside)
        table.dataSource = self
        table.delegate = self
        table.rowHeight = UITableView.automaticDimension
        table.estimatedRowHeight = 64
        let startLabel = UILabel()
        startLabel.text = "조회 시작일"
        let endLabel = UILabel()
        endLabel.text = "조회 종료일"
        for label in [startLabel, endLabel] {
            label.font = .preferredFont(forTextStyle: .body)
            label.adjustsFontForContentSizeCategory = true
            label.numberOfLines = 0
        }
        let stack = UIStackView(arrangedSubviews: [
            cancel, summary, startLabel, start, endLabel, end, reload, table, action,
        ])
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
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -12),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -16),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -32),
            table.heightAnchor.constraint(equalToConstant: 260),
        ])
        for button in [cancel, reload, action] {
            button.titleLabel?.font = .preferredFont(forTextStyle: .body)
            button.titleLabel?.adjustsFontForContentSizeCategory = true
            button.titleLabel?.numberOfLines = 0
        }
    }
    func render(_ session: HealthKitWorkoutSelectionSession) {
        loadViewIfNeeded()
        state = session.state
        candidates = session.candidates
        selected = session.selected
        selectionId = session.selectionId
        let message: String
        switch state {
        case .loading: message = "등록 목록과 기간 내 운동을 확인하고 있습니다."
        case .choosing:
            message =
                "\(candidates.count)개 후보 · \(selected.count)개 선택. 후보는 최대 200개, 선택은 최대 50개입니다. 빈 결과는 OS 읽기 허용이나 운동 기록 부재를 뜻하지 않습니다."
        case .confirming: message = "계정 귀속 선언을 확인해 주세요. 확인 전에는 운동을 등록하지 않습니다."
        case .registering: message = "서버 등록 결과를 확인하고 있습니다. 화면을 닫아도 이미 보낸 요청은 처리됐을 수 있습니다."
        case .registered: message = "서버 등록과 전체 목록 확인을 마쳤습니다. 등록한 운동만 수집 대상으로 사용합니다."
        case .refresh_pending: message = "등록 목록 재확인이 필요합니다. 등록 결과가 불확실하거나 수집 재개를 기다리고 있습니다. 취소는 서버 등록을 되돌리지 않습니다."
        case .offline: message = "연결을 확인할 수 없습니다. 이미 보낸 등록 요청은 같은 내용으로 재시도합니다."
        case .conflict: message = "등록 상태가 바뀌었습니다. 이 화면을 닫고 등록 목록을 다시 확인해 주세요."
        case .consent_required: message = "현재 계정의 HealthKit 동의를 다시 확인해 주세요."
        case .unauthorized: message = "로그인 계정이 바뀌었습니다. 선택을 다시 시작해 주세요."
        case .unavailable:
            message =
                session.pending == nil
                ? "이 환경에서 조회를 완료할 수 없습니다. DEBUG에서는 개인 운동을 읽지 않습니다."
                : "등록 결과를 확인하지 못했습니다. 보낸 요청은 서버에서 처리됐을 수 있습니다. 화면을 닫고 등록 목록을 다시 확인해 주세요."
        case .idle, .cancelled: message = "선택을 시작하거나 취소한 상태입니다."
        }
        summary.text = "현재 계정: \(owner)\n\(message)"
        action.setTitle(state == .offline || state == .refresh_pending ? "결과 다시 확인" : "선택한 운동의 계정 귀속 확인", for: .normal)
        action.isEnabled =
            (state == .choosing && !selected.isEmpty) || (state == .offline && session.pending != nil)
            || (state == .refresh_pending && session.acknowledgement != nil)
        table.reloadData()
    }
    func clearPrivateView() {
        candidates.removeAll()
        selected.removeAll()
        table.isHidden = true
        action.isEnabled = false
        summary.text = "선택을 닫았습니다. 이미 보낸 요청은 서버에서 처리됐을 수 있습니다."
        if let alert = presentedViewController as? UIAlertController { alert.message = "선택을 닫았습니다." }
        table.reloadData()
    }

    @objc private func close() { if let selectionId { coordinator.cancel(selectionId: selectionId) } }
    @objc private func reloadDates() {
        let from = Calendar.current.startOfDay(for: start.date)
        let through = min(
            Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: end.date)) ?? Date(),
            Date())
        if let selectionId { coordinator.changeDates(from: from, through: through, selectionId: selectionId) }
    }
    @objc private func proceed() {
        guard let selectionId else { return }
        if state == .choosing {
            coordinator.showConfirmation(selectionId: selectionId)
        } else {
            coordinator.retry(selectionId: selectionId)
        }
    }
    func confirm(account: String, count: Int, selectionId: UUID, generation: Int) {
        let alert = UIAlertController(
            title: "운동의 계정 귀속 선언",
            message:
                "선택한 \(count)개 운동을 현재 계정 \(account)에 귀속하고 서버 업로드 대상으로 등록합니다. HealthKit은 운동의 실제 소유자를 알려주지 않으며, 이 선택을 귀속 선언으로 사용합니다. 동의하시나요?",
            preferredStyle: .alert)
        alert.addAction(
            UIAlertAction(title: "계속 선택", style: .cancel) { [weak self] _ in
                self?.coordinator.continueChoosing(selectionId: selectionId, generation: generation)
            })
        alert.addAction(
            UIAlertAction(title: "이 계정에 귀속·등록", style: .default) { [weak self] _ in
                self?.coordinator.confirmed(selectionId: selectionId, generation: generation)
            })
        present(alert, animated: true)
    }
    func showLimit() {
        let alert = UIAlertController(title: "선택 확인", message: "현재 후보에서 1~50개 운동을 선택해 주세요.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "확인", style: .default))
        present(alert, animated: true)
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { close() }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { candidates.count }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let candidate = candidates[indexPath.row]
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        cell.textLabel?.text =
            "\(Self.activityLabel(candidate.activityType)) · \(formatter.string(from: candidate.start))"
        cell.detailTextLabel?.text = "\(Int(candidate.duration / 60))분"
        cell.textLabel?.font = .preferredFont(forTextStyle: .body)
        cell.detailTextLabel?.font = .preferredFont(forTextStyle: .caption1)
        for label in [cell.textLabel, cell.detailTextLabel] {
            label?.adjustsFontForContentSizeCategory = true
            label?.numberOfLines = 0
        }
        let checked = selected.contains(candidate.sampleId)
        cell.accessoryType = checked ? .checkmark : .none
        cell.accessibilityLabel =
            "\(cell.textLabel?.text ?? "운동"), \(cell.detailTextLabel?.text ?? ""), \(checked ? "선택됨" : "선택 안 됨")"
        cell.accessibilityTraits = checked ? [.button, .selected] : .button
        return cell
    }
    private static func activityLabel(_ raw: UInt) -> String {
        switch HKWorkoutActivityType(rawValue: raw) {
        case .running?: return "달리기"
        case .walking?: return "걷기"
        case .cycling?: return "자전거"
        case .swimming?: return "수영"
        case .traditionalStrengthTraining?: return "근력 운동"
        case .yoga?: return "요가"
        case .hiking?: return "하이킹"
        default: return "기타 운동"
        }
    }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        if state == .choosing, let selectionId {
            coordinator.toggle(candidates[indexPath.row].sampleId, selectionId: selectionId)
        }
        tableView.deselectRow(at: indexPath, animated: false)
    }
}
