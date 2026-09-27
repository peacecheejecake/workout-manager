import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

extension Notification.Name {
    static let nativeAuthCredentialInvalidated = Notification.Name("org.workoutmanager.nativeAuthCredentialInvalidated")
}

enum HealthKitConsentState: Equatable {
    case granted(revision: Int)
    case notGranted(revision: Int)
    case authenticationRequired
}

enum HealthKitConsentWriteOutcome {
    case updated(granted: Bool, revision: Int)
    case authenticationRequired
    case conflict
}

private enum NativeAuthFailure: Error {
    case unavailable
    case cancelled
    case invalidReply

    var bridgeCode: String {
        switch self {
        case .unavailable: return "UNAVAILABLE"
        case .cancelled: return "CANCELLED"
        case .invalidReply: return "INVALID_REPLY"
        }
    }
}

private struct NativeAuthConfiguration {
    static let callback = "org.workoutmanager.app://auth/callback"
    let apiOrigin: URL
    let idpOrigin: URL

    init?(info: [String: Any] = Bundle.main.infoDictionary ?? [:]) {
        guard let api = Self.exactHTTPSOrigin(info["WMNativeAPIOrigin"] as? String),
              let idp = Self.exactHTTPSOrigin(info["WMNativeIdPOrigin"] as? String) else {
            return nil
        }
        apiOrigin = api
        idpOrigin = idp
    }

    private static func exactHTTPSOrigin(_ input: String?) -> URL? {
        guard let input,
              let components = URLComponents(string: input),
              components.scheme == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.path.isEmpty, components.query == nil, components.fragment == nil,
              components.port.map({ (1...65535).contains($0) }) ?? true,
              let url = components.url, url.absoluteString == input else { return nil }
        return url
    }

    func apiURL(_ path: String) -> URL {
        // All callers supply a fixed absolute path; no browser input reaches this function.
        URL(string: path, relativeTo: apiOrigin)!.absoluteURL
    }

    func acceptsIdP(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return parts.scheme == "https" && parts.host == idpOrigin.host &&
            parts.port == URLComponents(url: idpOrigin, resolvingAgainstBaseURL: false)?.port &&
            parts.user == nil && parts.password == nil && parts.fragment == nil
    }
}

private struct NativeCredential: Codable {
    let accessToken: String
    let athleteId: String
    let sessionId: String
    let expiresAt: Date
    let apiOrigin: String

    var publicSession: [String: String] {
        ["state": "signed_in", "athleteId": athleteId,
         "expiresAt": ISO8601DateFormatter().string(from: expiresAt)]
    }
}

private struct NativeCredentialStore {
    private let service = Bundle.main.bundleIdentifier ?? "org.workoutmanager.app"
    private let account = "native-oidc-v1"
    private let apiOrigin = NativeAuthConfiguration()?.apiOrigin.absoluteString

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    func read() throws -> NativeCredential? {
        var attributes = query
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let credential = try? JSONDecoder().decode(NativeCredential.self, from: data),
              credential.accessToken.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              credential.athleteId.range(of: "^[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil,
              !credential.sessionId.isEmpty else {
            throw NativeAuthFailure.unavailable
        }
        if credential.apiOrigin != apiOrigin {
            // A build pointed at another API must never reuse this bearer or show its user.
            try delete()
            NotificationCenter.default.post(name: .nativeAuthCredentialInvalidated, object: nil)
            return nil
        }
        return credential
    }

    func save(_ credential: NativeCredential) throws {
        let data = try JSONEncoder().encode(credential)
        // Replacing a credential must not leave an older bearer behind if the add fails.
        let existing = try read()
        if existing != nil {
            let status = SecItemUpdate(query as CFDictionary,
                                       [kSecValueData as String: data] as CFDictionary)
            guard status == errSecSuccess else { throw NativeAuthFailure.unavailable }
        } else {
            var attributes = query
            attributes[kSecValueData as String] = data
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess else {
                throw NativeAuthFailure.unavailable
            }
        }
    }

    func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NativeAuthFailure.unavailable
        }
    }
}

/** A separate session per request enforces no cookies, no redirects and a hard 16 KiB response cap. */
private final class BoundedNativeRequest: NSObject, URLSessionDataDelegate {
    private let limit = 16_384
    private var body = Data()
    private var response: HTTPURLResponse?
    private var completion: ((Result<(Int, Data), Error>) -> Void)?
    private var session: URLSession?
    private let cancellationLock = NSLock()
    private var requestTask: URLSessionDataTask?
    private var cancellationRequested = false

