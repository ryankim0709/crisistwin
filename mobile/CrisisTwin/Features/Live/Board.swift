import Foundation

// The crowdsourced task board (ADR 0041, docs/live-reports.md "Task board"). Everything here is
// pure: the phone picks its own questions from the public board on the device, and detects
// road traversals and stalls from location fixes it already has. Nothing in this file sends or
// stores a position.

// MARK: - Wire models

enum BoardQuestionKind: String, Codable, Equatable {
    case roadStatus = "road_status"
    case shelterFull = "shelter_full"
}

enum BoardPlaceKind: String, Codable, Equatable {
    case segment, destination
}

struct BoardPlace: Codable, Equatable {
    var kind: BoardPlaceKind
    var segmentId: String?
    var destinationId: String?
    var name: String
    var coord: LonLat
    /// The segment's polyline; nil for a destination.
    var line: [LonLat]?
    var freeFlowKph: Double?
}

struct BoardItem: Codable, Equatable, Identifiable {
    var taskId: String
    var rank: Int
    var question: BoardQuestionKind
    var place: BoardPlace
    var expiresAt: Date

    var id: String { taskId }
}

/// The server's selection limits; the defaults are the documented constants.
struct BoardLimits: Codable, Equatable {
    /// PASSIVE_RADIUS_M
    var radiusM: Double = 1500
    /// MAX_PASSIVE_QUESTIONS
    var maxQuestions: Int = 3
    /// STALL_S
    var stallS: Double = 120
    /// SLOW_RATIO
    var slowRatio: Double = 0.5

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        radiusM = try c.decodeIfPresent(Double.self, forKey: .radiusM) ?? 1500
        maxQuestions = try c.decodeIfPresent(Int.self, forKey: .maxQuestions) ?? 3
        stallS = try c.decodeIfPresent(Double.self, forKey: .stallS) ?? 120
        slowRatio = try c.decodeIfPresent(Double.self, forKey: .slowRatio) ?? 0.5
    }

    private enum Keys: String, CodingKey { case radiusM, maxQuestions, stallS, slowRatio }
}

/// `GET incidents/{id}/board`. An item with an unknown `question` or `place.kind` (or any other
/// shape this build cannot read) is skipped, never an error.
struct BoardResponse: Decodable, Equatable {
    var incidentId: String?
    var limits: BoardLimits
    var items: [BoardItem]

    init(incidentId: String? = nil, limits: BoardLimits = BoardLimits(), items: [BoardItem] = []) {
        self.incidentId = incidentId
        self.limits = limits
        self.items = items
    }

    private enum Keys: String, CodingKey { case incidentId, limits, items }
    private struct Lossy: Decodable {
        let item: BoardItem?
        init(from decoder: Decoder) throws { item = try? BoardItem(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        incidentId = try c.decodeIfPresent(String.self, forKey: .incidentId)
        limits = (try? c.decode(BoardLimits.self, forKey: .limits)) ?? BoardLimits()
        items = (try c.decodeIfPresent([Lossy].self, forKey: .items) ?? []).compactMap(\.item)
    }
}

// MARK: - Questions shown to the person

enum BoardAnswer: String, Hashable {
    case passable, slow, blocked
    case full, hasSpace
    case yes, no

    var title: String {
        switch self {
        case .passable: return "Passable"
        case .slow: return "Slow"
        case .blocked: return "Blocked"
        case .full: return "Full"
        case .hasSpace: return "Has space"
        case .yes: return "Yes"
        case .no: return "No"
        }
    }
}

/// A selected board item as a one-tap question, or the explicit stall question for a segment.
struct BoardQuestion: Identifiable, Equatable {
    var item: BoardItem
    var isStall = false

    var id: String { item.taskId }

    var title: String {
        if isStall { return "Road ahead blocked?" }
        switch item.question {
        case .roadStatus: return "\(item.place.name): passable?"
        case .shelterFull: return "\(item.place.name): full?"
        }
    }

    var answers: [BoardAnswer] {
        if isStall { return [.yes, .no] }
        switch item.question {
        case .roadStatus: return [.passable, .slow, .blocked]
        case .shelterFull: return [.full, .hasSpace]
        }
    }

    var symbol: String {
        switch item.question {
        case .roadStatus: return isStall ? ReportKind.roadBlocked.systemImage : ReportKind.roadPassable.systemImage
        case .shelterFull: return ReportKind.shelterFull.systemImage
        }
    }

