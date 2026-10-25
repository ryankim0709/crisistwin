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
    /// Who decided this turn: `jev`, `claude` or nil (an older server).
    var decidedBy: String?
    /// Jev's confidence, 0 to 1. A model's number, not an observation.
    var confidence: Double?
    /// Which server facts the reply used (`guidance`, `hazards`, ...). Empty when none.
    var sources: [String] = []
    /// `ReportDraft.clientId` of the report the phone filed on its own this turn, if it did.
    var autoReportId: UUID?
    /// The auto-filed report was taken back.
    var undone = false

    /// Small caption under the reply, in words: "Jev · 94% · filed automatically", "Jev · 81%",
    /// "Claude". Nil when the server did not say.
    var attribution: String? {
        switch decidedBy {
        case "jev":
            var parts = ["Jev"]
            if let confidence { parts.append("\(Int((min(max(confidence, 0), 1) * 100).rounded()))%") }
            if autoReportId != nil { parts.append("filed automatically") }
            return parts.joined(separator: " \u{00B7} ")
        case "claude":
            return "Claude"
        default:
            return nil
        }
    }

    /// "From: published guidance \u{00B7} reported hazards \u{00B7} fire estimate". Nil when the reply
    /// used no facts. Unknown source values are ignored.
    var sourcesCaption: String? {
        let words = Self.sourceWords
        let names = sources.compactMap { words[$0] }
        guard !names.isEmpty else { return nil }
        return "From: " + names.joined(separator: " \u{00B7} ")
    }

    /// The sources spelled out for VoiceOver.
    var sourcesSpoken: String? {
        let names = sources.compactMap { Self.sourceWords[$0] }
        guard !names.isEmpty else { return nil }
        return "From " + names.joined(separator: ", ")
    }

    private static let sourceWords = [
        "guidance": "published guidance",
        "guidance_history": "guidance history",
        "hazards": "reported hazards",
        "shelters": "shelters",
        "fire": "fire estimate",
    ]

    /// The caption spelled out for VoiceOver.
    var attributionSpoken: String? {
        switch decidedBy {
        case "jev":
            var line = "Decided by Jev"
            if let confidence { line += ", \(Int((min(max(confidence, 0), 1) * 100).rounded())) percent confidence" }
            if autoReportId != nil { line += ", filed automatically" }
            return line
        case "claude":
            return "Decided by Claude"
        default:
            return nil
        }
    }
}

/// The voice assistant's controller: listen, ask the server, speak the reply as it streams in, and
/// act on what the model proposes. The model only proposes. A report or check-in waits in `pending`
/// until the person taps Send or says yes, and the phone validates it again before anything leaves
/// it (ADR 0011). Nothing is stored: the log lives in memory for as long as the sheet is open.
///
/// Speech and listening go through `VoiceSession` (Cartesia over WebSocket, or the phone's own
/// voice when Cartesia is unavailable). The sheet and Drive mode each own one agent.
@MainActor
@Observable
final class VoiceAgent {
    enum Phase { case idle, listening, thinking, speaking }

    /// Where this agent lives, which decides what "close" means after an open-screen action.
    enum Surface { case sheet, drive }

    /// Listening, speaking and the engine. Created on first use so building the view is free.
    @ObservationIgnored lazy var session = VoiceSession()
    /// Microphone, playback and the input level for the ring.
    var audio: VoiceAudio { session.audio }
    var availability: VoiceSession.Availability { session.availability }
    /// The live transcript while listening (final plus interim words).
    var caption: String { session.caption }

    let surface: Surface
    private(set) var phase: Phase = .idle
    private(set) var turns: [VoiceTurnLog] = []
    /// A proposed report or check-in awaiting Send.
    private(set) var pending: VoiceAction?
    private(set) var errorMessage: String?
    /// The announcement being spoken right now (Drive mode), for the screen to show.
    private(set) var announcement: String?
    /// A turn is being run (request out, reply streaming, or the action being carried out).
    private(set) var turnInFlight = false
    /// After the assistant asks "Send it?", listen again on its own.
    var handsFree = true
    /// The last report this agent sent, for "undo" (spoken or tapped). Cleared once taken back.
    private(set) var lastSent: SentReport?

