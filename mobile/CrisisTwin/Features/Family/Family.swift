import Foundation
import Observation
import Security

/// A household circle on the server (`/api/families`, docs/adr/0016-resident-live-and-family.md):
/// shared meeting points and each member's status. Status only, never a live location.
struct Family: Decodable, Equatable {
    let id: String
    let name: String
    let joinCode: String
    let primary: MeetingPoint?
    let backup: MeetingPoint?
    let meetingPointsUpdatedAt: String
    let meetingPointsUpdatedBy: String?
    let members: [FamilyMember]

    /// "ABCD-EFGH", easier to read aloud than eight letters in a row.
    var displayJoinCode: String {
        guard joinCode.count == 8 else { return joinCode }
        return "\(joinCode.prefix(4))-\(joinCode.suffix(4))"
    }

    var inviteText: String {
        "Join our CrisisTwin family “\(name)”: open CrisisTwin, go to Family, tap Join and enter code \(displayJoinCode)."
    }
}

struct FamilyMember: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    let status: String
    let statusUpdatedAt: String
    let isMe: Bool

    var memberStatus: MemberStatus { MemberStatus(rawValue: status) ?? .unknown }
}

enum MemberStatus: String, CaseIterable, Identifiable, Encodable {
    case unknown, safe, onTheWay = "on_the_way", atMeetingPoint = "at_meeting_point", needHelp = "need_help"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .unknown: return "No update"
        case .safe: return "Safe"
        case .onTheWay: return "On the way"
        case .atMeetingPoint: return "At meeting point"
        case .needHelp: return "Need help"
        }
    }

    var systemImage: String {
        switch self {
        case .unknown: return "questionmark.circle"
        case .safe: return "checkmark.shield.fill"
        case .onTheWay: return "car.fill"
        case .atMeetingPoint: return "figure.2"
        case .needHelp: return "sos"
        }
    }
}

/// What this phone needs to act as a member. The token is a secret, kept in the Keychain.
private struct Membership: Codable {
    let familyId: String
    let memberId: String
    let memberToken: String
}

private struct MembershipResponse: Decodable {
    let memberId: String
    let memberToken: String
    let family: Family
}

private enum MembershipKeychain {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "crisistwin.family",
        kSecAttrAccount as String: "membership",
    ]

    static func load() -> Membership? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(Membership.self, from: data)
    }

    static func save(_ membership: Membership) -> Bool {
        guard let data = try? JSONEncoder().encode(membership) else { return false }
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    static func clear() {
        SecItemDelete(query as CFDictionary)
    }
}

@MainActor
@Observable
final class FamilyStore {
    static let pollInterval: Duration = .seconds(10)

    private(set) var family: Family?
    private(set) var isWorking = false
    private(set) var errorMessage: String?
    private var membership: Membership?
    private var requestId = 0

    var isJoined: Bool { membership != nil }

    init() {
        membership = MembershipKeychain.load()
    }

    func create(familyName: String, memberName: String) async -> Bool {
        struct Body: Encodable { let familyName: String; let memberName: String }
        return await enroll("families", Body(familyName: familyName, memberName: memberName))
    }

    func join(code: String, memberName: String) async -> Bool {
        struct Body: Encodable { let joinCode: String; let memberName: String }
        return await enroll("families/join", Body(joinCode: code, memberName: memberName))
    }

    func refresh() async {
        await call("GET", "")
    }

    func setStatus(_ status: MemberStatus) async {
        struct Body: Encodable { let status: MemberStatus }
        await call("PUT", "/members/me", body: Body(status: status))
    }

    func setMeetingPoints(primary: MeetingPoint?, backup: MeetingPoint?) async {
        // Explicit nulls: the server requires both keys.
        struct Body: Encodable {
            let primary: MeetingPoint?
            let backup: MeetingPoint?
            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(primary, forKey: .primary)
                try container.encode(backup, forKey: .backup)
            }
            enum CodingKeys: String, CodingKey { case primary, backup }
        }
        await call("PUT", "/meeting-points", body: Body(primary: primary, backup: backup))
    }

    func leave() async {
        guard let membership, let client = try? BackendClient.configured() else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            try await client.send("DELETE", "families/\(membership.familyId)/members/me", token: membership.memberToken)
        } catch let error as BackendError where error.status == 404 {
            // Already gone on the server; forget it here too.
        } catch {
            errorMessage = "Could not leave the family: \(error.localizedDescription)"
            return
        }
        forget(message: nil)
    }

    private func enroll(_ path: String, _ body: some Encodable) async -> Bool {
        guard let client = try? BackendClient.configured() else {
            errorMessage = "Set a valid API_BASE_URL in the Xcode configuration."
            return false
        }
        isWorking = true
        defer { isWorking = false }
        do {
            let data = try await client.send("POST", path, body: body)
            let response = try client.decode(MembershipResponse.self, from: data)
            let next = Membership(familyId: response.family.id, memberId: response.memberId, memberToken: response.memberToken)
            guard MembershipKeychain.save(next) else {
                errorMessage = "Joined, but this phone could not store the membership securely."
                return false
            }
            membership = next
            family = response.family
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Runs an authorized call on this family and stores the returned family.
    private func call(_ method: String, _ suffix: String, body: (any Encodable)? = nil) async {
        guard let membership, let client = try? BackendClient.configured() else { return }
        requestId += 1
        let id = requestId
        do {
            let data = try await client.send(method, "families/\(membership.familyId)\(suffix)", body: body, token: membership.memberToken)
            let next = try client.decode(Family.self, from: data)
            guard id == requestId else { return }
            family = next
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch let error as BackendError where error.status == 404 {
            forget(message: "You are no longer in this family. It may have been deleted.")
        } catch {
            guard id == requestId else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func forget(message: String?) {
        MembershipKeychain.clear()
        membership = nil
        family = nil
        errorMessage = message
    }
}
