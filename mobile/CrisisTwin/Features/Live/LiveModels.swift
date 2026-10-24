import Foundation

/// Wire types for the live reports API. The contract is docs/live-reports.md; keep both in step.
/// JSON keys are snake_case on the wire, so properties use `Id` (not `ID`) to round-trip with
/// `LiveJSON`'s key strategies.

enum LiveIncident {
    static let defaultId = "camp-2018-drill"
    /// The incident of the server this phone joined by link, else the default.
    static var currentId: String { ServerSettings.overrideIncidentId ?? defaultId }
}

enum LiveRole: String, Codable {
    case civilian, responder, controller
}

enum ReportKind: String, Codable, CaseIterable, Identifiable {
    case roadBlocked = "road_blocked"
    case roadPassable = "road_passable"
    case heavyTraffic = "heavy_traffic"
    case fireSeen = "fire_seen"
    case heavySmoke = "heavy_smoke"
    case hazardDown = "hazard_down"
    case shelterFull = "shelter_full"
    case helpNeeded = "help_needed"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .roadBlocked: return "Road blocked"
        case .roadPassable: return "Road passable"
        case .heavyTraffic: return "Heavy traffic"
        case .fireSeen: return "Fire visible"
        case .heavySmoke: return "Heavy smoke"
        case .hazardDown: return "Power line or tree down"
        case .shelterFull: return "Shelter full"
        case .helpNeeded: return "Someone needs help"
        }
    }

    var systemImage: String {
        switch self {
        case .roadBlocked: return "xmark.octagon.fill"
        case .roadPassable: return "checkmark.circle.fill"
        case .heavyTraffic: return "car.2.fill"
        case .fireSeen: return "flame.fill"
        case .heavySmoke: return "smoke.fill"
        case .hazardDown: return "bolt.trianglebadge.exclamationmark.fill"
        case .shelterFull: return "house.fill"
        case .helpNeeded: return "person.fill.questionmark"
        }
    }

    /// Road kinds are snapped to a road segment by the server.
    var isRoadKind: Bool {
        [.roadBlocked, .roadPassable, .heavyTraffic].contains(self)
    }

    /// Whether severity applies to this kind.
    var hasSeverity: Bool {
        [.roadBlocked, .heavyTraffic].contains(self)
    }

    /// `help_needed` is visible to responders and controllers only, never on the public map.
    var canBePublic: Bool { self != .helpNeeded }
}

enum ReportSeverity: String, Codable, CaseIterable, Identifiable {
    case full, partial, slow

    var id: String { rawValue }

    var title: String {
        switch self {
        case .full: return "Fully blocked"
        case .partial: return "One lane or direction"
        case .slow: return "Slow but moving"
        }
    }
}

enum ReportStatus: String, Codable {
    case unverified, corroborated, dismissed, resolved, confirmed
    case responderConfirmed = "responder_confirmed"
    /// The reporter deleted it (`DELETE me/reports/{id}`); closed like `dismissed`.
    case withdrawn
    /// A status this build does not know; decoded instead of failing the whole list.
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ReportStatus(rawValue: raw) ?? .unknown
    }

    var title: String {
        switch self {
        case .unverified: return "Not yet verified"
        case .corroborated: return "Confirmed by others"
        case .responderConfirmed: return "Confirmed by a responder"
        case .confirmed: return "Confirmed by the controller"
        case .dismissed: return "Dismissed"
        case .resolved: return "Resolved"
        case .withdrawn: return "Withdrawn"
        case .unknown: return "Received"
        }
    }

    /// The reporter may edit or withdraw it: nobody with authority has acted on it yet.
    var isEditableByReporter: Bool { self == .unverified || self == .corroborated }
}

/// WGS84 decimal degrees, encoded as `[lon, lat]` like the sim and replay bundle.
struct LonLat: Codable, Equatable, Hashable {
    var lon: Double
    var lat: Double

    var isValid: Bool {
        lon.isFinite && lat.isFinite && (-180...180).contains(lon) && (-90...90).contains(lat)
    }

    init(lon: Double, lat: Double) {
        self.lon = lon
        self.lat = lat
    }

    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        lon = try c.decode(Double.self)
        lat = try c.decode(Double.self)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.unkeyedContainer()
        try c.encode(lon)
        try c.encode(lat)
    }
}

