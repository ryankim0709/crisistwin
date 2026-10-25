import Foundation

/// The phone's direct WebSockets to Cartesia (contract: `docs/live-reports.md` "Voice mode"),
/// authorised by the short-lived access token from `POST voice/token`. The API key never reaches
/// the phone. Audio goes to Cartesia only while the person is talking (STT) and only the reply
/// text goes out for speech (TTS); nothing is stored.
enum CartesiaSocket {
    /// WebSocket connections only. The request timeout is how long a quiet socket may wait.
    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    /// Speech chunks are base64 PCM; leave room above the 1 MB default.
    static let maxMessageBytes = 8 * 1024 * 1024

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    /// `base?query` with every value strictly percent-encoded (tokens may hold `+`, `/`, `=`).
    static func url(_ base: String, _ query: [(String, String)]) -> URL? {
        guard var components = URLComponents(string: base) else { return nil }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        let encoded = query.map { name, value in
            URLQueryItem(name: name, value: value.addingPercentEncoding(withAllowedCharacters: allowed))
        }
        components.percentEncodedQueryItems = (components.percentEncodedQueryItems ?? []) + encoded
        return components.url
    }
}

/// A failure of the speech services, worded for the person.
struct CartesiaError: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

// MARK: - Speech to text

/// One utterance of live transcription (`ink-whisper`). Send 16 kHz mono s16le chunks with
/// `send`; `onCaption` reports the finalized text so far and the latest interim guess.
/// Main-actor only; callbacks run on the main actor.
@MainActor final class CartesiaSTT {
    var onCaption: ((_ finalText: String, _ interim: String) -> Void)?
    /// The socket or service failed (not in the shared contract; `VoiceSession` uses it to stop
    /// listening early). Fires at most once, never after `finish()` or `cancel()`.
    var onFailure: ((String) -> Void)?

    private static let flushTimeout: TimeInterval = 3
    /// After `close` is sent, drop the socket this long later even if the send never completes.
    private static let closeGrace: TimeInterval = 2

    private let token: VoiceToken
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    /// The is_final pieces, joined exactly as sent.
    private var finalText = ""
    private var interim = ""
    private var failure: String?
    private var flushed = false
    private var finishing = false
    private var cancelled = false
    private var flushWaiter: CheckedContinuation<Void, Never>?

    private struct Message: Decodable {
        let type: String
        let isFinal: Bool?
        let text: String?
        let message: String?
        let error: String?

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            type = try c.decode(String.self, forKey: .type)
            isFinal = try? c.decodeIfPresent(Bool.self, forKey: .isFinal)
            text = try? c.decodeIfPresent(String.self, forKey: .text)
            message = try? c.decodeIfPresent(String.self, forKey: .message)
            error = try? c.decodeIfPresent(String.self, forKey: .error)
        }

