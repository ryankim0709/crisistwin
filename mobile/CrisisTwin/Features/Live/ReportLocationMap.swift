import CoreLocation
import MapKit
import SwiftUI

/// The report sheet's minimap: the report pin stays at the centre and the map moves under it.
/// Drag the map, or tap a spot to bring it under the pin. The fire estimate, the person's route
/// and confirmed blocks are drawn for context; the locate button puts the pin back on the person.
struct ReportLocationMap: View {
    /// Where the report will be placed. Setting it from outside recentres the map.
    @Binding var pin: LonLat?
    var here: LonLat?
    var kind: ReportKind?
    var situation: Situation?
    var route: [LonLat]
    /// The person moved the pin (drag or tap).
    var onMove: () -> Void
    /// The locate button.
    var onLocate: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var camera: MapCameraPosition = .region(LiveMap.campRegion)
    /// The last centre this view reported, so the binding echo does not recentre the camera.
    @State private var emitted: LonLat?
    /// A tap asked the camera to move; its end counts as the person's move.
    @State private var tapMove = false
    @State private var lifted = false
    @State private var dropTick = 0
    /// The visible span, kept when recentring so a zoom the person chose survives.
    @State private var span: CLLocationDistance = 700

    var body: some View {
        MapReader { proxy in
            Map(position: $camera, interactionModes: [.pan, .zoom]) {
                context
                UserAnnotation()
            }
            .mapStyle(.standard(emphasis: .muted, pointsOfInterest: .excludingAll))
            .mapControls {}
            .onTapGesture { point in
                guard let tapped = proxy.convert(point, from: .local) else { return }
                tapMove = true
                move(to: tapped)
            }
            .onMapCameraChange(frequency: .continuous) { _ in
                if camera.positionedByUser || tapMove, !lifted {
                    withAnimation(.snappy(duration: 0.18)) { lifted = true }
                }
            }
            .onMapCameraChange(frequency: .onEnd) { context in
                let byPerson = camera.positionedByUser || tapMove
                if byPerson { span = min(5_000, max(200, context.region.span.latitudeDelta * 111_000)) }
                tapMove = false
                if lifted { withAnimation(.snappy(duration: 0.22)) { lifted = false } }
                guard byPerson else { return }
                let center = context.region.center
                let moved = LonLat(lon: center.longitude, lat: center.latitude)
                emitted = moved
                pin = moved
                dropTick += 1
                onMove()
            }
        }
        .overlay { pinMark.allowsHitTesting(false) }
        .overlay(alignment: .bottomTrailing) { locateButton }
        .onChange(of: pin, initial: true) { _, new in recenter(on: new) }
        .sensoryFeedback(.impact(weight: .light), trigger: dropTick)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Report location")
        .accessibilityHint("Drag the map or tap a spot to move the pin")
    }

    // MARK: Context layers

    @MapContentBuilder private var context: some MapContent {
        let dark = colorScheme == .dark
        let firePolygons = situation?.fire.geometry.map(Self.polygons) ?? []
        let blocks = (situation?.hazards ?? []).filter { $0.kind == .roadBlocked }
        let coords = route.filter(\.isValid).map(\.clCoordinate)
        ForEach(Array(firePolygons.enumerated()), id: \.offset) { _, polygon in
            MapPolygon(polygon)
                .foregroundStyle(Color.ctFire.opacity(dark ? 0.28 : 0.20))
                .stroke(Color.ctFire, lineWidth: 1.5)
        }
        if coords.count > 1 {
            MapPolyline(coordinates: coords)
                .stroke(Color.ctCasing, style: StrokeStyle(lineWidth: 8, lineCap: .round, lineJoin: .round))
            MapPolyline(coordinates: coords)
                .stroke(Color.ctRoute, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
        }
        ForEach(blocks) { item in
            if let line = item.line?.filter(\.isValid), line.count > 1 {
                MapPolyline(coordinates: line.map(\.clCoordinate))
                    .stroke(Color.ctHazard, style: StrokeStyle(lineWidth: 4, lineCap: .round))
            }
        }
    }

    // MARK: Pin

    /// A head with the kind's symbol on a short stem; the tip marks the centre of the map. It
    /// lifts while the map moves and settles when it stops.
    private var pinMark: some View {
        let head: CGFloat = 40, stem: CGFloat = 12
        return ZStack {
            Ellipse()
                .fill(Color.black.opacity(lifted ? 0.18 : 0.3))
                .frame(width: lifted ? 14 : 8, height: lifted ? 5 : 3)
            VStack(spacing: 0) {
                Circle()
                    .fill(Color.ctBrand)
                    .overlay {
                        if let kind {
                            Image(systemName: kind.systemImage)
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(Color.ctBackground)
                                .transition(.scale.combined(with: .opacity))
                                .id(kind)
                        } else {
                            Circle().fill(Color.ctBackground).frame(width: 10, height: 10)
                        }
                    }
                    .overlay(Circle().strokeBorder(Color.ctBackground, lineWidth: 2))
                    .frame(width: head, height: head)
                Rectangle()
                    .fill(Color.ctBrand)
                    .frame(width: 3, height: stem)
            }
            .offset(y: -(head + stem) / 2 - (lifted ? 10 : 0))
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder private var locateButton: some View {
        if let here {
            let atHere = pin.map { Self.meters($0, here) < 5 } ?? false
            Button(action: onLocate) {
                Image(systemName: atHere ? "location.fill" : "location")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.ctInk)
                    .frame(width: 44, height: 44)
                    .contentShape(.circle)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .circle)
            .padding(10)
            .accessibilityLabel("Put the pin on my location")
        }
    }

    // MARK: Camera

    private func recenter(on target: LonLat?) {
        guard let target, target.isValid, target != emitted else { return }
        emitted = target
        move(to: target.clCoordinate)
    }

    private func move(to center: CLLocationCoordinate2D) {
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.35)) {
            camera = .region(MKCoordinateRegion(center: center, latitudinalMeters: span, longitudinalMeters: span))
        }
    }

