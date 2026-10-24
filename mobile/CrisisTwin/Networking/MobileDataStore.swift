import Foundation
import Security

/// A document in the mobile data store, with the app's own value in `data`.
struct MobileDocument<Value: Decodable>: Decodable, Identifiable {
    let id: String
    let collection: String
    let data: Value
    let createdAt: String
    let updatedAt: String

    var updatedDate: Date? { ServerDate.parse(updatedAt) }
}

enum MobileDataError: LocalizedError {
    case invalidCollection(String)
    case keychainUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidCollection(let name):
            return "“\(name)” is not a valid collection name: use 1-48 lowercase letters, digits or _, starting with a letter."
        case .keychainUnavailable:
            return "This phone could not store its data token securely."
        }
    }
}

/// Pushes and pulls app data to MongoDB Atlas through the CrisisTwin API (`/api/mobile/…`,
/// docs/adr/0029-mobile-data-store.md). The phone never holds an Atlas credential: it registers
/// once for a device token, kept in the Keychain, and sees only its own documents. Values are any
/// `Codable` type; keys go over the wire in snake_case, like every other `BackendClient` call.
actor MobileDataStore {
    static let shared = MobileDataStore()

    private var registration: Task<String, Error>?

    func push<T: Codable>(_ value: T, to collection: String) async throws -> MobileDocument<T> {
        try await call(T.self, "POST", collection, body: Payload(data: value))
    }

    /// Newest first. Pass `updatedAfter` to fetch only what changed since an earlier pull.
    func pull<T: Decodable>(
        _ type: T.Type, from collection: String, limit: Int = 50, updatedAfter: Date? = nil
    ) async throws -> [MobileDocument<T>] {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let updatedAfter {
            // Second precision with a Z offset, so no `+` needs escaping in the query.
            query.append(URLQueryItem(name: "updated_after", value: ISO8601DateFormatter().string(from: updatedAfter)))
        }
        return try await request(Page<T>.self, "GET", collection, query: query).documents
    }

    func fetch<T: Decodable>(_ type: T.Type, id: String, in collection: String) async throws -> MobileDocument<T> {
        try await call(T.self, "GET", "\(collection)/\(id)")
    }

    func replace<T: Codable>(id: String, in collection: String, with value: T) async throws -> MobileDocument<T> {
        try await call(T.self, "PUT", "\(collection)/\(id)", body: Payload(data: value))
    }

    func delete(id: String, in collection: String) async throws {
        try Self.validate(collection)
        try await send("DELETE", "\(collection)/\(id)")
    }

    private struct Payload<T: Encodable>: Encodable {
        let data: T
    }

    private struct Page<T: Decodable>: Decodable {
        let documents: [MobileDocument<T>]
    }

    private func call<T: Decodable>(
        _ type: T.Type, _ method: String, _ path: String, body: (any Encodable)? = nil
    ) async throws -> MobileDocument<T> {
        try await request(MobileDocument<T>.self, method, path, body: body)
    }

    private func request<R: Decodable>(
        _ type: R.Type, _ method: String, _ path: String,
        query: [URLQueryItem] = [], body: (any Encodable)? = nil
    ) async throws -> R {
        try Self.validate(String(path.prefix { $0 != "/" }))
        let client = try BackendClient.configured()
        return try client.decode(R.self, from: try await send(method, path, query: query, body: body))
    }

    /// Sends with the device token, registering first if needed. A 401 means the server no
    /// longer knows this device, so it registers again once and retries.
    @discardableResult
    private func send(
        _ method: String, _ path: String, query: [URLQueryItem] = [], body: (any Encodable)? = nil
    ) async throws -> Data {
        let client = try BackendClient.configured()
        let token = try await deviceToken()
        do {
            return try await client.send(method, "mobile/data/\(path)", query: query, body: body, token: token)
        } catch let error as BackendError where error.status == 401 {
            DeviceTokenKeychain.clear()
            let fresh = try await deviceToken()
            return try await client.send(method, "mobile/data/\(path)", query: query, body: body, token: fresh)
        }
    }

    private func deviceToken() async throws -> String {
        if let token = DeviceTokenKeychain.load() { return token }
        // One registration at a time, even when several calls start together.
        if let registration { return try await registration.value }
        let task = Task<String, Error> {
            struct Registration: Decodable { let deviceToken: String }
            let client = try BackendClient.configured()
            let data = try await client.send("POST", "mobile/devices")
            let token = try client.decode(Registration.self, from: data).deviceToken
            guard DeviceTokenKeychain.save(token) else { throw MobileDataError.keychainUnavailable }
            return token
        }
        registration = task
        defer { registration = nil }
        return try await task.value
    }

    private static func validate(_ collection: String) throws {
        guard collection.wholeMatch(of: /[a-z][a-z0-9_]{0,47}/) != nil else {
            throw MobileDataError.invalidCollection(collection)
        }
    }
}

/// The device token is a secret, kept in the Keychain on this device only.
private enum DeviceTokenKeychain {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "crisistwin.mobile-data",
        kSecAttrAccount as String: "device",
    ]

    static func load() -> String? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String) -> Bool {
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = Data(token.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    static func clear() {
        SecItemDelete(query as CFDictionary)
    }
}