        private enum CodingKeys: String, CodingKey { case type, isFinal, text, message, error }
    }

    /// `keyterms`: place names to boost ("Pentz Road" over "Pence Road"); Cartesia caps the list.
    init(token: VoiceToken, keyterms: [String] = []) {
        self.token = token
        self.keyterms = keyterms
    }

    private let keyterms: [String]

    /// Opens the socket. Chunks sent before it is open are queued by URLSession.
    func connect() {
        guard socket == nil, !cancelled, !finishing else { return }
        let stt = token.stt
        guard let url = CartesiaSocket.url(stt.url, [
            ("model", stt.model), ("language", stt.language), ("encoding", stt.encoding),
            ("sample_rate", String(stt.sampleRate)), ("cartesia_version", token.version),
            ("access_token", token.token),
        ] + keyterms.map { ("keyterm", $0) }) else {
            fail("Voice transcription is misconfigured on the server.")
            return
        }
        let socket = CartesiaSocket.session.webSocketTask(with: url)
        socket.maximumMessageSize = CartesiaSocket.maxMessageBytes
        self.socket = socket
        socket.resume()
        receiver = Task { [weak self] in
            while !Task.isCancelled {
                let message: URLSessionWebSocketTask.Message
                do {
                    message = try await socket.receive()
                } catch {
                    self?.socketEnded(socket)
                    return
                }
                guard let self else { return }
                self.handle(message)
            }
        }
    }

    /// One chunk of 16 kHz mono s16le PCM. Ignored once finishing or failed.
    func send(_ pcm: Data) {
        guard let socket, !finishing, !cancelled, failure == nil, !pcm.isEmpty else { return }
        socket.send(.data(pcm)) { _ in }  // a failed send also ends `receive`, which reports it
    }

    /// Sends `finalize`, waits for `flush_done` (at most 3 s), returns the full transcript (what
    /// it has on timeout), then sends `close`. Throws only if the service failed and nothing at
    /// all was transcribed.
    func finish() async throws -> String {
        guard !cancelled else { return "" }
        guard !finishing else { return finalText }
        finishing = true
        if let socket, failure == nil {
            socket.send(.string("finalize")) { _ in }
            await waitForFlush()
        }
        let text = flushed ? finalText : finalText + interim
        closeSocket()
        if text.isEmpty, let failure { throw CartesiaError(message: failure) }
        return text
    }

    /// Discards the utterance; no callbacks after this.
    func cancel() {
        guard !cancelled else { return }
        cancelled = true
        onCaption = nil
        onFailure = nil
        resumeFlush()
        receiver?.cancel()
        receiver = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        guard !cancelled, socket != nil else { return }
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let raw): data = raw
        @unknown default: return
        }
        guard let parsed = try? CartesiaSocket.decoder.decode(Message.self, from: data) else { return }
        switch parsed.type {
        case "transcript":
            let text = parsed.text ?? ""
            if parsed.isFinal == true {
                finalText += text
                interim = ""
            } else {
                interim = text
            }
            onCaption?(finalText, interim)
        case "flush_done":
            flushed = true
            resumeFlush()
        case "done":
            resumeFlush()
        case "error":
            fail(parsed.message ?? parsed.error ?? "Voice transcription had a problem.")
        default:
            break
        }
    }

    private func socketEnded(_ ended: URLSessionWebSocketTask) {
        guard ended === socket else { return }  // closed on purpose
        socket = nil
        fail("Lost the connection to voice transcription.")
    }

    private func fail(_ reason: String) {
        guard failure == nil else { return }
        failure = reason
        resumeFlush()
        if !finishing, !cancelled { onFailure?(reason) }
    }

    private func waitForFlush() async {
        guard !flushed, failure == nil, !cancelled else { return }
        let timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(CartesiaSTT.flushTimeout))
            self?.resumeFlush()
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                if flushed || failure != nil || cancelled {
                    continuation.resume()
                } else {
                    flushWaiter = continuation
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.resumeFlush() }
        }
        timer.cancel()
    }

    private func resumeFlush() {
        let waiter = flushWaiter
        flushWaiter = nil
        waiter?.resume()
    }

    private func closeSocket() {
        guard let socket else { return }
        self.socket = nil
        receiver?.cancel()
        receiver = nil
        socket.send(.string("close")) { _ in socket.cancel(with: .normalClosure, reason: nil) }
        Task {
            try? await Task.sleep(for: .seconds(CartesiaSTT.closeGrace))
            socket.cancel(with: .normalClosure, reason: nil)
        }
    }
}

// MARK: - Text to speech

/// How a line is voiced: replies neutral at normal speed, guidance announcements calm and a
/// little slower.
enum SpeechStyle {
    case reply, announcement

    var speed: Double {
        switch self {
        case .reply: return 1.0
        case .announcement: return 0.95
        }
    }

    var emotion: String {
        switch self {
        case .reply: return "neutral"
        case .announcement: return "calm"
        }
    }
}

/// Streaming speech (`sonic`) over one WebSocket, opened lazily and reopened if it drops. Each
/// utterance is its own `context_id`; audio chunks are routed back by that id and played through
/// `VoiceAudio`. Main-actor only.
@MainActor final class CartesiaTTS {
    private(set) var token: VoiceToken
    private let audio: VoiceAudio
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    /// Utterances waiting on Cartesia, by context id.
    private var utterances: [String: SpeechUtterance] = [:]

    private struct Message: Decodable {
        let type: String
        let contextId: String?
        let data: String?
        let error: String?
        let message: String?

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            type = try c.decode(String.self, forKey: .type)
            contextId = try? c.decodeIfPresent(String.self, forKey: .contextId)
            data = try? c.decodeIfPresent(String.self, forKey: .data)
            error = try? c.decodeIfPresent(String.self, forKey: .error)
            message = try? c.decodeIfPresent(String.self, forKey: .message)
        }