    struct SentReport: Equatable {
        var clientId: UUID
        var kind: ReportKind
        var sentAt: Date
    }

    /// How long after sending a report can be taken back.
    static let undoWindow: TimeInterval = 5 * 60

    /// The turn's auto-filed report can still be taken back (it is the last one sent, not undone,
    /// and inside the window). The tap is checked again when it happens.
    func canUndo(_ turn: VoiceTurnLog) -> Bool {
        guard let id = turn.autoReportId, !turn.undone, let sent = lastSent, sent.clientId == id else { return false }
        return Date().timeIntervalSince(sent.sentAt) <= Self.undoWindow
    }

    /// Voice input needs Cartesia; on the phone's own voice the person types.
    var canListen: Bool {
        if case .onDevice = session.availability { return false }
        return true
    }

    /// The reason Cartesia is not in use, when it is not.
    var onDeviceReason: String? {
        if case .onDevice(let reason) = session.availability { return reason }
        return nil
    }

    /// Send, Edit and the mic wait while a turn is running.
    var isBusy: Bool { phase == .thinking || turnInFlight }

    // MARK: Private state

    /// The last turn's words, kept so Retry can run it again.
    private var retryInput: (text: String, voice: Bool)?
    private var lastInputWasVoice = false
    /// This listen was started by hands-free after "Send it?"; hearing nothing just ends it.
    private var autoListening = false
    private var task: Task<Void, Never>?
    /// Bumped whenever a turn starts or is abandoned, so a late result or callback is ignored.
    private var turnID = 0
    /// Runs once the reply has been spoken (closing the sheet, opening the report sheet).
    private var afterSpeech: (() -> Void)?

    /// The person tapped or talked over the reply while the turn was still arriving: finish the
    /// turn silently, then listen if they meant to talk.
    private var muted = false
    private var listenAfterTurn = false
    /// Reply text was handed to a streamed utterance this turn (even if its audio is already done).
    private var replyWasStreamed = false
    /// An auto-filed report was just announced ("Say undo to take it back"): listen once for it.
    private var awaitingUndo = false

    /// The streamed reply being spoken, and how far the spoken run has got.
    private var utterance: SpeechUtterance?
    private var plan = SpeechPlan(token: 0)
    private var nextToken = 0
    private var announcementActive = false
    /// Announcements that arrived mid-turn; spoken as soon as the turn's action is done.
    private var queuedAnnouncements: [String] = []
    private var preparation: Task<Void, Never>?
    /// False once `stop()` has run, so a late announcement or callback stays silent.
    private var isActive = false

    /// One spoken run: the reply (streamed or whole), then lines said after it.
    private struct SpeechPlan {
        var token: Int
        var replyDone = false
        var finishing = false
        /// Nil until the turn's action has been handled, so the run waits for it.
        var tail: [String]?
        var tailIndex = 0
        var tailPlaying = false
    }

    private var store: LiveStore?
    private var location: LocationProvider?
    private var router: AppRouter?

    private static let emergencyLine = "If you are in danger, call 911."
    private static let noteLimit = 280

    init(surface: Surface = .sheet) {
        self.surface = surface
    }

    /// Wires the app's stores in; the view calls this when it appears.
    func attach(store: LiveStore, location: LocationProvider, router: AppRouter) {
        self.store = store
        self.location = location
        self.router = router
        isActive = true
        session.onBargeIn = { [weak self] in self?.bargeIn() }
    }

    /// Fetches the Cartesia token and starts the audio engine; falls back to on-device voice.
    /// Safe to call again: overlapping calls share one attempt.
    func prepare() async {
        guard let store else { return }
        if let preparation {
            await preparation.value
            return
        }
        let attempt = Task { await session.prepare(store: store) }
        preparation = attempt
        await attempt.value
        preparation = nil
    }

    // MARK: Controls

    /// The mic button: start, stop and send, or stop the reply and talk.
    func toggleListening() {
        switch phase {
        case .idle:
            beginListening()
        case .listening:
            // Still waiting on the permission prompt or the token: nothing is listening yet, so
            // just stand down.
            guard session.isListening else {
                abandonTurn()
                goIdle()
                return
            }
            session.stopListening()
        case .thinking:
            break
        case .speaking:
            stopSpeechAndListen()
        }
    }

