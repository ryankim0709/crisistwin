import CoreLocation
import Foundation
import Observation

/// `GET /api/live`: the simulation a web page is broadcasting. Contract in
/// `app/src/live/contracts.ts`; everything in it is simulated, never an official alert.
/// Coordinates arrive as WGS84 [longitude, latitude] pairs; minutes are simulation minutes from T+0.
struct LiveEnvelope: Decodable {
    let snapshot: LiveSnapshot
    let receivedAt: String
}

struct LiveSnapshot: Decodable, Equatable {
    struct Wind: Decodable, Equatable {
        let fromDegrees: Double
        let speedMph: Double
    }

    struct Fire: Decodable, Equatable {
        let perimeters: [[[Double]]]
        let burnedAreaHa: Double
    }

    struct Agent: Decodable, Equatable {
        let summary: String
        let model: String
        let minute: Double
    }

    let version: Int
    let source: String
    let sessionId: String
    let evidenceClass: String
    let playback: String
    let areaName: String
    let minute: Double
    let horizonMinutes: Double
    let wind: Wind
    let bbox: [Double]?
    let fire: Fire
    let zones: [BroadcastZone]
    let agent: Agent?

    var isDispatch: Bool { source == "dispatch_agent" }

    var fireRings: [[CLLocationCoordinate2D]] { fire.perimeters.map(Geo.coordinates) }

    func zone(containing point: CLLocationCoordinate2D) -> BroadcastZone? {
        zones.first { Geo.contains(Geo.coordinates($0.polygon), point) }
    }

    func fireReaches(_ point: CLLocationCoordinate2D) -> Bool {
        fireRings.contains { Geo.contains($0, point) }
    }

    /// Ground distance from `point` to the nearest simulated fire edge vertex, metres; nil with no fire.
    func distanceToFire(from point: CLLocationCoordinate2D) -> Double? {
        let here = CLLocation(latitude: point.latitude, longitude: point.longitude)
        return fireRings.flatMap { $0 }
            .map { here.distance(from: CLLocation(latitude: $0.latitude, longitude: $0.longitude)) }
            .min()
    }
}

struct BroadcastZone: Decodable, Equatable, Identifiable {
    enum Guidance: String {
        case noOrder = "no_order", leaveNow = "leave_now", wait, routeBlocked = "route_blocked", cleared, overrun
    }

    struct Exit: Decodable, Equatable {
        let id: String
        let name: String
        let road: String
        let location: [Double]

        var coordinate: CLLocationCoordinate2D { Geo.coordinate(location) }

        var directionsURL: URL {
            var components = URLComponents(string: "https://maps.apple.com/")!
            components.queryItems = [
                URLQueryItem(name: "daddr", value: "\(coordinate.latitude),\(coordinate.longitude)"),
                URLQueryItem(name: "q", value: name),
            ]
            return components.url!
        }
    }

    let id: String
    let name: String
    let polygon: [[Double]]
    let guidance: String
    let message: String
    let exit: Exit?
    let route: [[Double]]?
    let driveMin: Double?
    let waitMin: Double?
    let fireEtaMin: Double?
    let fireCoreEtaMin: Double?

    var kind: Guidance? { Guidance(rawValue: guidance) }
    var outline: [CLLocationCoordinate2D] { Geo.coordinates(polygon) }
    var routeLine: [CLLocationCoordinate2D] { route.map(Geo.coordinates) ?? [] }
}

/// Planar geometry on [longitude, latitude], adequate at neighbourhood scale.
enum Geo {
    static func coordinate(_ pair: [Double]) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: pair.count > 1 ? pair[1] : 0, longitude: pair.first ?? 0)
    }

    static func coordinates(_ pairs: [[Double]]) -> [CLLocationCoordinate2D] {
        pairs.filter { $0.count == 2 }.map(coordinate)
    }

    /// Ray casting; the ring may be closed or open.
    static func contains(_ ring: [CLLocationCoordinate2D], _ point: CLLocationCoordinate2D) -> Bool {
        guard ring.count >= 3 else { return false }
        var inside = false
        var j = ring.count - 1
        for i in ring.indices {
            let (xi, yi) = (ring[i].longitude, ring[i].latitude)
            let (xj, yj) = (ring[j].longitude, ring[j].latitude)
            if (yi > point.latitude) != (yj > point.latitude),
               point.longitude < (xj - xi) * (point.latitude - yi) / (yj - yi) + xi {
                inside.toggle()
            }
            j = i
        }
        return inside
    }
}

