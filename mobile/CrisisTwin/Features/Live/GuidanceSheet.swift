import SwiftUI
import UIKit
import CoreLocation

/// The one bottom sheet: the single instruction for the device's zone ("Leave via Pentz Road",
/// then "Chico shelter · 24 min  Start"), the reason and its age, a nearby "still there?" question,
/// and "I'm out" / "Need help" check-ins; for responders, the assigned task above it. The level
/// lives only in the status band. Reports its content height so the sheet fits it. Reads
/// `LiveStore` and `LocationProvider` from the environment.
struct GuidanceSheet: View {
    /// Called with the height the sheet needs to show all its content.
    var onHeight: (CGFloat) -> Void

    init(onHeight: @escaping (CGFloat) -> Void = { _ in }) {
        self.onHeight = onHeight
    }

    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @Environment(\.incidentActions) private var actions
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sending: CheckInStatus?
    @State private var confirmingHelp = false
    @State private var accepting = false
    @State private var cancelling: CheckTask?
    @State private var cancelNote = ""
    @State private var errorMessage: String?
    @State private var dismissedItems: Set<String> = []
    // Haptic triggers.
    @State private var selectionTick = 0
    @State private var successTick = 0
    @State private var errorTick = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let task = store.currentTask {
                    taskCard(task)
                    Rectangle().fill(Color.ctBorder).frame(height: 1)
                }
                instruction
                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(HazardTone.danger.color)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onHeight($0) }
            .animation(reduceMotion ? .easeInOut(duration: 0.2) : .snappy(duration: 0.35), value: store.myGuidance?.version)
            .animation(reduceMotion ? .easeInOut(duration: 0.2) : .snappy(duration: 0.35), value: stillThereItem?.id)
        }
        .scrollBounceBehavior(.basedOnSize)
        .sensoryFeedback(.selection, trigger: selectionTick)
        .sensoryFeedback(.success, trigger: successTick)
        .sensoryFeedback(.error, trigger: errorTick)
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
        case unavailable
        case outsideZones
        /// The zone has no published guidance yet.
        case noInstruction
        /// Published guidance with level `none`.
        case noOrder(ZoneGuidance)
        case evacuate(ZoneGuidance)
        case evacuateNoRoute(ZoneGuidance)
        case beReady(ZoneGuidance)
    }

    private var phase: Phase {
        if !location.isAuthorized {
            return .locationOff(denied: location.authorization == .denied || location.authorization == .restricted)
        }
        if store.situation == nil {
            if case .unavailable = store.connection { return .unavailable }
            return .connecting
        }
        if location.lastLocation == nil { return .locating }
        guard store.myZone != nil else { return .outsideZones }
        guard let guidance = store.myGuidance else { return .noInstruction }
        switch guidance.level {
        case .none: return .noOrder(guidance)
        case .evacuateNow:
            return guidance.noRoute || guidance.route == nil ? .evacuateNoRoute(guidance) : .evacuate(guidance)
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
            .buttonStyle(PrimaryButtonStyle(tint: .ctRoute))
        case .locating:
            HStack(spacing: 10) {
                ProgressView()
                headline("Finding your location")
            }
        case .connecting:
            HStack(spacing: 10) {
                ProgressView()
                headline("Connecting")
            }
        case .unavailable:
            headline("Can't reach the service")
            if !store.pending.isEmpty {
                meta(store.pending.count == 1 ? "1 report waiting to send" : "\(store.pending.count) reports waiting to send")
            }
        case .outsideZones:
            headline("You're outside the evacuation zones")
            stillThereRow
            checkIns
        case .noInstruction:
            headline("No instruction yet")
            stillThereRow
            checkIns
        case .noOrder(let guidance):
            guidanceHeadline("No order for your zone", version: guidance.version)
            about(guidance)
            stillThereRow
            checkIns
        case .evacuate(let guidance):
            guidanceHeadline(guidance.route?.via.first.map { "Leave via \($0)" } ?? "Leave now", version: guidance.version)
            destinationRow(guidance)
            about(guidance)
            stillThereRow
            checkIns
        case .evacuateNoRoute(let guidance):
            guidanceHeadline("Leave now. No open route.", version: guidance.version)
            about(guidance)
            stillThereRow
            needHelpFirst
        case .beReady(let guidance):
            guidanceHeadline("Be ready to leave", version: guidance.version)
            if guidance.route != nil, !guidance.noRoute, let line = plannedLine(guidance) {
                meta(line)
            }
            about(guidance)
            stillThereRow
            checkIns
        }
    }

    private func headline(_ text: String) -> some View {
        Text(text)
            .font(.title.bold())
            .foregroundStyle(Color.ctInk)
            .lineLimit(2)
            .minimumScaleFactor(0.85)
            .dynamicTypeSize(...DynamicTypeSize.accessibility2)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    /// The headline for published guidance; a new version pushes in from below.
    private func guidanceHeadline(_ text: String, version: Int) -> some View {
        headline(text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .id(version)
            .transition(reduceMotion ? .opacity : .push(from: .bottom))
            .clipped()
    }

    private func meta(_ text: String) -> some View {
        Text(text)
            .font(.footnote.monospacedDigit())
            .foregroundStyle(Color.ctMuted)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func plannedLine(_ guidance: ZoneGuidance) -> String? {
        var parts: [String] = []
        if let road = guidance.route?.via.first { parts.append("Via \(road)") }
        if let name = guidance.destination?.shortName { parts.append(name) }
        return parts.isEmpty ? nil : parts.joined(separator: " → ")
    }

    /// A zone whose start point is already at its exit has a zero-length route.
    private static func etaText(_ minutes: Int) -> String {
        minutes < 1 ? "<1 min" : "\(minutes) min"
    }

    /// "Exit west · 18 min" and Start. The destination is named only up to " via ", so the
    /// sheet never names a second road beside the headline's.
    private func destinationRow(_ guidance: ZoneGuidance) -> some View {
        HStack(alignment: .center, spacing: 12) {
            HStack(spacing: 6) {
                if let name = guidance.destination?.shortName {
                    Text(name)
                        .lineLimit(2)
                }
                if guidance.destination != nil, guidance.route?.etaMin != nil {
                    Text("·").foregroundStyle(Color.ctMuted).accessibilityHidden(true)
                }
                if let minutes = guidance.route?.etaMin {
                    Text(Self.etaText(minutes))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .fixedSize()
                        .accessibilityLabel(minutes < 1 ? "under 1 minute" : "\(minutes) minutes")
                }
            }
            .font(.title3.weight(.semibold))
            .foregroundStyle(Color.ctInk)
            .accessibilityElement(children: .combine)
            Spacer(minLength: 0)
            followButton
        }
    }

    /// The published reason and the guidance's age on the incident clock.
    private func about(_ guidance: ZoneGuidance) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            let reason = guidance.reason.trimmingCharacters(in: .whitespacesAndNewlines)
            if !reason.isEmpty {
                Text(reason)
                    .font(.subheadline)
                    .foregroundStyle(Color.ctInk)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            TimelineView(.periodic(from: .now, by: 30)) { context in
                let now = store.situation?.incidentNow(at: context.date) ?? context.date
                meta("Updated \(RelativeAge.text(from: guidance.asOf, to: now))")
            }
        }
    }

    private var followButton: some View {
        Button {
            selectionTick += 1
            actions.setFollowing(!actions.following)
        } label: {
            Text(actions.following ? "Stop" : "Start")
                .font(.headline)
                .foregroundStyle(actions.following ? Color.ctRoute : Color.white)
                .padding(.horizontal, 20)
                .frame(minHeight: 44)
                .background(actions.following ? Color.ctQuiet : Color.ctRoute, in: Capsule())
                .fixedSize()
        }
        .buttonStyle(.plain)
        .accessibilityHint(actions.following ? "Stops following your position" : "Follows your position on the route")
    }

    // MARK: Check-ins

    private var checkIns: some View {
        HStack(spacing: 10) {
            checkInButton(.out, title: "I'm out", systemImage: "checkmark.circle", tone: .ctInk)
            checkInButton(.needHelp, title: "Need help", systemImage: "sos", tone: HazardTone.danger.color)
        }
    }

    /// With no open route, asking for help is the primary action; "I'm out" stays beneath it.
    private var needHelpFirst: some View {
        VStack(spacing: 10) {
            checkInButton(.needHelp, title: "Need help", systemImage: "sos", tone: HazardTone.danger.color, prominent: true)
            checkInButton(.out, title: "I'm out", systemImage: "checkmark.circle", tone: .ctInk)
        }
    }

    private func checkInButton(_ status: CheckInStatus, title: String, systemImage: String, tone: Color,
                               prominent: Bool = false) -> some View {
        let sent = store.lastCheckIn?.status == status ? store.lastCheckIn : nil
        let filled = prominent || sent != nil
        return Button {
            if status == .needHelp { confirmingHelp = true } else { checkIn(status) }
        } label: {
            HStack(spacing: 8) {
                if sending == status {
                    ProgressView().controlSize(.small).tint(filled ? .ctOnTone : tone)
                } else {
                    Image(systemName: systemImage)
                        .font(.headline)
                        .symbolEffect(.bounce, value: sent?.id)
                }
                if let sent {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Sent").font(.headline)
                        Text(sent.at, style: .time).font(.caption.monospacedDigit())
                    }
                } else {
                    Text(title).font(.headline)
                }
            }
            .foregroundStyle(filled ? Color.ctOnTone : tone)
            .frame(maxWidth: .infinity, minHeight: prominent ? 56 : 52)
            .background(filled ? tone : Color.ctQuiet, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(sending != nil)
        .accessibilityLabel(sent.map { "\(title), sent \($0.at.formatted(date: .omitted, time: .shortened))" } ?? title)
        .accessibilityAddTraits(sent != nil ? .isSelected : [])
    }

    private func checkIn(_ status: CheckInStatus) {
        sending = status
        errorMessage = nil
        Task {
            do {
                try await store.checkIn(status)
                successTick += 1
            } catch {
                errorMessage = error.localizedDescription
                errorTick += 1
            }
            sending = nil
        }
    }

    // MARK: Still there?

    /// Nearest public hazard (crowd-reported or confirmed) within 500 m of the device, computed
    /// on the phone from the situation; nothing is sent to ask.
    private var stillThereItem: PublicMapItem? {
        guard let here = store.lastCoord, let hazards = store.situation?.hazards else { return nil }
        let origin = CLLocation(latitude: here.lat, longitude: here.lon)
        return hazards
            .filter { !dismissedItems.contains($0.id) }
            .map { ($0, origin.distance(from: CLLocation(latitude: $0.coord.lat, longitude: $0.coord.lon))) }
            .filter { $0.1 <= 500 }
            .min { $0.1 < $1.1 }?.0
    }

    @ViewBuilder private var stillThereRow: some View {
        if let item = stillThereItem {
            stillThere(item)
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
        }
    }

    private func stillThere(_ item: PublicMapItem) -> some View {
        let road = item.roadRef?.name
        let question: String
        switch item.kind {
        case .roadBlocked: question = "Is \(road ?? "this road") still blocked?"
        case .roadPassable: question = "Is \(road ?? "this road") still passable?"
        case .heavyTraffic: question = "Is traffic still heavy\(road.map { " on \($0)" } ?? "")?"
        default: question = "Still there: \(item.kind.title.lowercased())\(road.map { " near \($0)" } ?? "")?"
        }
        return HStack(spacing: 10) {
            Image(systemName: item.kind.systemImage)
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(item.kind.tone.color)
                .accessibilityHidden(true)
            Text(question)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.ctInk)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                answerStillThere(item, kind: item.kind)
            } label: {
                Text("Yes")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.ctSurface)
                    .frame(width: 64, height: 44)
                    .background(Color.ctInk, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Yes, still there")
            Button {
                if let gone = item.kind.goneKind {
                    answerStillThere(item, kind: gone)
                } else {
                    selectionTick += 1
                    dismissedItems.insert(item.id)
                }
            } label: {
                Text("No")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.ctInk)
                    .frame(width: 64, height: 44)
                    .background(Color.ctQuiet, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("No, gone")
        }
        .accessibilityElement(children: .contain)
    }

    private func answerStillThere(_ item: PublicMapItem, kind: ReportKind) {
        store.submit(ReportDraft(
            incidentId: store.incidentId,
            kind: kind,
            severity: kind.hasSeverity ? item.severity : nil,
            location: ReportLocation(coord: item.coord, accuracyM: nil),
            observedAt: Date()))
        selectionTick += 1
        dismissedItems.insert(item.id)
    }

    // MARK: Responder task

    private func taskCard(_ task: CheckTask) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Check \(store.targetName(task))")
                        .font(.headline)
                        .foregroundStyle(Color.ctInk)
                        .lineLimit(2)
                    if let note = task.note, !note.isEmpty {
                        Text(note)
                            .font(.subheadline)
                            .foregroundStyle(Color.ctMuted)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: 2) {
                    if let distance = distanceText(task) {
                        Text(distance)
                            .font(.subheadline.weight(.semibold).monospacedDigit())
                            .foregroundStyle(Color.ctInk)
                    }
                    if store.otherTaskCount > 0 {
                        Text("+\(store.otherTaskCount)")
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(Color.ctMuted)
                            .accessibilityLabel("\(store.otherTaskCount) more tasks")
                    }
                }
            }
            HStack(spacing: 10) {
                if task.status == .accepted {
                    Button {
                        actions.openReport(ReportPrefill(kind: nil, coord: store.taskTarget(task), taskId: task.id))
                    } label: {
                        taskLabel(Text("Answer"), filled: true)
                    }
                    .buttonStyle(.plain)
                } else {
                    Button {
                        accept(task)
                    } label: {
                        taskLabel(accepting ? nil : Text("Accept"), filled: true)
                    }
                    .buttonStyle(.plain)
                    .disabled(accepting)
                }
                Button {
                    cancelNote = ""
                    cancelling = task
                } label: {
                    taskLabel(Text("Can't reach"), filled: false)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.leading, 14)
        .background(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2).fill(HazardTone.info.color).frame(width: 4)
        }
    }

    /// A task button label; nil text shows progress.
    private func taskLabel(_ text: Text?, filled: Bool) -> some View {
        Group {
            if let text { text } else { ProgressView().controlSize(.small).tint(Color.ctOnTone) }
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(filled ? Color.ctOnTone : Color.ctInk)
        .frame(maxWidth: .infinity, minHeight: 44)
        .background(filled ? HazardTone.info.color : Color.ctQuiet, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(Rectangle())
    }

    /// On-device distance from the last fix to the task target.
    private func distanceText(_ task: CheckTask) -> String? {
        guard let here = store.lastCoord, let target = store.taskTarget(task) else { return nil }
        let meters = CLLocation(latitude: here.lat, longitude: here.lon)
            .distance(from: CLLocation(latitude: target.lat, longitude: target.lon))
        let miles = meters / 1609.344
        return miles < 10 ? String(format: "%.1f mi", miles) : "\(Int(miles.rounded())) mi"
    }

    private func accept(_ task: CheckTask) {
        accepting = true
        errorMessage = nil
        Task {
            do {
                try await store.acceptTask(task)
                successTick += 1
            } catch LiveAPIError.conflict {
                errorMessage = "Another responder took this task."
                errorTick += 1
                await store.refresh()
            } catch {
                errorMessage = error.localizedDescription
                errorTick += 1
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
                successTick += 1
                await store.refresh()
            } catch {
                errorMessage = error.localizedDescription
                errorTick += 1
            }
        }
    }
}

/// Responder task helpers shared by the sheet and the map.
extension LiveStore {
    private var openTasks: [CheckTask] {
        (situation?.tasks ?? tasks).filter { $0.status == .open || $0.status == .accepted }
    }

    /// The task to show: accepted first, then assigned to this device, then oldest. Nil for civilians.
    var currentTask: CheckTask? {
        guard role != .civilian else { return nil }
        let me = credential?.partyKey
        return openTasks.min { a, b in
            func rank(_ t: CheckTask) -> Int {
                if t.status == .accepted { return 0 }
                return t.assignee != nil && t.assignee == me ? 1 : 2
            }
            return rank(a) == rank(b) ? a.createdAt < b.createdAt : rank(a) < rank(b)
        }
    }

    var otherTaskCount: Int { max(0, openTasks.count - 1) }

    /// Where the task points: its coordinate, else a known hazard or report on its segment.
    func taskTarget(_ task: CheckTask) -> LonLat? {
        if let c = task.target.coord, c.isValid { return c }
        guard let id = task.target.segmentId else { return nil }
        return situation?.hazards.first { $0.roadRef?.segmentId == id }?.coord
            ?? allReports.first { $0.roadRef?.segmentId == id }?.location.coord
    }

    /// The road name for the task's segment, else "the marked place".
    func targetName(_ task: CheckTask) -> String {
        if let id = task.target.segmentId {
            let name = situation?.hazards.first { $0.roadRef?.segmentId == id }?.roadRef?.name
                ?? allReports.first { $0.roadRef?.segmentId == id }?.roadRef?.name
                ?? publicItems.first { $0.roadRef?.segmentId == id }?.roadRef?.name
            if let name { return name }
        }
        return "the marked place"
    }
}
