import MapKit
import SwiftUI

/// How a zone with an order is drawn: a soft fill in the level's hue with an edge in that hue;
/// Leave now is clearly stronger than Be ready. Shared with the Map tab's legend.
struct ZoneStyle {
    let fill: Color
    let edge: Color
    let width: CGFloat

    init(level: GuidanceLevel) {
        switch level {
        case .evacuateNow:
            fill = Color.ctDanger.opacity(0.22)
            edge = .ctDanger
            width = 2.5
        case .beReady:
            fill = (GuidanceLevel.beReady.fill ?? .ctWarning).opacity(0.16)
            edge = .ctWarning
            width = 1.25
        case .none:
            fill = .clear
            edge = .clear
            width = 0
        }
    }
}

/// Full-bleed map: the zones being evacuated now (tinted by level), the fire estimate in orange
/// (labeled on the edge facing the person, never over the fire), the way out in blue, and
/// confirmed blocks in red. Observed and confirmed facts only; never a forecast, and unverified
/// reports are never drawn. A new guidance version ghosts the old route and draws the new one
/// from the person to the destination (spec, "Motion").
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
    @Environment(LiveStore.self) private var store
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
    /// The map rect inside the safe area (clear of the drawer and legend) and its size in points,
    /// so the fire label can be placed where it is seen and never over the fire.
    @State private var visibleRect: MKMapRect?
    @State private var mapSize: CGSize = .zero
    /// The fire label's average character width and height, following Dynamic Type.
    @ScaledMetric(relativeTo: .caption) private var labelCharWidth: CGFloat = 7.4
    @ScaledMetric(relativeTo: .caption) private var labelHeight: CGFloat = 32

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

    /// The drive to the responder's accepted task (`GET tasks/{id}/route`), when there is one.
    private var taskRouteLine: [LonLat] {
        guard let task, task.status == .accepted else { return [] }
        return (store.taskRoutes[task.id]?.route?.line ?? []).filter(\.isValid)
    }

    private var routeKey: String? {
        // The destination too: picking another exit (D1) redraws the route and reframes.
        guidance.map { "\($0.zoneId)#\($0.version)#\($0.destination?.id ?? "")" }
    }

    private static func roundStroke(_ width: CGFloat, dash: [CGFloat] = []) -> StrokeStyle {
        StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round, dash: dash)
    }

    var body: some View {
        // Read here so a new track re-evaluates this body, not only the timeline's closure.
        let followedTrack = store.followedTrack
        // The followed simulated person glides between server ticks, so the timeline keeps running
        // while they are on the road (10 frames a second; the route draw-on keeps 30).
        let gliding = followedTrack?.isEnRoute == true
        return TimelineView(.animation(minimumInterval: drawStart == nil ? 1 / 10 : 1 / 30, paused: drawStart == nil && !gliding)) { context in
            let progress = drawStart.map { min(1, context.date.timeIntervalSince($0) / Self.drawSeconds) } ?? 1
            let followed = followedTrack.flatMap { _ in store.followedSample(at: context.date) }
            map(drawn: progress, now: context.date, followedTrack: followedTrack, followed: followed)
                .onChange(of: followed?.coord) { _, coord in followedMoved(coord) }
        }
        .onChange(of: routeKey, initial: true) { _, key in routeChanged(key) }
        .onChange(of: router.following, initial: true) { _, following in follow(following) }
        .onChange(of: store.followedPersonId) { _, _ in if router.following { follow(true) } }
        .onChange(of: router.focus, initial: true) { _, target in focus(target) }
        .onChange(of: myLocation) { _, _ in followMoved() }
        .onChange(of: camera.positionedByUser) { _, byUser in
            if byUser, router.following { router.following = false }
        }
        .onChange(of: frameKey, initial: true) { _, _ in frame(force: false) }
    }

    private func map(drawn: Double, now: Date, followedTrack: DrillTrack?, followed: FollowedSample?) -> some View {
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
        let taskRoute = taskRouteLine.map(\.clCoordinate)

        let ordered = orderedZones
        let otherOptions = alternativeDestinations

        return Map(position: $camera, interactionModes: [.pan, .zoom, .rotate]) {
            // Be ready under Leave now, so the stronger edge is never hidden.
            ForEach(ordered, id: \.key) { entry in
                let style = ZoneStyle(level: entry.level)
                MapPolygon(entry.polygon)
                    .foregroundStyle(style.fill)
                    .stroke(style.edge, style: StrokeStyle(lineWidth: style.width, lineJoin: .round))
            }

            if let zone {
                ForEach(Array(Self.mkPolygons(zone.geometry).enumerated()), id: \.offset) { _, polygon in
                    MapPolygon(polygon)
                        .foregroundStyle(Color.clear)
                        .stroke(Color.ctInk.opacity(0.7), style: StrokeStyle(lineWidth: 1.5, dash: [2, 4]))
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

            // Under the way out, so the evacuation route stays on top; dotted to tell them apart.
            if taskRoute.count > 1 {
                MapPolyline(coordinates: taskRoute)
                    .stroke(Color.ctCasing, style: Self.roundStroke(9))
                MapPolyline(coordinates: taskRoute)
                    .stroke(Color.ctBrand, style: Self.roundStroke(5, dash: [1, 9]))
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
                // Anchored on the edge, extending away from the fire toward the person.
                Annotation(label.text, coordinate: label.coord.clCoordinate, anchor: label.anchor) {
                    Text(label.text)
                        .font(.ctMapLabel)
                        .monospacedDigit()
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .glassEffect(.regular, in: .capsule)
                        .padding(label.pad, 4)
                }
                .annotationTitles(.hidden)
            }

            ForEach(otherOptions) { option in
                Annotation(option.destination.shortName, coordinate: option.destination.coord.clCoordinate, anchor: .center) {
                    Circle()
                        .strokeBorder(Color.ctInkMuted, lineWidth: 2.5)
                        .background(Circle().fill(Color.ctSurface.opacity(0.9)))
                        .frame(width: 14, height: 14)
                        .accessibilityLabel("Other place to go: \(option.destination.shortName)")
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

            // A simulated person of the drill, followed from Home or Map: their whole way out dashed,
            // the part driven so far solid, where they are going, and where they are now.
            if let track = followedTrack {
                if track.path.count > 1 {
                    MapPolyline(coordinates: track.path.map(\.clCoordinate))
                        .stroke(Color.ctBrand.opacity(0.8), style: Self.roundStroke(5, dash: [2, 8]))
                }
                if let followed, followed.travelled.count > 1 {
                    let driven = followed.travelled.map(\.clCoordinate)
                    MapPolyline(coordinates: driven)
                        .stroke(Color.ctCasing, style: Self.roundStroke(10))
                    MapPolyline(coordinates: driven)
                        .stroke(Color.ctBrand, style: Self.roundStroke(6))
                } else if track.path.count < 2, store.followedTrail.count > 1 {
                    // No route yet (still at home, or going back for something): where they have been.
                    let trail = store.followedTrail.map(\.clCoordinate)
                    MapPolyline(coordinates: trail)
                        .stroke(Color.ctBrand, style: Self.roundStroke(4))
                }
                if let destination = track.destination, destination.coord.isValid {
                    Annotation(destination.name ?? "Destination", coordinate: destination.coord.clCoordinate, anchor: .center) {
                        followedDestinationMarker(destination)
                    }
                    .annotationTitles(.hidden)
                }
                if let followed {
                    Annotation(track.label, coordinate: followed.coord.clCoordinate, anchor: .center) {
                        followedMarker(track)
                    }
                    .annotationTitles(.hidden)
                }
            }

            if location.isAuthorized { UserAnnotation() }
        }
        .onMapCameraChange(frequency: .onEnd) { context in visibleRect = context.rect }
        .onGeometryChange(for: CGSize.self) { $0.size } action: { mapSize = $0 }
        .mapStyle(.standard(elevation: .realistic, emphasis: .muted, pointsOfInterest: .excludingAll))
        .mapControls { MapCompass() }
        .tint(Color.ctRoute)
        .animation(reduceMotion ? nil : .smooth(duration: 0.6), value: fire?.geometry)
    }

    private struct FireLabel {
        var text: String
        var coord: LonLat
        var anchor: UnitPoint
        /// The side of the label touching the edge, padded so the capsule clears the stroke.
        var pad: Edge.Set
    }

    /// "Fire estimate, 12 min" on the fire's edge, never over the fire. Candidates are the edge
    /// point nearest the person (on their side first), then the fire's northern, southern,
    /// eastern and western extremes; the first whose on-screen rectangle holds no fire, hides no
    /// marker (the person, blocks, the destination) and sits in the unobstructed part of the map
    /// wins. Before the map has a size, or when
    /// nothing fits, the label goes above the northernmost point.
    private func fireLabel(_ fire: FireEstimate, now: Date) -> FireLabel? {
        guard fire.method != .none, let geometry = fire.geometry else { return nil }
        let exterior = geometry.polygons.compactMap { $0.first }.flatMap { $0 }.filter(\.isValid)
        guard let north = exterior.max(by: { $0.lat < $1.lat }), let south = exterior.min(by: { $0.lat < $1.lat }),
              let east = exterior.max(by: { $0.lon < $1.lon }), let west = exterior.min(by: { $0.lon < $1.lon })
        else { return nil }
        let method = fire.method == .satellitePerimeter ? "Satellite perimeter" : "Fire estimate"
        let incidentNow = situation?.incidentNow(at: now) ?? now
        let text = fire.asOf.map { "\(method), \(RelativeAge.short(from: $0, to: incidentNow))" } ?? method
        let fallback = FireLabel(text: text, coord: north, anchor: .bottom, pad: .bottom)

        var candidates: [(LonLat, UnitPoint)] = []
        if let me = myLocation, let nearest = ZoneLocator.nearest(on: geometry, to: me), nearest.meters > 0 {
            let x: CGFloat = me.lon >= nearest.coord.lon ? 0 : 1, y: CGFloat = me.lat >= nearest.coord.lat ? 1 : 0
            for anchor in [UnitPoint(x: 0.5, y: y), UnitPoint(x: x, y: y), UnitPoint(x: 1 - x, y: y),
                           UnitPoint(x: x, y: 0.5), UnitPoint(x: 0.5, y: 1 - y)] {
                candidates.append((nearest.coord, anchor))
            }
        }
        candidates += [(north, .bottom), (north, .bottomLeading), (north, .bottomTrailing),
                       (south, .top), (south, .topLeading), (south, .topTrailing),
                       (east, .leading), (west, .trailing)]

        guard let visible = visibleRect, mapSize.width > 0, visible.size.width > 0 else { return fallback }
        let perPoint = visible.size.width / mapSize.width  // map points per screen point
        // Estimated capsule: caption semibold, 10 pt side padding, plus the 4 pt gap.
        let size = CGSize(width: (CGFloat(text.count) * labelCharWidth + 28) * perPoint, height: labelHeight * perPoint)
        // `visibleRect` already excludes the safe area (the drawer, legend and bars).
        let usable = visible.insetBy(dx: 8 * perPoint, dy: 8 * perPoint)
        // Markers the label must not hide: the person, confirmed blocks, the destination.
        var markers: [LonLat] = (situation?.hazards ?? []).filter { $0.kind == .roadBlocked }.map(\.coord)
        if let me = myLocation { markers.append(me) }
        if let destination = guidance?.destination?.coord { markers.append(destination) }
        let clearance = 22 * perPoint
        func label(_ coord: LonLat, _ anchor: UnitPoint) -> FireLabel {
            var pad: Edge.Set = []
            if anchor.x == 0 { pad.insert(.leading) } else if anchor.x == 1 { pad.insert(.trailing) }
            if anchor.y == 0 { pad.insert(.top) } else if anchor.y == 1 { pad.insert(.bottom) }
            return FireLabel(text: text, coord: coord, anchor: anchor, pad: pad)
        }
        // Best: in view, off the fire, hiding no marker. Then in view and off the fire. Then in view.
        var offFire: FireLabel?, inView: FireLabel?
        for (coord, anchor) in candidates {
            let p = MKMapPoint(coord.clCoordinate)
            let rect = MKMapRect(x: p.x - anchor.x * size.width, y: p.y - anchor.y * size.height,
                                 width: size.width, height: size.height)
            guard usable.contains(rect) else { continue }
            inView = inView ?? label(coord, anchor)
            // A few points of slack so the edge the label rests on does not count as overlap.
            guard !Self.overlaps(rect.insetBy(dx: 6 * perPoint, dy: 6 * perPoint), geometry, exterior) else { continue }
            offFire = offFire ?? label(coord, anchor)
            let padded = rect.insetBy(dx: -clearance, dy: -clearance)
            if !markers.contains(where: { $0.isValid && padded.contains(MKMapPoint($0.clCoordinate)) }) {
                return label(coord, anchor)
            }
        }
        return offFire ?? inView ?? fallback
    }

    /// Whether the fire reaches into `rect`: a vertex inside it, or a sampled point of it inside the fire.
    private static func overlaps(_ rect: MKMapRect, _ geometry: LiveGeometry, _ exterior: [LonLat]) -> Bool {
        let inner = rect
        if exterior.contains(where: { inner.contains(MKMapPoint($0.clCoordinate)) }) { return true }
        for i in 0...6 {
            for j in 0...2 {
                let point = MKMapPoint(x: inner.minX + inner.size.width * Double(i) / 6,
                                       y: inner.minY + inner.size.height * Double(j) / 2)
                let c = point.coordinate
                if ZoneLocator.contains(geometry, LonLat(lon: c.longitude, lat: c.latitude)) { return true }
            }
        }
        return false
    }

    // MARK: Zones

    private struct ZoneEntry {
        var key: String
        var level: GuidanceLevel
        var polygon: MKPolygon
    }

    /// Zones with an order, Be ready first so Leave now draws on top.
    private var orderedZones: [ZoneEntry] {
        guard let situation, let zones = situation.zones else { return [] }
        let levels = Dictionary(situation.guidance.map { ($0.zoneId, $0.level) }, uniquingKeysWith: { $1 })
        var entries: [ZoneEntry] = []
        for level in [GuidanceLevel.beReady, .evacuateNow] {
            for zone in zones where levels[zone.id] == level {
                for (i, polygon) in Self.mkPolygons(zone.geometry).enumerated() {
                    entries.append(ZoneEntry(key: "\(zone.id)#\(i)", level: level, polygon: polygon))
                }
            }
        }
        return entries
    }

    /// The other places on offer (D1), drawn as small hollow rings.
    private var alternativeDestinations: [GuidanceAlternative] {
        guard let guidance, guidance.hasRoute else { return [] }
        return guidance.exitOptions.filter { $0.id != guidance.destination?.id && $0.destination.coord.isValid }
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
        // Following a simulated person: the camera goes to them, not to the GPS fix.
        if store.followedPersonId != nil {
            if let person = store.followedSample(at: Date()) { moveCamera(to: person.coord, animation: .smooth(duration: 0.8)) }
            return
        }
        if let me = myLocation {
            withAnimation(reduceMotion ? nil : .smooth(duration: 0.8)) {
                camera = .camera(MapCamera(centerCoordinate: me.clCoordinate, distance: 1_400, heading: 0, pitch: 45))
            }
        }
    }

    /// While following, the pitched camera stays centred on each new fix.
    private func followMoved() {
        guard router.following, store.followedPersonId == nil, let me = myLocation else { return }
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.5)) {
            camera = .camera(MapCamera(centerCoordinate: me.clCoordinate, distance: 1_400, heading: 0, pitch: 45))
        }
    }

    /// The followed person moved (a glide step or a new track): the pitched camera stays on them. A
    /// short linear animation per step reads as one continuous move at the glide's 10 frames a second.
    private func followedMoved(_ coord: LonLat?) {
        guard router.following, store.followedPersonId != nil, let coord else { return }
        moveCamera(to: coord, animation: .linear(duration: 0.12))
    }

    private func moveCamera(to coord: LonLat, animation: Animation) {
        guard coord.isValid else { return }
        withAnimation(reduceMotion ? nil : animation) {
            camera = .camera(MapCamera(centerCoordinate: coord.clCoordinate, distance: 2_000, heading: 0, pitch: 45))
        }
    }

    /// A responder task: fly to it, or frame the drive to it when it has a route.
    private func focus(_ target: LonLat?) {
        guard let target, target.isValid else { return }
        let line = target == taskTarget ? taskRouteLine : []
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.6)) {
            if !line.isEmpty, let rect = Self.boundingRect(line + [target]) {
                camera = .rect(rect)
            } else {
                camera = .region(MKCoordinateRegion(center: target.clCoordinate, latitudinalMeters: 900, longitudinalMeters: 900))
            }
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
        // Keep the fire's near side and its label in view.
        // Keep the fire near the person in view (within 10 km of its nearest point), with room
        // for its label.
        if !points.isEmpty, let me = myLocation, let geometry = situation?.fire.geometry,
           let nearest = ZoneLocator.nearest(on: geometry, to: me) {
            let origin = CLLocation(latitude: nearest.coord.lat, longitude: nearest.coord.lon)
            let near = geometry.polygons.compactMap(\.first).flatMap { $0 }.filter {
                $0.isValid && origin.distance(from: CLLocation(latitude: $0.lat, longitude: $0.lon)) <= 10_000
            }
            points.append(nearest.coord)
            if let minLat = near.map(\.lat).min(), let maxLat = near.map(\.lat).max(),
               let minLon = near.map(\.lon).min(), let maxLon = near.map(\.lon).max() {
                points += [LonLat(lon: minLon, lat: minLat), LonLat(lon: maxLon, lat: maxLat)]
            }
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

    /// The followed simulated person: a disc with what they are doing (a car on the road, red when
    /// stuck), and the status above it. The hidden copy of the label below keeps the disc centred on
    /// the coordinate. Simulated: said in the label for VoiceOver.
    private func followedMarker(_ track: DrillTrack) -> some View {
        let symbol: String
        switch track.phase {
        case "en_route": symbol = "car.fill"
        case "out": symbol = "checkmark"
        case "help": symbol = "exclamationmark"
        case "picked_up": symbol = "figure.wave"
        case "home", "packing", "trip", "staying": symbol = "house.fill"
        default: symbol = "person.fill"
        }
        let text = track.status.isEmpty ? track.label : track.status
        let tag = Text(text)
            .font(.ctMapLabel)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
        return VStack(spacing: 4) {
            tag.glassEffect(.regular, in: .capsule)
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(Color.white)
                .frame(width: 34, height: 34)
                .background(track.isStuck ? Color.ctHazard : Color.ctBrand, in: Circle())
                .overlay(Circle().strokeBorder(Color.white, lineWidth: 2.5))
            tag.hidden()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Simulated person \(track.label): \(text)")
    }

    /// Where the followed simulated person is heading.
    private func followedDestinationMarker(_ destination: DrillTrack.Destination) -> some View {
        Image(systemName: "flag.checkered")
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(Color.white)
            .frame(width: 32, height: 32)
            .background(Color.ctBrand, in: Circle())
            .overlay(Circle().strokeBorder(Color.ctCasing, lineWidth: 2))
            .accessibilityLabel("Simulated person's destination: \(destination.name ?? "exit")")
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