    /// The typed fallback. Typed turns are answered in text; on the phone's own voice they are
    /// also read aloud.
    func send(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isBusy else { return }
        interruptAll()
        startTyped(String(trimmed.prefix(500)))
    }

    /// Runs the last turn again after an error.
    func retry() {
        guard let input = retryInput, phase == .idle, !isBusy else { return }
        interruptAll()
        turnID += 1
        let gen = turnID
        task = Task { await executeTurn(text: input.text, voice: input.voice, gen: gen) }
    }

    /// Send on the proposal card.
    func confirmPending() {
        guard let action = pending, !isBusy else { return }
        interruptAll()
        turnID += 1
        let gen = turnID
        phase = .thinking
        turnInFlight = true
        task = Task {
            let outcome = await perform(action)
            guard gen == turnID else { return }
            if outcome.succeeded { pending = nil }
            record(outcome, on: turns.last?.id, replaceReply: true)
            turnInFlight = false
            // The button is silent on the sheet apart from the 911 line; Drive reads the result
            // out because the driver is not looking.
            var lines: [String] = []
            if surface == .drive, let line = outcome.spoken ?? outcome.result {
                lines.append(line.hasSuffix(".") ? line : line + ".")
            }
            if let extra = outcome.extraSpoken, !lines.contains(where: { $0.contains("911") }) {
                lines.append(extra)
            }
            afterSpeech = outcome.afterSpeech
            if lines.isEmpty {
                if goIdle() { return }
                runAfterSpeech()
            } else {
                beginSpeechRun(first: nil, tail: lines)
                flushAnnouncements()
            }
        }
    }

    /// Cancel on the proposal card.
    func cancelPending() {
        pending = nil
    }

    /// The Undo button on an auto-filed report: the same as saying "undo".
    func undoLastReport() {
        guard !isBusy else { return }
        // Recorded on the turn that filed it, so its result line changes in place.
        let target = turns.last(where: { $0.autoReportId != nil && $0.autoReportId == lastSent?.clientId })?.id
            ?? turns.last?.id
        interruptAll()
        turnID += 1
        let gen = turnID
        phase = .thinking
        turnInFlight = true
        task = Task {
            let outcome = await undoLast()
            guard gen == turnID else { return }
            record(outcome, on: target, replaceReply: false)
            turnInFlight = false
            // Silent on the sheet; Drive reads the result out because the driver is not looking.
            var lines: [String] = []
            if surface == .drive, let line = outcome.spoken ?? outcome.result {
                lines.append(line.hasSuffix(".") ? line : line + ".")
            }
            if lines.isEmpty {
                if goIdle() { return }
            } else {
                beginSpeechRun(first: nil, tail: lines)
                flushAnnouncements()
            }
        }
    }

    /// Edit on the proposal card: the report sheet opens with the proposal filled in.
    func editPending() {
        guard case .report(let kind, let severity, let note)? = pending else { return }
        pending = nil
        interruptAll()
        handOffToReportSheet(ReportPrefill(kind: kind, severity: severity, note: note))
    }

    /// The surface is going away: cancel listening, the request and playback, and free the audio.
    func stop() {
        abandonTurn()
        invalidateSpeech()
        afterSpeech = nil
        queuedAnnouncements = []
        announcementActive = false
        announcement = nil
        turnInFlight = false
        phase = .idle
        isActive = false
        session.onBargeIn = nil
        session.shutdown()
    }

    // MARK: Announcements (Drive mode)

    /// Reads `text` aloud now, in the calm announcement voice. It interrupts listening and any
    /// reply being spoken, but not a pending proposal. While a turn is still running (its request
    /// or its action) it waits for the action to finish, which takes seconds, not a whole reply.
    /// Hands-free re-listening never cuts an announcement off; it waits until it has finished.
    func announce(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, isActive else { return }
        if turnInFlight {
            queuedAnnouncements.append(trimmed)
            queuedAnnouncements = Array(queuedAnnouncements.suffix(2))
            return
        }
        if case .unknown = session.availability {
            Task {
                await prepare()
                guard self.isActive else { return }
                if self.turnInFlight {
                    self.queuedAnnouncements.append(trimmed)
                } else {
                    self.playAnnouncement(trimmed)
                }
            }
            return
        }
        playAnnouncement(trimmed)
    }

