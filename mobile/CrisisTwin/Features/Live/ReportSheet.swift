import CoreLocation
import MapKit
import SwiftUI

/// "Report what you see": pick what it is, confirm where, send. Works offline; the store saves the
/// draft on the phone first (ADR 0011).
struct ReportSheet: View {
    var prefill: ReportPrefill? = nil

    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @Environment(\.dismiss) private var dismiss

    /// Where the report is about, and when that was captured on this device.
    private struct Spot {
        var coordinate: CLLocationCoordinate2D
        var accuracyM: Double?
        var capturedAt: Date
        var fromGPS: Bool
    }

    private static let noteLimit = 280

    @State private var kind: ReportKind?
    @State private var severity: ReportSeverity?
    @State private var note = ""
    @State private var spot: Spot?
    @State private var detailsMode = false
    @State private var camera: MapCameraPosition = .region(LiveMapView.campRegion)
    @State private var sentKind: ReportKind?
    @State private var started = false

    private let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]

    var body: some View {
        Group {
            if let sentKind {
                confirmation(for: sentKind)
            } else {
                form
            }
        }
        .navigationTitle("Report")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                if sentKind == nil { Button("Cancel") { dismiss() } }
            }
        }
        .sensoryFeedback(.success, trigger: sentKind) { _, new in new != nil }
        .task { await start() }
    }

    // MARK: Form

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                kindGrid
                if detailsMode {
                    if let kind { details(for: kind) }
                    locationSection
                } else {
                    HStack {
                        Text("Only what you see now.")
                            .font(.footnote)
                            .foregroundStyle(Color.ctMuted)
                        Spacer()
                        Button {
                            withAnimation(.snappy(duration: 0.2)) { detailsMode = true }
                        } label: {
                            Text("Adjust").font(.subheadline.weight(.semibold))
                                .frame(minWidth: 44, minHeight: 44)
                        }
                        .accessibilityLabel("Adjust details and location")
                    }
                }
            }
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color.ctBackground)
        .safeAreaInset(edge: .bottom, spacing: 0) { if detailsMode { sendBar } }
    }

    private var kindGrid: some View {
        VStack(alignment: .leading, spacing: 12) {
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(ReportKind.allCases) { option in
                    Button {
                        withAnimation(.snappy(duration: 0.2)) { select(option) }
                    } label: {
                        kindLabel(option)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Report \(option.title.lowercased())")
                    .accessibilityAddTraits(kind == option ? .isSelected : [])
                }
            }
        }
    }

    private func kindLabel(_ option: ReportKind) -> some View {
        let selected = kind == option
        let tone = option.tone.color
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        return HStack(spacing: 10) {
            Image(systemName: option.systemImage)
                .font(.body.weight(.semibold))
                .foregroundStyle(selected ? Color.white : tone)
                .frame(width: 40, height: 40)
                .background(selected ? tone : tone.opacity(0.12), in: Circle())
                .accessibilityHidden(true)
            Text(option.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.ctInk)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: selected ? 18 : 0)
        }
        .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
        .padding(12)
        .background(selected ? tone.opacity(0.10) : Color.ctSurface, in: shape)
        .overlay(alignment: .topTrailing) {
            if selected {
                Image(systemName: "checkmark.circle.fill")
                    .font(.subheadline)
                    .foregroundStyle(tone)
                    .padding(6)
                    .accessibilityHidden(true)
            }
        }
        .overlay {
            shape.strokeBorder(selected ? tone : Color.ctBorder.opacity(0.8), lineWidth: selected ? 2.5 : 1)
        }
        .shadow(color: .black.opacity(selected ? 0 : 0.03), radius: 6, y: 2)
        .contentShape(shape)
    }

    @ViewBuilder
    private func details(for kind: ReportKind) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if kind.isRoadKind {
                Label("Place the pin on the road.", systemImage: "road.lanes")
                    .font(.footnote)
                    .foregroundStyle(Color.ctMuted)
            }
            if kind == .helpNeeded {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "phone.fill")
                        .font(.headline)
                        .foregroundStyle(HazardTone.danger.color)
                        .frame(width: 36, height: 36)
                        .background(HazardTone.danger.color.opacity(0.12), in: Circle())
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("If you are in danger, call 911.").font(.headline).foregroundStyle(Color.ctInk)
                        Text("Responders only, never on the public map. It may not reach anyone right away.")
                            .font(.footnote)
                            .foregroundStyle(Color.ctMuted)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(HazardTone.danger.color.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(HazardTone.danger.color.opacity(0.35), lineWidth: 1))
                .accessibilityElement(children: .combine)
            }
            if kind.hasSeverity {
                HStack {
                    Text("How bad is it?").font(.subheadline.weight(.semibold)).foregroundStyle(Color.ctInk)
                    Spacer()
                    Picker("How bad is it?", selection: $severity) {
                        Text("Not sure").tag(ReportSeverity?.none)
                        ForEach(ReportSeverity.allCases) { Text($0.title).tag(ReportSeverity?.some($0)) }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 50)
                .background(Color.ctSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.ctBorder, lineWidth: 1))
            }
            TextField("Short note (optional)", text: $note, axis: .vertical)
                .lineLimit(1...3)
                .padding(14)
                .frame(minHeight: 50)
                .background(Color.ctSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.ctBorder, lineWidth: 1))
                .onChange(of: note) { _, value in
                    if value.count > Self.noteLimit { note = String(value.prefix(Self.noteLimit)) }
                }
        }
    }

    private var locationSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            MapReader { proxy in
                Map(position: $camera) {
                    if let spot {
                        if let accuracy = spot.accuracyM, accuracy > 0 {
                            MapCircle(center: spot.coordinate, radius: accuracy)
                                .foregroundStyle(Color.accentColor.opacity(0.15))
                        }
                        Marker("Report location", systemImage: kind?.systemImage ?? "mappin", coordinate: spot.coordinate)
                            .tint(kind?.tone.color ?? Color.ctBrand)
                    }
                }
                .mapStyle(.standard(pointsOfInterest: .excludingAll))
                .onTapGesture { point in
                    if let tapped = proxy.convert(point, from: .local) { drop(tapped) }
                }
            }
            .frame(height: 240)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.ctBorder, lineWidth: 1))
            .accessibilityLabel("Map. Tap to place the pin.")

            Label(spot == nil ? "Tap the map to place the pin." : "Tap the map to move the pin.",
                  systemImage: spot == nil ? "mappin.slash" : "mappin.circle.fill")
                .font(.footnote)
                .foregroundStyle(spot == nil ? Color.ctMuted : Color.ctBrand)
        }
    }

    private var sendBar: some View {
        let ready = kind != nil && spot != nil
        return VStack(spacing: 0) {
            Button(action: send) {
                Label("Send", systemImage: "paperplane.fill")
            }
            .buttonStyle(PrimaryButtonStyle(tint: ready ? .ctBrand : Color.ctMuted.opacity(0.45)))
            .disabled(!ready)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    // MARK: Confirmation

    private func confirmation(for kind: ReportKind) -> some View {
        let queued = !store.pending.isEmpty
        return VStack(spacing: 14) {
            Spacer()
            Image(systemName: "checkmark")
                .font(.system(size: 36, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 88, height: 88)
                .background(Color.ctBrand, in: Circle())
                .accessibilityHidden(true)
            Text(queued ? "Saved, sends when online" : "Sent")
                .font(.title2.bold())
                .foregroundStyle(Color.ctInk)
            if kind == .helpNeeded {
                Text("If you are in danger, call 911.")
                    .font(.headline)
                    .foregroundStyle(Color.ctInk)
            }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.ctBackground)
        .accessibilityElement(children: .combine)
        .onAppear {
            AccessibilityNotification.Announcement(queued ? "Saved. Sends when online." : "Sent.").post()
        }
        .task {
            try? await Task.sleep(for: .milliseconds(1500))
            dismiss()
        }
    }

    // MARK: Actions

    /// With a fix and no details requested, a tap sends at once. Otherwise it selects the kind and
    /// shows the map.
    private func select(_ option: ReportKind) {
        kind = option
        if !option.hasSeverity { severity = nil }
        if spot == nil { detailsMode = true } else if !detailsMode { send() }
    }

    /// Applies the prefill once, then takes a fix if access is already granted. It never shows the
    /// permission prompt on its own.
    private func start() async {
        guard !started else { return }
        started = true
        if let prefill {
            detailsMode = true
            if let coord = prefill.coord, coord.isValid {
                drop(CLLocationCoordinate2D(latitude: coord.lat, longitude: coord.lon))
                camera = .region(MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: coord.lat, longitude: coord.lon),
                                                    latitudinalMeters: 600, longitudinalMeters: 600))
            }
            if let kind = prefill.kind { select(kind) }
        }
        if spot == nil, location.isAuthorized { await useCurrentLocation() }
        #if DEBUG
        if let raw = UserDefaults.standard.string(forKey: "reporttap"), let option = ReportKind(rawValue: raw) {
            select(option)
        }
        #endif
    }

    private func drop(_ coordinate: CLLocationCoordinate2D) {
        spot = Spot(coordinate: coordinate, accuracyM: nil, capturedAt: Date(), fromGPS: false)
    }

    private func useCurrentLocation() async {
        do {
            let fix = try await location.currentLocation()
            spot = Spot(coordinate: fix.coordinate, accuracyM: fix.horizontalAccuracy, capturedAt: fix.timestamp, fromGPS: true)
            camera = .region(MKCoordinateRegion(center: fix.coordinate, latitudinalMeters: 600, longitudinalMeters: 600))
        } catch {}
    }

    private func send() {
        guard let kind, let spot else { return }
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let draft = ReportDraft(
            incidentId: store.incidentId,
            kind: kind,
            severity: kind.hasSeverity ? severity : nil,
            location: ReportLocation(
                coord: LonLat(lon: spot.coordinate.longitude, lat: spot.coordinate.latitude),
                accuracyM: spot.accuracyM
            ),
            taskId: prefill?.taskId,
            note: trimmed.isEmpty ? nil : trimmed,
            observedAt: spot.capturedAt
        )
        store.submit(draft)
        sentKind = kind
    }
}

#Preview {
    NavigationStack { ReportSheet() }
        .environment(LiveStore())
        .environment(LocationProvider())
}
