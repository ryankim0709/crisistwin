import SwiftUI
import UIKit

/// The voice sheet: talk to the AI assistant to file a report, check in, or jump to a screen. The
/// conversation shows what was heard and what the assistant said (labelled as AI). A proposed
/// report or check-in waits on a card until the person taps Send; nothing leaves the phone before
/// that. It is a drill assistant, not an official channel.
struct VoiceView: View {
    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var agent = VoiceAgent()
    @State private var typing = false
    @State private var draft = ""
    @FocusState private var typingFocused: Bool

    private static let examples = ["Pentz Road is blocked", "I'm out of the area", "Where do I go?"]

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let reason = agent.onDeviceReason { onDeviceCard(reason) }
                        if agent.turns.isEmpty && agent.errorMessage == nil && agent.phase != .listening { emptyState }
                        ForEach(agent.turns) { turn in
                            TurnView(
                                turn: turn,
                                canUndo: agent.canUndo(turn),
                                busy: agent.isBusy,
                                onUndo: { agent.undoLastReport() })
                        }
                        if agent.phase == .listening { captionBubble }
                        if let action = agent.pending { pendingCard(action) }
                        if let message = agent.errorMessage { errorCard(message) }
                        if agent.audio.permission == .denied { deniedCard }
                        footer
                        Color.clear.frame(height: 1).id("voice-bottom")
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 16)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: agent.turns.count) { scrollDown(proxy) }
                .onChange(of: agent.pending) { scrollDown(proxy) }
                .onChange(of: agent.errorMessage) { scrollDown(proxy) }
                .onChange(of: agent.phase) { scrollDown(proxy) }
                .onChange(of: agent.caption) { scrollDown(proxy) }
                .onChange(of: agent.turns.last?.reply) { scrollDown(proxy) }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { controls }
            .ctScreenBackground()
            .navigationTitle("Voice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                }
            }
        }
        .presentationBackground(Color.ctBackground)
        .sensoryFeedback(.selection, trigger: agent.phase)
        .onAppear { agent.attach(store: store, location: location, router: router) }
        .task { await agent.prepare() }
        .onDisappear { agent.stop() }
        .onChange(of: agent.onDeviceReason != nil) { _, onDevice in
            if onDevice { typing = true }
        }
        .onChange(of: agent.phase) { _, phase in
            if phase == .listening { AccessibilityNotification.Announcement("Listening").post() }
        }
    }

    private func scrollDown(_ proxy: ScrollViewProxy) {
        withAnimation(reduceMotion ? nil : .snappy) { proxy.scrollTo("voice-bottom", anchor: .bottom) }
    }

    // MARK: Content

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Say what you see, or ask where to go.", systemImage: "waveform")
                .font(.ctTitle)
                .foregroundStyle(Color.ctInk)
                .fixedSize(horizontal: false, vertical: true)
            Text("Try saying")
                .font(.subheadline)
                .foregroundStyle(Color.ctInkMuted)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Self.examples, id: \.self) { example in
                    Button { agent.send(text: example) } label: {
                        Text("\u{201C}\(example)\u{201D}")
                            .font(.body)
                            .foregroundStyle(Color.ctInk)
                            .multilineTextAlignment(.leading)
                            .padding(.horizontal, 12)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .background(Color.ctBrandSoft, in: .capsule)
                            .contentShape(.capsule)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Ask: \(example)")
                    .accessibilityHint("Sends these words as text")
                }
            }
        }
        .ctPanel()
    }

    private var footer: some View {
        Text(footerText)
            .font(.footnote)
            .foregroundStyle(Color.ctInkMuted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 4)
    }

    private var footerText: String {
        if agent.onDeviceReason != nil {
            return "Drill assistant. Your typed words go to the CrisisTwin server; replies are read aloud by this phone. Nothing is saved. If you are in danger, call 911."
        }
        return "Drill assistant. While you talk, your voice is streamed to Cartesia to be transcribed, and Cartesia speaks the reply; the words go to the CrisisTwin server. Nothing is saved. If you are in danger, call 911."
    }

    /// What the assistant is hearing right now, word by word.
    private var captionBubble: some View {
        let words = agent.caption.trimmingCharacters(in: .whitespacesAndNewlines)
        return Text(words.isEmpty ? "Listening\u{2026}" : words)
            .font(.body)
            .foregroundStyle(words.isEmpty ? Color.ctInkMuted : Color.ctInk)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.ctBrandSoft, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .frame(maxWidth: .infinity, alignment: .trailing)
            .accessibilityLabel(words.isEmpty ? "Listening" : "Hearing: \(words)")
    }

    private func onDeviceCard(_ reason: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Using on-device voice", systemImage: "iphone")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.ctInk)
            Text("\(reason) You can type, and replies are read aloud by this phone.")
                .font(.footnote)
                .foregroundStyle(Color.ctInkMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .ctPanel()
    }

    private func errorCard(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(Color.ctWarning)
                .fixedSize(horizontal: false, vertical: true)
            Button("Try again") { agent.retry() }
                .buttonStyle(CTPillButtonStyle(prominent: false))
                .accessibilityLabel("Try that again")
        }
        .ctPanel()
    }

    private var deniedCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Microphone access is off. Turn it on in Settings to talk, or type instead.",
                  systemImage: "mic.slash.fill")
                .foregroundStyle(Color.ctInk)
                .fixedSize(horizontal: false, vertical: true)
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }
            .buttonStyle(CTPillButtonStyle(prominent: true))
            .accessibilityLabel("Open Settings to allow the microphone")
        }
        .ctPanel()
    }

    // MARK: Proposal

    /// A proposed report or check-in. The AI wrote it; the person sends it.
    @ViewBuilder private func pendingCard(_ action: VoiceAction) -> some View {
        switch action {
        case .report(let kind, let severity, let note):
            reportCard(kind: kind, severity: severity, note: note)
        case .checkIn(let status):
            checkInCard(status)
        default:
            EmptyView()
        }
    }

    private func reportCard(kind: ReportKind, severity: ReportSeverity?, note: String?) -> some View {
        let place = placeWords
        return VStack(alignment: .leading, spacing: 12) {
            proposalHeader("Proposed report")
            Label {
                Text(kind.title)
                    .font(.headline)
                    .foregroundStyle(Color.ctInk)
            } icon: {
                Image(systemName: kind.systemImage)
                    .foregroundStyle(kind.symbolColor)
            }
            if let severity {
                Text(severity.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.ctInk)
            }
            if let note {
                Text("\u{201C}\(note)\u{201D}")
                    .font(.subheadline)
                    .foregroundStyle(Color.ctInkMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(place.primary)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.ctInk)
                    if let secondary = place.secondary {
                        Text(secondary)
                            .font(.footnote)
                            .foregroundStyle(Color.ctInkMuted)
                    }
                }
            } icon: {
                Image(systemName: "mappin.and.ellipse")
                    .foregroundStyle(Color.ctBrand)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Report goes here: \([place.primary, place.secondary].compactMap { $0 }.joined(separator: ", "))")
            if kind == .helpNeeded { emergencyLine }
            proposalButtons(canEdit: true)
        }
        .ctPanel()
    }

    private func checkInCard(_ status: CheckInStatus) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            proposalHeader("Proposed check-in")
            Label {
                Text(Self.checkInTitle(status))
                    .font(.headline)
                    .foregroundStyle(status == .needHelp ? Color.ctDanger : Color.ctInk)
            } icon: {
                Image(systemName: Self.checkInSymbol(status))
                    .foregroundStyle(status == .needHelp ? Color.ctDanger : Color.ctBrand)
            }
            if status == .needHelp {
                Text("This sends your location to responders.")
                    .font(.subheadline)
                    .foregroundStyle(Color.ctInkMuted)
                emergencyLine
            }
            proposalButtons(canEdit: false)
        }
        .ctPanel()
    }

    private func proposalHeader(_ title: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.ctInkMuted)
                .textCase(.uppercase)
                .accessibilityAddTraits(.isHeader)
            Text("Written by the AI assistant. Nothing is sent until you tap Send.")
                .font(.footnote)
                .foregroundStyle(Color.ctInkMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var emergencyLine: some View {
        Label("If you are in danger, call 911.", systemImage: "phone.fill")
            .font(.headline)
            .foregroundStyle(Color.ctDanger)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func proposalButtons(canEdit: Bool) -> some View {
        let busy = agent.isBusy
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { buttons(canEdit: canEdit, busy: busy) }
            VStack(spacing: 8) { buttons(canEdit: canEdit, busy: busy) }
        }
    }

    @ViewBuilder private func buttons(canEdit: Bool, busy: Bool) -> some View {
        Button { agent.confirmPending() } label: {
            Label("Send", systemImage: "paperplane.fill")
        }
        .buttonStyle(CTPillButtonStyle(prominent: true, fullWidth: true))
        .disabled(busy)
        .accessibilityLabel("Send")
        if canEdit {
            Button { agent.editPending() } label: {
                Label("Edit", systemImage: "pencil")
            }
            .buttonStyle(CTPillButtonStyle(prominent: false, fullWidth: true))
            .disabled(busy)
            .accessibilityLabel("Edit in the report form")
        }
        Button { agent.cancelPending() } label: {
            Label("Cancel", systemImage: "xmark")
        }
        .buttonStyle(CTPillButtonStyle(prominent: false, fullWidth: true))
        .disabled(busy)
        .accessibilityLabel("Cancel")
    }

    /// Where the report would be placed: the device's fix, in the words the report sheet uses.
    private var placeWords: (primary: String, secondary: String?) {
        guard let fix = location.lastLocation else {
            return ("No location yet", "You will place the pin on the report form.")
        }
        let here = LonLat(lon: fix.coordinate.longitude, lat: fix.coordinate.latitude)
        let road = store.nearestRoad(to: here)
        let offset = store.offsetFromHere(here)
        guard let road else { return ("Your location", nil) }
        return (road, offset)
    }

    private static func checkInTitle(_ status: CheckInStatus) -> String {
        switch status {
        case .out: return "I'm out of the area"
        case .staying: return "I'm staying"
        case .needHelp: return "I need help"
        }
    }

    private static func checkInSymbol(_ status: CheckInStatus) -> String {
        switch status {
        case .out: return "checkmark.circle"
        case .staying: return "house"
        case .needHelp: return "hand.raised.fill"
        }
    }

    // MARK: Controls

    private var controls: some View {
        VStack(spacing: 10) {
            micButton
            Text(statusWords)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.ctInk)
                .accessibilityHidden(true)
            typeInstead
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
        .background(Color.ctBackground)
    }

    private var statusWords: String {
        switch agent.phase {
        case .idle:
            if !agent.canListen { return "Voice input is off. Type instead." }
            return agent.audio.permission == .denied ? "Microphone is off" : "Tap to talk"
        case .listening: return "Listening. Tap to send."
        case .thinking: return "Thinking"
        case .speaking: return agent.canListen ? "Speaking. Tap to interrupt and talk." : "Speaking. Tap to stop."
        }
    }

    private var micLabel: String {
        switch agent.phase {
        case .idle: return agent.canListen ? "Talk" : "Talk, unavailable"
        case .listening: return "Stop listening and send"
        case .thinking: return "Thinking"
        case .speaking: return agent.canListen ? "Stop speaking and talk" : "Stop speaking"
        }
    }

    private static let micSize: CGFloat = 76

    private var micButton: some View {
        Button { agent.toggleListening() } label: {
            ZStack {
                switch agent.phase {
                case .idle:
                    Image(systemName: "mic.fill")
                case .listening:
                    Image(systemName: "stop.fill")
                case .thinking:
                    ProgressView()
                case .speaking:
                    Image(systemName: "waveform")
                        .symbolEffect(.variableColor.iterative, isActive: !reduceMotion)
                }
            }
            .font(.system(size: 30, weight: .semibold))
            .foregroundStyle(Color.ctSurface)
            .frame(width: Self.micSize, height: Self.micSize)
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.tint(Color.ctBrand).interactive(), in: .circle)
        .background {
            if agent.phase == .listening {
                Circle()
                    .strokeBorder(Color.ctBrand, lineWidth: 4)
                    .scaleEffect(reduceMotion ? 1.15 : 1 + CGFloat(agent.audio.level) * 0.45)
                    .opacity(0.7)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.1), value: agent.audio.level)
                    .accessibilityHidden(true)
            }
        }
        .frame(width: Self.micSize * 1.5, height: Self.micSize * 1.2)
        .disabled(agent.phase == .thinking || (agent.phase == .idle && (agent.audio.permission == .denied || !agent.canListen)))
        .accessibilityLabel(micLabel)
        .accessibilityValue(statusWords)
    }

    @ViewBuilder private var typeInstead: some View {
        if typing {
            HStack(spacing: 8) {
                TextField("Type instead", text: $draft)
                    .focused($typingFocused)
                    .onAppear { typingFocused = true }
                    .submitLabel(.send)
                    .onSubmit(sendTyped)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    .background(Color.ctSurfaceSunken, in: .capsule)
                    .overlay(Capsule().strokeBorder(Color.ctBorderSubtle))
                    .accessibilityLabel("Type a message to the assistant")
                Button(action: sendTyped) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(canSendTyped ? Color.ctBrand : Color.ctInkSubtle)
                        .frame(width: 44, height: 44)
                        .contentShape(.circle)
                }
                .buttonStyle(.plain)
                .disabled(!canSendTyped)
                .accessibilityLabel("Send message")
            }
        } else {
            Button { typing = true } label: {
                Label("Type instead", systemImage: "keyboard")
                    .font(.subheadline)
                    .foregroundStyle(Color.ctBrand)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    .contentShape(.capsule)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Type instead")
        }
    }

    private var canSendTyped: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !agent.isBusy
    }

    private func sendTyped() {
        guard canSendTyped else { return }
        agent.send(text: draft)
        draft = ""
    }
}

