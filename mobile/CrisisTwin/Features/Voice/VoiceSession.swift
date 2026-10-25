import Foundation
import Observation

/// The voice facade the UI uses: one Cartesia token, the audio engine, live listening (STT) and
/// streamed speech (TTS). Without Cartesia (server 503, or the token could not be fetched) it
/// stays usable on-device: `speak` and `say` return utterances spoken with AVSpeechSynthesizer,
/// and `listen` throws so the UI offers typed input.
///
/// Main-actor only. Every callback (`onDone`, `onBargeIn`) runs on the main actor.
@MainActor @Observable
final class VoiceSession {
    enum Availability: Equatable {
        case unknown
        case cartesia
        /// The reason, worded for the person.
        case onDevice(String)
    }

    let audio: VoiceAudio
    private(set) var availability: Availability = .unknown
    /// Live transcript while listening (final + interim). Kept after `listen` returns until the
    /// next `listen` starts.
    private(set) var caption = ""
    private(set) var isListening = false

    /// Forwarded to `audio.onBargeIn` (fires only while streamed speech plays and not listening).
    @ObservationIgnored var onBargeIn: (() -> Void)? {
        didSet {
            audio.onBargeIn = onBargeIn == nil ? nil : { [weak self] in self?.onBargeIn?() }
        }
    }

    /// Refresh the token when fewer than this many seconds remain.
    private static let refreshMargin: TimeInterval = 30
    /// Never renew more often than this (the server allows 6 tokens a minute per device).
    private static let minRenewalDelay: TimeInterval = 15

    private enum ListenEnd {
        case speech(heard: Bool)
        case cancelled
        case failed(Error)
    }

    @ObservationIgnored private var token: VoiceToken?
    @ObservationIgnored private var tokenExpiry = Date.distantPast
    @ObservationIgnored private var tts: CartesiaTTS?
    @ObservationIgnored private var stt: CartesiaSTT?
    @ObservationIgnored private var current: SpeechUtterance?
    /// 503: the server has no voice keys; stay on-device for this session.
    @ObservationIgnored private var unavailable = false
    @ObservationIgnored private weak var store: LiveStore?
    @ObservationIgnored private var refreshing: Task<Void, Never>?
    @ObservationIgnored private var renewal: Task<Void, Never>?
    @ObservationIgnored private var active = false
    @ObservationIgnored private var listenID = 0
    @ObservationIgnored private var cancelledListen = -1
    @ObservationIgnored private var listenEnd: CheckedContinuation<ListenEnd, Never>?

    init() {
        audio = VoiceAudio()
    }

    // MARK: Lifecycle

    /// Fetches a token (refreshing when < 30 s remain) and starts the engine. 503 -> `.onDevice`.
    /// Any other failure also falls back to `.onDevice(reason)`; the next `prepare` tries again.
    func prepare(store: LiveStore) async {
        self.store = store
        active = true
        if !unavailable { await refreshToken(force: false) }
        guard availability == .cartesia else { return }
        do {
            try audio.start()
        } catch {
            availability = .onDevice(error.localizedDescription)
        }
    }

    /// Stops listening (listen returns nil) and speaking (no `onDone`), closes the sockets, stops
    /// the engine and releases the audio session. `prepare` again to reuse.
    func shutdown() {
        active = false
        cancelListening()
        stopSpeaking()
        renewal?.cancel()
        renewal = nil
        tts?.close()
        tts = nil
        audio.shutdown()
    }

    // MARK: Listening