struct ReportLocation: Codable, Equatable {
    var coord: LonLat
    var accuracyM: Double?
}

struct RoadRef: Codable, Equatable, Hashable {
    var segmentId: String
    var name: String
    var snapM: Double?
}

/// What the device sends. `clientId` makes offline retries idempotent.
struct ReportDraft: Codable, Equatable, Identifiable {
    var clientId = UUID()
    var incidentId: String
    var kind: ReportKind
    var severity: ReportSeverity?
    var location: ReportLocation
    var headingDeg: Double?
    var destinationId: String?
    /// Set when a responder answers a check task with this report; the server closes the task.
    var taskId: String?
    var note: String?
    /// Device clock at capture, not at send.
    var observedAt: Date

    var id: UUID { clientId }
}

struct Reporter: Codable, Equatable {
    var role: LiveRole
    var partyKey: String
}

/// A report as the server stores it.
struct FieldReport: Codable, Equatable, Identifiable {
    var id: String
    var clientId: UUID
    var incidentId: String
    var reporter: Reporter
    var kind: ReportKind
    var severity: ReportSeverity?
    var location: ReportLocation
    var headingDeg: Double?
    var roadRef: RoadRef?
    var destinationId: String?
    var taskId: String?
    var observedAt: Date
    var receivedAt: Date
    var note: String?
    var status: ReportStatus
    var evidenceClass: String
    /// Set when the reporter edited it; nil from older servers too.
    var editedAt: Date?
    var withdrawnAt: Date?
}

/// Body of `PATCH me/reports/{id}`: only the fields that changed. A `severity` or `note` set to
/// `.some(nil)` goes out as JSON null, which clears it on the server.
struct ReportPatch: Encodable, Equatable {
    var kind: ReportKind?
    var severity: ReportSeverity??
    var location: ReportLocation?
    var note: String??

    var isEmpty: Bool { kind == nil && severity == nil && location == nil && note == nil }

    private enum CodingKeys: String, CodingKey { case kind, severity, location, note }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(kind, forKey: .kind)
        try c.encodeIfPresent(location, forKey: .location)
        if let severity {
            if let severity { try c.encode(severity, forKey: .severity) } else { try c.encodeNil(forKey: .severity) }
        }
        if let note {
            if let note { try c.encode(note, forKey: .note) } else { try c.encodeNil(forKey: .note) }
        }
    }
}

/// One of this phone's reports opened for editing: an unsent draft (changed on the phone only)
/// or a report the server accepted (changed with `PATCH me/reports/{id}`).
enum ReportEditTarget: Equatable, Identifiable {
    case draft(ReportDraft)
    case report(FieldReport)

    var id: UUID { clientId }

    var clientId: UUID {
        switch self {
        case .draft(let draft): return draft.clientId
        case .report(let report): return report.clientId
        }
    }

    /// The server's report; nil for an unsent draft.
    var report: FieldReport? {
        if case .report(let report) = self { return report }
        return nil
    }

    var kind: ReportKind {
        switch self {
        case .draft(let draft): return draft.kind
        case .report(let report): return report.kind
        }
    }

    var severity: ReportSeverity? {
        switch self {
        case .draft(let draft): return draft.severity
        case .report(let report): return report.severity
        }
    }

    var location: ReportLocation {
        switch self {
        case .draft(let draft): return draft.location
        case .report(let report): return report.location
        }
    }

    var note: String? {
        switch self {
        case .draft(let draft): return draft.note
        case .report(let report): return report.note
        }
    }

    var observedAt: Date {
        switch self {
        case .draft(let draft): return draft.observedAt
        case .report(let report): return report.observedAt
        }
    }

    /// Unsent drafts can always change; sent reports only while unverified or corroborated.
    var isEditable: Bool {
        switch self {
        case .draft: return true
        case .report(let report): return report.status.isEditableByReporter
        }
    }
}