    func send(_ request: URLRequest) async throws -> (Int, Data) {
        try Task.checkCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let configuration = URLSessionConfiguration.ephemeral
                configuration.httpShouldSetCookies = false
                configuration.httpCookieAcceptPolicy = .never
                configuration.httpCookieStorage = nil
                configuration.urlCache = nil
                configuration.timeoutIntervalForRequest = 15
                configuration.timeoutIntervalForResource = 30
                completion = { result in continuation.resume(with: result) }
                let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
                self.session = session
                let task = session.dataTask(with: request)
                cancellationLock.lock()
                requestTask = task
                let cancelled = cancellationRequested
                cancellationLock.unlock()
                task.resume()
                if cancelled { task.cancel() }
            }
        } onCancel: {
            self.cancel()
        }
    }

    private func cancel() {
        cancellationLock.lock()
        cancellationRequested = true
        let task = requestTask
        cancellationLock.unlock()
        task?.cancel()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse,
              response.expectedContentLength <= Int64(limit) else {
            completionHandler(.cancel)
            return
        }
        self.response = http
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard body.count <= limit - data.count else {
            dataTask.cancel()
            return
        }
        body.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        cancellationLock.lock()
        let cancelled = cancellationRequested
        requestTask = nil
        cancellationLock.unlock()
        let result: Result<(Int, Data), Error>
        if error == nil, let response {
            // Keep a completed response available to the caller even if cancellation
            // arrived between receiving the response and this callback.
            result = .success((response.statusCode, body))
        } else if cancelled, let response {
            // A complete JSON response can still be decoded by the caller and
            // an observed logout status can clear local credentials.
            result = .success((response.statusCode, body))
        } else if cancelled {
            result = .failure(NativeAuthFailure.cancelled)
        } else {
            result = .failure(NativeAuthFailure.unavailable)
        }
        completion?(result)
        completion = nil
        self.session?.finishTasksAndInvalidate()
        self.session = nil
    }
}

@MainActor
final class NativeAuth: NSObject, ASWebAuthenticationPresentationContextProviding {
    struct SignInOutcome {
        let session: [String: String]
        let sessionID: String
    }
    static let shared = NativeAuth()
    nonisolated static var isConfigured: Bool {
        guard NativeAuthConfiguration() != nil else { return false }
        // An unsigned simulator or a broken Keychain entitlement must not advertise transport.
        do { _ = try NativeCredentialStore().read(); return true }
        catch { return false }
    }
    private let configuration = NativeAuthConfiguration()
    private let credentialStore = NativeCredentialStore()
    private var authenticationSession: ASWebAuthenticationSession?
    private var authenticationContinuation: CheckedContinuation<URL, Error>?
    private var busy = false

    private func clearCredential() throws {
        try credentialStore.delete()
        // No token, athlete ID, or health data crosses this local signal.
        NotificationCenter.default.post(name: .nativeAuthCredentialInvalidated, object: nil)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }

