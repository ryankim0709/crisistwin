import SwiftUI
import UIKit

/// The one bottom sheet: the single instruction for the device's zone ("Leave now via Pentz Road",
/// "Chico shelter · 24 min") with "I'm out" / "Need help" check-ins; for responders, the assigned
/// task with Accept, Answer and Can't reach above it. The medium detent adds the reason and the
/// fire estimate label. Reads `LiveStore` and `LocationProvider` from the environment.
struct GuidanceSheet: View {
    init() {}

    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @Environment(\.incidentActions) private var actions
    @Environment(\.openURL) private var openURL
    @State private var sending: CheckInStatus?
    @State private var confirmingHelp = false
    @State private var accepting = false
    @State private var cancelling: CheckTask?
    @State private var cancelNote = ""
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if store.role != .civilian, let task = currentTask {
                    taskCard(task)
                    Divider().overlay(Color.ctBorder)
                }
                instruction
                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(HazardTone.danger.color)
                }
                details
            }
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollBounceBehavior(.basedOnSize)
        .confirmationDialog("Send your location to responders?", isPresented: $confirmingHelp, titleVisibility: .visible) {
            Button("Send my location") { checkIn(.needHelp) }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Can't reach it", isPresented: Binding(
            get: { cancelling != nil }, set: { if !$0 { cancelling = nil } })
        ) {
            TextField("Why not? (optional)", text: $cancelNote)
            Button("Send") { submitCancel() }
            Button("Back", role: .cancel) {}
        }
    }

    // MARK: Instruction

    private enum Phase {
        case locationOff(denied: Bool)
        case locating
        case connecting
        case unavailable(String)
        case outsideZones
        case noOrder
        case evacuate(ZoneGuidance)
        case evacuateNoRoute
        case beReady(ZoneGuidance)
    }

    private var phase: Phase {
        if !location.isAuthorized {
            return .locationOff(denied: location.authorization == .denied || location.authorization == .restricted)
        }
        if store.situation == nil {
            if case .unavailable(let message) = store.connection { return .unavailable(message) }
            return .connecting
        }
        if location.lastLocation == nil { return .locating }
        guard store.myZone != nil else { return .outsideZones }
        guard let guidance = store.myGuidance else { return .noOrder }
        switch guidance.level {
        case .none: return .noOrder
        case .evacuateNow: return guidance.noRoute || guidance.route == nil ? .evacuateNoRoute : .evacuate(guidance)
        case .beReady: return .beReady(guidance)
        }
    }

    @ViewBuilder private var instruction: some View {
        switch phase {
        case .locationOff(let denied):
            headline("Turn on location to see guidance for where you are")
            Button(denied ? "Open Settings" : "Turn on location") {
                if denied, let url = URL(string: UIApplication.openSettingsURLString) {
                    openURL(url)
                } else {
                    location.requestPermission()
                    location.startUpdating()
                }
            }
            .buttonStyle(PrimaryButtonStyle())
        case .locating:
            HStack(spacing: 10) {
                ProgressView()
                headline("Finding your location")
            }
        case .connecting:
            HStack(spacing: 10) {
                ProgressView()
                headline("Connecting to the drill")
            }
        case .unavailable(let message):
            headline("Can't reach the drill service")
            subline(message)
        case .outsideZones:
            headline("You're outside the drill zones")
            checkIns(showOut: false)
        case .noOrder:
            headline("No order for your zone.")
            checkIns(showOut: false)
        case .evacuate(let guidance):
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    headline(guidance.route?.via.first.map { "Leave now via \($0)" } ?? "Leave now")
                    subline(destinationLine(guidance))
                }
                Spacer(minLength: 0)
                followButton
            }
            staleLine
            checkIns(showOut: true)
        case .evacuateNoRoute:
            headline("Leave now. No open route found.")
            subline("Follow responders and official orders.")
            staleLine
            checkIns(showOut: true)
        case .beReady(let guidance):
            headline("Be ready to leave")
            if guidance.route != nil, !guidance.noRoute {
                subline(plannedLine(guidance))
            }
            staleLine
            checkIns(showOut: true)
        }
    }

    private func headline(_ text: String) -> some View {
        Text(text)
            .font(.title3.weight(.bold))
            .foregroundStyle(Color.ctInk)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    private func subline(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(Color.ctMuted)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func destinationLine(_ guidance: ZoneGuidance) -> String {
        [guidance.destination?.name, guidance.route.map { Self.etaText($0.etaMin) }]
            .compactMap { $0 }.joined(separator: " · ")
    }

    private func plannedLine(_ guidance: ZoneGuidance) -> String {
        var parts: [String] = []
        if let road = guidance.route?.via.first { parts.append("Via \(road)") }
        if let name = guidance.destination?.name { parts.append(name) }
        let line = parts.joined(separator: " → ")
        guard let minutes = guidance.route?.etaMin else { return line }
        let eta = Self.etaText(minutes)
        return line.isEmpty ? eta : "\(line), \(eta)"
    }

    /// A zone whose start point is already at its exit has a zero-length route.
    private static func etaText(_ minutes: Int) -> String {
        minutes < 1 ? "under 1 min" : "\(minutes) min"
    }

    /// Shown only when the last poll failed, so old guidance is never mistaken for current.
    @ViewBuilder private var staleLine: some View {
        if case .unavailable = store.connection, let situation = store.situation {
            Label("Offline · last update \(Text(situation.generatedAt, style: .time))", systemImage: "wifi.exclamationmark")
                .font(.footnote)
                .foregroundStyle(HazardTone.caution.color)
        }
    }

    private var followButton: some View {
        Button {
            actions.setFollowing(!actions.following)
        } label: {
            Text(actions.following ? "Stop" : "Start")
                .font(.headline)
                .foregroundStyle(actions.following ? Color.ctBrand : Color(light: 0xFFFFFF, dark: 0x0E1A16))
                .padding(.horizontal, 22)
                .frame(minHeight: 44)
                .background(actions.following ? Color.ctSurface : Color.ctBrand, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.ctBrand, lineWidth: actions.following ? 1.5 : 0))
        }
        .buttonStyle(.plain)
        .accessibilityHint(actions.following ? "Stops following your position" : "Follows your position on the route")
    }

    // MARK: Check-ins

    private func checkIns(showOut: Bool) -> some View {
        HStack(spacing: 10) {
            if showOut {
                checkInButton(.out, title: "I'm out", systemImage: "checkmark.circle")
            }
            checkInButton(.needHelp, title: "Need help", systemImage: "sos")
        }
    }

    private func checkInButton(_ status: CheckInStatus, title: String, systemImage: String) -> some View {
        let current = store.lastCheckIn?.status == status
        return Button {
            if status == .needHelp { confirmingHelp = true } else { checkIn(status) }
        } label: {
            HStack(spacing: 6) {
                if sending == status {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: current ? "checkmark" : systemImage)
                }
                Text(title)
            }
        }
        .buttonStyle(LiveCompactButtonStyle(filled: current))
        .disabled(sending != nil)
        .accessibilityAddTraits(current ? .isSelected : [])
    }

    private func checkIn(_ status: CheckInStatus) {
        sending = status
        errorMessage = nil
        Task {
            do {
                try await store.checkIn(status)
            } catch {
                errorMessage = error.localizedDescription
            }
            sending = nil
        }
    }

    // MARK: Details (medium detent)

    @ViewBuilder private var details: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let reason = store.myGuidance?.reason, !reason.isEmpty, store.myGuidance?.level != GuidanceLevel.none {
                detailRow(reason, systemImage: "info.circle", tone: Color.ctInk)
            }
            if let fire = store.situation?.fire {
                detailRow(fire.label, systemImage: "flame", tone: Color.ctInk)
            }
            detailRow(store.situation?.drill.label ?? LiveIncident.drillLabel,
                      systemImage: "exclamationmark.triangle", tone: Color.ctMuted)
        }
        .padding(.top, 8)
    }

    private func detailRow(_ text: String, systemImage: String, tone: Color) -> some View {
        Label {
            Text(text).foregroundStyle(tone).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: systemImage).foregroundStyle(Color.ctMuted)
        }
        .font(.subheadline)
    }

    // MARK: Responder task

    private var currentTask: CheckTask? {
        let me = store.credential?.partyKey
        let tasks = (store.situation?.tasks ?? store.tasks)
            .filter { $0.status == .open || $0.status == .accepted }
        return tasks.min { a, b in
            func rank(_ t: CheckTask) -> Int {
                if t.status == .accepted { return 0 }
                return t.assignee != nil && t.assignee == me ? 1 : 2
            }
            return rank(a) == rank(b) ? a.createdAt < b.createdAt : rank(a) < rank(b)
        }
    }

    private var otherTaskCount: Int {
        max(0, (store.situation?.tasks ?? store.tasks).filter { $0.status == .open || $0.status == .accepted }.count - 1)
    }

    private func targetText(_ task: CheckTask) -> String {
        if let id = task.target.segmentId {
            let name = store.situation?.hazards.first { $0.roadRef?.segmentId == id }?.roadRef?.name
                ?? store.allReports.first { $0.roadRef?.segmentId == id }?.roadRef?.name
                ?? store.publicItems.first { $0.roadRef?.segmentId == id }?.roadRef?.name
            if let name { return name }
        }
        if let c = task.target.coord { return String(format: "%.4f, %.4f", c.lat, c.lon) }
        return "the marked place"
    }

    private func taskCard(_ task: CheckTask) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "magnifyingglass")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(HazardTone.info.color)
                    .frame(width: 40, height: 40)
                    .background(HazardTone.info.color.opacity(0.14), in: Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Check \(targetText(task))")
                        .font(.headline)
                        .foregroundStyle(Color.ctInk)
                    if let note = task.note, !note.isEmpty {
                        Text(note).font(.subheadline).foregroundStyle(Color.ctMuted)
                    }
                }
                Spacer(minLength: 0)
                if otherTaskCount > 0 {
                    Text("+\(otherTaskCount)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.ctMuted)
                        .accessibilityLabel("\(otherTaskCount) more tasks")
                }
            }
            HStack(spacing: 10) {
                if task.status == .accepted {
                    Button("Answer") {
                        actions.openReport(ReportPrefill(kind: nil, coord: task.target.coord, taskId: task.id))
                    }
                    .buttonStyle(LiveCompactButtonStyle(filled: true))
                } else {
                    Button {
                        accept(task)
                    } label: {
                        if accepting { ProgressView().controlSize(.small) } else { Text("Accept") }
                    }
                    .buttonStyle(LiveCompactButtonStyle(filled: true))
                    .disabled(accepting)
                }
                Button("Can't reach") {
                    cancelNote = ""
                    cancelling = task
                }
                .buttonStyle(LiveCompactButtonStyle(filled: false))
            }
        }
    }

    private func accept(_ task: CheckTask) {
        accepting = true
        errorMessage = nil
        Task {
            do {
                try await store.acceptTask(task)
            } catch LiveAPIError.conflict {
                errorMessage = "Another responder took this task."
                await store.refresh()
            } catch {
                errorMessage = error.localizedDescription
            }
            accepting = false
        }
    }

    private func submitCancel() {
        guard let task = cancelling else { return }
        let note = cancelNote.trimmingCharacters(in: .whitespacesAndNewlines)
        errorMessage = nil
        Task {
            do {
                try await store.cancelTask(task, note: note.isEmpty ? "Could not reach it" : note)
                await store.refresh()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
