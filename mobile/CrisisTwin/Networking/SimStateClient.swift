import Foundation

/// What the latest Simulation Studio run says a home should do (`docs/sim-state-api.md`).
/// Unrecognised values decode as `.unknown` so a newer server never breaks the card.
enum SimAdviceKind: String, Decodable, Equatable {
    case leaveNow = "leave_now"
    case leaveLater = "leave_later"
    case noOrder = "no_order"
    case cutOff = "cut_off"
    case cleared
    case overrun
    case left
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SimAdviceKind(rawValue: raw) ?? .unknown
    }
}

/// A synthetic home in the published run. Addresses are made up: a real street name with an invented number.
struct SimHome: Decodable, Equatable {
    let homeId: String
    let address: String
    /// WGS84 `[lon, lat]`.
    let coord: [Double]
    let zoneId: String
    let zoneName: String
    /// Only present for lon/lat queries.
    let distanceM: Double?
}

/// `GET /api/sim-state/advice`. Everything in it is simulated; `notice` must be shown.
struct SimAdvice: Decodable, Equatable {
    let evidenceClass: String
    let notice: String
    /// Elapsed simulation minutes from T+0 (not wall-clock). Nil before the first tick.
    let minute: Int?
    /// Server time of the last tick, UTC ISO 8601.
    let updatedAt: String?
    let home: SimHome
    let advice: SimAdviceKind
    let orderMinute: Int?
    let minutesUntilOrder: Int?
    let exitId: String?

    var updatedDate: Date? { updatedAt.flatMap(ServerDate.parse) }
}

/// A home in `GET /api/sim-state/homes` results: the home fields plus its advice.
struct SimHomeAdvice: Decodable, Equatable {
    let homeId: String
    let address: String
    let coord: [Double]
    let zoneId: String
    let zoneName: String
    let advice: SimAdviceKind
    let orderMinute: Int?
    let exitId: String?
}

/// Failures the card shows as their own states.
enum SimStateError: LocalizedError, Equatable {
    /// 404 `no_simulation`: Studio has not published a run.
    case noSimulation
    /// 404 `no_home_nearby`: no synthetic home within 300 m.
    case noHomeNearby

    var errorDescription: String? {
        switch self {
        case .noSimulation: return "No simulation has been published."
        case .noHomeNearby: return "No synthetic home near this address."
        }
    }
}

struct SimStateClient {
    let backend: BackendClient

    static func configured() throws -> SimStateClient {
        SimStateClient(backend: try BackendClient.configured())
    }

    func advice(lon: Double, lat: Double) async throws -> SimAdvice {
        let data = try await get("sim-state/advice", [
            URLQueryItem(name: "lon", value: String(lon)),
            URLQueryItem(name: "lat", value: String(lat)),
        ])
        return try backend.decode(SimAdvice.self, from: data)
    }

    func searchHomes(q: String, limit: Int = 20) async throws -> [SimHomeAdvice] {
        struct Response: Decodable { let homes: [SimHomeAdvice] }
        let data = try await get("sim-state/homes", [
            URLQueryItem(name: "q", value: q),
            URLQueryItem(name: "limit", value: String(limit)),
        ])
        return try backend.decode(Response.self, from: data).homes
    }

    private func get(_ path: String, _ query: [URLQueryItem]) async throws -> Data {
        do {
            return try await backend.send("GET", path, query: query)
        } catch BackendError.http(404, "no_simulation", _) {
            throw SimStateError.noSimulation
        } catch BackendError.http(404, "no_home_nearby", _) {
            throw SimStateError.noHomeNearby
        }
    }
}