        private enum CodingKeys: String, CodingKey { case type, contextId, data, error, message }
    }

    init(token: VoiceToken, audio: VoiceAudio) {
        self.token = token
        self.audio = audio
    }

    func utterance(style: SpeechStyle) -> SpeechUtterance {
        SpeechUtterance(tts: self, audio: audio, style: style)
    }

    /// A fresh token for the next connection; an open socket keeps working on the old one.
    func update(token: VoiceToken) {
        self.token = token
    }

    /// Cancels every utterance in flight (their `onDone` never fires) and closes the socket.
    func close() {
        let all = utterances.values
        utterances = [:]
        var seen = Set<ObjectIdentifier>()
        for u in all where seen.insert(ObjectIdentifier(u)).inserted { u.cancel() }
        receiver?.cancel()
        receiver = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    fileprivate func send(_ json: String, contextId: String, from utterance: SpeechUtterance) {
        utterances[contextId] = utterance
        guard let socket = openSocket() else {
            utterances[contextId] = nil
            utterance.failed("Voice playback is misconfigured on the server.")
            return
        }
        socket.send(.string(json)) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor in self?.sendFailed(contextId: contextId) }
        }
    }

    fileprivate func cancel(contextId: String) {
        utterances[contextId] = nil
        guard let socket, socket.state == .running else { return }
        let body = "{\"context_id\":\"\(contextId)\",\"cancel\":true}"
        socket.send(.string(body)) { _ in }
    }

    /// Stops routing a context to its utterance (it fell back or finished).
    fileprivate func forget(contextId: String) {
        utterances[contextId] = nil
    }

    private func openSocket() -> URLSessionWebSocketTask? {
        if let socket, socket.state == .running { return socket }
        socket?.cancel(with: .goingAway, reason: nil)
        receiver?.cancel()
        guard let url = CartesiaSocket.url(token.tts.url, [
            ("cartesia_version", token.version), ("access_token", token.token),
        ]) else { return nil }
        let socket = CartesiaSocket.session.webSocketTask(with: url)
        socket.maximumMessageSize = CartesiaSocket.maxMessageBytes
        self.socket = socket
        socket.resume()
        receiver = Task { [weak self] in
            while !Task.isCancelled {
                let message: URLSessionWebSocketTask.Message
                do {
                    message = try await socket.receive()
                } catch {
                    self?.socketEnded(socket)
                    return
                }
                guard let self else { return }
                self.handle(message)
            }
        }
        return socket
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let raw): data = raw
        @unknown default: return
        }
        guard let parsed = try? CartesiaSocket.decoder.decode(Message.self, from: data) else { return }
        guard let id = parsed.contextId else {
            if parsed.type == "error" { failAll(parsed.error ?? parsed.message ?? "Voice playback had a problem.") }
            return
        }
        guard let utterance = utterances[id] else { return }  // cancelled or already done
        switch parsed.type {
        case "chunk":
            if let encoded = parsed.data, let pcm = Data(base64Encoded: encoded), !pcm.isEmpty {
                utterance.received(pcm, contextId: id)
            }
        case "done":
            utterances[id] = nil
            utterance.serverDone(contextId: id)
        case "error":
            utterances[id] = nil
            utterance.failed(parsed.error ?? parsed.message ?? "Voice playback had a problem.")
        default:
            break  // timestamps, flush_done: not used
        }
    }

    private func sendFailed(contextId: String) {
        guard let utterance = utterances[contextId] else { return }
        utterances[contextId] = nil
        utterance.failed("Could not reach voice playback.")
    }

    private func socketEnded(_ ended: URLSessionWebSocketTask) {
        guard ended === socket else { return }
        socket = nil
        receiver = nil
        failAll("Lost the connection to voice playback.")
    }

    private func failAll(_ reason: String) {
        let all = utterances.values
        utterances = [:]
        var seen = Set<ObjectIdentifier>()
        for u in all where seen.insert(ObjectIdentifier(u)).inserted { u.failed(reason) }
    }
}

/// One spoken line, streamed as its text arrives. Created by `CartesiaTTS.utterance(style:)` or,
/// without Cartesia, by `VoiceSession` as an on-device utterance with the same API (text is
/// buffered and spoken with `VoiceAudio.speakLocally` on `finish`). Main-actor only.
@MainActor final class SpeechUtterance {
    private enum State { case open, finishing, done, cancelled }

    /// A piece was sent and no audio came back for this long: Cartesia is not answering.
    private static let firstAudioTimeout: TimeInterval = 5
    /// After `finish`, no chunk or `done` for this long: end with what has played.
    private static let doneTimeout: TimeInterval = 5

