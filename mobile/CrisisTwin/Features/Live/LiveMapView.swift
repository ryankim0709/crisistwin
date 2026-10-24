import MapKit
import SwiftUI

extension ReportKind {
    /// The kind to report when someone confirms the item is still there.
    var stillThereKind: ReportKind { self }

    /// The kind to report when the item is gone. Road kinds flip; others have no direct opposite.
    var goneKind: ReportKind? {
        switch self {
        case .roadBlocked, .heavyTraffic: return .roadPassable
        case .roadPassable: return .roadBlocked
        default: return nil
        }
    }
}

extension LonLat {
    var clCoordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: lat, longitude: lon) }
}

/// The live map: independently confirmed public items for everyone, plus raw reports for responders.
struct LiveMapView: View {
    var onReport: (ReportPrefill?) -> Void = { _ in }

    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @State private var camera: MapCameraPosition = .region(Self.campRegion)
    @State private var selectedId: String?
    /// Names sit beside markers once zoomed in enough that they no longer crowd each other.
    @State private var showsLabels = false

    /// The P0 drill area around Paradise, CA; also the report sheet's starting region.
    static let campRegion = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 39.76, longitude: -121.60),
        latitudinalMeters: 6_000, longitudinalMeters: 6_000)

    private struct Entry: Identifiable {
        let id: String
        let kind: ReportKind
        let severity: ReportSeverity?
        let coord: LonLat
        let road: String?
        let line: [LonLat]?
        let lastSeen: Date
        let confirmation: [String]
        /// Shown on responder-only items, for example "Unverified".
        let badge: String?
    }

    private var entries: [Entry] {
        var result = store.publicItems.compactMap { item -> Entry? in
            guard item.coord.isValid else { return nil }
            var lines = ["Confirmed by \(item.independentParties) independent \(item.independentParties == 1 ? "person" : "people")"]
            if item.responderReports > 0 { lines.append("A responder has also reported this") }
            if item.controllerConfirmed { lines.append("Confirmed by the incident controller") }
            return Entry(id: item.id, kind: item.kind, severity: item.severity, coord: item.coord,
                         road: item.roadRef?.name, line: item.line, lastSeen: item.lastObservedAt,
                         confirmation: lines, badge: nil)
        }
        if store.role != .civilian {
            let shown = Set(result.map(\.id))
            result += store.allReports.compactMap { report -> Entry? in
                guard report.location.coord.isValid, !shown.contains(report.id),
                      report.status != .dismissed, report.status != .resolved else { return nil }
                return Entry(id: report.id, kind: report.kind, severity: report.severity,
                             coord: report.location.coord, road: report.roadRef?.name, line: nil,
                             lastSeen: report.observedAt, confirmation: ["Status: \(report.status.title)"],
                             badge: report.status == .unverified ? "Unverified" : report.status.title)
            }
        }
        return result
    }

    var body: some View {
        let entries = entries
        let selected = entries.first(where: { $0.id == selectedId })
        Map(position: $camera) {
            if location.isAuthorized { UserAnnotation() }
            ForEach(entries) { entry in
                if let line = entry.line, line.count > 1 {
                    let coords = line.map(\.clCoordinate)
                    // A light casing under the tone stroke keeps the road readable on any basemap.
                    MapPolyline(coordinates: coords)
                        .stroke(Color.ctSurface, style: StrokeStyle(lineWidth: 9, lineCap: .round, lineJoin: .round))
                    MapPolyline(coordinates: coords)
                        .stroke(entry.kind.tone.color, style: StrokeStyle(
                            lineWidth: 5, lineCap: .round, lineJoin: .round, dash: entry.badge == nil ? [] : [6, 6]))
                }
                Annotation(entry.kind.title, coordinate: entry.coord.clCoordinate, anchor: .center) {
                    marker(entry, isSelected: entry.id == selectedId, showsLabel: showsLabels || entry.id == selectedId)
                }
                .annotationTitles(.hidden)
            }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .onMapCameraChange { context in
            let zoomedIn = context.region.span.latitudeDelta < 0.03
            if zoomedIn != showsLabels { withAnimation(.easeOut(duration: 0.2)) { showsLabels = zoomedIn } }
        }
        .mapControls { MapCompass(); MapUserLocationButton(); MapScaleView() }
        .overlay(alignment: .bottom) {
            Group {
                if let selected {
                    detailCard(selected)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                } else {
                    footer(isEmpty: entries.isEmpty)
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .animation(.snappy(duration: 0.25), value: selectedId)
        }
    }

    /// A compact tone-colored dot with the kind's icon. The name appears beside it when selected or
    /// zoomed in;
    /// VoiceOver always reads it, and the icon differs per kind so color is never the only signal.
    private func marker(_ entry: Entry, isSelected: Bool, showsLabel: Bool) -> some View {
        let tone = entry.kind.tone.color
        let unconfirmed = entry.badge != nil
        return Button {
            withAnimation(.snappy(duration: 0.25)) {
                selectedId = entry.id == selectedId ? nil : entry.id
            }
        } label: {
            HStack(spacing: 6) {
                ZStack {
                    Circle()
                        .fill(unconfirmed ? Color.ctSurface : tone)
                    Circle()
                        .strokeBorder(unconfirmed ? tone : Color.white,
                                      style: StrokeStyle(lineWidth: 2, dash: unconfirmed ? [3, 2.5] : []))
                    Image(systemName: entry.kind.systemImage)
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(unconfirmed ? tone : Color.white)
                }
                .frame(width: isSelected ? 36 : 30, height: isSelected ? 36 : 30)
                .shadow(color: .black.opacity(0.25), radius: 3, y: 1)

                if showsLabel {
                    Text(entry.badge.map { "\(entry.kind.title) (\($0))" } ?? entry.kind.title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.ctInk)
                        .lineLimit(1)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color.ctSurface, in: Capsule())
                        .overlay(Capsule().strokeBorder(tone.opacity(0.6), lineWidth: 1))
                        .shadow(color: .black.opacity(0.12), radius: 3, y: 1)
                }
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityText(entry))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityHint("Shows details")
    }

    private func accessibilityText(_ entry: Entry) -> String {
        [entry.kind.title, entry.road, entry.badge].compactMap { $0 }.joined(separator: ", ")
    }

    private func detailCard(_ entry: Entry) -> some View {
        let tone = entry.kind.tone
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: entry.kind.systemImage)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(tone.color)
                    .frame(width: 44, height: 44)
                    .background(tone.color.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.kind.title)
                        .font(.headline)
                        .foregroundStyle(Color.ctInk)
                    if let road = entry.road {
                        Text(road).font(.subheadline).foregroundStyle(Color.ctMuted)
                    }
                }
                Spacer(minLength: 0)
                Button {
                    withAnimation(.snappy(duration: 0.25)) { selectedId = nil }
                } label: {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(Color.ctMuted)
                        .frame(width: 30, height: 30)
                        .background(Color.ctBorder.opacity(0.5), in: Circle())
                        .frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close details")
            }

            if entry.badge != nil || entry.severity != nil {
                FlowRow {
                    if let badge = entry.badge {
                        StatusPill(text: badge, systemImage: "questionmark.circle", tone: .caution)
                    }
                    if let severity = entry.severity {
                        StatusPill(text: severity.title, systemImage: "gauge.with.dots.needle.67percent", tone: tone)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                ForEach(entry.confirmation, id: \.self) { line in
                    Label(line, systemImage: entry.badge == nil ? "checkmark.seal" : "info.circle")
                        .font(.subheadline)
                        .foregroundStyle(Color.ctInk)
                }
                Label {
                    Text("Last seen \(Text(entry.lastSeen, style: .relative)) ago")
                } icon: {
                    Image(systemName: "clock")
                }
                .font(.subheadline)
                .foregroundStyle(Color.ctMuted)
            }

            HStack(spacing: 10) {
                Button {
                    onReport(ReportPrefill(kind: entry.kind.stillThereKind, coord: entry.coord, taskId: nil))
                } label: {
                    Text("Still there")
                }
                .buttonStyle(LiveCompactButtonStyle(filled: true))
                Button {
                    onReport(ReportPrefill(kind: entry.kind.goneKind, coord: entry.coord, taskId: nil))
                } label: {
                    Text("Not there anymore")
                }
                .buttonStyle(LiveCompactButtonStyle(filled: false))
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.ctSurface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.ctBorder.opacity(0.7), lineWidth: 1))
        .shadow(color: .black.opacity(0.14), radius: 16, y: 6)
    }

    private func footer(isEmpty: Bool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "person.2.wave.2")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.ctBrand)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                if isEmpty {
                    Text("No confirmed reports right now. That does not mean it is safe.")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Color.ctInk)
                }
                Text("Reports from people nearby. Follow official orders first.")
                    .font(.footnote)
                    .foregroundStyle(Color.ctInk)
                Group {
                    if let refreshed = store.lastRefreshed {
                        Text("Updated \(Text(refreshed, style: .time))")
                    } else {
                        Text("Not updated yet")
                    }
                }
                .font(.caption)
                .foregroundStyle(Color.ctMuted)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.ctBorder.opacity(0.6), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

/// Wraps pills onto new lines at large text sizes.
private struct FlowRow<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { content }
            VStack(alignment: .leading, spacing: 6) { content }
        }
    }
}

/// Half-width buttons for paired choices on cards; 44pt minimum height.
struct LiveCompactButtonStyle: ButtonStyle {
    var filled: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .multilineTextAlignment(.center)
            .foregroundStyle(filled ? Color(light: 0xFFFFFF, dark: 0x0E1A16) : Color.ctBrand)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(filled ? Color.ctBrand : Color.ctSurface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                if !filled {
                    RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.ctBorder, lineWidth: 1)
                }
            }
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

#Preview {
    LiveMapView()
        .environment(LiveStore())
        .environment(LocationProvider())
}
