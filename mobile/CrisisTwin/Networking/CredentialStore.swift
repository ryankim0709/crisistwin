import Foundation
import Security

/// Keeps live credentials in the Keychain, available after first unlock and never synced or
/// backed up to another device. The civilian device credential and the responder credential
/// live in separate slots, so leaving the responder role falls back to the device one.
enum CredentialStore {
    enum Slot: String {
        case device, responder
    }

    private static let service = "\(Bundle.main.bundleIdentifier ?? "CrisisTwin").live-credential"

    static func load(_ slot: Slot) -> LiveCredential? {
        var query = baseQuery(slot)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? LiveJSON.decoder.decode(LiveCredential.self, from: data)
    }

    @discardableResult
    static func save(_ credential: LiveCredential, slot: Slot) -> Bool {
        guard let data = try? LiveJSON.encoder.encode(credential) else { return false }
        let update = SecItemUpdate(
            baseQuery(slot) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return true }
        guard update == errSecItemNotFound else { return false }
        var add = baseQuery(slot)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func delete(_ slot: Slot) {
        SecItemDelete(baseQuery(slot) as CFDictionary)
    }

    private static func baseQuery(_ slot: Slot) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: slot.rawValue,
        ]
    }
}