    // MARK: Geometry

    private static func polygons(_ geometry: LiveGeometry) -> [MKPolygon] {
        geometry.polygons.compactMap { rings in
            guard let exterior = rings.first?.filter(\.isValid), exterior.count > 2 else { return nil }
            let holes = rings.dropFirst().compactMap { ring -> MKPolygon? in
                let coords = ring.filter(\.isValid).map(\.clCoordinate)
                return coords.count > 2 ? MKPolygon(coordinates: coords, count: coords.count) : nil
            }
            let coords = exterior.map(\.clCoordinate)
            return MKPolygon(coordinates: coords, count: coords.count, interiorPolygons: holes)
        }
    }

    static func meters(_ a: LonLat, _ b: LonLat) -> Double {
        let dx = (b.lon - a.lon) * 111_320 * cos(a.lat * .pi / 180), dy = (b.lat - a.lat) * 111_320
        return (dx * dx + dy * dy).squareRoot()
    }
}

/// Words for a report's place, from what the phone already knows about the incident's roads.
extension LiveStore {
    /// A road within this distance names the place.
    private static let roadNameM = 60.0

    /// The nearest named road to `point` among the confirmed hazards' road lines and the
    /// server-snapped reports this phone has seen; nil when none is close. Nothing is sent.
    func nearestRoad(to point: LonLat) -> String? {
        var best: (name: String, meters: Double)?
        func consider(_ name: String?, _ meters: Double) {
            guard let name, !name.isEmpty, meters <= Self.roadNameM else { return }
            if best.map({ meters < $0.meters }) ?? true { best = (name, meters) }
        }
        for item in situation?.hazards ?? [] {
            guard let ref = item.roadRef else { continue }
            let line = (item.line ?? []).filter(\.isValid)
            consider(ref.name, line.count > 1
                     ? Self.distance(point, toLine: line) : ReportLocationMap.meters(point, item.coord))
        }
        for report in myReports + allReports {
            consider(report.roadRef?.name, ReportLocationMap.meters(point, report.location.coord))
        }
        return best?.name
    }

    /// "Your location", "180 m north-east of you", or nil without a fix.
    func offsetFromHere(_ point: LonLat) -> String? {
        guard let here = lastCoord else { return nil }
        let meters = ReportLocationMap.meters(here, point)
        if meters < 25 { return "Your location" }
        let distance = Measurement(value: meters, unit: UnitLength.meters)
            .formatted(.measurement(width: .abbreviated, usage: .road))
        return "\(distance) \(ZoneLocator.compassWord(from: here, to: point)) of you"
    }

    /// Point-to-polyline distance in metres (local equirectangular projection).
    private static func distance(_ p: LonLat, toLine line: [LonLat]) -> Double {
        let mx = 111_320 * cos(p.lat * .pi / 180), my = 111_320.0
        func xy(_ c: LonLat) -> (Double, Double) { ((c.lon - p.lon) * mx, (c.lat - p.lat) * my) }
        var best = Double.infinity
        for (a, b) in zip(line, line.dropFirst()) {
            let (ax, ay) = xy(a), (bx, by) = xy(b)
            let dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy
            let t = len2 > 0 ? max(0, min(1, -(ax * dx + ay * dy) / len2)) : 0
            let x = ax + t * dx, y = ay + t * dy
            best = min(best, (x * x + y * y).squareRoot())
        }
        return best
    }
}