/// One item on the public map (or a nearby "still there?" prompt). Only items that pass the
/// independence rules in docs/live-reports.md are returned to civilians.
struct PublicMapItem: Codable, Equatable, Identifiable {
    var id: String
    var kind: ReportKind
    var severity: ReportSeverity?
    var coord: LonLat
    var roadRef: RoadRef?
    /// The road segment's polyline, `[lon, lat]` pairs, when the item is on a road.
    var line: [LonLat]?
    var independentParties: Int
    var responderReports: Int
    var controllerConfirmed: Bool
    var confidence: Double
    var firstReportedAt: Date
    var lastObservedAt: Date
}

struct ReportsPage: Codable, Equatable {
    var reports: [FieldReport]
    var nextCursor: String
}

struct TaskTarget: Codable, Equatable {
    var segmentId: String?
    var coord: LonLat?
}

enum TaskStatus: String, Codable {
    /// `accepted` is v2: a responder took the task (`POST tasks/{id}` with `{"status":"accepted"}`).
    case open, accepted, done, cancelled
}

/// A controller's request that a responder check something.
struct CheckTask: Codable, Equatable, Identifiable {
    var id: String
    var incidentId: String
    var kind: String  // "verify"
    var target: TaskTarget
    var reportIds: [String]
    var note: String?
    var createdAt: Date
    var status: TaskStatus
    /// v2: responder `party_key`, or nil when any responder may accept it.
    var assignee: String?
    /// The need-help check-in an `assist` task answers.
    var checkinId: String?

    /// Go to a resident who asked for help; closed with `done` instead of a report.
    var isAssist: Bool { kind == "assist" }
}

/// Returned by `POST devices` and `POST incidents/{id}/join`.
struct LiveCredential: Codable, Equatable {
    var token: String
    var role: LiveRole
    var partyKey: String
    var incidentId: String?
}

/// Starting values when the report sheet is opened from a task or a map item.
struct ReportPrefill: Equatable {
    var kind: ReportKind?
    var coord: LonLat?
    var taskId: String?
}

// MARK: - v2: situation, guidance, check-ins (ADR 0012)

/// Polygon or MultiPolygon area, normalized to polygons -> rings -> points. Encodes as GeoJSON
/// `MultiPolygon`. The first ring of each polygon is the exterior; the rest are holes.
struct LiveGeometry: Codable, Equatable {
    var polygons: [[[LonLat]]]

    init(polygons: [[[LonLat]]]) {
        self.polygons = polygons
    }

    private enum CodingKeys: String, CodingKey { case type, coordinates }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "Polygon":
            polygons = [try c.decode([[LonLat]].self, forKey: .coordinates)]
        case "MultiPolygon":
            polygons = try c.decode([[[LonLat]]].self, forKey: .coordinates)
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c, debugDescription: "Expected Polygon or MultiPolygon, got \(other)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode("MultiPolygon", forKey: .type)
        try c.encode(polygons, forKey: .coordinates)
    }
}

/// The served incident. `mode` is "live" for a real incident; anything else is an exercise and
/// shows a small tag (data-integrity floor).
struct IncidentInfo: Codable, Equatable {
    var mode: String
    var name: String?

    var isExercise: Bool { mode != "live" }
}

/// An evacuation zone. The phone finds its own zone on the device (`ZoneLocator`).
struct LiveZone: Codable, Equatable, Identifiable {
    var id: String
    var name: String
    var geometry: LiveGeometry
}

enum GuidanceLevel: String, Codable {
    case evacuateNow = "evacuate_now"
    case beReady = "be_ready"
    case none
}

enum DestinationKind: String, Codable {
    case exit, shelter
    case temporaryRefuge = "temporary_refuge"
}

struct GuidanceDestination: Codable, Equatable, Identifiable {
    var id: String
    var name: String
    var kind: DestinationKind
    var coord: LonLat

    /// The name up to " via ", e.g. "Exit west" for "Exit west via Honey Run Road": the road to
    /// leave by is already in the headline, so the destination never names a second one.
    var shortName: String {
        guard let range = name.range(of: " via ") else { return name }
        let head = name[..<range.lowerBound].trimmingCharacters(in: .whitespaces)
        return head.isEmpty ? name : head
    }
}

extension ZoneGuidance {
    /// The same guidance with the destination named by `shortName`, for views that label it
    /// beside a headline that already names the road out.
    var withShortDestinationName: ZoneGuidance {
        var copy = self
        if let short = destination?.shortName { copy.destination?.name = short }
        return copy
    }
}

