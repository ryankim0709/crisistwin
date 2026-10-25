import SwiftUI
import UIKit

/// Drive mode: a full-screen, voice-first view for use with the phone mounted or in a hand. It
/// shows the published guidance for the person's zone in very large type, reads each change aloud
/// on its own (deterministic sentences from the published guidance, see `DriveAnnouncer`; no AI
/// writes them), keeps the screen awake, and is operated with one big tap target. The same voice
/// assistant as the sheet answers questions and proposes reports; the AI's words are labelled, and
/// nothing is sent until Send is tapped or "yes" is heard.
struct DriveView: View {
    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @Environment(AppRouter.self) private var router
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .largeTitle) private var bigSize: CGFloat = 60

    @State private var agent = VoiceAgent(surface: .drive)

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: 12) {
                    topBar
                    verdictCard
                    conversation
                    if let action = agent.pending { proposalCard(action) }
                    if let message = agent.errorMessage { errorCard(message) }
                    if agent.audio.permission == .denied { deniedCard }
                    talkButton
                    footer
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .frame(minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(Color.ctBackground.ignoresSafeArea())
        // Dark and high contrast whatever the system setting: it is glanced at, often at night.
        .preferredColorScheme(.dark)
        .sensoryFeedback(.selection, trigger: agent.phase)
        .onAppear {
            UIApplication.shared.isIdleTimerDisabled = true
            agent.attach(store: store, location: location, router: router)
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            agent.stop()
        }
        .task {
            await agent.prepare()
            guard !Task.isCancelled else { return }
            agent.announce(DriveAnnouncer.entry(
                store.myGuidance, zone: nil,
                isDrill: store.situation?.incident?.isExercise ?? true))
        }
        // A new published version for this zone: read it out, over whatever is playing.
        .onChange(of: store.guidanceChange?.id) {
            guard let change = store.guidanceChange else { return }
            agent.announce(DriveAnnouncer.change(change, guidance: store.myGuidance))
        }
        // The service went away: say what the last instruction was.
        .onChange(of: store.offlineSince != nil) { _, offline in
            guard offline else { return }
            agent.announce(DriveAnnouncer.offline(store.myGuidance))
        }
        .onChange(of: agent.phase) { _, phase in
            if phase == .listening { AccessibilityNotification.Announcement("Listening").post() }
        }
    }

    // MARK: Top bar

    private var topBar: some View {
        HStack(spacing: 12) {
            Label("Drive mode", systemImage: "car.fill")
                .font(.headline)
                .foregroundStyle(Color.ctInk)
                .accessibilityAddTraits(.isHeader)
            if store.situation?.incident?.isExercise ?? true {
                Text("Drill")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Color.ctWarning)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Color.ctWarningSoft, in: .capsule)
                    .overlay(Capsule().strokeBorder(Color.ctWarning, lineWidth: 1))
                    .accessibilityLabel("Drill, not a real incident")
            }
            Spacer(minLength: 8)
            Button {
                agent.stop()
                router.drive = false
            } label: {
                Label("End drive", systemImage: "xmark")
                    .font(.headline)
                    .foregroundStyle(Color.ctInk)
                    .padding(.horizontal, 18)
                    .frame(minHeight: 56)
                    .background(Color.ctSurfaceRaised, in: .capsule)
                    .overlay(Capsule().strokeBorder(Color.ctInk.opacity(0.6), lineWidth: 2))
                    .contentShape(.capsule)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("End drive")
            .accessibilityHint("Closes Drive mode")
        }
    }

    // MARK: Guidance

    @ViewBuilder private var verdictCard: some View {
        if let guidance = store.activeGuidance {
            let level = guidance.level
            VStack(alignment: .leading, spacing: 10) {
                Label {
                    Text(level.verdict(zone: nil))
                        .font(.system(.largeTitle, weight: .heavy))
                        .lineLimit(2)
                        .minimumScaleFactor(0.6)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: level.symbol)
                        .font(.system(.title, weight: .bold))
                }
                .accessibilityAddTraits(.isHeader)

                if guidance.hasRoute {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            if let via = guidance.viaText {
                                Text(via)
                                    .font(.title2.weight(.bold))
                            }
                            if let destination = guidance.destination {
                                Text("To \(destination.shortName)")
                                    .font(.title3.weight(.semibold))
                            }
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        if let eta = guidance.etaText {
                            Text(eta)
                                .font(.system(size: bigSize, weight: .heavy))
                                .monospacedDigit()
                                .minimumScaleFactor(0.5)
                                .lineLimit(1)
                        }
                    }
                } else if level == .evacuateNow {
                    Label("No open route", systemImage: "exclamationmark.octagon.fill")
                        .font(.title2.weight(.bold))
                } else {
                    Text(level.meaning)
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let caveat = store.caveatText(for: guidance) {
                    Label(caveat, systemImage: "flame.fill")
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                }

                GuidanceProvenance(
                    guidance: guidance, offlineSince: store.offlineSince,
                    incidentNow: { store.situation?.incidentNow(at: $0) ?? $0 })
                    .font(.subheadline.weight(.medium))
            }
            .foregroundStyle(level.onFill)
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(level.fill ?? .clear, in: .rect(cornerRadius: 24, style: .continuous))
            .accessibilityElement(children: .combine)
        } else {
            noOrderCard
        }
    }

    private var noOrderCard: some View {
        let zone = store.myZone?.name
        return VStack(alignment: .leading, spacing: 8) {
            Label {
                Text(zone != nil
                    ? GuidanceLevel.none.verdict(zone: nil)
                    : store.situation == nil ? "Waiting for guidance"
                    : location.lastLocation == nil ? "Finding your area"
                    : "No emergency near you")
                    .font(.system(.title, weight: .bold))
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: GuidanceLevel.none.symbol)
                    .font(.title)
            }
            .foregroundStyle(Color.ctInk)
            if zone != nil {
                Text(GuidanceLevel.none.meaning)
                    .font(.title3)
                    .foregroundStyle(Color.ctInkMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let place = location.placeName {
                Label("Near \(place)", systemImage: "location.fill")
                    .font(.title3)
                    .foregroundStyle(Color.ctInkMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let since = store.offlineSince {
                Label("Offline. Guidance from \(since.formatted(date: .omitted, time: .shortened)).",
                      systemImage: "wifi.slash")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.ctInk)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.ctSurface, in: .rect(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Color.ctBorder, lineWidth: 2))
        .accessibilityElement(children: .combine)
    }

    // MARK: Conversation

    /// What is being said right now: an announcement, what is being heard, or the last exchange.
    @ViewBuilder private var conversation: some View {
        if let text = agent.announcement {
            VStack(alignment: .leading, spacing: 4) {
                Label("Guidance announcement", systemImage: "speaker.wave.2.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.ctInkMuted)
                Text(text)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color.ctInk)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Read from the published guidance. Not written by AI.")
                    .font(.footnote)
                    .foregroundStyle(Color.ctInkMuted)
            }
            .accessibilityElement(children: .combine)
            .panel()
        } else if agent.phase == .listening {
            let words = agent.caption.trimmingCharacters(in: .whitespacesAndNewlines)
            Text(words.isEmpty ? "Listening\u{2026}" : words)
                .font(.title3.weight(.medium))
                .foregroundStyle(words.isEmpty ? Color.ctInkMuted : Color.ctInk)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .panel()
                .accessibilityLabel(words.isEmpty ? "Listening" : "Hearing: \(words)")
        } else if let turn = agent.turns.last {
            lastTurn(turn)
        }
    }

    private func lastTurn(_ turn: VoiceTurnLog) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\u{201C}\(turn.heard)\u{201D}")
                .font(.body)
                .foregroundStyle(Color.ctInkMuted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("You said: \(turn.heard)")
            if !turn.reply.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Label("AI assistant", systemImage: "sparkles")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.ctInkMuted)
                    Text(turn.reply)
                        .font(.title3.weight(.medium))
                        .foregroundStyle(Color.ctInk)
                        .fixedSize(horizontal: false, vertical: true)
                    if let attribution = turn.attribution {
                        Text(attribution)
                            .font(.footnote)
                            .foregroundStyle(Color.ctInkMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let sources = turn.sourcesCaption {
                        Text(sources)
                            .font(.footnote)
                            .foregroundStyle(Color.ctInkMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                    ["AI assistant says: \(turn.reply)", turn.attributionSpoken, turn.sourcesSpoken].compactMap { $0 }.joined(separator: ". "))
            }
            if let result = turn.result {
                Label(result, systemImage: turn.failed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .font(.headline)
                    .foregroundStyle(turn.failed ? Color.ctWarning : Color.ctSuccess)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if agent.canUndo(turn) {
                Button { agent.undoLastReport() } label: {
                    Label("Undo", systemImage: "arrow.uturn.backward")
                }
                .buttonStyle(DriveButtonStyle(prominent: false))
                .disabled(agent.isBusy)
                .accessibilityLabel("Undo")
                .accessibilityHint("Takes back the report the assistant just filed")
            }
            if turn.showsEmergencyLine { emergencyLine }
        }
        .panel()
    }

    private var emergencyLine: some View {
        Label("If you are in danger, call 911.", systemImage: "phone.fill")
            .font(.headline)
            .foregroundStyle(Color.ctDanger)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Proposal

    /// A proposed report or check-in, with Send and Cancel sized to hit without looking. The AI
    /// wrote it; the person sends it.
    @ViewBuilder private func proposalCard(_ action: VoiceAction) -> some View {
        let summary = Self.summary(action)
        if let summary {
            VStack(alignment: .leading, spacing: 10) {
                Text("Proposed by the AI assistant")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.ctInkMuted)
                    .textCase(.uppercase)
                    .accessibilityAddTraits(.isHeader)
                Label(summary.title, systemImage: summary.symbol)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(summary.urgent ? Color.ctDanger : Color.ctInk)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = summary.detail {
                    Text(detail)
                        .font(.body)
                        .foregroundStyle(Color.ctInkMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if summary.urgent { emergencyLine }
                Text("Nothing is sent until you tap Send or say yes.")
                    .font(.footnote)
                    .foregroundStyle(Color.ctInkMuted)
                    .fixedSize(horizontal: false, vertical: true)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { proposalButtons }
                    VStack(spacing: 12) { proposalButtons }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.ctSurfaceRaised, in: .rect(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Color.ctBrand, lineWidth: 2))
        }
    }

    @ViewBuilder private var proposalButtons: some View {
        Button { agent.confirmPending() } label: {
            Label("Send", systemImage: "paperplane.fill")
        }
        .buttonStyle(DriveButtonStyle(prominent: true))
        .disabled(agent.isBusy)
        .accessibilityLabel("Send")
        Button { agent.cancelPending() } label: {
            Label("Cancel", systemImage: "xmark")
        }
        .buttonStyle(DriveButtonStyle(prominent: false))
        .disabled(agent.isBusy)
        .accessibilityLabel("Cancel")
    }

    private struct ProposalSummary {
        var title: String
        var symbol: String
        var detail: String?
        var urgent = false
    }

    private static func summary(_ action: VoiceAction) -> ProposalSummary? {
        switch action {
        case .report(let kind, let severity, let note):
            let detail = [severity?.title, note.map { "\u{201C}\($0)\u{201D}" }, "At your current location."]
                .compactMap { $0 }.joined(separator: ". ")
            return ProposalSummary(
                title: "Report: \(kind.title)", symbol: kind.systemImage, detail: detail,
                urgent: kind == .helpNeeded)
        case .checkIn(let status):
            switch status {
            case .out:
                return ProposalSummary(title: "Check in: I'm out", symbol: "checkmark.circle")
            case .staying:
                return ProposalSummary(title: "Check in: I'm staying", symbol: "house")
            case .needHelp:
                return ProposalSummary(
                    title: "Check in: I need help", symbol: "hand.raised.fill",
                    detail: "This sends your location to responders.", urgent: true)
            }
        default:
            return nil
        }
    }

    // MARK: Errors

    private func errorCard(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(Color.ctWarning)
                .fixedSize(horizontal: false, vertical: true)
            Button { agent.retry() } label: {
                Label("Try again", systemImage: "arrow.clockwise")
            }
            .buttonStyle(DriveButtonStyle(prominent: false))
            .accessibilityLabel("Try that again")
        }
        .panel()
    }

    private var deniedCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Microphone access is off. Turn it on in Settings to talk.", systemImage: "mic.slash.fill")
                .font(.headline)
                .foregroundStyle(Color.ctInk)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            } label: {
                Label("Open Settings", systemImage: "gearshape")
            }
            .buttonStyle(DriveButtonStyle(prominent: false))
            .accessibilityLabel("Open Settings to allow the microphone")
        }
        .panel()
    }

    // MARK: Talk

    private var statusWords: String {
        if let reason = agent.onDeviceReason, agent.phase == .idle {
            return "Voice input is off. \(reason)"
        }
        switch agent.phase {
        case .idle: return agent.audio.permission == .denied ? "Microphone is off" : "Tap to talk"
        case .listening: return "Listening. Tap to send."
        case .thinking: return "Thinking"
        case .speaking: return "Speaking. Tap to talk."
        }
    }

    private var talkEnabled: Bool {
        switch agent.phase {
        case .idle: return agent.canListen && agent.audio.permission != .denied
        case .listening, .speaking: return true
        case .thinking: return false
        }
    }

    /// The one big target: most of the screen. Its words change with what the phone is doing, so
    /// state never rests on colour.
    private var talkButton: some View {
        let active = agent.phase == .listening
        return Button { agent.toggleListening() } label: {
            VStack(spacing: 12) {
                Group {
                    switch agent.phase {
                    case .idle:
                        Image(systemName: agent.canListen ? "mic.fill" : "mic.slash.fill")
                    case .listening:
                        Image(systemName: "stop.fill")
                    case .thinking:
                        ProgressView().controlSize(.extraLarge)
                    case .speaking:
                        Image(systemName: "waveform")
                            .symbolEffect(.variableColor.iterative, isActive: !reduceMotion)
                    }
                }
                .font(.system(size: 64, weight: .bold))
                Text(statusWords)
                    .font(.title.weight(.bold))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(talkEnabled && agent.phase != .speaking ? Color.ctBackground : Color.ctInk)
            .padding(16)
            .frame(maxWidth: .infinity, minHeight: 200, maxHeight: .infinity)
            .background(talkFill, in: .rect(cornerRadius: 32, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 32, style: .continuous)
                    .strokeBorder(Color.ctBrand, lineWidth: active ? 4 + CGFloat(agent.audio.level) * 14 : 3)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.1), value: agent.audio.level)
            }
            .contentShape(.rect(cornerRadius: 32))
        }
        .buttonStyle(.plain)
        .disabled(!talkEnabled)
        .accessibilityLabel(agent.phase == .listening ? "Stop listening and send" : "Talk")
        .accessibilityValue(statusWords)
        .accessibilityIdentifier("drive-talk")
    }

    private var talkFill: Color {
        switch agent.phase {
        case .idle: return talkEnabled ? Color.ctBrand : Color.ctSurface
        case .listening: return Color.ctBrandStrong
        case .thinking, .speaking: return Color.ctSurfaceRaised
        }
    }

    private var footer: some View {
        Text("Drill assistant. AI replies are not official instructions. Guidance changes are read from the published guidance. If you are in danger, call 911.")
            .font(.footnote)
            .foregroundStyle(Color.ctInkMuted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Big, plain buttons for a glance: solid brand fill for the main action, an outline for the other.
private struct DriveButtonStyle: ButtonStyle {
    var prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.title2.weight(.bold))
            .foregroundStyle(prominent ? Color.ctBackground : Color.ctInk)
            .frame(maxWidth: .infinity, minHeight: 72)
            .padding(.horizontal, 16)
            .background(prominent ? Color.ctBrand : Color.ctSurface, in: .rect(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(prominent ? Color.ctBrand : Color.ctInk.opacity(0.6), lineWidth: 2))
            .opacity(configuration.isPressed ? 0.8 : 1)
            .contentShape(.rect(cornerRadius: 20))
    }
}

private extension View {
    /// A dark panel with a visible border, for text read at a glance.
    func panel() -> some View {
        padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.ctSurface, in: .rect(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color.ctBorder, lineWidth: 2))
    }
}

#Preview {
    DriveView()
        .environment(LiveStore())
        .environment(LocationProvider())
        .environment(AppRouter())
}