/// Follows the latest broadcast: pushed over `GET /api/live/stream` (Server-Sent Events from a
/// MongoDB Atlas change stream) when the server offers it, otherwise polled from `GET /api/live`.
/// Older responses never replace newer ones (request ids), and a zone whose exit changes within
/// the same run is remembered so the app can say "route changed".
@MainActor
@Observable
final class BroadcastStore {
    enum State: Equatable {
        case loading
        case notConfigured
        case noBroadcast
        case failed(String)
        case live(LiveSnapshot, receivedAt: Date)
    }

    /// The pages post about every 2 s while playing; older than this, say the feed went quiet.
    static let staleAfter: TimeInterval = 20
    static let pollInterval: Duration = .seconds(3)
    /// After the push stream fails, poll this long before trying it again.
    static let streamRetryAfter: Duration = .seconds(30)

    enum Transport: Equatable {
        case push
        case polling
    }

    /// How updates arrive now; shown so a drill can tell pushed updates from polled ones.
    private(set) var transport: Transport = .polling
    /// Resume token of the last pushed event, so a reconnect gets exactly what it missed.
    private var lastEventId: String?

    private(set) var state: State = .loading
    /// Zone ids whose assigned exit changed during the current run.
    private(set) var redirectedZoneIds: Set<String> = []
    private var lastExitByZone: [String: String] = [:]
    private var lastSessionId: String?
    private var requestId = 0

    var snapshot: LiveSnapshot? {
        if case .live(let snapshot, _) = state { return snapshot }
        return nil
    }

    func refresh() async {
        guard let client = try? BackendClient.configured() else {
            state = .notConfigured
            return
        }
        requestId += 1
        let id = requestId
        do {
            let data = try await client.send("GET", "live")
            let envelope = try client.decode(LiveEnvelope.self, from: data)
            guard id == requestId else { return }
            apply(envelope)
        } catch is CancellationError {
            return
        } catch let error as BackendError where error.status == 404 {
            guard id == requestId else { return }
            state = .noBroadcast
        } catch {
            guard id == requestId else { return }
            // Keep showing the last snapshot through a brief network blip; the age label shows it is old.
            if snapshot == nil { state = .failed(error.localizedDescription) }
        }
    }

    /// Keeps the feed current until the task is cancelled: the push stream while it works, polling
    /// while it does not (an older server, no change streams, or a network drop).
    func follow() async {
        var streamAfter = ContinuousClock.now
        while !Task.isCancelled {
            if ContinuousClock.now >= streamAfter {
                let opened = ContinuousClock.now
                do {
                    try await stream()
                    // The server ends a stream after a few minutes: reconnect at once, unless it
                    // ended straight away (then something in between is not passing it through).
                    if ContinuousClock.now - opened > .seconds(5) { continue }
                    streamAfter = .now + Self.streamRetryAfter
                } catch is CancellationError {
                    return
                } catch {
                    streamAfter = .now + Self.streamRetryAfter
                }
            }
            transport = .polling
            await refresh()
            try? await Task.sleep(for: Self.pollInterval)
        }
    }

    private func stream() async throws {
        // Unconfigured: polling reports it.
        guard let client = try? BackendClient.configured() else { throw BackendError.unexpectedResponse }
        for try await event in client.events("live/stream", lastEventId: lastEventId) {
            if let id = event.id { lastEventId = id }
            switch event.event {
            case "snapshot":
                let envelope = try client.decode(LiveEnvelope.self, from: event.data)
                requestId += 1  // An older poll still in flight must not replace this.
                transport = .push
                apply(envelope)
            case "cleared":
                requestId += 1
                transport = .push
                state = .noBroadcast
            case "error":
                throw BackendError.unexpectedResponse
            default:
                break
            }
        }
    }

    private func apply(_ envelope: LiveEnvelope) {
        guard envelope.snapshot.version == 1, envelope.snapshot.evidenceClass == "simulated" else {
            state = .failed("The simulation feed uses a newer format. Update the app.")
            return
        }
        track(envelope.snapshot)
        state = .live(envelope.snapshot, receivedAt: ServerDate.parse(envelope.receivedAt) ?? .now)
    }

    private func track(_ snapshot: LiveSnapshot) {
        if snapshot.sessionId != lastSessionId {
            lastSessionId = snapshot.sessionId
            lastExitByZone = [:]
            redirectedZoneIds = []
        }
        for zone in snapshot.zones {
            guard let exitId = zone.exit?.id else { continue }
            if let previous = lastExitByZone[zone.id], previous != exitId {
                redirectedZoneIds.insert(zone.id)
            }
            lastExitByZone[zone.id] = exitId
        }
    }
}
