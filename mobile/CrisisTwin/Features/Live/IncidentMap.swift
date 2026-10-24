import MapKit
import SwiftUI

/// Full-bleed map: the device position, the current fire estimate (labeled with method and
/// time), confirmed hazards, and the route for the device's zone. Observed and confirmed facts
/// only; never a forecast.
struct IncidentMap: View {
    let situation: Situation?
    let myLocation: LonLat?
    let guidance: ZoneGuidance?
    let zone: LiveZone?
    let task: CheckTask?
    let taskTarget: LonLat?

    /// - Parameters:
    ///   - situation: latest situation (fire, hazards, zones); nil while loading.
    ///   - myLocation: the device position, drawn but never sent.
    ///   - guidance: the device zone's guidance; its `route.line` is drawn.
    ///   - zone: the device's zone (outlined), known even when it has no guidance.
    ///   - task: the responder's current task (nil for civilians); `taskTarget` is where it points.
    init(situation: Situation?, myLocation: LonLat?, guidance: ZoneGuidance?, zone: LiveZone? = nil,
         task: CheckTask? = nil, taskTarget: LonLat? = nil) {
        self.situation = situation
        self.myLocation = myLocation
        self.guidance = guidance
        self.zone = zone
        self.task = task
        self.taskTarget = taskTarget
    }

    @Environment(LocationProvider.self) private var location
    @Environment(\.incidentActions) private var actions
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var camera: MapCameraPosition = .region(LiveMapView.campRegion)
    @State private var selectedHazard: String?
    /// The guidance (zone and version) the camera was last framed for.
    @State private var framedFor: String?

    /// Most recent observations drawn; older ones add clutter without changing the picture.
    private static let maxObservations = 300

    private var routeLine: [LonLat] {
        guard let line = guidance?.route?.line, guidance?.level != GuidanceLevel.none else { return [] }
        return line.filter(\.isValid)
    }