struct GuidanceRoute: Codable, Equatable {
    var line: [LonLat]
    /// Up to three road names in route order; `via.first` is the road to leave by.
    var via: [String]
    var distanceM: Double
    /// Free-flow minutes, rounded up.
    var etaMin: Int
    /// How the route relates to the fire estimate; nil from older servers.
    var safety: RouteSafety?
}

/// Route exposure to the fire estimate (contract: "D1 destination choice").
enum RouteSafety: String, Codable, Equatable {
    case clear
    case passesNearFire = "passes_near_fire"
    case passesFire = "passes_fire"
}

/// One destination a person may choose for their zone. The controller's pick has
/// `recommended: true`; the server never offers a destination inside the fire estimate.
struct GuidanceAlternative: Codable, Equatable, Identifiable {
    var destination: GuidanceDestination
    var route: GuidanceRoute
    var safety: RouteSafety
    /// Share of the destination's capacity already heading there, 0...1; nil when unknown.
    var load: Double?
    var recommended: Bool

    var id: String { destination.id }
}

/// `POST me/destination` body and response.
struct DestinationChoiceRequest: Codable, Equatable {
    var zoneId: String
    var destinationId: String
}

struct DestinationChoice: Codable, Equatable {
    var zoneId: String
    var destinationId: String
    var expiresAt: Date
}

enum GuidanceApprover: String, Codable {
    case autoPolicy = "auto_policy"
    case controller
}

/// Published guidance for one zone. A zone without an entry, or with level `none`, has no instruction.
struct ZoneGuidance: Codable, Equatable, Identifiable {
    var zoneId: String
    var level: GuidanceLevel
    var destination: GuidanceDestination?
    var route: GuidanceRoute?
    /// The zone needs to move but no open route exists; `destination` and `route` are nil.
    var noRoute: Bool
    var reason: String
    var reasonCode: String?
    /// Plain-language warning when every option passes the fire; shown as the headline caveat.
    var caveat: String?
    /// The recommended destination plus up to 3 alternatives; nil or empty when there is no choice.
    var alternatives: [GuidanceAlternative]?
    /// Per zone, starts at 1 and increases on every publish.
    var version: Int
    var publishedAt: Date
    var replayAt: Date?
    var approvedBy: GuidanceApprover
    var proposalId: String?

    var id: String { zoneId }

    /// When the guidance was computed, on the incident clock (`Situation.incidentNow`).
    var asOf: Date { replayAt ?? publishedAt }
}

enum FireMethod: String, Codable {
    case satellitePerimeter = "satellite_perimeter"
    case modelNowcast = "model_nowcast"
    case none
}

struct FireObservation: Codable, Equatable {
    var coord: LonLat
    /// Drill time.
    var at: Date
    /// `nist_reconstructed` or `field_report`.
    var source: String
}

/// Current best estimate of where the fire is now (never a forecast). Always show `label`.
struct FireEstimate: Codable, Equatable {
    /// Drill time of the source geometry; nil when `method` is `none`.
    var asOf: Date?
    var method: FireMethod
    var label: String
    var geometry: LiveGeometry?
    var observations: [FireObservation]
    /// `reconstructed`, `simulated` or `none`.
    var evidenceClass: String
}

enum CheckInStatus: String, Codable {
    case out
    case needHelp = "need_help"
    case staying
}

/// Body of `POST incidents/{id}/checkins`. `coord` only with `needHelp`.
struct CheckInRequest: Codable, Equatable {
    var status: CheckInStatus
    var zoneId: String?
    var coord: LonLat?
}

/// The latest check-in for this device.
struct CheckIn: Codable, Equatable, Identifiable {
    var id: String
    var status: CheckInStatus
    var zoneId: String?
    var coord: LonLat?
    var at: Date
    var replayAt: Date?
    /// Where a need-help request stands with the controller; nil for other statuses.
    var help: HelpState?
}

/// `checkin.help`: the controller's handling of a need-help check-in.
struct HelpState: Codable, Equatable {
    enum Status: String, Codable {
        case open, acknowledged, assigned, resolved
    }

    var status: Status
    var assignee: String?
    var taskId: String?
    var updatedAt: Date?
}