    private func playAnnouncement(_ text: String) {
        abandonTurn()
        invalidateSpeech()
        nextToken += 1
        let token = nextToken
        plan = SpeechPlan(token: token)
        announcementActive = true
        announcement = text
        phase = .speaking
        session.say(text, style: .announcement) { [weak self] in self?.announcementFinished(token) }
    }

    private func announcementFinished(_ token: Int) {
        guard token == plan.token, announcementActive else { return }
        announcementActive = false
        announcement = nil
        if goIdle() { return }
        resumeAfterSpeech()
    }

    @discardableResult
    private func flushAnnouncements() -> Bool {
        guard !turnInFlight, !queuedAnnouncements.isEmpty else { return false }
        let text = queuedAnnouncements.joined(separator: " ")
        queuedAnnouncements = []
        playAnnouncement(text)
        return true
    }

    /// Back to idle. Returns true when a queued announcement started instead, in which case the
    /// caller leaves the rest (re-listening, closing) until that announcement has finished.
    @discardableResult
    private func goIdle() -> Bool {
        phase = .idle
        return flushAnnouncements()
    }

    // MARK: Listening

    private func beginListening(auto: Bool = false) {
        guard let store else { return }
        guard canListen else {
            errorMessage = "Voice input is not available. Type instead."
            return
        }
        autoListening = auto
        errorMessage = nil
        task?.cancel()
        turnID += 1
        let gen = turnID
        phase = .listening
        task = Task {
            if audio.permission != .granted, await audio.requestPermission() == false {
                if gen == turnID { goIdle() }
                return
            }
            guard gen == turnID, !Task.isCancelled else { return }
            await prepare()
            guard gen == turnID, !Task.isCancelled else { return }
            guard canListen else {
                errorMessage = "Voice input is not available. Type instead."
                goIdle()
                return
            }
            do {
                let heard = try await session.listen(store: store)
                guard gen == turnID, phase == .listening else { return }
                let text = heard?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard !text.isEmpty else {
                    if !autoListening {
                        errorMessage = "I did not hear anything. Tap the mic and try again, or type instead."
                        retryInput = nil
                    }
                    goIdle()
                    return
                }
                await executeTurn(text: String(text.prefix(500)), voice: true, gen: gen)
            } catch is CancellationError {
            } catch {
                guard gen == turnID else { return }
                errorMessage = "The microphone could not start. Try again, or type instead."
                goIdle()
            }
        }
    }

    /// Stops listening, the request and speech without callbacks.
    private func abandonTurn() {
        turnID += 1
        task?.cancel()
        task = nil
        session.cancelListening()
    }

    /// Everything the person's next action replaces: the turn, listening and speech.
    private func interruptAll() {
        abandonTurn()
        invalidateSpeech()
        afterSpeech = nil
        announcementActive = false
        announcement = nil
    }

    /// Stops the spoken run. Callbacks from it are ignored from here on.
    private func invalidateSpeech() {
        nextToken += 1
        plan = SpeechPlan(token: nextToken)
        utterance?.cancel()
        utterance = nil
        session.stopSpeaking()
    }

    /// Tap while speaking, or the person talking over the reply: stop and listen at once.
    private func stopSpeechAndListen() {
        invalidateSpeech()
        announcementActive = false
        announcement = nil
        if afterSpeech != nil {
            // The reply was heading somewhere (close the sheet, open the report form): go there.
            goIdle()
            runAfterSpeech()
            return
        }
        if turnInFlight {
            // The reply was still arriving: let the turn finish quietly, then listen.
            muted = true
            listenAfterTurn = true
            phase = .thinking
            return
        }
        phase = .idle
        if canListen { beginListening() }
    }

    private func bargeIn() {
        // A guidance announcement is never talked over by accident; only a tap stops it.
        guard phase == .speaking, !announcementActive else { return }
        stopSpeechAndListen()
    }

    // MARK: A turn

    private func startTyped(_ text: String) {
        turnID += 1
        let gen = turnID
        task = Task { await executeTurn(text: text, voice: false, gen: gen) }
    }

