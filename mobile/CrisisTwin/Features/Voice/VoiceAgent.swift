import CoreLocation
import Foundation
import Observation

/// One exchange in the voice sheet: what was heard, what the AI assistant said, and what the phone
/// then did about it.
struct VoiceTurnLog: Identifiable, Equatable {
    let id = UUID()
    /// The transcript (or the typed words).
    var heard: String
    /// The assistant's reply, as spoken and shown. AI output, never an official instruction.
    var reply: String
    /// What the phone did: "Sent", "Saved, sends when online", "Checked in: I'm out".
    var result: String?
    /// The result is a failure, so the sheet words it as one.
    var failed = false
    /// Show "If you are in danger, call 911." under this turn.
    var showsEmergencyLine = false
}

/// The voice assistant's controller: record, ask the server, speak the reply, and act on what the
/// model proposes. The model only proposes. A report or check-in waits in `pending` until the person
/// taps Send or says yes, and the phone validates it again before anything leaves it (ADR 0011).
/// Nothing is stored: the log lives in memory for as long as the sheet is open.
@MainActor
@Observable
final class VoiceAgent {
    enum Phase { case idle, listening, thinking, speaking }

    /// Microphone, playback and the input level for the sheet's ring.
    let audio = VoiceAudio()
    private(set) var phase: Phase = .idle
    private(set) var turns: [VoiceTurnLog] = []
    /// A proposed report or check-in awaiting Send.
    private(set) var pending: VoiceAction?
    private(set) var errorMessage: String?
    /// After the assistant asks "Send it?", listen again on its own.
    var handsFree = true

    /// The words or audio of the last turn, kept so Retry can run it again.
    private var retryInput: (audioB64: String?, text: String?)?
    private var lastInputWasVoice = false
    /// This recording was started by hands-free after "Send it?"; silence then just ends it.
    private var autoListening = false
    private var task: Task<Void, Never>?
    /// Bumped whenever speech starts or is cancelled, so a finished or stopped clip is ignored.
    private var speechToken = 0
    /// Runs once the reply has been spoken (closing the sheet, opening the report sheet).
    private var afterSpeech: (() -> Void)?

    private var store: LiveStore?
    private var location: LocationProvider?
    private var router: AppRouter?

    private static let emergencyLine = "If you are in danger, call 911."
    private static let noteLimit = 280

    init() {
        audio.onFinishedRecording = { [weak self] data in self?.finishedRecording(data) }
    }

    /// Wires the app's stores in; the view calls this when it appears.
    func attach(store: LiveStore, location: LocationProvider, router: AppRouter) {
        self.store = store
        self.location = location
        self.router = router
    }

    // MARK: Controls

    /// The mic button: start, stop and send, or stop the reply.
    func toggleListening() {
        switch phase {
        case .idle:
            beginListening()
        case .listening:
            // Still waiting on the permission prompt: nothing is recording yet, so just stand down.
            guard audio.isRecording else {
                task?.cancel()
                phase = .idle
                return
            }
            audio.stopRecording()
        case .thinking:
            break
        case .speaking:
            speechToken += 1
            audio.stopPlayback()
            phase = .idle
            runAfterSpeech()
        }
    }

    /// The typed fallback. Typed turns are answered in text only.
    func send(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, phase != .thinking else { return }
        interrupt()
        run(audioB64: nil, text: String(trimmed.prefix(500)), spoken: false)
    }

    /// Runs the last turn again after an error.
    func retry() {
        guard let input = retryInput, phase == .idle else { return }
        run(audioB64: input.audioB64, text: input.text, spoken: input.audioB64 != nil)
    }

    /// Send on the proposal card.
    func confirmPending() {
        guard let action = pending, phase != .thinking else { return }
        interrupt()
        phase = .thinking
        task = Task {
            let outcome = await perform(action)
            guard !Task.isCancelled else { return }
            if outcome.succeeded { pending = nil }
            record(outcome, on: turns.last?.id)
            phase = .idle
            outcome.afterSpeech?()
        }
    }

    /// Cancel on the proposal card.
    func cancelPending() {
        pending = nil
    }

    /// Edit on the proposal card: the report sheet opens with the proposal filled in.
    func editPending() {
        guard case .report(let kind, let severity, let note)? = pending else { return }
        pending = nil
        interrupt()
        handOffToReportSheet(ReportPrefill(kind: kind, severity: severity, note: note))
    }

    /// The sheet is going away: cancel recording, the request and playback.
    func stop() {
        task?.cancel()
        task = nil
        interrupt()
        phase = .idle
    }

    // MARK: Listening

    private func beginListening(auto: Bool = false) {
        autoListening = auto
        errorMessage = nil
        phase = .listening
        task = Task {
            if audio.permission != .granted, await audio.requestPermission() == false {
                if phase == .listening { phase = .idle }
                return
            }
            guard phase == .listening, !Task.isCancelled else { return }
            do {
                try audio.startRecording()
            } catch {
                errorMessage = "The microphone could not start. Try again, or type instead."
                phase = .idle
            }
        }
    }