/// Response of `POST incidents/{id}/checkins`.
struct CheckInResponse: Codable, Equatable {
    var checkin: CheckIn
}

/// Body of `POST me/location` (responders who opted in; latest position only).
struct ResponderLocationUpdate: Codable, Equatable {
    var coord: LonLat
    var accuracyM: Double?
    var at: Date
}

/// Response of `POST tasks/{id}` in v2.
struct TaskResponse: Codable, Equatable {
    var task: CheckTask
}

/// `GET tasks/{id}/route`: the drive from the responder's shared location to the task target.
/// Computed by the server's road model (`evidence_class: simulated`), never observed.
struct TaskRouteResponse: Codable, Equatable {
    var taskId: String
    var route: TaskRoute?
    /// "unreachable" or "no_origin" when `route` is nil.
    var reason: String?
    /// Short phrase for "No route: <detail>".
    var detail: String?
    /// Drill time of the fire estimate and traffic state the route used.
    var asOf: Date?
}

struct TaskRoute: Codable, Equatable {
    var line: [LonLat]
    var via: [String]
    var distanceM: Int
    var etaMin: Int
    /// "clear" or "near_fire"; never through the fire.
    var exposure: String
    /// "twin" (simulated traffic slows the ETA) or "unavailable" (free-flow).
    var congestion: String

    var nearFire: Bool { exposure == "near_fire" }
    var simulatedTraffic: Bool { congestion == "twin" }
}

/// `GET incidents/{id}/situation`: everything the phone's one screen shows.
struct Situation: Codable, Equatable {
    var incidentId: String
    var generatedAt: Date
    /// Nil from an older server; treated as a real incident.
    var incident: IncidentInfo?
    var zonesVersion: String
    /// Nil when requested with `?zones=0`; keep the cached zones while `zonesVersion` matches.
    var zones: [LiveZone]?
    var guidance: [ZoneGuidance]
    var fire: FireEstimate
    /// Public-map items (confirmed hazards).
    var hazards: [PublicMapItem]
    /// Responders: open and accepted tasks for this device. Civilians: empty.
    var tasks: [CheckTask]
    var myCheckin: CheckIn?
    /// The exercise clock, when one runs. Used only to measure ages; never displayed.
    var drill: DrillClock?

    /// The incident clock at wall time `now`: the exercise clock when one runs, else wall time.
    /// Ages ("12 min ago") are measured against it so drill and wall times never mix.
    func incidentNow(at now: Date = Date()) -> Date {
        guard let drill, let replayNow = drill.replayNow else { return now }
        let rate = drill.running == false ? 0 : (drill.speed ?? 1)
        return replayNow.addingTimeInterval(max(0, now.timeIntervalSince(generatedAt)) * rate)
    }
}

/// `situation.drill`: decoded only to measure ages against the exercise clock.
struct DrillClock: Codable, Equatable {
    var replayNow: Date?
    var speed: Double?
    var running: Bool?
}

/// "just now", "12 min ago", "1 h 5 min ago" from `from` to `to`.
enum RelativeAge {
    static func text(from date: Date, to now: Date) -> String {
        let minutes = Int(max(0, now.timeIntervalSince(date)) / 60)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes) min ago" }
        let hours = minutes / 60, rest = minutes % 60
        return rest == 0 ? "\(hours) h ago" : "\(hours) h \(rest) min ago"
    }
}

/// A change to this device's zone guidance, for a one-time banner and haptic.
struct GuidanceChange: Equatable, Identifiable {
    /// Unique per change, e.g. "<zone_id>#<version>".
    var id: String
    /// The instruction first, e.g. "Evacuate now · Leave via Skyway Road" or "New route: Exit west".
    var message: String
    /// The published reason, shown second when it fits.
    var detail: String?
    /// The new level.
    var level: GuidanceLevel = .none
    /// Same level as before, with a new destination or route.
    var isReroute = false
    /// The level became Evacuate now.
    var isEscalation = false
}

enum LiveJSON {
    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    /// Accepts ISO 8601 with or without fractional seconds.
    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        d.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            let plain = ISO8601DateFormatter()
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = plain.date(from: raw) ?? fractional.date(from: raw) {
                return date
            }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Expected an ISO 8601 date, got \(raw)"))
        }
        return d
    }()
}