    /// The report an answer sends: always at the place's own coordinate with no accuracy, never
    /// the device position. Nil when the answer sends nothing ("Has space", "No").
    func draft(for answer: BoardAnswer, incidentId: String, at now: Date = Date()) -> ReportDraft? {
        let kind: ReportKind
        var severity: ReportSeverity?
        var destinationId: String?
        switch answer {
        case .passable: kind = .roadPassable
        case .slow: kind = .heavyTraffic; severity = .slow
        case .blocked, .yes: kind = .roadBlocked; severity = .full
        case .full: kind = .shelterFull; destinationId = item.place.destinationId
        case .hasSpace, .no: return nil
        }
        return ReportDraft(
            incidentId: incidentId, kind: kind, severity: severity,
            location: ReportLocation(coord: item.place.coord, accuracyM: nil),
            destinationId: destinationId, taskId: item.taskId, observedAt: now)
    }
}

// MARK: - Geometry (meters, local flat approximation; the distances here are a few km at most)

enum BoardGeo {
    private static let metersPerDegLat = 110_540.0
    private static func metersPerDegLon(at lat: Double) -> Double { 111_320.0 * cos(lat * .pi / 180) }

    private struct XY { var x: Double; var y: Double }

    private static func project(_ p: LonLat, origin: LonLat) -> XY {
        XY(x: (p.lon - origin.lon) * metersPerDegLon(at: origin.lat), y: (p.lat - origin.lat) * metersPerDegLat)
    }

    static func distance(_ a: LonLat, _ b: LonLat) -> Double {
        let p = project(b, origin: a)
        return (p.x * p.x + p.y * p.y).squareRoot()
    }

    private static func distance(_ p: XY, toSegment a: XY, _ b: XY) -> Double {
        let dx = b.x - a.x, dy = b.y - a.y
        let len2 = dx * dx + dy * dy
        var t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0
        t = min(1, max(0, t))
        let ex = p.x - (a.x + t * dx), ey = p.y - (a.y + t * dy)
        return (ex * ex + ey * ey).squareRoot()
    }

    /// Distance from `p` to the polyline `line`; infinity for an empty line.
    static func distance(_ p: LonLat, toLine line: [LonLat]) -> Double {
        guard let first = line.first else { return .infinity }
        if line.count == 1 { return distance(p, first) }
        let origin = p
        let pp = XY(x: 0, y: 0)
        var best = Double.infinity
        for i in 1..<line.count {
            best = min(best, distance(pp, toSegment: project(line[i - 1], origin: origin), project(line[i], origin: origin)))
        }
        return best
    }

    /// Length of the polyline in meters.
    static func length(_ line: [LonLat]) -> Double {
        guard line.count > 1 else { return 0 }
        return (1..<line.count).reduce(0) { $0 + distance(line[$1 - 1], line[$1]) }
    }

    /// The point `fraction` (0...1) of the way along the polyline by length.
    static func point(along line: [LonLat], fraction: Double) -> LonLat? {
        guard let first = line.first else { return nil }
        let total = length(line)
        guard line.count > 1, total > 0 else { return first }
        var remaining = total * min(1, max(0, fraction))
        for i in 1..<line.count {
            let leg = distance(line[i - 1], line[i])
            if remaining <= leg || i == line.count - 1 {
                let t = leg > 0 ? min(1, remaining / leg) : 0
                return LonLat(lon: line[i - 1].lon + (line[i].lon - line[i - 1].lon) * t,
                              lat: line[i - 1].lat + (line[i].lat - line[i - 1].lat) * t)
            }
            remaining -= leg
        }
        return line.last
    }

    /// Points along the polyline no more than `spacingM` apart, ends included.
    static func samples(of line: [LonLat], spacingM: Double) -> [LonLat] {
        guard line.count > 1 else { return line }
        var out = [line[0]]
        for i in 1..<line.count {
            let leg = distance(line[i - 1], line[i])
            let steps = max(1, Int((leg / spacingM).rounded(.up)))
            for s in 1...steps {
                let t = Double(s) / Double(steps)
                out.append(LonLat(lon: line[i - 1].lon + (line[i].lon - line[i - 1].lon) * t,
                                  lat: line[i - 1].lat + (line[i].lat - line[i - 1].lat) * t))
            }
        }
        return out
    }

    static func contains(_ polygon: [[LonLat]], _ p: LonLat) -> Bool {
        guard let outer = polygon.first, ring(outer, contains: p) else { return false }
        return !polygon.dropFirst().contains { ring($0, contains: p) }
    }

    private static func ring(_ ring: [LonLat], contains p: LonLat) -> Bool {
        var inside = false
        var j = ring.count - 1
        for i in 0..<ring.count {
            let a = ring[i], b = ring[j]
            if (a.lat > p.lat) != (b.lat > p.lat),
               p.lon < (b.lon - a.lon) * (p.lat - a.lat) / (b.lat - a.lat) + a.lon {
                inside.toggle()
            }
            j = i
        }
        return inside
    }

