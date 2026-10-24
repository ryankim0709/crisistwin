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
    /// The pin map is open (no fix yet, a prefilled place, or "Move pin").
    @State private var movingPin = false
    @State private var camera: MapCameraPosition = .region(LiveMap.campRegion)
    @State private var sentKind: ReportKind?
    @State private var drawn = false
    @State private var started = false
    @State private var tick = 0

    var body: some View {
        Group {
            if let sentKind {
                confirmation(for: sentKind)
            } else {
                form
            }
        }
        .navigationTitle(sentKind == nil ? "Report" : "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                if sentKind == nil { Button(role: .close) { dismiss() } }
            }
        }
        .sensoryFeedback(.selection, trigger: tick)
        .sensoryFeedback(.success, trigger: sentKind) { _, new in new != nil }
        .task { await start() }
    }

    // MARK: Form

    private var form: some View {
        List {
            Section {
                ForEach(ReportKind.allCases) { option in
                    Button {
                        tick += 1
                        withAnimation(.snappy(duration: 0.2)) { select(option) }
                    } label: {
                        HStack(spacing: 14) {
                            Image(systemName: option.systemImage)
                                .foregroundStyle(option.symbolColor)
                                .frame(width: 28)
                                .accessibilityHidden(true)
                            Text(option.title)
                            Spacer()
                            if kind == option {
                                Image(systemName: "checkmark")
                                    .font(.body.weight(.semibold))
                                    .accessibilityHidden(true)
                            }
                        }
                        .frame(minHeight: 52)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Report \(option.title.lowercased())")
                    .accessibilityAddTraits(kind == option ? .isSelected : [])
                }
            }

            if let kind { details(for: kind) }

            locationSection
        }
        .listStyle(.insetGrouped)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) { sendBar }
    }

    @ViewBuilder
    private func details(for kind: ReportKind) -> some View {
        if kind == .helpNeeded {
            Section {
                Label("If you are in danger, call 911.", systemImage: "phone.fill")
                    .font(.headline)
            }
        }
        Section {
            if kind.hasSeverity {
                Picker("How bad is it?", selection: $severity) {
                    Text("Not sure").tag(ReportSeverity?.none)
                    ForEach(ReportSeverity.allCases) { Text($0.title).tag(ReportSeverity?.some($0)) }
                }
                .pickerStyle(.menu)
                .frame(minHeight: 44)
            }
            TextField("Note (optional)", text: $note, axis: .vertical)
                .lineLimit(1...3)
                .frame(minHeight: 44)
                .onChange(of: note) { _, value in
                    if value.count > Self.noteLimit { note = String(value.prefix(Self.noteLimit)) }
                }
        }
    }

    private var locationSection: some View {
        Section {
            HStack {
                Label(spot == nil ? "No location yet" : spot?.fromGPS == true ? "Your location" : "Pinned location",
                      systemImage: spot?.fromGPS == true ? "location.fill" : "mappin")
                Spacer()
                if !movingPin {
                    Button("Move pin") { withAnimation(.snappy) { movingPin = true } }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                }
            }
            .frame(minHeight: 44)
            if movingPin {
                MapReader { proxy in
                    Map(position: $camera) {
                        if let spot {
                            Marker("Report location", systemImage: kind?.systemImage ?? "mappin", coordinate: spot.coordinate)
                                .tint(Color.ctRoute)
                        }
                    }
                    .mapStyle(.standard(emphasis: .muted, pointsOfInterest: .excludingAll))
                    .onTapGesture { point in
                        if let tapped = proxy.convert(point, from: .local) {
                            tick += 1
                            drop(tapped)
                        }
                    }
                }
                .frame(height: 240)
                .listRowInsets(EdgeInsets())
                .accessibilityLabel("Map. Tap to place the pin.")
            }
        }
    }

    private var sendBar: some View {
        Button(action: send) {
            Label("Send", systemImage: "paperplane.fill")
                .font(.headline)
                .foregroundStyle(kind == nil || spot == nil ? Color.secondary : Color(uiColor: .systemBackground))
                .frame(maxWidth: .infinity, minHeight: 50)
        }
        .buttonStyle(.glassProminent)
        .disabled(kind == nil || spot == nil)
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    // MARK: Confirmation

    private func confirmation(for kind: ReportKind) -> some View {
        let queued = !store.pending.isEmpty
        return VStack(spacing: 16) {
            Spacer()
            ZStack {
                if drawn {
                    Image(systemName: "checkmark.circle")
                        .font(.system(size: 72, weight: .regular))
                        .transition(.symbolEffect(.drawOn))
                }
            }
            .frame(height: 88)
            .accessibilityHidden(true)
            Text(queued ? "Saved, sends when online" : "Sent")
                .font(.title2.bold())
            if kind == .helpNeeded {
                Text("If you are in danger, call 911.")
                    .font(.headline)
            }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .onAppear {
            withAnimation { drawn = true }
            AccessibilityNotification.Announcement(queued ? "Saved. Sends when online." : "Sent.").post()
        }
        .task {
            try? await Task.sleep(for: .milliseconds(1500))
            dismiss()
        }
    }

    // MARK: Actions

    private func select(_ option: ReportKind) {
        kind = option
        if !option.hasSeverity { severity = nil }
    }

    /// Applies the prefill once, then takes a fix if access is already granted. It never shows the
    /// permission prompt on its own.
    private func start() async {
        guard !started else { return }
        started = true
        if let prefill {
            movingPin = true
            if let coord = prefill.coord, coord.isValid {
                drop(CLLocationCoordinate2D(latitude: coord.lat, longitude: coord.lon))
                camera = .region(MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: coord.lat, longitude: coord.lon),
                                                    latitudinalMeters: 600, longitudinalMeters: 600))
            }
            if let kind = prefill.kind { select(kind) }
        }
        if spot == nil, location.isAuthorized { await useCurrentLocation() }
        if spot == nil { movingPin = true }
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
            // Observed now: the fix can be the last one from continuous updates, which pause
            // while the device is still, so its own timestamp may be minutes old.
            spot = Spot(coordinate: fix.coordinate, accuracyM: fix.horizontalAccuracy, capturedAt: Date(), fromGPS: true)
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
