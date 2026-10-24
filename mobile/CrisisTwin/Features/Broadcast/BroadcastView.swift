import MapKit
import SwiftUI

/// The simulation drill: where the simulated fire is now and, while the dispatch agent runs,
/// what the simulation tells the household's zone to do. Always labelled as a simulation.
struct BroadcastView: View {
    let openTab: (AppTab) -> Void

    @Environment(BroadcastStore.self) private var live
    @Environment(MeetingPlanStore.self) private var planStore
    @Environment(FamilyStore.self) private var family
    @State private var camera: MapCameraPosition = .region(PlanMap.defaultRegion)
    @State private var framedSessionId: String?
    @State private var editingHome = false

    private var plan: MeetingPlan { planStore.plan }

    var body: some View {
        List {
            Group {
            Section {
                Label {
                    Text("Simulation drill. The fire and any orders here come from CrisisTwin's models, not from emergency services. In a real emergency, follow official orders.")
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Color.ctWarning)
                }
                .font(.subheadline)
            }

            switch live.state {
            case .loading:
                Section { ProgressView("Looking for a simulation…") }
            case .notConfigured:
                Section { Label("Set a valid API_BASE_URL in the Xcode configuration.", systemImage: "gear.badge.xmark") }
            case .noBroadcast:
                Section {
                    ContentUnavailableView(
                        "No simulation running",
                        systemImage: "flame",
                        description: Text("When a planner plays a fire on the CrisisTwin web app with “Share with resident app” on, it appears here.")
                    )
                }
            case .failed(let message):
                Section {
                    Label(message, systemImage: "wifi.exclamationmark")
                    Button("Try again") { Task { await live.refresh() } }
                }
            case .live(let snapshot, let receivedAt):
                liveSections(snapshot, receivedAt: receivedAt)
            }
            }
            .listRowBackground(Color.ctSurface)
        }
        .scrollContentBackground(.hidden)
        .listRowSeparatorTint(Color.ctBorderSubtle)
        .ctScreenBackground()
        .tint(Color.ctBrand)
        .navigationTitle("Web simulation")
        .refreshable { await live.refresh() }
        .sheet(isPresented: $editingHome) {
            MeetingPointEditor(title: "Your home", point: plan.home) { point in
                planStore.update { $0.home = point }
            }
        }
        .onChange(of: live.snapshot?.sessionId) { frameIfNeeded() }
        .onAppear { frameIfNeeded() }
    }

    @ViewBuilder
    private func liveSections(_ snapshot: LiveSnapshot, receivedAt: Date) -> some View {
        Section {
            map(snapshot)
                .frame(height: 320)
                .listRowInsets(EdgeInsets())
            Text(legend(snapshot))
                .font(.caption)
                .foregroundStyle(Color.ctInkMuted)
        }

        Section("Your household") {
            householdGuidance(snapshot)
        }

        meetingPointSection(snapshot)

        if family.isJoined, let members = family.family?.members, !members.isEmpty {
            Section("Family") {
                ForEach(members) { member in
                    LabeledContent(member.isMe ? "\(member.name) (you)" : member.name) {
                        Label(member.memberStatus.label, systemImage: member.memberStatus.systemImage)
                    }
                }
                Button("Update my status") { openTab(.family) }
            }
        }

        if let agent = snapshot.agent {
            Section {
                Text(agent.summary.isEmpty ? "No summary for this decision." : agent.summary)
            } header: {
                Text("Dispatch agent · T+\(Int(agent.minute)) min")
            } footer: {
                Text("Written by an AI dispatcher (\(agent.model)) inside the simulation. Routes and times come from the simulator, not the AI.")
            }
        }

        Section {
            LabeledContent("Area", value: snapshot.areaName)
            LabeledContent("Simulation time", value: "T+\(Int(snapshot.minute)) of \(Int(snapshot.horizonMinutes)) min")
            LabeledContent("Burned (simulated)", value: "\(Int(snapshot.fire.burnedAreaHa)) ha")
            LabeledContent("Wind (assumed)", value: "\(Int(snapshot.wind.speedMph)) mph from \(Int(snapshot.wind.fromDegrees))°")
            LabeledContent("Source", value: snapshot.isDispatch ? "Fire model + dispatch agent" : "Fire spread model")
            TimelineView(.periodic(from: .now, by: 5)) { context in
                LabeledContent("Status", value: statusText(snapshot, receivedAt: receivedAt, now: context.date))
            }
            LabeledContent("Updates", value: live.transport == .push ? "Pushed live" : "Checked every few seconds")
        } header: {
            Text("About this simulation")
        }
    }

    // MARK: Map

    private func map(_ snapshot: LiveSnapshot) -> some View {
        let myZone = plan.home.flatMap { snapshot.zone(containing: $0.coordinate) }
        return Map(position: $camera) {
            ForEach(snapshot.zones) { zone in
                MapPolygon(coordinates: zone.outline)
                    .foregroundStyle(zone.id == myZone?.id ? Color.ctRoute.opacity(0.12) : Color.clear)
                    .stroke(zone.id == myZone?.id ? Color.ctRoute : Color.ctSmoke.opacity(0.6), lineWidth: zone.id == myZone?.id ? 3 : 1)
            }
            ForEach(Array(snapshot.fireRings.enumerated()), id: \.offset) { entry in
                MapPolygon(coordinates: entry.element)
                    .foregroundStyle(Color.ctFire.opacity(0.35))
                    .stroke(Color.ctFire, lineWidth: 2)
            }
            if let zone = myZone, !zone.routeLine.isEmpty {
                MapPolyline(coordinates: zone.routeLine)
                    .stroke(Color.ctRoute, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
            }
            if let exit = myZone?.exit {
                Marker("Exit: \(exit.name)", systemImage: "arrow.up.right.square.fill", coordinate: exit.coordinate)
                    .tint(Color.ctRoute)
            }
            if let home = plan.home {
                Marker("Home", systemImage: "house.fill", coordinate: home.coordinate)
                    .tint(Color.ctInfo)
            }
            if let primary = plan.primary {
                Marker("1 · \(primary.name)", systemImage: "figure.2", coordinate: primary.coordinate)
                    .tint(Color.ctBrand)
            }
            if let backup = plan.backup {
                Marker("2 · \(backup.name)", systemImage: "figure.2", coordinate: backup.coordinate)
                    .tint(Color.ctInkMuted)
            }
        }
        .accessibilityLabel(mapSummary(snapshot, myZone: myZone))
    }

    private func legend(_ snapshot: LiveSnapshot) -> String {
        var parts = ["Red shaded area: simulated fire at T+\(Int(snapshot.minute)) min."]
        if snapshot.isDispatch {
            parts.append("Thick outline: your zone. Thick line: your assigned route to the marked exit.")
        }
        parts.append("Pins: home and meeting points.")
        return parts.joined(separator: " ")
    }

    private func mapSummary(_ snapshot: LiveSnapshot, myZone: BroadcastZone?) -> String {
        var text = "Map of the simulated fire, \(snapshot.fireRings.count) burning area\(snapshot.fireRings.count == 1 ? "" : "s")."
        if let myZone { text += " Your zone is \(myZone.name)." }
        return text
    }

    /// Frame the run's area once per run, so polling never fights the user's panning.
    private func frameIfNeeded() {
        guard let snapshot = live.snapshot, snapshot.sessionId != framedSessionId else { return }
        framedSessionId = snapshot.sessionId
        var points = snapshot.fireRings.flatMap { $0 }
        if let bbox = snapshot.bbox, bbox.count == 4 {
            points = [CLLocationCoordinate2D(latitude: bbox[1], longitude: bbox[0]),
                      CLLocationCoordinate2D(latitude: bbox[3], longitude: bbox[2])]
        }
        if let home = plan.home { points.append(home.coordinate) }
        guard !points.isEmpty else { return }
        let lats = points.map(\.latitude), lons = points.map(\.longitude)
        camera = .region(MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: (lats.min()! + lats.max()!) / 2, longitude: (lons.min()! + lons.max()!) / 2),
            span: MKCoordinateSpan(latitudeDelta: max((lats.max()! - lats.min()!) * 1.3, 0.02),
                                   longitudeDelta: max((lons.max()! - lons.min()!) * 1.3, 0.02))
        ))
    }

    // MARK: Guidance

    @ViewBuilder
    private func householdGuidance(_ snapshot: LiveSnapshot) -> some View {
        if let home = plan.home {
            let reached = snapshot.fireReaches(home.coordinate)
            if snapshot.isDispatch, let zone = snapshot.zone(containing: home.coordinate) {
                zoneGuidance(zone, redirected: live.redirectedZoneIds.contains(zone.id))
            } else if snapshot.isDispatch {
                Label("Your home is outside the simulated dispatch area, so there are no zone orders for it.", systemImage: "mappin.slash")
            }
            if reached {
                Label("In the simulation, fire has reached your home location.", systemImage: "flame.fill")
                    .foregroundStyle(Color.ctDanger)
            } else if let meters = snapshot.distanceToFire(from: home.coordinate) {
                Label("Simulated fire edge is about \(distanceText(meters)) from home.", systemImage: "ruler")
            } else {
                Label("No simulated fire yet at this time.", systemImage: "checkmark.circle")
            }
            Button("Change home location") { editingHome = true }
        } else {
            Text("Set your home to see your zone's simulated orders and how far the fire is. Your home stays on this phone; the app works out your zone itself.")
                .foregroundStyle(Color.ctInkMuted)
            Button {
                editingHome = true
            } label: {
                Label("Set my home", systemImage: "house")
            }
        }
    }

    @ViewBuilder
    private func zoneGuidance(_ zone: BroadcastZone, redirected: Bool) -> some View {
        let style = GuidanceStyle(zone.kind)
        VStack(alignment: .leading, spacing: 8) {
            Label(style.title, systemImage: style.systemImage)
                .font(.title3.bold())
                .foregroundStyle(style.color)
            Text(zone.message)
            if redirected, zone.kind == .leaveNow || zone.kind == .wait {
                Label("Your route changed. Use the exit shown here.", systemImage: "arrow.triangle.branch")
                    .font(.subheadline.weight(.semibold))
            }
            Text("Zone \(zone.name)")
                .font(.caption)
                .foregroundStyle(Color.ctInkMuted)
            if let core = zone.fireCoreEtaMin, zone.kind != .overrun, zone.kind != .cleared {
                Text(core == 0 ? "Simulated fire is in the zone." : "Simulated fire reaches the zone centre in about \(Int(core)) min.")
                    .font(.caption)
                    .foregroundStyle(Color.ctInkMuted)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        if let exit = zone.exit, zone.kind == .leaveNow || zone.kind == .wait {
            Link(destination: exit.directionsURL) {
                Label("Directions to \(exit.name)", systemImage: "arrow.triangle.turn.up.right.diamond")
            }
        }
    }

    @ViewBuilder
    private func meetingPointSection(_ snapshot: LiveSnapshot) -> some View {
        let points: [(String, MeetingPoint)] = [("Primary", plan.primary), ("Backup", plan.backup)]
            .compactMap { entry in entry.1.map { (entry.0, $0) } }
        if !points.isEmpty {
            let reached = points.map { snapshot.fireReaches($0.1.coordinate) }
            Section {
                ForEach(Array(points.enumerated()), id: \.offset) { entry in
                    let isReached = reached[entry.offset]
                    LabeledContent("\(entry.element.0): \(entry.element.1.name)") {
                        Label(isReached ? "Fire reached" : "Clear", systemImage: isReached ? "flame.fill" : "checkmark.circle")
                            .foregroundStyle(isReached ? Color.ctDanger : Color.ctInkMuted)
                    }
                }
                if let firstClear = points.indices.first(where: { !reached[$0] }) {
                    if firstClear > 0 {
                        Text("The simulated fire reached your primary point. Meet at \(points[firstClear].1.name) instead.")
                            .font(.subheadline.weight(.semibold))
                    }
                    Link(destination: points[firstClear].1.directionsURL) {
                        Label("Directions to \(points[firstClear].1.name)", systemImage: "figure.walk")
                    }
                } else {
                    Text("The simulated fire reached every meeting point. Choose another place away from the fire.")
                        .font(.subheadline.weight(.semibold))
                }
            } header: {
                Text("Meeting points")
            } footer: {
                Text("Checked against the simulated fire only. Apple Maps directions do not know about the simulated fire or closed roads.")
            }
        }
    }

    private func distanceText(_ meters: Double) -> String {
        Measurement(value: meters, unit: UnitLength.meters)
            .formatted(.measurement(width: .abbreviated, usage: .road))
    }

    private func statusText(_ snapshot: LiveSnapshot, receivedAt: Date, now: Date) -> String {
        let age = max(0, now.timeIntervalSince(receivedAt))
        let ago = age < 5 ? "just now" : "\(Int(age)) s ago"
        switch snapshot.playback {
        case "stopped": return "Stopped by the planner · \(ago)"
        case "finished": return "Finished · \(ago)"
        case "paused": return "Paused · updated \(ago)"
        default:
            return age > BroadcastStore.staleAfter ? "No update for \(Int(age)) s; the planner may have closed the page" : "Playing · updated \(ago)"
        }
    }
}

/// Title, icon and colour for a guidance kind. The title text always carries the meaning.
private struct GuidanceStyle {
    let title: String
    let systemImage: String
    let color: Color

    init(_ kind: BroadcastZone.Guidance?) {
        let style: (String, String, Color)
        switch kind {
        case .leaveNow: style = ("Leave now", "car.fill", .ctDanger)
        case .wait: style = ("Ordered out — wait a little", "hourglass", .ctWarning)
        case .routeBlocked: style = ("Route blocked — hold", "xmark.octagon.fill", .ctDanger)
        case .noOrder: style = ("No order yet — be ready", "bell", .ctInk)
        case .cleared: style = ("Zone evacuated", "checkmark.seal.fill", .ctSuccess)
        case .overrun: style = ("Fire in your zone", "flame.fill", .ctDanger)
        case nil: style = ("Update the app", "questionmark.circle", .ctInkMuted)
        }
        title = style.0
        systemImage = style.1
        color = style.2
    }
}