    private func finishedRecording(_ data: Data?) {
        guard phase == .listening else { return }
        guard let data else {
            if autoListening {
                phase = .idle
                return
            }
            errorMessage = "I did not hear anything. Tap the mic and try again, or type instead."
            retryInput = nil
            phase = .idle
            return
        }
        run(audioB64: data.base64EncodedString(), text: nil, spoken: true)
    }

    /// Stops recording and speech without a callback.
    private func interrupt() {
        speechToken += 1
        afterSpeech = nil
        audio.cancelRecording()
        audio.stopPlayback()
    }

    // MARK: A turn

    private func run(audioB64: String?, text: String?, spoken: Bool) {
        guard let store else { return }
        task?.cancel()
        errorMessage = nil
        phase = .thinking
        lastInputWasVoice = spoken
        retryInput = (audioB64, text)
        let request = VoiceTurnRequest(
            audioB64: audioB64, text: text, context: context(store: store), speak: spoken)
        task = Task {
            do {
                let response = try await store.voiceTurn(request)
                guard !Task.isCancelled else { return }
                retryInput = nil
                await handle(response)
            } catch is CancellationError {
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = error.localizedDescription
                phase = .idle
            }
        }
    }

    /// The model's view of the phone: where the person is, what the guidance says, what is waiting.
    private func context(store: LiveStore) -> VoiceContext {
        let guidance = store.myGuidance.map { g in
            VoiceGuidanceContext(
                level: g.level.rawValue,
                headline: GuidanceHistoryEntry.title(g),
                spoken: g.spokenSentence,
                reason: g.reasonText,
                caveat: g.caveat,
                source: g.sourceText)
        }
        let history = turns.suffix(6)
            .filter { !$0.heard.isEmpty && !$0.reply.isEmpty }
            .map { VoiceHistoryTurn(user: $0.heard, agent: $0.reply) }
        return VoiceContext(
            zone: store.myZone?.name,
            role: store.role == .civilian ? "civilian" : "responder",
            guidance: guidance,
            pending: pending,
            history: history)
    }

    private func handle(_ response: VoiceTurnResponse) async {
        var log = VoiceTurnLog(
            heard: response.transcript.trimmingCharacters(in: .whitespacesAndNewlines),
            reply: response.reply.trimmingCharacters(in: .whitespacesAndNewlines))
        if log.heard.isEmpty { log.heard = "(nothing heard)" }
        turns.append(log)
        let id = log.id

        var outcome = Outcome()
        switch validated(response.action) {
        case .report, .checkIn:
            pending = validated(response.action)
        case .confirm:
            if let action = pending {
                phase = .thinking
                outcome = await perform(action)
                guard !Task.isCancelled else { return }
                if outcome.succeeded { pending = nil }
            }
        case .cancel:
            pending = nil
        case .open(let screen):
            pending = nil
            outcome = open(screen)
        case nil:
            break
        }
        record(outcome, on: id)

        if lastInputWasVoice {
            speak(outcome.spoken ?? log.reply, wav: outcome.spoken == nil ? wav(response) : nil,
                  extra: outcome.extraSpoken, then: outcome.afterSpeech)
        } else {
            phase = .idle
            outcome.afterSpeech?()
        }
    }

    private func wav(_ response: VoiceTurnResponse) -> Data? {
        response.audioB64.flatMap { Data(base64Encoded: $0) }
    }

    /// The phone's own checks on what the model proposed: severity only where it applies, the note
    /// trimmed and capped. Anything else is dropped to the plain kind.
    private func validated(_ action: VoiceAction?) -> VoiceAction? {
        guard case .report(let kind, let severity, let note)? = action else { return action }
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        return .report(
            kind: kind,
            severity: kind.hasSeverity ? severity : nil,
            note: (trimmed?.isEmpty ?? true) ? nil : String(trimmed!.prefix(Self.noteLimit)))
    }

    // MARK: Acting

    /// What a confirmed action did, and what the assistant says instead of its own reply when the
    /// phone could not do it.
    private struct Outcome {
        var result: String?
        var failed = false
        /// Keep the proposal for another try (a failed check-in); false clears it.
        var succeeded = true
        var emergency = false
        /// Replaces the server's reply (and its audio) when the action did not go as it said.
        var spoken: String?
        /// Said on the phone after the reply, so the 911 line is always heard.
        var extraSpoken: String?
        var afterSpeech: (() -> Void)?
    }

    private func record(_ outcome: Outcome, on id: UUID?) {
        guard let id, let index = turns.firstIndex(where: { $0.id == id }) else { return }
        if let result = outcome.result { turns[index].result = result }
        turns[index].failed = outcome.failed
        turns[index].showsEmergencyLine = outcome.emergency
        if let spoken = outcome.spoken { turns[index].reply = spoken }
    }