    private let audio: VoiceAudio
    private let tts: CartesiaTTS?
    private let settings: VoiceToken.TTS?
    private let style: SpeechStyle
    private var contextId = UUID().uuidString
    private var state: State = .open
    private var onDone: (() -> Void)?
    /// Everything appended, for the on-device fallback.
    private var fullText = ""
    /// Text not yet sent; may start with a space (kept so pieces join into the transcript).
    private var buffer = ""
    /// The latest complete sentence(s), held until more text proves it is not the last piece.
    private var held: String?
    private var sentAny = false
    /// Cartesia finished the current context.
    private var contextDone = false
    /// `VoiceAudio.speechID` of our playback, once it started.
    private var audioID: Int?
    private var playedAny = false
    /// Cartesia failed before any audio: speak `fullText` on-device at `finish`.
    private var local: Bool
    /// Cartesia failed after some audio played: no more pieces; end with what played.
    private var broken = false
    private var ending = false
    private var stall: Task<Void, Never>?

    init(tts: CartesiaTTS, audio: VoiceAudio, style: SpeechStyle) {
        self.tts = tts
        self.settings = tts.token.tts
        self.audio = audio
        self.style = style
        self.local = false
    }

    /// The on-device variant: same API, spoken with `speakLocally` on `finish`.
    init(onDevice audio: VoiceAudio, style: SpeechStyle) {
        self.tts = nil
        self.settings = nil
        self.audio = audio
        self.style = style
        self.local = true
    }

    /// Streamed reply text. Pieces are sent at sentence ends (. ? !), holding the latest complete
    /// sentence back until more text arrives so the final piece can carry continue:false.
    func append(_ text: String) {
        guard state == .open, !text.isEmpty else { return }
        fullText += text
        guard !local, !broken else { return }
        buffer += text
        if let end = Self.lastSentenceEnd(in: buffer) {
            held = (held ?? "") + buffer[..<end]
            buffer = String(buffer[end...])
        }
        if let ready = held, Self.hasWords(buffer) {
            held = nil
            sendPiece(ready, last: false)
        }
    }

    /// Sends what is left with continue:false; `onDone` after the audio has finished playing
    /// (at once, synchronously, if there was nothing to say). If Cartesia fails before any audio
    /// played, speaks the whole text with `speakLocally` instead.
    func finish(onDone: @escaping () -> Void) {
        guard state == .open else { return }
        state = .finishing
        self.onDone = onDone
        if local {
            speakLocal()
            return
        }
        if broken {
            endAudio()
            return
        }
        let rest = (held ?? "") + buffer
        held = nil
        buffer = ""
        if Self.hasWords(rest) {
            sendPiece(rest, last: true)
        } else if !sentAny {
            complete()
        } else if contextDone {
            endAudio()
        } else {
            armStall()
        }
    }

    /// Cancels the context and stops our playback; `onDone` never fires.
    func cancel() {
        guard state == .open || state == .finishing else { return }
        state = .cancelled
        onDone = nil
        stall?.cancel()
        stall = nil
        if let tts, sentAny, !contextDone, !local { tts.cancel(contextId: contextId) }
        if let audioID, audio.speechID == audioID { audio.stopSpeech() }
    }

    // MARK: From CartesiaTTS

    fileprivate func received(_ pcm: Data, contextId id: String) {
        guard state == .open || state == .finishing, !local, !ending else { return }
        if audioID == nil {
            audio.beginSpeech(sampleRate: Double(settings?.sampleRate ?? 24_000))
            audioID = audio.speechID
        }
        guard audio.speechID == audioID else {
            // Something else took the speaker: this line is over, quietly.
            superseded()
            return
        }
        guard !audio.speechFailed else {
            if !playedAny {
                failed("The speaker could not play the voice.")
            } else {
                broken = true
                if state == .finishing { endAudio() }
            }
            return
        }
        audio.enqueueSpeech(pcm)
        playedAny = true
        armStall()
    }

    fileprivate func serverDone(contextId id: String) {
        guard id == contextId, state == .open || state == .finishing, !local else { return }
        contextDone = true
        if state == .finishing { endAudio() }
    }

    fileprivate func failed(_ reason: String) {
        guard state == .open || state == .finishing, !local, !ending else { return }
        stall?.cancel()
        stall = nil
        tts?.forget(contextId: contextId)
        if !playedAny {
            if let audioID, audio.speechID == audioID { audio.stopSpeech() }
            audioID = nil
            local = true
            if state == .finishing { speakLocal() }
        } else {
            broken = true
            if state == .finishing { endAudio() }
        }
    }

    // MARK: Internals