    /// One utterance from the person. Returns the transcript, or nil if nothing was heard /
    /// cancelled. Requires `.cartesia` availability (throws otherwise). Stops any speech first.
    func listen(store: LiveStore) async throws -> String? {
        self.store = store
        active = true
        guard availability == .cartesia else {
            throw VoiceTurnError(message: "Live voice isn't available right now. Type instead.")
        }
        cancelListening()
        stopSpeaking()
        await refreshToken(force: false)
        guard availability == .cartesia, let token, tokenExpiry > Date() else {
            throw VoiceTurnError(message: "Live voice isn't available right now. Type instead.")
        }
        if audio.permission != .granted {
            guard await audio.requestPermission() else {
                throw VoiceTurnError(message: "Microphone access is off. Turn it on in Settings, or type instead.")
            }
        }
        try Task.checkCancellation()

        listenID += 1
        let id = listenID
        let stt = CartesiaSTT(token: token, keyterms: Self.keyterms(store: store, server: token.stt.keyterms ?? []))
        self.stt = stt
        caption = ""
        isListening = true
        stt.onCaption = { [weak self] finalText, interim in
            guard let self, self.listenID == id else { return }
            self.caption = finalText + interim
        }
        // The service failed mid-utterance: stop now; `finish` returns what it has or throws.
        stt.onFailure = { [weak self] _ in self?.endListen(id, .speech(heard: true)) }
        stt.connect()

        let end: ListenEnd = await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<ListenEnd, Never>) in
                listenEnd = continuation
                do {
                    try audio.beginCapture(
                        onChunk: { [weak stt] chunk in stt?.send(chunk) },
                        onSpeechStart: {},
                        onEndOfSpeech: { [weak self] heard in self?.endListen(id, .speech(heard: heard)) })
                } catch {
                    endListen(id, .failed(error))
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.endListen(id, .cancelled) }
        }

        // Only touch shared state while this is still the current listen.
        if id == listenID { audio.endCapture() }
        func done() {
            guard id == listenID else { return }
            isListening = false
            self.stt = nil
        }

        switch end {
        case .cancelled:
            stt.cancel()
            done()
            return nil
        case .failed(let error):
            stt.cancel()
            done()
            throw error
        case .speech(let heard):
            if !heard, caption.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || id != listenID {
                stt.cancel()
                done()
                return nil
            }
            let text: String
            do {
                text = try await stt.finish()
            } catch {
                done()
                if cancelledListen == id || Task.isCancelled { return nil }
                throw error
            }
            done()
            if cancelledListen == id || Task.isCancelled { return nil }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
    }

    /// Finish now (the person tapped): what was said so far is transcribed and returned.
    func stopListening() {
        guard isListening else { return }
        endListen(listenID, .speech(heard: true))
    }

    /// Discard; `listen()` returns nil.
    func cancelListening() {
        guard isListening else { return }
        cancelledListen = listenID
        endListen(listenID, .cancelled)
        stt?.cancel()  // also ends a `finish` that is waiting on the flush
        audio.endCapture()
        isListening = false
    }

    private func endListen(_ id: Int, _ result: ListenEnd) {
        guard id == listenID, let continuation = listenEnd else { return }
        listenEnd = nil
        continuation.resume(returning: result)
    }

    // MARK: Speaking

    /// A new utterance (Cartesia, or on-device with the same API). Stops the current one first:
    /// its `onDone` never fires.
    func speak(style: SpeechStyle) -> SpeechUtterance {
        stopSpeaking()
        let utterance: SpeechUtterance
        if availability == .cartesia, let tts {
            if tokenExpiry.timeIntervalSinceNow < Self.refreshMargin {
                Task { [weak self] in await self?.refreshToken(force: false) }
            }
            utterance = tts.utterance(style: style)
        } else {
            utterance = SpeechUtterance(onDevice: audio, style: style)
        }
        current = utterance
        return utterance
    }

    /// Speaks a whole text; `onDone` after it has played (not if stopped or replaced).
    func say(_ text: String, style: SpeechStyle, onDone: @escaping () -> Void) {
        let utterance = speak(style: style)
        utterance.append(text)
        utterance.finish(onDone: onDone)
    }

    /// Stops the current utterance (no `onDone`) and anything else playing.
    func stopSpeaking() {
        current?.cancel()
        current = nil
        audio.stopSpeech()
    }

    // MARK: Token

    private func refreshToken(force: Bool) async {
        if let refreshing {
            await refreshing.value
            return
        }
        if !force, token != nil, tokenExpiry.timeIntervalSinceNow > Self.refreshMargin {
            ensureTTS()
            return
        }
        guard let store else { return }
        let task = Task { [weak self] () -> Void in await self?.fetchToken(store) }
        refreshing = task
        await task.value
        refreshing = nil
    }

    private func fetchToken(_ store: LiveStore) async {
        do {
            let fresh = try await store.voiceToken()
            token = fresh
            tokenExpiry = Date().addingTimeInterval(TimeInterval(max(fresh.expiresIn, 0)))
            if let tts { tts.update(token: fresh) }
            ensureTTS()
            availability = .cartesia
            scheduleRenewal()
        } catch let error as VoiceTurnError where error.status == 503 {
            unavailable = true
            token = nil
            tts?.close()
            tts = nil
            availability = .onDevice(error.message)
        } catch is CancellationError {
            return
        } catch {
            if token == nil || tokenExpiry <= Date() {
                availability = .onDevice(error.localizedDescription)
            }
        }
    }

    private func ensureTTS() {
        guard tts == nil, let token, active else { return }
        tts = CartesiaTTS(token: token, audio: audio)
    }

    /// Keeps the token fresh while the session is prepared, so a socket that has to reconnect
    /// (an announcement minutes later in Drive mode) does not use an expired one.
    private func scheduleRenewal() {
        renewal?.cancel()
        guard active else { return }
        let delay = max(Self.minRenewalDelay, tokenExpiry.timeIntervalSinceNow - Self.refreshMargin - 5)
        renewal = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, self.active else { return }
            await self.refreshToken(force: true)
        }
    }
}

extension VoiceSession {
    /// More than about 10 boosts dilute each other (tested: "Pentz Road" was heard right with 10
    /// and wrong with 20), so the phone picks the names this person is most likely to say.
    static let maxKeyterms = 10

    /// Roads on this zone's published route and its destination, the roads and places in this
    /// phone's on-device questions, then the incident's busiest roads. All public map names; the
    /// person's own position is not among them.
    static func keyterms(store: LiveStore, server: [String]) -> [String] {
        var names: [String] = []
        if let guidance = store.myGuidance {
            names += guidance.route?.via ?? []
            if let destination = guidance.destination?.shortName { names.append(destination) }
        }
        names += store.boardQuestions.map(\.item.place.name)
        names += server
        var seen = Set<String>()
        var picked: [String] = []
        for name in names {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = trimmed.lowercased()
            guard !trimmed.isEmpty, trimmed.count <= 60, !key.hasPrefix("unnamed"), !key.hasPrefix("exit "),
                  seen.insert(key).inserted else { continue }
            picked.append(trimmed)
            if picked.count == maxKeyterms { break }
        }
        return picked
    }
}
