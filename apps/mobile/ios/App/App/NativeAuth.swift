import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

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

    func send(_ request: URLRequest) async throws -> (Int, Data) {
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
            session.dataTask(with: request).resume()
        }
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
        let result: Result<(Int, Data), Error>
        if error != nil || response == nil {
            result = .failure(NativeAuthFailure.unavailable)
        } else {
            result = .success((response?.statusCode ?? 0, body))
        }
        completion?(result)
        completion = nil
        self.session?.finishTasksAndInvalidate()
        self.session = nil
    }
}

@MainActor
final class NativeAuth: NSObject, ASWebAuthenticationPresentationContextProviding {
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

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }

    func signIn() async throws -> [String: String] {
        guard Self.isConfigured, let configuration else { throw NativeAuthFailure.unavailable }
        guard !busy else { throw NativeAuthFailure.unavailable }
        busy = true
        defer { busy = false }
        if let existing = try credentialStore.read() {
            if existing.expiresAt > Date() { throw NativeAuthFailure.unavailable }
            try credentialStore.delete()
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
        guard let location = URL(string: start.location), configuration.acceptsIdP(location) else {
            throw NativeAuthFailure.invalidReply
        }
        let callback = try await authorize(location)
        let code = try Self.callbackCode(callback)
        let exchanged: ExchangeReply = try await post(
            configuration.apiURL("/bff/v1/auth/native/exchange"),
            body: ["code": code, "codeVerifier": verifier])
        guard exchanged.tokenType == "Bearer",
              exchanged.accessToken.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              exchanged.athleteId.range(of: "^[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil,
              !exchanged.sessionId.isEmpty,
              let expiry = Self.parseExpiry(exchanged.expiresAt),
              expiry > Date(), expiry <= Date().addingTimeInterval(28_800) else {
            throw NativeAuthFailure.invalidReply
        }
        let credential = NativeCredential(accessToken: exchanged.accessToken,
                                          athleteId: exchanged.athleteId,
                                          sessionId: exchanged.sessionId,
                                          expiresAt: expiry,
                                          apiOrigin: configuration.apiOrigin.absoluteString)
        do {
            try credentialStore.save(credential)
        } catch {
            // A successful exchange must not strand an active bearer when persistence fails.
            try? await revoke(exchanged.accessToken, at: configuration)
            throw NativeAuthFailure.unavailable
        }
        return credential.publicSession
    }

    func currentSession() throws -> [String: String] {
        guard Self.isConfigured else { throw NativeAuthFailure.unavailable }
        guard !busy else { throw NativeAuthFailure.unavailable }
        guard let credential = try credentialStore.read() else { return ["state": "signed_out"] }
        if credential.expiresAt <= Date() {
            try credentialStore.delete()
            return ["state": "signed_out"]
        }
        return credential.publicSession
    }

    func signOut() async throws {
        guard Self.isConfigured, let configuration else { throw NativeAuthFailure.unavailable }
        guard !busy else { throw NativeAuthFailure.unavailable }
        busy = true
        defer { busy = false }
        guard let credential = try credentialStore.read() else { return }
        if credential.expiresAt <= Date() {
            try credentialStore.delete()
            return
        }
        try await revoke(credential.accessToken, at: configuration)
        try credentialStore.delete()
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
        (error as? NativeAuthFailure)?.bridgeCode ?? "UNAVAILABLE"
    }
}