    private func sendPiece(_ text: String, last: Bool) {
        guard let tts, let settings else { return }
        if contextDone {
            // Cartesia closed the context early; carry on in a fresh one.
            contextId = UUID().uuidString
            contextDone = false
        }
        let request = TTSRequest(
            modelId: settings.model, transcript: text, voice: .init(id: settings.voiceId),
            language: settings.language, contextId: contextId, continue: !last, maxBufferDelayMs: 0,
            outputFormat: .init(container: "raw", encoding: settings.encoding, sampleRate: settings.sampleRate),
            generationConfig: .init(speed: style.speed, emotion: style.emotion))
        guard let data = try? JSONEncoder().encode(request), let json = String(data: data, encoding: .utf8) else {
            failed("Voice playback could not start.")
            return
        }
        sentAny = true
        tts.send(json, contextId: contextId, from: self)
        armStall()
    }

    private func endAudio() {
        guard !ending, state == .finishing else { return }
        ending = true
        stall?.cancel()
        stall = nil
        tts?.forget(contextId: contextId)
        if let audioID {
            guard audio.speechID == audioID else {
                superseded()
                return
            }
            audio.endSpeech { [weak self] in self?.complete() }
        } else if Self.hasWords(fullText) {
            // Cartesia ended without any audio: say it on-device rather than nothing.
            ending = false
            local = true
            speakLocal()
        } else {
            complete()
        }
    }

    private func speakLocal() {
        guard state == .finishing else { return }
        guard Self.hasWords(fullText) else {
            complete()
            return
        }
        audio.speakLocally(fullText) { [weak self] in self?.complete() }
        if state == .finishing { audioID = audio.speechID }
    }

    private func superseded() {
        guard state == .open || state == .finishing else { return }
        state = .cancelled
        onDone = nil
        stall?.cancel()
        stall = nil
        if let tts, sentAny, !contextDone { tts.cancel(contextId: contextId) }
    }

    private func complete() {
        guard state == .open || state == .finishing else { return }
        state = .done
        stall?.cancel()
        stall = nil
        let done = onDone
        onDone = nil
        done?()
    }

    /// Waits on Cartesia only when something is owed: audio for a sent piece, or the end after
    /// `finish`. Re-armed by every send and chunk.
    private func armStall() {
        stall?.cancel()
        stall = nil
        guard !local, !ending, state == .open || state == .finishing,
              (sentAny && !playedAny) || state == .finishing else { return }
        let wait = playedAny ? Self.doneTimeout : Self.firstAudioTimeout
        stall = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, let self else { return }
            self.stalled()
        }
    }

    private func stalled() {
        stall = nil
        if !playedAny {
            failed("Voice playback did not answer.")
        } else if state == .finishing {
            endAudio()
        }
    }

    /// Index just past the last sentence end (. ? ! and any closing quotes or brackets) that is
    /// followed by whitespace. A terminator at the very end is not trusted yet ("3." of "3.5").
    static func lastSentenceEnd(in text: String) -> String.Index? {
        let closers: Set<Character> = ["\"", "'", ")", "]", "\u{201D}", "\u{2019}"]
        var result: String.Index?
        var i = text.startIndex
        while i < text.endIndex {
            let c = text[i]
            if c == "." || c == "?" || c == "!" {
                var j = text.index(after: i)
                while j < text.endIndex, closers.contains(text[j]) { j = text.index(after: j) }
                if j < text.endIndex, text[j].isWhitespace { result = j }
                i = j
            } else {
                i = text.index(after: i)
            }
        }
        return result
    }

    static func hasWords(_ text: String) -> Bool {
        text.contains { !$0.isWhitespace }
    }
}

/// One TTS WebSocket message (contract above). Keys are spelled out, not converted.
private struct TTSRequest: Encodable {
    struct Voice: Encodable { let id: String }
    struct OutputFormat: Encodable {
        let container: String
        let encoding: String
        let sampleRate: Int
        private enum CodingKeys: String, CodingKey {
            case container, encoding
            case sampleRate = "sample_rate"
        }
    }
    struct GenerationConfig: Encodable {
        let speed: Double
        let emotion: String
    }

    let modelId: String
    let transcript: String
    let voice: Voice
    let language: String
    let contextId: String
    let `continue`: Bool
    let maxBufferDelayMs: Int
    let outputFormat: OutputFormat
    let generationConfig: GenerationConfig

    private enum CodingKeys: String, CodingKey {
        case modelId = "model_id"
        case transcript, voice, language
        case contextId = "context_id"
        case `continue`
        case maxBufferDelayMs = "max_buffer_delay_ms"
        case outputFormat = "output_format"
        case generationConfig = "generation_config"
    }
}