/// One exchange: what was heard on the right, the AI assistant's reply on the left, then what the
/// phone did.
private struct TurnView: View {
    let turn: VoiceTurnLog
    var canUndo = false
    var busy = false
    var onUndo: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(turn.heard)
                .font(.body)
                .foregroundStyle(Color.ctInk)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.ctBrandSoft, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .accessibilityLabel("You said: \(turn.heard)")
            if !turn.reply.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Label("AI assistant", systemImage: "sparkles")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.ctInkMuted)
                    Text(turn.reply)
                        .font(.body)
                        .foregroundStyle(Color.ctInk)
                        .fixedSize(horizontal: false, vertical: true)
                    if let attribution = turn.attribution {
                        Text(attribution)
                            .font(.caption)
                            .foregroundStyle(Color.ctInkMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let sources = turn.sourcesCaption {
                        Text(sources)
                            .font(.caption)
                            .foregroundStyle(Color.ctInkMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.ctSurface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.ctBorder))
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                    ["AI assistant says: \(turn.reply)", turn.attributionSpoken, turn.sourcesSpoken].compactMap { $0 }.joined(separator: ". "))
            }
            if let result = turn.result {
                Label(result, systemImage: turn.failed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(turn.failed ? Color.ctWarning : Color.ctSuccess)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if canUndo {
                Button(action: onUndo) {
                    Label("Undo", systemImage: "arrow.uturn.backward")
                }
                .buttonStyle(CTPillButtonStyle(prominent: false))
                .disabled(busy)
                .accessibilityLabel("Undo")
                .accessibilityHint("Takes back the report the assistant just filed")
            }
            if turn.showsEmergencyLine {
                Label("If you are in danger, call 911.", systemImage: "phone.fill")
                    .font(.headline)
                    .foregroundStyle(Color.ctDanger)
            }
        }
    }
}

#Preview {
    VoiceView()
        .environment(LiveStore())
        .environment(LocationProvider())
        .environment(AppRouter())
}