    private static func roundStroke(_ width: CGFloat, dash: [CGFloat] = []) -> StrokeStyle {
        StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round, dash: dash)
    }

    var body: some View {
        let fire = situation?.fire
        let firePolygons = fire?.geometry.map(Self.mkPolygons) ?? []
        let observations = Array((fire?.observations ?? []).filter(\.coord.isValid)
            .sorted { $0.at > $1.at }.prefix(Self.maxObservations))
        let hazards = (situation?.hazards ?? []).filter(\.coord.isValid)
        let route = routeLine.map(\.clCoordinate)
        let ready = guidance?.level == .beReady
        let fireFill = Color.ctFire.opacity(colorScheme == .dark ? 0.24 : 0.18)

        Map(position: $camera, interactionModes: [.pan, .zoom]) {
            if let zone {
                ForEach(Array(Self.mkPolygons(zone.geometry).enumerated()), id: \.offset) { _, polygon in
                    MapPolygon(polygon)
                        .foregroundStyle(Color.clear)
                        .stroke(Color.ctInk.opacity(0.4), style: StrokeStyle(lineWidth: 2, dash: [5, 4]))
                }
            }

            ForEach(Array(firePolygons.enumerated()), id: \.offset) { _, polygon in
                MapPolygon(polygon)
                    .foregroundStyle(Color.clear)
                    .stroke(Color.ctCasing.opacity(0.6), lineWidth: 4)
                MapPolygon(polygon)
                    .foregroundStyle(fireFill)
                    .stroke(Color.ctFire, lineWidth: 2)
            }
            ForEach(Array(observations.enumerated()), id: \.offset) { _, observation in
                MapCircle(center: observation.coord.clCoordinate, radius: 25)
                    .foregroundStyle(Color.ctFire.opacity(0.6))
            }

            if route.count > 1 {
                if ready {
                    MapPolyline(coordinates: route)
                        .stroke(Color.ctRoute.opacity(0.6), style: Self.roundStroke(6, dash: [8, 6]))
                } else {
                    MapPolyline(coordinates: route)
                        .stroke(Color.ctCasing, style: Self.roundStroke(11))
                    MapPolyline(coordinates: route)
                        .stroke(Color.ctRoute, style: Self.roundStroke(6))
                }
            }

            ForEach(hazards) { item in
                if let line = item.line?.filter(\.isValid), line.count > 1 {
                    let coords = line.map(\.clCoordinate)
                    MapPolyline(coordinates: coords)
                        .stroke(Color.ctCasing, style: Self.roundStroke(8))
                    MapPolyline(coordinates: coords)
                        .stroke(item.kind.tone.color, style: Self.roundStroke(4))
                }
            }
            ForEach(hazards) { item in
                Annotation(item.kind.title, coordinate: item.coord.clCoordinate, anchor: .center) {
                    hazardMarker(item)
                }
                .annotationTitles(.hidden)
            }

            if let destination = guidance?.destination, destination.coord.isValid, guidance?.level != GuidanceLevel.none {
                Annotation(destination.name, coordinate: destination.coord.clCoordinate, anchor: .center) {
                    destinationMarker(destination)
                }
                .annotationTitles(.automatic)
            }

            if let task, let taskTarget, taskTarget.isValid {
                Annotation("Task", coordinate: taskTarget.clCoordinate, anchor: .center) {
                    taskMarker(task)
                }
                .annotationTitles(.hidden)
            }

            if location.isAuthorized { UserAnnotation() }
        }
        .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll, showsTraffic: false))
        .mapControls {}
        .animation(reduceMotion ? nil : .smooth(duration: 0.6), value: fire?.geometry)
        .onChange(of: actions.following, initial: true) { _, following in
            if following {
                withAnimation(reduceMotion ? nil : .smooth(duration: 0.6)) {
                    camera = .userLocation(followsHeading: false, fallback: .automatic)
                }
            } else {
                frame(force: true)
            }
        }
        .onChange(of: camera.positionedByUser) { _, byUser in
            if byUser, actions.following { actions.setFollowing(false) }
        }
        .onChange(of: frameKey, initial: true) { _, _ in frame(force: false) }
    }

    // MARK: Camera

    /// Changes when there is something new to frame: a new guidance version or the first data.
    private var frameKey: String {
        let g = guidance.map { "\($0.zoneId)#\($0.version)" } ?? zone?.id ?? "none"
        return "\(g)|\(situation == nil ? 0 : 1)|\(myLocation == nil ? 0 : 1)"
    }

    /// Frames the route and the device, else the zone, else the fire. Leaves the camera alone
    /// while following, or once framed for this guidance unless `force`.
    private func frame(force: Bool) {
        guard !actions.following else { return }
        guard force || framedFor != frameKey else { return }
        var points = routeLine
        if points.isEmpty, let zone { points = zone.geometry.polygons.flatMap { $0.first ?? [] } }
        if let myLocation, !points.isEmpty { points.append(myLocation) }
        if points.isEmpty, let rings = situation?.fire.geometry?.polygons {
            points = rings.flatMap { $0.first ?? [] }
        }
        guard let rect = Self.boundingRect(points) else { return }
        framedFor = frameKey
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.6)) { camera = .rect(rect) }
    }

    private static func boundingRect(_ points: [LonLat]) -> MKMapRect? {
        let valid = points.filter(\.isValid)
        guard let first = valid.first else { return nil }
        var rect = MKMapRect(origin: MKMapPoint(first.clCoordinate), size: MKMapSize(width: 0, height: 0))
        for point in valid.dropFirst() {
            rect = rect.union(MKMapRect(origin: MKMapPoint(point.clCoordinate), size: MKMapSize(width: 0, height: 0)))
        }
        // At least ~2 km across, plus a margin so markers are not on the edge.
        let minSide = 2_000 * MKMapPointsPerMeterAtLatitude(first.lat)
        let width = max(rect.size.width, minSide)
        let height = max(rect.size.height, minSide)
        let centered = MKMapRect(x: rect.midX - width / 2, y: rect.midY - height / 2, width: width, height: height)
        return centered.insetBy(dx: -width * 0.2, dy: -height * 0.2)
    }

    // MARK: Geometry

    /// One `MKPolygon` per polygon, with holes, so the fill matches the GeoJSON.
    private static func mkPolygons(_ geometry: LiveGeometry) -> [MKPolygon] {
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

    // MARK: Markers

    /// Same visual language as `LiveMapView`'s confirmed markers: tone dot, white ring, kind icon.
    private func hazardMarker(_ item: PublicMapItem) -> some View {
        let tone = item.kind.tone.color
        let selected = selectedHazard == item.id
        return Button {
            withAnimation(.snappy(duration: 0.2)) { selectedHazard = selected ? nil : item.id }
        } label: {
            HStack(spacing: 6) {
                ZStack {
                    Circle().fill(tone)
                    Circle().strokeBorder(Color.white, lineWidth: 2)
                    Image(systemName: item.kind.systemImage)
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(Color.white)
                }
                .frame(width: 30, height: 30)
                .shadow(color: .black.opacity(0.25), radius: 3, y: 1)
                if selected {
                    Text([item.kind.title, item.roadRef?.name].compactMap { $0 }.joined(separator: ", "))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.ctInk)
                        .lineLimit(1)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color.ctSurface, in: Capsule())
                        .overlay(Capsule().strokeBorder(tone.opacity(0.6), lineWidth: 1))
                }
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel([item.kind.title, item.roadRef?.name].compactMap { $0 }.joined(separator: ", "))
    }

    private func destinationMarker(_ destination: GuidanceDestination) -> some View {
        Image(systemName: destination.kind == .exit ? "arrow.up.right" : "flag.fill")
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(Color.ctOnTone)
            .frame(width: 34, height: 34)
            .background(Color.ctRoute, in: Circle())
            .overlay(Circle().strokeBorder(Color.ctCasing, lineWidth: 2.5))
            .shadow(color: .black.opacity(0.25), radius: 3, y: 1)
            .accessibilityLabel("Destination: \(destination.name)")
    }

    /// The responder's task target: an info-tone diamond with a magnifying glass.
    private func taskMarker(_ task: CheckTask) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(HazardTone.info.color)
                .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(Color.white, lineWidth: 2))
                .frame(width: 24, height: 24)
                .rotationEffect(.degrees(45))
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Color.white)
        }
        .frame(width: 34, height: 34)
        .shadow(color: .black.opacity(0.25), radius: 3, y: 1)
        .accessibilityLabel(task.status == .accepted ? "Your task" : "Task to check")
    }
}