    private func perform(_ action: VoiceAction) async -> Outcome {
        guard let store, let location else { return Outcome(succeeded: false) }
        switch action {
        case .report(let kind, let severity, let note):
            return await submitReport(kind: kind, severity: severity, note: note, store: store, location: location)
        case .checkIn(let status):
            var outcome = Outcome(emergency: status == .needHelp)
            outcome.extraSpoken = status == .needHelp ? Self.emergencyLine : nil
            do {
                try await store.checkIn(status)
                outcome.result = "Checked in: \(Self.words(status))"
            } catch {
                outcome.result = "The check-in did not send: \(error.localizedDescription)"
                outcome.failed = true
                outcome.succeeded = false
                outcome.spoken = "I could not send that check-in. Try again."
            }
            return outcome
        case .open(let screen):
            return open(screen)
        case .confirm, .cancel:
            return Outcome()
        }
    }

    /// Puts the report in the outbox with the device's fix. Without a fix nothing is sent: the report
    /// sheet opens filled in, so the person places the pin.
    private func submitReport(kind: ReportKind, severity: ReportSeverity?, note: String?,
                              store: LiveStore, location: LocationProvider) async -> Outcome {
        var fix = location.lastLocation
        if fix == nil, location.isAuthorized { fix = try? await location.currentLocation() }
        guard let fix else {
            var outcome = Outcome(emergency: kind == .helpNeeded)
            outcome.result = "Needs your location. Placing the pin on the report screen."
            outcome.spoken = "I do not have your location yet. Drop the pin on the report screen."
            outcome.afterSpeech = { [weak self] in
                self?.handOffToReportSheet(ReportPrefill(kind: kind, severity: severity, note: note))
            }
            return outcome
        }
        let draft = ReportDraft(
            incidentId: store.incidentId,
            kind: kind,
            severity: kind.hasSeverity ? severity : nil,
            location: ReportLocation(
                coord: LonLat(lon: fix.coordinate.longitude, lat: fix.coordinate.latitude),
                accuracyM: fix.horizontalAccuracy >= 0 ? fix.horizontalAccuracy : nil),
            taskId: nil,
            note: note,
            observedAt: Date())
        store.submit(draft)
        // The outbox sends right away when online; give it a moment before calling it queued.
        for _ in 0..<6 where !store.pending.isEmpty {
            try? await Task.sleep(for: .milliseconds(250))
        }
        var outcome = Outcome(emergency: kind == .helpNeeded)
        outcome.result = store.pending.isEmpty ? "Sent" : "Saved, sends when online"
        outcome.extraSpoken = kind == .helpNeeded ? Self.emergencyLine : nil
        return outcome
    }

    private func open(_ screen: VoiceScreen) -> Outcome {
        guard let router else { return Outcome() }
        var outcome = Outcome()
        switch screen {
        case .home: router.tab = .home; outcome.result = "Opened Home"
        case .map: router.tab = .map; outcome.result = "Opened Map"
        case .reports: router.tab = .reports; outcome.result = "Opened Reports"
        case .plan: router.tab = .plan; outcome.result = "Opened Plan"
        case .route: router.start(); outcome.result = "Started directions"
        }
        // The sheet stays up until the reply has been spoken; closing it would cut the audio off.
        outcome.afterSpeech = { router.voice = false }
        return outcome
    }

    /// Sheets can't overlap: close this one, then open the report sheet. The task is not tied to the
    /// agent, which goes away with the sheet.
    private func handOffToReportSheet(_ prefill: ReportPrefill) {
        guard let router else { return }
        router.voice = false
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(450))
            router.openReport(prefill, from: "voice")
        }
    }

    private static func words(_ status: CheckInStatus) -> String {
        switch status {
        case .out: return "I'm out"
        case .needHelp: return "Need help"
        case .staying: return "Staying"
        }
    }

    // MARK: Speaking

    private func speak(_ text: String, wav: Data?, extra: String?, then afterSpeech: (() -> Void)?) {
        self.afterSpeech = afterSpeech
        guard !text.isEmpty else {
            phase = .idle
            runAfterSpeech()
            return
        }
        phase = .speaking
        speechToken += 1
        let token = speechToken
        let finished: () -> Void = { [weak self] in self?.spoke(token) }
        let tail: () -> Void = { [weak self] in
            guard let self, token == self.speechToken else { return }
            if let extra, !text.contains("911") {
                self.audio.speakLocally(extra, onFinish: finished)
            } else {
                finished()
            }
        }
        if let wav {
            audio.play(wav: wav, onFinish: tail)
        } else {
            audio.speakLocally(text, onFinish: tail)
        }
    }

    private func spoke(_ token: Int) {
        guard token == speechToken, phase == .speaking else { return }
        phase = .idle
        if afterSpeech != nil {
            runAfterSpeech()
        } else if handsFree, pending != nil, lastInputWasVoice {
            beginListening(auto: true)
        }
    }

    private func runAfterSpeech() {
        let action = afterSpeech
        afterSpeech = nil
        action?()
    }
}
