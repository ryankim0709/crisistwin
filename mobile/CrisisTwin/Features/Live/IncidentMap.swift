import MapKit
import SwiftUI

/// Full-bleed map in three colors: orange for the fire estimate (labeled on its edge with method
/// and age), blue for the way out, red for confirmed blocks. Observed and confirmed facts only;
/// never a forecast, and unverified reports are never drawn. A new guidance version ghosts the
/// old route and draws the new one from the person to the destination (spec, "Motion").
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
    ///   - guidance: the device zone's active guidance; its `route.line` is drawn.
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
    @Environment(AppRouter.self) private var router
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var camera: MapCameraPosition = .region(LiveMap.campRegion)
    @State private var selectedBlock: String?
    /// The guidance (zone and version) the camera was last framed for.
    @State private var framedFor: String?
    /// The route of the guidance version on screen, kept to ghost it when the next one arrives.
    @State private var shownRoute: ShownRoute?
    @State private var ghost: [LonLat] = []
    @State private var drawStart: Date?

    private struct ShownRoute: Equatable {
        var key: String
        var line: [LonLat]
    }

    private static let drawSeconds = 0.6
    private static let ghostSeconds = 1.5

    private var routeLine: [LonLat] {
        guard let guidance, guidance.hasRoute, guidance.level != .none else { return [] }
        return (guidance.route?.line ?? []).filter(\.isValid)
    }

    private var routeKey: String? {
        guidance.map { "\($0.zoneId)#\($0.version)" }
    }

    private static func roundStroke(_ width: CGFloat, dash: [CGFloat] = []) -> StrokeStyle {
        StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round, dash: dash)
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: drawStart == nil)) { context in
            let progress = drawStart.map { min(1, context.date.timeIntervalSince($0) / Self.drawSeconds) } ?? 1
            map(drawn: progress, now: context.date)
        }
        .onChange(of: routeKey, initial: true) { _, key in routeChanged(key) }
        .onChange(of: router.following, initial: true) { _, following in follow(following) }
        .onChange(of: router.focus, initial: true) { _, target in focus(target) }
        .onChange(of: myLocation) { _, _ in followMoved() }
        .onChange(of: camera.positionedByUser) { _, byUser in
            if byUser, router.following { router.following = false }
        }
        .onChange(of: frameKey, initial: true) { _, _ in frame(force: false) }
    }

    private func map(drawn: Double, now: Date) -> some View {
        let fire = situation?.fire
        let firePolygons = fire?.geometry.map(Self.mkPolygons) ?? []
        let blocks = (situation?.hazards ?? []).filter { $0.kind == .roadBlocked && $0.coord.isValid }
        let line = routeLine
        let shown = drawn >= 1 ? line : Array(line.prefix(max(2, Int((Double(line.count) * drawn).rounded(.up)))))
        let route = shown.map(\.clCoordinate)
        let ready = guidance?.level == .beReady
        let dark = colorScheme == .dark
        let edgeDash: [CGFloat] = fire?.method == .satellitePerimeter ? [] : [6, 4]
        let label = fire.flatMap { fireLabel($0, now: now) }

        return Map(position: $camera, interactionModes: [.pan, .zoom, .rotate]) {
            if let zone {
                ForEach(Array(Self.mkPolygons(zone.geometry).enumerated()), id: \.offset) { _, polygon in
                    MapPolygon(polygon)
                        .foregroundStyle(Color.clear)
                        .stroke(Color.primary.opacity(0.35), style: StrokeStyle(lineWidth: 1.5, dash: [2, 4]))
                }
            }

            ForEach(Array(firePolygons.enumerated()), id: \.offset) { _, polygon in
                MapPolygon(polygon)
                    .foregroundStyle(Color.ctFire.opacity(dark ? 0.28 : 0.20))
                    .stroke(Color.ctFire.opacity(0.25), lineWidth: 10)
                MapPolygon(polygon)
                    .foregroundStyle(Color.clear)
                    .stroke(Color.ctFire, style: StrokeStyle(lineWidth: 2, lineJoin: .round, dash: edgeDash))
            }

            if ghost.count > 1 {
                MapPolyline(coordinates: ghost.map(\.clCoordinate))
                    .stroke(Color.ctRoute.opacity(0.3), style: Self.roundStroke(6, dash: [8, 6]))
            }

            if route.count > 1 {
                if ready {
                    MapPolyline(coordinates: route)
                        .stroke(Color.ctRoute, style: Self.roundStroke(6, dash: [8, 6]))
                } else {
                    MapPolyline(coordinates: route)
                        .stroke(Color.ctCasing, style: Self.roundStroke(11))
                    MapPolyline(coordinates: route)
                        .stroke(Color.ctRoute, style: Self.roundStroke(6))
                }
            }

            ForEach(blocks) { item in
                if let line = item.line?.filter(\.isValid), line.count > 1 {
                    let coords = line.map(\.clCoordinate)
                    MapPolyline(coordinates: coords)
                        .stroke(Color.ctCasing, style: Self.roundStroke(9))
                    MapPolyline(coordinates: coords)
                        .stroke(Color.ctHazard, style: Self.roundStroke(4))
                }
            }
            ForEach(blocks) { item in
                Annotation(StillThereRow.title(item), coordinate: item.coord.clCoordinate, anchor: .center) {
                    blockMarker(item)
                }
                .annotationTitles(.hidden)
            }

            if let label {
                Annotation(label.text, coordinate: label.coord.clCoordinate, anchor: .bottom) {
                    Text(label.text)
                        .font(.ctMapLabel)
                        .monospacedDigit()
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .glassEffect(.regular, in: .capsule)
                        .padding(.bottom, 6)
                }
                .annotationTitles(.hidden)
            }

            if let destination = guidance?.destination, destination.coord.isValid, guidance?.hasRoute == true, drawn >= 1 {
                Annotation(destination.shortName, coordinate: destination.coord.clCoordinate, anchor: .center) {
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
        .mapStyle(.standard(elevation: .realistic, emphasis: .muted, pointsOfInterest: .excludingAll))
        .mapControls { MapCompass() }
        .tint(Color.ctRoute)
        .animation(reduceMotion ? nil : .smooth(duration: 0.6), value: fire?.geometry)
    }

    /// "Fire estimate, 12 min" on the fire edge nearest the person (else its first vertex).
    private func fireLabel(_ fire: FireEstimate, now: Date) -> (text: String, coord: LonLat)? {
        guard fire.method != .none, let geometry = fire.geometry,
              let first = geometry.polygons.first?.first?.first(where: \.isValid) else { return nil }
        let method = fire.method == .satellitePerimeter ? "Satellite perimeter" : "Fire estimate"
        let incidentNow = situation?.incidentNow(at: now) ?? now
        let text = fire.asOf.map { "\(method), \(RelativeAge.short(from: $0, to: incidentNow))" } ?? method
        var coord = first
        if let me = myLocation, let nearest = ZoneLocator.nearest(on: geometry, to: me), nearest.meters > 0 {
            coord = nearest.coord
        }
        return (text, coord)
    }

    // MARK: Route draw-on

    /// A new guidance version: the old route turns into a ghost for 1.5 s and the new one draws
    /// from the person to the destination over 600 ms. Reduce Motion swaps at once.
    private func routeChanged(_ key: String?) {
        let line = routeLine
        let previous = shownRoute
        shownRoute = key.map { ShownRoute(key: $0, line: line) }
        guard let previous, previous.key != key, !reduceMotion, line.count > 1 else { return }
        ghost = previous.line
        drawStart = .now
        Task {
            try? await Task.sleep(for: .seconds(Self.drawSeconds))
            drawStart = nil
            try? await Task.sleep(for: .seconds(Self.ghostSeconds - Self.drawSeconds))
            ghost = []
        }
    }

    // MARK: Camera

    /// Changes when there is something new to frame: a new guidance version or the first data.
    private var frameKey: String {
        let g = routeKey ?? zone?.id ?? "none"
        return "\(g)|\(situation == nil ? 0 : 1)|\(myLocation == nil ? 0 : 1)"
    }

    /// Start: the camera pitches to 45 degrees over the person and follows each fix.
    private func follow(_ following: Bool) {
        guard following else { return frame(force: true) }
        if let me = myLocation {
            withAnimation(reduceMotion ? nil : .smooth(duration: 0.8)) {
                camera = .camera(MapCamera(centerCoordinate: me.clCoordinate, distance: 1_400, heading: 0, pitch: 45))
            }
        }
    }

    /// While following, the pitched camera stays centred on each new fix.
    private func followMoved() {
        guard router.following, let me = myLocation else { return }
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.5)) {
            camera = .camera(MapCamera(centerCoordinate: me.clCoordinate, distance: 1_400, heading: 0, pitch: 45))
        }
    }

    /// A responder task: fly to it.
    private func focus(_ target: LonLat?) {
        guard let target, target.isValid else { return }
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.6)) {
            camera = .region(MKCoordinateRegion(center: target.clCoordinate, latitudinalMeters: 900, longitudinalMeters: 900))
        }
        framedFor = frameKey
        router.focus = nil
    }

    /// Frames the route and the device, else the zone, else the fire. Leaves the camera alone
    /// while following, or once framed for this guidance unless `force`.
    private func frame(force: Bool) {
        guard !router.following, router.focus == nil else { return }
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
        return centered.insetBy(dx: -width * 0.15, dy: -height * 0.15)
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

    /// A confirmed block: a white disc with the red octagon; tap for the road name.
    private func blockMarker(_ item: PublicMapItem) -> some View {
        let selected = selectedBlock == item.id
        return Button {
            withAnimation(.snappy(duration: 0.2)) { selectedBlock = selected ? nil : item.id }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "xmark.octagon.fill")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(Color.ctHazard)
                    .frame(width: 30, height: 30)
                    .background(Color.white, in: Circle())
                if selected {
                    Text(StillThereRow.title(item))
                        .font(.ctMapLabel)
                        .lineLimit(1)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .glassEffect(.regular, in: .capsule)
                }
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(StillThereRow.title(item))
    }

    private func destinationMarker(_ destination: GuidanceDestination) -> some View {
        Image(systemName: "signpost.right.fill")
            .font(.system(size: 16, weight: .bold))
            .foregroundStyle(Color.white)
            .frame(width: 36, height: 36)
            .background(Color.ctRoute, in: Circle())
            .overlay(Circle().strokeBorder(Color.ctCasing, lineWidth: 2))
            .accessibilityLabel("Destination: \(destination.shortName)")
    }

    /// The responder's task target: a magnifying glass on glass.
    private func taskMarker(_ task: CheckTask) -> some View {
        Image(systemName: "magnifyingglass")
            .font(.system(size: 15, weight: .bold))
            .frame(width: 36, height: 36)
            .glassEffect(.regular, in: .circle)
            .accessibilityLabel(task.status == .accepted ? "Your task" : "Task to check")
    }
}