    func signIn() async throws -> SignInOutcome {
        try Task.checkCancellation()
        guard Self.isConfigured, let configuration else { throw NativeAuthFailure.unavailable }
        guard !busy else { throw NativeAuthFailure.unavailable }
        busy = true
        defer { busy = false }
        if let existing = try credentialStore.read() {
            if existing.expiresAt > Date() { throw NativeAuthFailure.unavailable }
            try clearCredential()
        }

        var random = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else {
            throw NativeAuthFailure.unavailable
        }
        let verifier = Self.base64URL(Data(random))
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        guard verifier.count == 43, challenge.count == 43 else {
            throw NativeAuthFailure.unavailable
        }
        let start: StartReply = try await post(
            configuration.apiURL("/bff/v1/auth/native/start"),
            body: ["codeChallenge": challenge])
        try Task.checkCancellation()
        guard let location = URL(string: start.location), configuration.acceptsIdP(location) else {
            throw NativeAuthFailure.invalidReply
        }
        let callback = try await authorize(location)
        try Task.checkCancellation()
        let code = try Self.callbackCode(callback)
        let exchanged: ExchangeReply = try await post(
            configuration.apiURL("/bff/v1/auth/native/exchange"),
            body: ["code": code, "codeVerifier": verifier])
        let validBearer = exchanged.accessToken.range(
            of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
        guard exchanged.tokenType == "Bearer", validBearer,
              exchanged.athleteId.range(of: "^[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil,
              !exchanged.sessionId.isEmpty,
              let expiry = Self.parseExpiry(exchanged.expiresAt),
              expiry > Date(), expiry <= Date().addingTimeInterval(28_800) else {
            if validBearer {
                await revokeAfterCancellation(exchanged.accessToken, at: configuration)
            }
            throw NativeAuthFailure.invalidReply
        }
        let credential = NativeCredential(accessToken: exchanged.accessToken,
                                          athleteId: exchanged.athleteId,
                                          sessionId: exchanged.sessionId,
                                          expiresAt: expiry,
                                          apiOrigin: configuration.apiOrigin.absoluteString)
        do {
            try Task.checkCancellation()
        } catch {
            await revokeAfterCancellation(exchanged.accessToken, at: configuration)
            throw NativeAuthFailure.cancelled
        }
        do {
            try credentialStore.save(credential)
        } catch {
            // A successful exchange must not strand an active bearer when persistence fails.
            await revokeAfterCancellation(exchanged.accessToken, at: configuration)
            throw NativeAuthFailure.unavailable
        }
        do {
            try Task.checkCancellation()
        } catch {
            try? clearCredential()
            await revokeAfterCancellation(exchanged.accessToken, at: configuration)
            throw NativeAuthFailure.cancelled
        }
        return SignInOutcome(session: credential.publicSession, sessionID: credential.sessionId)
    }

    func cancelCompletedSignIn(sessionID: String) async {
        guard let configuration,
              let credential = try? credentialStore.read(),
              credential.sessionId == sessionID else { return }
        try? clearCredential()
        await revokeAfterCancellation(credential.accessToken, at: configuration)
    }

    private func revokeAfterCancellation(_ bearer: String,
                                         at configuration: NativeAuthConfiguration) async {
        // This cleanup must outlive cancellation of the bridge request.
        let cleanup = Task { @MainActor in try? await self.revoke(bearer, at: configuration) }
        await cleanup.value
    }

    func currentSession() async throws -> [String: String] {
        guard Self.isConfigured, let configuration else { throw NativeAuthFailure.unavailable }
        guard !busy else { throw NativeAuthFailure.unavailable }
        busy = true
        defer { busy = false }
        guard let credential = try credentialStore.read() else { return ["state": "signed_out"] }
        if credential.expiresAt <= Date() {
            try clearCredential()
            return ["state": "signed_out"]
        }
        let (status, body) = try await get("/bff/v1/session", credential: credential,
                                           at: configuration)
        if status == 401 {
            if let current = try credentialStore.read(),
               current.sessionId == credential.sessionId,
               current.accessToken == credential.accessToken { try clearCredential() }
            return ["state": "signed_out"]
        }
        guard status == 200 else { throw NativeAuthFailure.unavailable }
        try validateSession(body, credential: credential)
        guard let current = try credentialStore.read(),
              current.sessionId == credential.sessionId,
              current.accessToken == credential.accessToken,
              current.athleteId == credential.athleteId,
              current.expiresAt > Date() else {
            return ["state": "signed_out"]
        }
        return credential.publicSession
    }

    func readAPI(_ path: String) async throws -> [String: Any] {
        guard Self.isConfigured, let configuration else { throw NativeAuthFailure.unavailable }
        guard path == "/bff/v1/session" || path == "/bff/v1/consents/ai" ||
                path == "/bff/v1/consents/healthkit" else {
            throw NativeAuthFailure.invalidReply
        }
        guard !busy else { throw NativeAuthFailure.unavailable }
        busy = true
        defer { busy = false }
        guard let credential = try credentialStore.read() else {
            return ["path": path, "status": 401, "body": NSNull()]
        }
        if credential.expiresAt <= Date() {
            try clearCredential()
            return ["path": path, "status": 401, "body": NSNull()]
        }
        let (status, data) = try await get(path, credential: credential, at: configuration)
        if status == 401 {
            if let current = try credentialStore.read(),
               current.sessionId == credential.sessionId,
               current.accessToken == credential.accessToken { try clearCredential() }
            return ["path": path, "status": 401, "body": NSNull()]
        }
        guard status == 200 else { throw NativeAuthFailure.unavailable }
        let body: [String: Any]
        if path == "/bff/v1/session" {
            let athleteId = try validateSession(data, credential: credential)
            body = ["athleteId": athleteId]
        } else if path == "/bff/v1/consents/ai" {
            body = try validateAIConsent(data)
        } else {
            body = try validateHealthKitConsent(data)
        }
        guard let current = try credentialStore.read(),
              current.sessionId == credential.sessionId,
              current.accessToken == credential.accessToken,
              current.athleteId == credential.athleteId,
              current.expiresAt > Date() else {
            return ["path": path, "status": 401, "body": NSNull()]
        }
        return ["path": path, "status": 200, "body": body]
    }

    func uploadHealthKitWorkoutBatch(body: Data, ownerAthleteId: String,
                                     installationId: UUID, batchId: UUID,
                                     eventCount: Int) async throws -> HealthKitWorkoutUploadOutcome {
        try Task.checkCancellation()
        guard HealthKitWorkoutUploader.acceptsBody(body, installationId: installationId,
                                                    batchId: batchId, eventCount: eventCount) else {
            return .rejected
        }
        guard Self.isConfigured, let configuration else { throw NativeAuthFailure.unavailable }
        // A queued batch is bound to the athlete who owned it when it was collected.
        // Never send it under a later login, even if the installation remains the same.
        guard let credential = try credentialStore.read() else {
            return .authenticationRequired
        }
        if credential.expiresAt <= Date() {
            try clearCredential()
            return .authenticationRequired
        }
        guard credential.athleteId == ownerAthleteId else { return .authenticationRequired }
        guard !busy else { throw NativeAuthFailure.unavailable }
        var request = URLRequest(url: configuration.apiURL(HealthKitWorkoutUploader.path))
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        let (status, response) = try await BoundedNativeRequest().send(request)
        if status == 401 {
            // Do not erase a replacement login if logout/sign-in crossed this request.
            if let current = try credentialStore.read(),
               current.sessionId == credential.sessionId,
               current.accessToken == credential.accessToken {
                try clearCredential()
            }
            return .authenticationRequired
        }
        try Task.checkCancellation()
        guard let current = try credentialStore.read(),
              current.sessionId == credential.sessionId,
              current.accessToken == credential.accessToken,
              current.athleteId == ownerAthleteId,
              current.expiresAt > Date() else {
            // The server may have accepted the original request; retain the batch and
            // replay its stable ID under the original owner only after re-authentication.
            return .authenticationRequired
        }
        return try HealthKitWorkoutUploader.outcome(status: status, body: response,
                                                     installationId: installationId,
                                                     batchId: batchId, eventCount: eventCount)
    }

    func healthKitConsent() async throws -> HealthKitConsentState {
        try Task.checkCancellation()
        guard Self.isConfigured, let configuration else { throw NativeAuthFailure.unavailable }
        guard !busy else { throw NativeAuthFailure.unavailable }
        guard let credential = try credentialStore.read() else {
            return .authenticationRequired
        }
        if credential.expiresAt <= Date() {
            try clearCredential()
            return .authenticationRequired
        }
        let (status, data) = try await get("/bff/v1/consents/healthkit", credential: credential,
                                           at: configuration)
        if status == 401 {
            if let current = try credentialStore.read(),
               current.sessionId == credential.sessionId,
               current.accessToken == credential.accessToken {
                try clearCredential()
            }
            return .authenticationRequired
        }
        try Task.checkCancellation()
        guard status == 200 else { throw NativeAuthFailure.unavailable }
        try exactObject(data, keys: ["kind", "granted", "revision"])
        guard let reply = try? JSONDecoder().decode(HealthKitConsentReadReply.self, from: data),
              reply.kind == "healthkit", reply.revision >= 0,
              reply.revision <= 9_007_199_254_740_991 else {
            throw NativeAuthFailure.invalidReply
        }
        guard let current = try credentialStore.read(),
              current.sessionId == credential.sessionId,
              current.accessToken == credential.accessToken,
              current.expiresAt > Date() else {
            return .authenticationRequired
        }
        return reply.granted ? .granted(revision: reply.revision)
                             : .notGranted(revision: reply.revision)
    }

    /** Fixed-path bearer write; no URL, token, or arbitrary body enters from WebView. */
    func writeHealthKitConsent(granted: Bool, expectedRevision: Int,
                               idempotencyKey: String) async throws -> HealthKitConsentWriteOutcome {
        try Task.checkCancellation()
        guard (0...2_147_483_646).contains(expectedRevision),
              idempotencyKey.range(of: "^[A-Za-z0-9_-]{8,128}$", options: .regularExpression) != nil,
              Self.isConfigured, let configuration else { throw NativeAuthFailure.invalidReply }
        guard !busy else { throw NativeAuthFailure.unavailable }
        busy = true
        defer { busy = false }
        guard let credential = try credentialStore.read() else { return .authenticationRequired }
        if credential.expiresAt <= Date() {
            try clearCredential()
            return .authenticationRequired
        }
        var request = URLRequest(url: configuration.apiURL("/bff/v1/consents/healthkit"))
        request.httpMethod = "PUT"
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "granted": granted, "expectedRevision": expectedRevision
        ])
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        let (status, data) = try await BoundedNativeRequest().send(request)
        if status == 401 {
            if let current = try credentialStore.read(),
               current.sessionId == credential.sessionId,
               current.accessToken == credential.accessToken { try clearCredential() }
            return .authenticationRequired
        }
        // Decode an observed commit even after cancellation, so a withdrawal can
        // clear the local collector before the bridge settles the cancelled call.
        guard let current = try credentialStore.read(),
              current.sessionId == credential.sessionId,
              current.accessToken == credential.accessToken,
              current.athleteId == credential.athleteId,
              current.expiresAt > Date() else { return .authenticationRequired }
        if status == 409 {
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let error = object["error"] as? [String: Any],
                  Set(error.keys) == ["code"], error["code"] as? String == "CONSENT_CONFLICT" else {
                throw NativeAuthFailure.invalidReply
            }
            return .conflict
        }
        guard status == 200 else { throw NativeAuthFailure.unavailable }
        let consent = try validateHealthKitConsent(data)
        guard consent["granted"] as? Bool == granted,
              let revision = consent["revision"] as? Int else { throw NativeAuthFailure.invalidReply }
        return .updated(granted: granted, revision: revision)
    }

