import MapKit
import SwiftUI

/// Full-bleed map: the device position, the current fire estimate (labeled with method and
/// time), confirmed hazards, and the route for the device's zone. Observed and confirmed facts
/// only; never a forecast.
struct IncidentMap: View {
    let situation: Situation?
    let myLocation: LonLat?
    let guidance: ZoneGuidance?

    /// - Parameters:
    ///   - situation: latest situation (fire, hazards, zones); nil while loading.
    ///   - myLocation: the device position, drawn but never sent.
    ///   - guidance: the device zone's guidance; its `route.line` is drawn.
    init(situation: Situation?, myLocation: LonLat?, guidance: ZoneGuidance?) {
        self.situation = situation
        self.myLocation = myLocation
        self.guidance = guidance
    }

    @Environment(LocationProvider.self) private var location
    @Environment(\.incidentActions) private var actions
    @State private var camera: MapCameraPosition = .region(LiveMapView.campRegion)
    @State private var selectedHazard: String?
    @State private var fireExpanded = false
    /// The guidance (zone and version) the camera was last framed for.
    @State private var framedFor: String?

    /// Most recent observations drawn; older ones add clutter without changing the picture.
    private static let maxObservations = 300

    private var zone: LiveZone? {
        guard let id = guidance?.zoneId else { return nil }
        return situation?.zones?.first { $0.id == id }
    }

    private var routeLine: [LonLat] {
        guard let line = guidance?.route?.line, guidance?.level != GuidanceLevel.none else { return [] }
        return line.filter(\.isValid)
    }

    var body: some View {
        let fire = situation?.fire
        let firePolygons = fire?.geometry.map(Self.mkPolygons) ?? []
        let observations = Array((fire?.observations ?? []).filter(\.coord.isValid)
            .sorted { $0.at > $1.at }.prefix(Self.maxObservations))
        let hazards = (situation?.hazards ?? []).filter(\.coord.isValid)
        let route = routeLine.map(\.clCoordinate)

        Map(position: $camera, interactionModes: [.pan, .zoom]) {
            if let zone {
                ForEach(Array(Self.mkPolygons(zone.geometry).enumerated()), id: \.offset) { _, polygon in
                    MapPolygon(polygon)
                        .foregroundStyle(Color.ctBrand.opacity(0.06))
                        .stroke(Color.ctBrand.opacity(0.55), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                }
            }

            ForEach(Array(firePolygons.enumerated()), id: \.offset) { _, polygon in
                MapPolygon(polygon)
                    .foregroundStyle(HazardTone.danger.color.opacity(0.22))
                    .stroke(HazardTone.danger.color, lineWidth: 2)
            }
            ForEach(Array(observations.enumerated()), id: \.offset) { _, observation in
                MapCircle(center: observation.coord.clCoordinate, radius: 30)
                    .foregroundStyle(HazardTone.danger.color.opacity(0.85))
                    .stroke(Color.white.opacity(0.9), lineWidth: 1)
            }

            if route.count > 1 {
                MapPolyline(coordinates: route)
                    .stroke(Color.ctSurface, style: StrokeStyle(lineWidth: 10, lineCap: .round, lineJoin: .round))
                MapPolyline(coordinates: route)
                    .stroke(Color.ctBrand, style: StrokeStyle(
                        lineWidth: 6, lineCap: .round, lineJoin: .round,
                        dash: guidance?.level == .beReady ? [8, 6] : []))
            }

            ForEach(hazards) { item in
                if let line = item.line?.filter(\.isValid), line.count > 1 {
                    let coords = line.map(\.clCoordinate)
                    MapPolyline(coordinates: coords)
                        .stroke(Color.ctSurface, style: StrokeStyle(lineWidth: 9, lineCap: .round, lineJoin: .round))
                    MapPolyline(coordinates: coords)
                        .stroke(item.kind.tone.color, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
                }
            }
            ForEach(hazards) { item in
                Annotation(item.kind.title, coordinate: item.coord.clCoordinate, anchor: .center) {
                    hazardMarker(item)
                }
                .annotationTitles(.hidden)
            }

            if let fire, fire.method != .none, let anchor = Self.labelAnchor(firePolygons) {
                Annotation(fire.label, coordinate: anchor, anchor: .center) {
                    fireChip(fire)
                }
                .annotationTitles(.hidden)
            }

            if let destination = guidance?.destination, destination.coord.isValid, guidance?.level != GuidanceLevel.none {
                Annotation(destination.name, coordinate: destination.coord.clCoordinate, anchor: .bottom) {
                    destinationMarker(destination)
                }
            }

            if location.isAuthorized { UserAnnotation() }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .mapControls {}
        .onChange(of: actions.following, initial: true) { _, following in
            if following {
                withAnimation { camera = .userLocation(followsHeading: false, fallback: .automatic) }
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
        let g = guidance.map { "\($0.zoneId)#\($0.version)" } ?? "none"
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
        withAnimation(.easeInOut(duration: 0.6)) { camera = .rect(rect) }
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

    /// Where the fire label sits: the center of the largest fire polygon's bounding box.
    private static func labelAnchor(_ polygons: [MKPolygon]) -> CLLocationCoordinate2D? {
        guard let largest = polygons.max(by: {
            $0.boundingMapRect.size.width * $0.boundingMapRect.size.height
                < $1.boundingMapRect.size.width * $1.boundingMapRect.size.height
        }) else { return nil }
        let rect = largest.boundingMapRect
        return MKMapPoint(x: rect.midX, y: rect.midY).coordinate
    }

    // MARK: Markers

    /// The fire estimate's method and time. Tap for its evidence.
    private func fireChip(_ fire: FireEstimate) -> some View {
        Button {
            withAnimation(.snappy(duration: 0.2)) { fireExpanded.toggle() }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Label(fire.label, systemImage: "flame.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.ctInk)
                if fireExpanded {
                    Text(fire.evidenceClass == "simulated"
                         ? "Fire model fitted to observations. Not a forecast."
                         : "Reconstructed from observations. Not a forecast.")
                        .font(.caption2)
                        .foregroundStyle(Color.ctMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .labelStyle(FireLabelStyle())
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(maxWidth: 220, alignment: .leading)
            .background(Color.ctSurface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(HazardTone.danger.color.opacity(0.7), lineWidth: 1))
            .shadow(color: .black.opacity(0.15), radius: 4, y: 1)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(fire.label)
        .accessibilityHint("Shows how the estimate was made")
    }

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
            .foregroundStyle(Color(light: 0xFFFFFF, dark: 0x0E1A16))
            .frame(width: 32, height: 32)
            .background(Color.ctBrand, in: Circle())
            .overlay(Circle().strokeBorder(Color.white, lineWidth: 2))
            .shadow(color: .black.opacity(0.25), radius: 3, y: 1)
            .accessibilityLabel("Destination: \(destination.name)")
    }
}

/// Icon tinted with the danger tone, title in ink.
private struct FireLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) {
            configuration.icon.foregroundStyle(HazardTone.danger.color)
            configuration.title
        }
    }
}