    /// One turn: ask the server with the words, show and speak the reply as it arrives, then act.
    private func executeTurn(text: String, voice: Bool, gen: Int) async {
        guard let store, gen == turnID else { return }
        let streaming = session.availability == .cartesia
        // Typed turns are text only, except on the phone's own voice, where there is no mic and
        // the reply is read out.
        let speaks = voice || !streaming
        errorMessage = nil
        phase = .thinking
        turnInFlight = true
        muted = false
        listenAfterTurn = false
        replyWasStreamed = false
        awaitingUndo = false
        lastInputWasVoice = voice
        retryInput = (text, voice)
        var request = VoiceTurnRequest(audioB64: nil, text: text, context: context(store: store), speak: false)
        if streaming { request.stream = true }
        let log = VoiceTurnLog(heard: text, reply: "")
        turns.append(log)
        let id = log.id
        do {
            let response: VoiceTurnResponse
            if streaming {
                var reply = ""
                var finalResponse: VoiceTurnResponse?
                for try await event in try await store.voiceTurnStream(request) {
                    guard gen == turnID else {
                        utterance?.cancel()
                        utterance = nil
                        return
                    }
                    switch event {
                    case .replyDelta(let piece):
                        reply += piece
                        setReply(reply.trimmingCharacters(in: .whitespacesAndNewlines), on: id)
                        if speaks, !muted {
                            let current = utterance ?? startReplySpeech()
                            current.append(piece)
                        }
                    case .replyEnd:
                        finishReplySpeech()
                    case .final(let done):
                        finalResponse = done
                    case .failed(let detail):
                        throw VoiceTurnError(message: detail)
                    }
                }
                guard let finalResponse else {
                    throw VoiceTurnError(message: "The reply was cut off. Try again.")
                }
                response = finalResponse
            } else {
                response = try await store.voiceTurn(request)
            }
            guard gen == turnID else { return }
            retryInput = nil
            await complete(response, id: id, gen: gen, speaks: speaks)
        } catch is CancellationError {
        } catch {
            guard gen == turnID else { return }
            utterance?.cancel()
            utterance = nil
            session.stopSpeaking()
            turns.removeAll { $0.id == id }
            errorMessage = error.localizedDescription
            turnInFlight = false
            muted = false
            goIdle()
        }
    }