    func signOut() async throws {
        try Task.checkCancellation()
        guard Self.isConfigured, let configuration else { throw NativeAuthFailure.unavailable }
        guard !busy else { throw NativeAuthFailure.unavailable }
        busy = true
        defer { busy = false }
        guard let credential = try credentialStore.read() else { return }
        if credential.expiresAt <= Date() {
            try clearCredential()
            return
        }
        try await revoke(credential.accessToken, at: configuration)
        // A completed server revoke wins over a concurrent client timeout.
        try clearCredential()
        try Task.checkCancellation()
    }

    private func revoke(_ bearer: String, at configuration: NativeAuthConfiguration) async throws {
        var request = URLRequest(url: configuration.apiURL("/bff/v1/auth/logout"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        let (status, body) = try await BoundedNativeRequest().send(request)
        // A 401 means the bearer is already unusable (for example, back-channel logout).
        // It is safe to clear that credential locally too.
        guard (status == 204 && body.isEmpty) || status == 401 else {
            throw NativeAuthFailure.unavailable
        }
    }

    private func get(_ path: String, credential: NativeCredential,
                     at configuration: NativeAuthConfiguration) async throws -> (Int, Data) {
        var request = URLRequest(url: configuration.apiURL(path))
        request.httpMethod = "GET"
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        return try await BoundedNativeRequest().send(request)
    }

    private struct SessionReadReply: Decodable { let athleteId: String }
    private struct AIConsentReadReply: Decodable {
        let kind: String
        let granted: Bool
        let revision: Int
    }
    private struct HealthKitConsentReadReply: Decodable {
        let kind: String
        let granted: Bool
        let revision: Int
    }

    private func exactObject(_ data: Data, keys: Set<String>) throws {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == keys else { throw NativeAuthFailure.invalidReply }
    }

    @discardableResult
    private func validateSession(_ data: Data, credential: NativeCredential) throws -> String {
        try exactObject(data, keys: ["athleteId"])
        guard let reply = try? JSONDecoder().decode(SessionReadReply.self, from: data),
              reply.athleteId.range(of: "^[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil else {
            throw NativeAuthFailure.invalidReply
        }
        guard reply.athleteId == credential.athleteId else {
            // Never expose a response for a different account under this local credential.
            if let current = try credentialStore.read(),
               current.sessionId == credential.sessionId,
               current.accessToken == credential.accessToken { try clearCredential() }
            throw NativeAuthFailure.invalidReply
        }
        return reply.athleteId
    }

    private func validateAIConsent(_ data: Data) throws -> [String: Any] {
        try exactObject(data, keys: ["kind", "granted", "revision"])
        guard let reply = try? JSONDecoder().decode(AIConsentReadReply.self, from: data),
              reply.kind == "ai", reply.revision >= 0,
              reply.revision <= 9_007_199_254_740_991 else {
            throw NativeAuthFailure.invalidReply
        }
        return ["kind": "ai", "granted": reply.granted, "revision": reply.revision]
    }

    private func validateHealthKitConsent(_ data: Data) throws -> [String: Any] {
        try exactObject(data, keys: ["kind", "granted", "revision"])
        guard let reply = try? JSONDecoder().decode(HealthKitConsentReadReply.self, from: data),
              reply.kind == "healthkit", reply.revision >= 0,
              reply.revision <= 9_007_199_254_740_991 else {
            throw NativeAuthFailure.invalidReply
        }
        return ["kind": "healthkit", "granted": reply.granted, "revision": reply.revision]
    }

    private struct StartReply: Decodable { let location: String }
    private struct ExchangeReply: Decodable {
        let accessToken: String
        let tokenType: String
        let athleteId: String
        let sessionId: String
        let expiresAt: String
    }

    private func post<T: Decodable>(_ url: URL, body: [String: String]) async throws -> T {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        let (status, data) = try await BoundedNativeRequest().send(request)
        guard status == 200,
              let decoded = try? JSONDecoder().decode(T.self, from: data) else {
            throw NativeAuthFailure.unavailable
        }
        return decoded
    }

    private func authorize(_ location: URL) async throws -> URL {
        try Task.checkCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                authenticationContinuation = continuation
                let session = ASWebAuthenticationSession(url: location,
                                                         callbackURLScheme: "org.workoutmanager.app") { callback, error in
                    Task { @MainActor in
                        if let callback {
                            self.completeAuthorization(.success(callback))
                        } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                            self.completeAuthorization(.failure(NativeAuthFailure.cancelled))
                        } else {
                            self.completeAuthorization(.failure(NativeAuthFailure.unavailable))
                        }
                    }
                }
                session.presentationContextProvider = self
                session.prefersEphemeralWebBrowserSession = true
                authenticationSession = session
                if !session.start() {
                    completeAuthorization(.failure(NativeAuthFailure.unavailable))
                }
            }
        } onCancel: {
            Task { @MainActor in
                self.authenticationSession?.cancel()
                self.completeAuthorization(.failure(NativeAuthFailure.cancelled))
            }
        }
    }

    private func completeAuthorization(_ result: Result<URL, Error>) {
        guard let continuation = authenticationContinuation else { return }
        authenticationContinuation = nil
        authenticationSession = nil
        continuation.resume(with: result)
    }

    private static func callbackCode(_ url: URL) throws -> String {
        guard url.scheme == "org.workoutmanager.app", url.host == "auth",
              url.path == "/callback", url.port == nil,
              url.user == nil, url.password == nil, url.fragment == nil,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              items.count == 1 else { throw NativeAuthFailure.invalidReply }
        if items[0].name == "error" {
            throw items[0].value == "cancelled" ? NativeAuthFailure.cancelled : NativeAuthFailure.unavailable
        }
        guard items[0].name == "code", let code = items[0].value,
              code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw NativeAuthFailure.invalidReply
        }
        return code
    }

    private static func base64URL(_ bytes: Data) -> String {
        bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func parseExpiry(_ value: String) -> Date? {
        let milliseconds = ISO8601DateFormatter()
        milliseconds.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return milliseconds.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

extension NativeAuth {
    static func bridgeCode(for error: Error) -> String {
        if error is CancellationError { return "CANCELLED" }
        return (error as? NativeAuthFailure)?.bridgeCode ?? "UNAVAILABLE"
    }
}