    /// 0 when `p` is inside the geometry, else the distance to its nearest edge.
    static func distance(_ p: LonLat, to geometry: LiveGeometry) -> Double {
        var best = Double.infinity
        for polygon in geometry.polygons {
            if contains(polygon, p) { return 0 }
            for ring in polygon where ring.count > 1 {
                best = min(best, distance(p, toLine: ring + [ring[0]]))
            }
        }
        return best
    }
}

// MARK: - Selection on the device

enum BoardSelector {
    /// ON_ROUTE_M: a segment lies on the route when two of its quarter points are this close to it.
    static let onRouteM = 30.0
    /// FIRE_EXCLUSION_M
    static let fireExclusionM = 1000.0

    /// The questions this phone shows, best server rank first, at most `limits.max_questions`.
    /// Keeps items whose segment lies on `route` (the phone's own published route line) or whose
    /// place is within `limits.radiusM` of `device`; drops expired items and any item whose place
    /// or segment is within `fireExclusionM` of the fire estimate (or inside it). The device
    /// position is only compared here; it is never sent.
    static func select(items: [BoardItem], route: [LonLat]?, device: LonLat?, fire: LiveGeometry?,
                       limits: BoardLimits = BoardLimits(), now: Date = Date()) -> [BoardItem] {
        let kept = items.filter { item in
            guard item.expiresAt > now, item.place.coord.isValid else { return false }
            let onRoute = isOnRoute(item, route: route)
            let near = device.map { BoardGeo.distance($0, item.place.coord) <= limits.radiusM } ?? false
            guard onRoute || near else { return false }
            return !nearFire(item, fire: fire)
        }
        return Array(kept.sorted { $0.rank < $1.rank }.prefix(max(0, limits.maxQuestions)))
    }

    static func isOnRoute(_ item: BoardItem, route: [LonLat]?) -> Bool {
        guard let route, route.count > 1, let line = item.place.line, line.count > 1 else { return false }
        let near = [0.25, 0.5, 0.75].filter { fraction in
            BoardGeo.point(along: line, fraction: fraction).map { BoardGeo.distance($0, toLine: route) <= onRouteM } ?? false
        }
        return near.count >= 2
    }

    static func nearFire(_ item: BoardItem, fire: LiveGeometry?) -> Bool {
        guard let fire, !fire.polygons.isEmpty else { return false }
        var points = [item.place.coord]
        if let line = item.place.line { points += BoardGeo.samples(of: line, spacingM: 100) }
        return points.contains { BoardGeo.distance($0, to: fire) <= fireExclusionM }
    }
}

// MARK: - Passive traversal

/// A board segment the phone is watching while it navigates.
struct BoardTracked: Equatable {
    var taskId: String
    var segmentId: String
    var line: [LonLat]
    var freeFlowKph: Double?
    var lengthM: Double

    init?(item: BoardItem) {
        guard item.question == .roadStatus, item.place.kind == .segment,
              let segmentId = item.place.segmentId, let line = item.place.line, line.count > 1 else { return nil }
        taskId = item.taskId
        self.segmentId = segmentId
        self.line = line
        freeFlowKph = item.place.freeFlowKph
        lengthM = BoardGeo.length(line)
    }
}

/// One location fix, as much of it as detection needs.
struct BoardFix: Equatable {
    var coord: LonLat
    var at: Date
    /// m/s from the fix, or nil when the sensor gave none (then it is derived from the last fix).
    var speedMps: Double?
}

/// Detects, per tracked segment, that the phone entered the segment's buffer near one end, stayed
/// in it, and reached the other end, in order and at driving speed. It keeps only each segment's
/// entry end, last position and time, and running distance and time counters: no list of
/// positions, and nothing is persisted. Run it only while the person navigates and has turned on
/// "Share road observations".
struct PassiveTraversal {
    /// SEGMENT_BUFFER_M
    static let bufferM = 40.0
    /// An end counts as reached within twice the buffer.
    static let endM = 80.0
    /// PASSIVE_MIN_SPEED_MPS
    static let minSpeedMps = 4.5
    /// A longer silence inside the buffer ends the traversal; it is not "staying in" the buffer.
    static let maxGapS = 30.0

    struct Traversed: Equatable {
        var taskId: String
        var segmentId: String
        /// When the phone left the segment at its far end.
        var exitedAt: Date
        var meanSpeedMps: Double
        var slow: Bool
    }

    private enum Phase {
        case idle
        /// Inside the buffer without having entered near an end; wait to leave before counting.
        case ignoring
        case inside(Run)
    }

    private struct Run {
        var enteredAtStart: Bool
        var lastCoord: LonLat
        var lastAt: Date
        var distanceM = 0.0
        var durationS = 0.0
    }

    private var tracked: [String: BoardTracked] = [:]
    private var phases: [String: Phase] = [:]
    private var completed: Set<String> = []
    var slowRatio: Double

    init(slowRatio: Double = BoardLimits().slowRatio) { self.slowRatio = slowRatio }