    /// The final message arrived: take the action the model proposed (the phone checks it first)
    /// and finish the speech.
    private func complete(_ response: VoiceTurnResponse, id: UUID, gen: Int, speaks: Bool) async {
        let reply = response.reply.trimmingCharacters(in: .whitespacesAndNewlines)
        let streamedSpeech = replyWasStreamed
        if !reply.isEmpty { setReply(reply, on: id) }
        // Some replies end without a reply_end line; the audio must still be told it is complete.
        finishReplySpeech()

        if let index = turns.firstIndex(where: { $0.id == id }) {
            turns[index].decidedBy = response.decidedBy
            turns[index].confidence = response.confidence
            turns[index].sources = response.sources
        }

        var outcome = Outcome()
        let checked = validated(response.action)
        var autoAttempted = false
        switch checked {
        case .report(let kind, _, _):
            // The server's `auto` only counts for a report that is not a need-help. Everything
            // else is a normal proposal that waits for Send or yes.
            if response.auto, kind != .helpNeeded, let checked {
                pending = nil
                autoAttempted = true
                outcome = await perform(checked)
                guard gen == turnID else { return }
                if outcome.filedReportId == nil, outcome.spoken == nil {
                    outcome.spoken = "I could not file that report. Try again."
                    outcome.failed = true
                }
                if let index = turns.firstIndex(where: { $0.id == id }) {
                    turns[index].autoReportId = outcome.filedReportId
                }
                awaitingUndo = outcome.filedReportId != nil
            } else {
                pending = checked
            }
        case .checkIn:
            pending = checked
        case .undo:
            outcome = await undoLast()
            guard gen == turnID else { return }
        case .confirm:
            if let action = pending {
                outcome = await perform(action)
                guard gen == turnID else { return }
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
        guard gen == turnID else { return }
        // A streamed reply has already been said, so the correction is shown beside it and spoken
        // after it. A whole reply is replaced, as before.
        // An auto-filed report that could not be filed must not stay on screen as "Reported".
        let correctsReply = autoAttempted && outcome.filedReportId == nil && outcome.spoken != nil
        record(outcome, on: id, replaceReply: !streamedSpeech || correctsReply)
        turnInFlight = false

        if !speaks {
            afterSpeech = outcome.afterSpeech
            if goIdle() { return }
            runAfterSpeech()
            return
        }
        if muted {
            afterSpeech = outcome.afterSpeech
            let relisten = listenAfterTurn
            muted = false
            listenAfterTurn = false
            if goIdle() { return }
            if afterSpeech != nil {
                runAfterSpeech()
            } else if relisten, canListen {
                beginListening()
            }
            return
        }

        afterSpeech = outcome.afterSpeech
        let extras = extraLines(response, outcome: outcome, reply: reply)
        if streamedSpeech {
            plan.tail = (outcome.spoken.map { [$0] } ?? []) + extras
            advanceSpeech()
        } else {
            let first = outcome.spoken ?? reply
            if first.isEmpty && extras.isEmpty {
                if goIdle() { return }
                runAfterSpeech()
                return
            }
            beginSpeechRun(first: first.isEmpty ? nil : first, tail: extras)
        }
        flushAnnouncements()
    }

    /// Lines said after the reply: the 911 line (from the server or from a sent need-help),
    /// once, and only when the reply did not already say it.
    private func extraLines(_ response: VoiceTurnResponse, outcome: Outcome, reply: String) -> [String] {
        var lines: [String] = []
        var saidEmergency = reply.contains("911") || (outcome.spoken?.contains("911") ?? false)
        for extra in [response.spokenExtra, outcome.extraSpoken].compactMap({ $0 }) where !extra.isEmpty {
            if extra.contains("911") {
                if saidEmergency { continue }
                saidEmergency = true
            } else if lines.contains(extra) {
                continue
            }
            lines.append(extra)
        }
        return lines
    }

    private func setReply(_ text: String, on id: UUID) {
        guard let index = turns.firstIndex(where: { $0.id == id }) else { return }
        turns[index].reply = text
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
            history: history,
            zoneId: store.myZone?.id)
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
        /// Replaces the server's reply when the action did not go as it said.
        var spoken: String?
        /// Said on the phone after the reply, so the 911 line is always heard.
        var extraSpoken: String?
        var afterSpeech: (() -> Void)?
        /// The report this action put in the outbox, so it can be taken back.
        var filedReportId: UUID?
    }

    private func record(_ outcome: Outcome, on id: UUID?, replaceReply: Bool) {
        guard let id, let index = turns.firstIndex(where: { $0.id == id }) else { return }
        if let result = outcome.result { turns[index].result = result }
        turns[index].failed = outcome.failed
        turns[index].showsEmergencyLine = outcome.emergency
        if replaceReply, let spoken = outcome.spoken { turns[index].reply = spoken }
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
        case .undo:
            return await undoLast()
        case .confirm, .cancel:
            return Outcome()
        }
    }

    /// Takes back the last report this agent sent, within the window: removes it from the outbox if
    /// it has not gone yet, otherwise withdraws it on the server.
    private func undoLast() async -> Outcome {
        guard let store else { return Outcome(succeeded: false) }
        let none = "There's nothing to take back."
        guard let sent = lastSent else {
            return Outcome(result: none, spoken: none)
        }
        guard Date().timeIntervalSince(sent.sentAt) <= Self.undoWindow else {
            lastSent = nil
            let line = "That report was sent more than 5 minutes ago, so it can't be taken back here. Open Reports to delete it."
            return Outcome(result: line, spoken: line)
        }
        func failure(_ line: String) -> Outcome {
            Outcome(result: line, failed: true, succeeded: false, spoken: line)
        }
        do {
            if let draft = store.pending.first(where: { $0.clientId == sent.clientId }) {
                try store.deleteDraft(draft)
            } else {
                var report = store.myReports.first { $0.clientId == sent.clientId }
                if report == nil {
                    // It just went out; the list on the phone may not have caught up.
                    await store.refresh()
                    report = store.myReports.first { $0.clientId == sent.clientId }
                }
                guard let report else {
                    return failure("I could not find that report to take it back.")
                }
                try await store.withdrawReport(report)
            }
        } catch LiveAPIError.reportLocked {
            lastSent = nil
            return failure("A responder already acted on it, so it can't be taken back.")
        } catch let error as ReportChangeError {
            if case .gone = error { lastSent = nil }
            return failure(error.localizedDescription)
        } catch {
            return failure("I could not take that back: \(error.localizedDescription)")
        }
        lastSent = nil
        for index in turns.indices where turns[index].autoReportId == sent.clientId {
            turns[index].undone = true
            turns[index].result = "Report taken back"
            turns[index].failed = false
        }
        return Outcome(result: "Report taken back")
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
        lastSent = SentReport(clientId: draft.clientId, kind: kind, sentAt: Date())
        // The outbox sends right away when online; give it a moment before calling it queued.
        for _ in 0..<6 where !store.pending.isEmpty {
            try? await Task.sleep(for: .milliseconds(250))
        }
        var outcome = Outcome(emergency: kind == .helpNeeded)
        outcome.result = store.pending.isEmpty ? "Sent" : "Saved, sends when online"
        outcome.filedReportId = draft.clientId
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
        // The surface stays up until the reply has been spoken; closing it would cut the audio off.
        outcome.afterSpeech = { [weak self] in self?.closeSurface() }
        return outcome
    }

    private func closeSurface() {
        switch surface {
        case .sheet: router?.voice = false
        case .drive: router?.drive = false
        }
    }

    /// Sheets can't overlap: close this surface, then open the report sheet. The task is not tied
    /// to the agent, which goes away with the surface.
    private func handOffToReportSheet(_ prefill: ReportPrefill) {
        guard let router else { return }
        closeSurface()
        let delay: Duration = surface == .drive ? .milliseconds(700) : .milliseconds(450)
        Task { @MainActor in
            try? await Task.sleep(for: delay)
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

    /// First streamed text of a reply: opens the utterance that the deltas are appended to.
    private func startReplySpeech() -> SpeechUtterance {
        nextToken += 1
        plan = SpeechPlan(token: nextToken)
        phase = .speaking
        replyWasStreamed = true
        let started = session.speak(style: .reply)
        utterance = started
        return started
    }

    /// Tells the utterance its text is complete. Safe to call more than once.
    private func finishReplySpeech() {
        guard let current = utterance, !plan.finishing else { return }
        plan.finishing = true
        let token = plan.token
        current.finish { [weak self] in self?.replySpeechDone(token) }
    }

    /// Speaks a whole reply (`first`), then `tail`; either may be empty.
    private func beginSpeechRun(first: String?, tail: [String]) {
        nextToken += 1
        let token = nextToken
        plan = SpeechPlan(token: token, replyDone: first == nil, tail: tail)
        phase = .speaking
        if let first {
            session.say(first, style: .reply) { [weak self] in self?.replySpeechDone(token) }
        } else {
            advanceSpeech()
        }
    }

    private func replySpeechDone(_ token: Int) {
        guard token == plan.token else { return }
        plan.replyDone = true
        utterance = nil
        advanceSpeech()
    }

    /// Plays the next line after the reply, once both the reply audio and the turn's action are done.
    private func advanceSpeech() {
        guard plan.replyDone, let tail = plan.tail, !plan.tailPlaying else { return }
        let token = plan.token
        guard plan.tailIndex < tail.count else {
            spoke(token)
            return
        }
        let line = tail[plan.tailIndex]
        plan.tailIndex += 1
        plan.tailPlaying = true
        session.say(line, style: .reply) { [weak self] in
            guard let self, self.plan.token == token else { return }
            self.plan.tailPlaying = false
            self.advanceSpeech()
        }
    }

    private func spoke(_ token: Int) {
        guard token == plan.token, phase == .speaking else { return }
        if goIdle() { return }
        resumeAfterSpeech()
    }

    /// After a spoken run ends: run what the reply was heading to, or listen for the yes or no.
    private func resumeAfterSpeech() {
        if afterSpeech != nil {
            runAfterSpeech()
        } else if handsFree, pending != nil || awaitingUndo, lastInputWasVoice, canListen {
            awaitingUndo = false
            beginListening(auto: true)
        }
    }

    private func runAfterSpeech() {
        let action = afterSpeech
        afterSpeech = nil
        action?()
    }
}