    /// Watches exactly these segments; state for others is dropped.
    mutating func track(_ segments: [BoardTracked]) {
        tracked = Dictionary(segments.map { ($0.taskId, $0) }, uniquingKeysWith: { $1 })
        phases = phases.filter { tracked[$0.key] != nil }
    }

    mutating func reset() {
        tracked = [:]
        phases = [:]
    }

    /// Feeds one fix; returns traversals completed by it (at most once per task).
    mutating func feed(_ fix: BoardFix) -> [Traversed] {
        var events: [Traversed] = []
        for (taskId, seg) in tracked where !completed.contains(taskId) {
            let inside = BoardGeo.distance(fix.coord, toLine: seg.line) <= Self.bufferM
            guard inside else { phases[taskId] = .idle; continue }
            let toStart = BoardGeo.distance(fix.coord, seg.line[0])
            let toEnd = BoardGeo.distance(fix.coord, seg.line[seg.line.count - 1])

            switch phases[taskId] ?? .idle {
            case .idle:
                let nearStart = toStart <= Self.endM, nearEnd = toEnd <= Self.endM
                if nearStart || nearEnd {
                    let atStart = nearStart && (!nearEnd || toStart <= toEnd)
                    phases[taskId] = .inside(Run(enteredAtStart: atStart, lastCoord: fix.coord, lastAt: fix.at))
                } else {
                    phases[taskId] = .ignoring
                }
            case .ignoring:
                break
            case .inside(var run):
                let dt = fix.at.timeIntervalSince(run.lastAt)
                if dt < 0 { break }
                if dt > Self.maxGapS { phases[taskId] = .ignoring; break }
                run.distanceM += BoardGeo.distance(run.lastCoord, fix.coord)
                run.durationS += dt
                run.lastCoord = fix.coord
                run.lastAt = fix.at
                let toFar = run.enteredAtStart ? toEnd : toStart
                // Most of the segment must have been covered, so a short loop at one end is not a pass.
                if toFar <= Self.endM, run.distanceM >= 0.5 * seg.lengthM, run.durationS > 0 {
                    let mean = run.distanceM / run.durationS
                    phases[taskId] = .idle
                    if mean >= Self.minSpeedMps {
                        completed.insert(taskId)
                        let slow = seg.freeFlowKph.map { mean < slowRatio * $0 / 3.6 } ?? false
                        events.append(Traversed(taskId: taskId, segmentId: seg.segmentId, exitedAt: fix.at,
                                                meanSpeedMps: mean, slow: slow))
                    }
                } else {
                    phases[taskId] = .inside(run)
                }
            }
        }
        return events
    }
}

// MARK: - Stall

/// Notices a phone sitting nearly still inside a board segment's buffer for longer than
/// `STALL_S`, so the app can ask one explicit question. It never infers a block. Memory holds
/// one start time per segment.
struct StallDetector {
    /// Below this speed the phone counts as stopped.
    static let stoppedMps = 1.0

    private var tracked: [String: BoardTracked] = [:]
    private var stoppedSince: [String: Date] = [:]
    private var asked: Set<String> = []
    private var lastCoord: LonLat?
    private var lastAt: Date?

    mutating func track(_ segments: [BoardTracked]) {
        tracked = Dictionary(segments.map { ($0.taskId, $0) }, uniquingKeysWith: { $1 })
        stoppedSince = stoppedSince.filter { tracked[$0.key] != nil }
    }

    mutating func reset() {
        tracked = [:]
        stoppedSince = [:]
        lastCoord = nil
        lastAt = nil
    }

    /// Feeds a fix and returns the tasks whose stall question is now due.
    mutating func feed(_ fix: BoardFix, stallS: Double) -> [String] {
        var speed = fix.speedMps.flatMap { $0 >= 0 ? $0 : nil }
        if speed == nil, let c = lastCoord, let t = lastAt, fix.at > t {
            speed = BoardGeo.distance(c, fix.coord) / fix.at.timeIntervalSince(t)
        }
        lastCoord = fix.coord
        lastAt = fix.at
        let stopped = (speed ?? .infinity) < Self.stoppedMps
        for (taskId, seg) in tracked {
            let inside = BoardGeo.distance(fix.coord, toLine: seg.line) <= PassiveTraversal.bufferM
            if inside && stopped {
                if stoppedSince[taskId] == nil { stoppedSince[taskId] = fix.at }
            } else {
                stoppedSince[taskId] = nil
            }
        }
        return due(now: fix.at, stallS: stallS)
    }

    /// Checks without a new fix (a stationary phone may deliver none).
    mutating func due(now: Date, stallS: Double) -> [String] {
        var out: [String] = []
        for (taskId, since) in stoppedSince where !asked.contains(taskId) && now.timeIntervalSince(since) > stallS {
            asked.insert(taskId)
            out.append(taskId)
        }
        return out
    }
}
