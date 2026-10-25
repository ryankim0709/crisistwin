import AVFoundation
import Foundation
import Observation

/// Microphone capture and speaker playback for voice mode, on one AVAudioEngine with voice
/// processing on, so the echo canceller removes the phone's own speech from the microphone and
/// the person can talk over a reply (barge-in) on the speaker.
///
/// - Capture: the mic is converted to 16 kHz mono s16le and handed out in ~100 ms chunks while a
///   consumer is attached (`beginCapture`), with an end-of-speech detector. Nothing is recorded to
///   disk or kept.
/// - Playback: streamed f32le PCM (Cartesia) through an AVAudioPlayerNode, or on-device
///   AVSpeechSynthesizer as the fallback.
///
/// Main-actor only; every callback is delivered on the main actor. Never crashes on audio
/// failures: starting throws, playback degrades (its `onFinish` still fires). The session is
/// active from `start()` until `shutdown()`, and an interruption or route change stops capture
/// cleanly; the engine restarts on next use.
@MainActor @Observable
final class VoiceAudio {
    enum Permission { case undetermined, granted, denied }

    private(set) var permission: Permission
    /// The engine is up.
    private(set) var isRunning = false
    /// Mic chunks are going to a consumer.
    private(set) var isCapturing = false
    /// Streamed PCM or on-device speech is playing.
    private(set) var isSpeaking = false
    /// 0...1 mic level, whenever the engine has the mic (also while speaking, for barge-in UI).
    private(set) var level: Float = 0

    /// While `isSpeaking` (streamed speech) and not capturing: fires once per utterance when the
    /// person talks over the reply. Nil disables barge-in. Not raised during on-device speech,
    /// which does not pass through the echo canceller and would hear itself.
    @ObservationIgnored var onBargeIn: (() -> Void)?

    /// Changes whenever speech starts, stops or finishes, so a speaker can tell whether the
    /// current playback is still its own.
    @ObservationIgnored private(set) var speechID = 0
    /// The current streamed speech could not play (engine failed or stopped); `endSpeech` then
    /// finishes at once. Lets a speaker fall back to on-device speech.
    @ObservationIgnored private(set) var speechFailed = false

    // MARK: Tuning

    /// Mic chunks: 16 kHz mono 16-bit, 100 ms.
    nonisolated static let captureSampleRate: Double = 16_000
    nonisolated static let chunkBytes = 3_200
    /// Requested tap size; the system may deliver other sizes.
    private static let tapFrames: AVAudioFrameCount = 2_048
    /// Default playback rate until `beginSpeech` says otherwise (Cartesia's 24 kHz).
    private static let defaultSpeechRate: Double = 24_000
    /// RMS (dBFS) above this counts as speech for end-of-speech detection.
    private static let speechThresholdDB: Float = -40
    /// Less speech than this is a cough or a tap, not someone talking.
    private static let minSpeech: TimeInterval = 0.2
    /// Silence this long after speech ends the utterance.
    private static let endSilence: TimeInterval = 1.0
    /// Give up if nothing was heard by now.
    private static let noSpeechTimeout: TimeInterval = 5
    /// Hard cap on one utterance.
    private static let maxCapture: TimeInterval = 20
    /// Barge-in is deliberately stricter than speech detection: louder, and sustained.
    private static let bargeInThresholdDB: Float = -28
    private static let bargeInSustain: TimeInterval = 0.3
    /// Input levels from `floorDB` (silent) to `ceilingDB` (loud) map onto 0...1 for the UI.
    private static let floorDB: Float = -60
    private static let ceilingDB: Float = -10
    /// After `endSpeech`, finish anyway this long after the queued audio should have played, in
    /// case the player never reports it (engine stalled without a notification).
    private static let finishGrace: TimeInterval = 1.5
    /// Engine recoveries allowed within `recoveryWindow` before giving up (avoids a restart loop).
    private static let maxRecoveries = 3
    private static let recoveryWindow: TimeInterval = 5

    private struct AudioFailure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    // MARK: Engine state

    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var player: AVAudioPlayerNode?
    @ObservationIgnored private var playerFormat: AVAudioFormat?
    /// Nil when the engine runs without the mic (no permission yet, or no usable input).
    @ObservationIgnored private var mic: MicProcessor?
    @ObservationIgnored private var echoCancelled = false
    /// Mic callbacks from a torn-down engine are dropped.
    @ObservationIgnored private var engineGeneration = 0
    @ObservationIgnored private var recoveries: [Date] = []
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    // MARK: Capture state

    private struct Capture {
        let onChunk: (Data) -> Void
        let onSpeechStart: () -> Void
        let onEndOfSpeech: (Bool) -> Void
        var elapsed: TimeInterval = 0
        var speech: TimeInterval = 0
        var lastSpeechAt: TimeInterval = 0
        var heard = false
    }

    @ObservationIgnored private var capture: Capture?

    // MARK: Speech state

    /// Streamed PCM is the current speech (as opposed to on-device).
    @ObservationIgnored private var streaming = false
    @ObservationIgnored private var scheduled = 0
    @ObservationIgnored private var played = 0
    /// Seconds of scheduled audio not yet reported played.
    @ObservationIgnored private var pendingSeconds: TimeInterval = 0
    @ObservationIgnored private var speechEnded = false
    @ObservationIgnored private var speechFinish: (() -> Void)?
    /// Bytes of a partial f32 sample carried to the next chunk.
    @ObservationIgnored private var remainder = Data()
    @ObservationIgnored private var watchdog: Task<Void, Never>?
    @ObservationIgnored private var bargeRun: TimeInterval = 0
    @ObservationIgnored private var bargeFired = false

    @ObservationIgnored private var synthesizer: AVSpeechSynthesizer?
    @ObservationIgnored private var speechDelegate: SpeechDelegate?
    @ObservationIgnored private var localFinish: (() -> Void)?

    init() {
        permission = Self.currentPermission()
        observeSession()
    }

    // MARK: Permission

    /// Asks for microphone access if it has not been asked yet. True when granted.
    func requestPermission() async -> Bool {
        if Self.currentPermission() == .undetermined {
            _ = await AVAudioApplication.requestRecordPermission()
        }
        permission = Self.currentPermission()
        return permission == .granted
    }

    private static func currentPermission() -> Permission {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        default: return .undetermined
        }
    }

    // MARK: Lifecycle

    /// Activates the session (`.playAndRecord`, speaker, Bluetooth HFP) and starts the engine with
    /// voice processing and the player node. Without microphone permission the engine starts for
    /// playback only; `beginCapture` rebuilds it with the mic later. Idempotent.
    func start() throws {
        permission = Self.currentPermission()
        if let engine, engine.isRunning, isRunning, mic != nil || permission != .granted { return }
        teardownEngine()
        do {
            try Self.activateSession()
        } catch {
            throw AudioFailure(message: "The phone's audio could not start. Try again.")
        }
        try buildEngine()
    }

    /// Stops capture (firing `onEndOfSpeech(false)` so no listener waits forever), speech (no
    /// callbacks) and the engine, and deactivates the session so other apps' audio resumes.
    func shutdown() {
        finishCapture(firing: true)
        stopSpeech()
        teardownEngine()
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: Capture

    /// Mic -> 16 kHz mono s16le chunks of ~100 ms. `onSpeechStart` once speech is heard;
    /// `onEndOfSpeech(heard:)` after ~1.0 s of silence following speech, after ~5 s if nothing was
    /// ever heard (heard: false), at 20 s, or when an interruption stops the mic. Capture has
    /// already ended when `onEndOfSpeech` runs. Throws if the mic is off or cannot start.
    func beginCapture(
        onChunk: @escaping (Data) -> Void, onSpeechStart: @escaping () -> Void,
        onEndOfSpeech: @escaping (_ heard: Bool) -> Void
    ) throws {
        permission = Self.currentPermission()
        guard permission == .granted else {
            throw AudioFailure(message: "Microphone access is off. Turn it on in Settings, or type instead.")
        }
        finishCapture(firing: false)
        if mic == nil || engine?.isRunning != true || !isRunning {
            try start()
        }
        guard mic != nil else {
            throw AudioFailure(message: "The microphone isn't available right now. Type instead.")
        }
        capture = Capture(onChunk: onChunk, onSpeechStart: onSpeechStart, onEndOfSpeech: onEndOfSpeech)
        isCapturing = true
        bargeRun = 0
    }

    /// Stops delivering; no callbacks after this.
    func endCapture() {
        finishCapture(firing: false)
    }

    private func finishCapture(firing: Bool) {
        guard let ended = capture else { return }
        capture = nil
        isCapturing = false
        bargeRun = 0
        if firing { ended.onEndOfSpeech(ended.heard) }
    }

    /// One converted mic buffer, on the main actor, in order.
    fileprivate func handleMic(_ result: MicResult, generation: Int) {
        guard generation == engineGeneration else { return }
        let normalized = min(1, max(0, (result.db - Self.floorDB) / (Self.ceilingDB - Self.floorDB)))
        if abs(normalized - level) > 0.01 { level = normalized }

        if capture != nil {
            for chunk in result.chunks { capture?.onChunk(chunk) }
            guard var c = capture else { return }
            c.elapsed += result.seconds
            if result.db > Self.speechThresholdDB {
                c.speech += result.seconds
                c.lastSpeechAt = c.elapsed
            }
            let startedNow = !c.heard && c.speech >= Self.minSpeech
            if startedNow { c.heard = true }
            let done = c.elapsed >= Self.maxCapture
                || (c.heard && c.elapsed - c.lastSpeechAt >= Self.endSilence)
                || (!c.heard && c.elapsed >= Self.noSpeechTimeout)
            capture = c
            if startedNow { c.onSpeechStart() }
            if done, capture != nil { finishCapture(firing: true) }
            return
        }

        guard isSpeaking, streaming, echoCancelled, !bargeFired, onBargeIn != nil else {
            bargeRun = 0
            return
        }
        if result.db > Self.bargeInThresholdDB {
            bargeRun += result.seconds
            if bargeRun >= Self.bargeInSustain {
                bargeFired = true
                bargeRun = 0
                onBargeIn?()
            }
        } else {
            bargeRun = 0
        }
    }

    // MARK: Streamed speech

    /// Starts streamed speech: f32le mono PCM at `sampleRate`. Stops any current speech first.
    func beginSpeech(sampleRate: Double) {
        stopSpeech()
        speechID += 1
        isSpeaking = true
        streaming = true
        bargeFired = false
        bargeRun = 0
        do {
            if engine?.isRunning != true || !isRunning { try start() }
            try connectPlayer(sampleRate: sampleRate)
            if let player, engine?.isRunning == true, !player.isPlaying { player.play() }
        } catch {
            speechFailed = true
        }
    }

    /// Queues PCM for the current streamed speech. Ignored after `endSpeech` or `stopSpeech`.
    func enqueueSpeech(_ pcm: Data) {
        guard streaming, !speechEnded, !speechFailed, let player, let format = playerFormat,
              let engine, engine.isRunning else { return }
        var bytes = Data(capacity: remainder.count + pcm.count)
        bytes.append(remainder)
        bytes.append(pcm)
        let sampleBytes = MemoryLayout<Float>.size
        let usable = bytes.count / sampleBytes * sampleBytes
        remainder = Data(bytes.suffix(bytes.count - usable))
        let frames = usable / sampleBytes
        guard frames > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData?[0] else { return }
        bytes.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            memcpy(channel, base, usable)
        }
        buffer.frameLength = AVAudioFrameCount(frames)
        let seconds = Double(frames) / format.sampleRate
        scheduled += 1
        pendingSeconds += seconds
        Self.schedule(buffer, on: player, owner: self, speech: speechID, seconds: seconds)
        if !player.isPlaying { player.play() }
    }

    /// `onFinish` runs after the last enqueued buffer has played (at once if nothing is playing,
    /// or if playback failed). Not called after `stopSpeech()`.
    func endSpeech(onFinish: @escaping () -> Void) {
        guard isSpeaking, streaming, !speechEnded else {
            onFinish()
            return
        }
        speechEnded = true
        speechFinish = onFinish
        remainder = Data()
        if speechFailed || played >= scheduled {
            finishSpeech()
            return
        }
        armWatchdog()
    }

    /// Immediate; no callbacks. Also stops on-device speech.
    func stopSpeech() {
        speechID += 1
        watchdog?.cancel()
        watchdog = nil
        if let player, engine?.isRunning == true { player.stop() }
        resetStreamState()
        synthesizer?.stopSpeaking(at: .immediate)
        synthesizer = nil
        speechDelegate = nil
        localFinish = nil
        isSpeaking = false
    }

    private func resetStreamState() {
        streaming = false
        scheduled = 0
        played = 0
        pendingSeconds = 0
        speechEnded = false
        speechFinish = nil
        speechFailed = false
        remainder = Data()
        bargeRun = 0
    }

    fileprivate func bufferPlayed(speech: Int, seconds: TimeInterval) {
        guard speech == speechID, streaming else { return }
        played += 1
        pendingSeconds = max(0, pendingSeconds - seconds)
        if speechEnded, played >= scheduled { finishSpeech() }
    }

    private func armWatchdog() {
        watchdog?.cancel()
        let id = speechID
        let wait = pendingSeconds + Self.finishGrace
        watchdog = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, let self, self.speechID == id, self.speechEnded else { return }
            self.finishSpeech()
        }
    }

    private func finishSpeech() {
        let done = speechFinish
        watchdog?.cancel()
        watchdog = nil
        resetStreamState()
        speechID += 1
        isSpeaking = false
        done?()
    }

    /// The engine went away under streamed speech: queued audio is lost. Finishes now if
    /// `endSpeech` was called; otherwise `endSpeech` will finish at once.
    private func breakSpeech() {
        guard streaming else { return }
        speechFailed = true
        played = scheduled
        pendingSeconds = 0
        if speechEnded { finishSpeech() }
    }

    private func connectPlayer(sampleRate: Double) throws {
        guard let engine, let player else { throw AudioFailure(message: "Playback could not start.") }
        let rate = sampleRate > 0 ? sampleRate : Self.defaultSpeechRate
        if let playerFormat, playerFormat.sampleRate == rate { return }
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)
        else { throw AudioFailure(message: "Playback could not start.") }
        player.stop()
        engine.disconnectNodeOutput(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        playerFormat = format
    }

    // MARK: On-device speech

    /// AVSpeechSynthesizer fallback. Stops any current speech first. `onFinish` fires when it
    /// ends (at once for empty text); not after `stopSpeech()`.
    func speakLocally(_ text: String, onFinish: @escaping () -> Void) {
        stopSpeech()
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            onFinish()
            return
        }
        // A failure to activate is not fatal: the synthesizer can still speak.
        if !isRunning { try? Self.activateSession() }
        speechID += 1
        let synthesizer = AVSpeechSynthesizer()
        let delegate = SpeechDelegate { [weak self, weak synthesizer] in
            guard let self, let synthesizer, self.synthesizer === synthesizer else { return }
            self.finishLocal()
        }
        synthesizer.delegate = delegate
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
        self.synthesizer = synthesizer
        speechDelegate = delegate
        localFinish = onFinish
        isSpeaking = true
        streaming = false
        bargeFired = true
        synthesizer.speak(utterance)
    }

    private func finishLocal() {
        let done = localFinish
        synthesizer = nil
        speechDelegate = nil
        localFinish = nil
        speechID += 1
        isSpeaking = false
        done?()
    }

    // MARK: Engine

    private static func activateSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
    }

    private func buildEngine() throws {
        let engine = AVAudioEngine()
        engineGeneration += 1
        let generation = engineGeneration
        var mic: MicProcessor?
        var echoCancelled = false

        if permission == .granted {
            let input = engine.inputNode
            // Before anything is connected or started: it changes the input format.
            do {
                try input.setVoiceProcessingEnabled(true)
                echoCancelled = true
                // Keep on-device speech (not part of voice processing) at normal volume.
                input.voiceProcessingOtherAudioDuckingConfiguration =
                    AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
            } catch {
                echoCancelled = false
            }
            let format = input.outputFormat(forBus: 0)
            if let processor = MicProcessor(inputFormat: format) {
                input.installTap(
                    onBus: 0, bufferSize: Self.tapFrames, format: format,
                    block: Self.tapBlock(processor, owner: self, generation: generation))
                mic = processor
            }
        }

        let player = AVAudioPlayerNode()
        engine.attach(player)
        let rate = playerFormat?.sampleRate ?? Self.defaultSpeechRate
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)
        else { throw AudioFailure(message: "Playback could not start.") }
        engine.connect(player, to: engine.mainMixerNode, format: format)
        engine.prepare()
        do {
            try engine.start()
        } catch {
            if mic != nil { engine.inputNode.removeTap(onBus: 0) }
            engineGeneration += 1
            throw AudioFailure(message: "The microphone or speaker could not start. Try again, or type instead.")
        }
        self.engine = engine
        self.player = player
        self.playerFormat = format
        self.mic = mic
        self.echoCancelled = echoCancelled
        isRunning = true
    }

    /// Stops the engine and drops it; streamed speech in flight is broken (see `breakSpeech`).
    /// Capture state is kept so `recoverEngine` can continue it.
    private func teardownEngine() {
        breakSpeech()
        if let engine {
            if mic != nil { engine.inputNode.removeTap(onBus: 0) }
            engine.stop()
        }
        engine = nil
        player = nil
        mic = nil
        echoCancelled = false
        engineGeneration += 1
        isRunning = false
    }

    /// The engine stopped under us (route or configuration change): rebuild it and carry on
    /// capturing; give up cleanly if it will not come back.
    private func recoverEngine() {
        let now = Date()
        recoveries = recoveries.filter { now.timeIntervalSince($0) < Self.recoveryWindow } + [now]
        stopLocalSpeechAsFinished()
        teardownEngine()
        guard recoveries.count <= Self.maxRecoveries, (try? start()) != nil, mic != nil || capture == nil else {
            finishCapture(firing: true)
            return
        }
    }

    /// An interruption stops the synthesizer too (it may only pause); finish it so nobody waits.
    private func stopLocalSpeechAsFinished() {
        guard let synthesizer else { return }
        synthesizer.stopSpeaking(at: .immediate)
        finishLocal()
    }

    // MARK: Session notifications

    private func observeSession() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            MainActor.assumeIsolated { self?.handleInterruption(raw) }
        })
        observers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.handleEngineMayHaveStopped() }
        })
        observers.append(center.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main
        ) { [weak self] note in
            let changed = note.object as? AVAudioEngine
            MainActor.assumeIsolated {
                guard let self, let changed, changed === self.engine else { return }
                self.handleEngineMayHaveStopped()
            }
        })
        observers.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.handleInterruption(AVAudioSession.InterruptionType.began.rawValue) }
        })
    }

    private func handleInterruption(_ raw: UInt?) {
        guard let raw, AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
        // The system stopped the engine. Stop capture cleanly and let the next use restart it.
        stopLocalSpeechAsFinished()
        teardownEngine()
        finishCapture(firing: true)
        level = 0
    }

    /// A configuration change stops the engine. Restart the same engine first: with voice
    /// processing on, every newly built engine posts its own change right after starting, so
    /// rebuilding on each one loops (seen in the simulator: four rebuilds in 5 s, then no audio).
    private func handleEngineMayHaveStopped() {
        guard isRunning, let engine, !engine.isRunning else { return }
        if restartInPlace(engine) { return }
        recoverEngine()
    }

    /// Re-taps the mic if its format changed, then starts the engine again and resumes playback.
    private func restartInPlace(_ engine: AVAudioEngine) -> Bool {
        if mic != nil {
            let format = engine.inputNode.outputFormat(forBus: 0)
            if format != mic?.inputFormat {
                engine.inputNode.removeTap(onBus: 0)
                guard let processor = MicProcessor(inputFormat: format) else { return false }
                engine.inputNode.installTap(
                    onBus: 0, bufferSize: Self.tapFrames, format: format,
                    block: Self.tapBlock(processor, owner: self, generation: engineGeneration))
                mic = processor
            }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            return false
        }
        if let player, scheduled > played, !player.isPlaying { player.play() }
        return true
    }

    // MARK: Off-main helpers (closures here are not main-actor isolated)

    nonisolated private static func tapBlock(
        _ processor: MicProcessor, owner: VoiceAudio, generation: Int
    ) -> AVAudioNodeTapBlock {
        { [weak owner] buffer, _ in
            let result = processor.process(buffer)
            DispatchQueue.main.async {
                MainActor.assumeIsolated { owner?.handleMic(result, generation: generation) }
            }
        }
    }

    nonisolated private static func schedule(
        _ buffer: AVAudioPCMBuffer, on player: AVAudioPlayerNode, owner: VoiceAudio, speech: Int,
        seconds: TimeInterval
    ) {
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak owner] _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { owner?.bufferPlayed(speech: speech, seconds: seconds) }
            }
        }
    }
}

/// One mic buffer after conversion: whole 100 ms chunks, the buffer's RMS level and duration.
private struct MicResult {
    let chunks: [Data]
    let db: Float
    let seconds: TimeInterval
}

/// Converts mic buffers (hardware format) to 16 kHz mono s16le and cuts 100 ms chunks. Runs on
/// the tap's thread; the tap calls it serially, so its state needs no lock.
private final class MicProcessor: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let outputFormat: AVAudioFormat
    /// The mic format this converter was built for.
    let inputFormat: AVAudioFormat
    private let inputRate: Double
    private var pendingInput: AVAudioPCMBuffer?
    private var bytes = Data()

    init?(inputFormat: AVAudioFormat) {
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let output = AVAudioFormat(
                commonFormat: .pcmFormatInt16, sampleRate: VoiceAudio.captureSampleRate, channels: 1,
                interleaved: true),
              let converter = AVAudioConverter(from: inputFormat, to: output)
        else { return nil }
        self.converter = converter
        self.outputFormat = output
        self.inputFormat = inputFormat
        self.inputRate = inputFormat.sampleRate
    }

    func process(_ buffer: AVAudioPCMBuffer) -> MicResult {
        let seconds = Double(buffer.frameLength) / inputRate
        var sumSquares: Double = 0
        var samples = 0

        // Float input (the engine's usual format): measure the level before conversion.
        if let channel = buffer.floatChannelData?[0] {
            let count = Int(buffer.frameLength)
            for i in 0..<count {
                let v = Double(channel[i])
                sumSquares += v * v
            }
            samples = count
        }

        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * VoiceAudio.captureSampleRate / inputRate).rounded(.up)) + 64
        pendingInput = buffer
        // The converter may hand back output in several passes; `.haveData` means the output
        // buffer filled and more may follow. When our one input buffer is used up it asks for
        // more and gets `.noDataNow`, so it returns `.inputRanOutOfData` and keeps its state.
        for _ in 0..<8 {
            guard let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { break }
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { [self] _, inputStatus in
                guard let input = pendingInput else {
                    inputStatus.pointee = .noDataNow
                    return nil
                }
                pendingInput = nil
                inputStatus.pointee = .haveData
                return input
            }
            if out.frameLength > 0, let data = out.int16ChannelData?[0] {
                let count = Int(out.frameLength)
                bytes.append(Data(bytes: data, count: count * MemoryLayout<Int16>.size))
                if samples == 0 {
                    for i in 0..<count {
                        let v = Double(data[i]) / Double(Int16.max)
                        sumSquares += v * v
                    }
                    samples = count
                }
            }
            if status != .haveData { break }
        }
        pendingInput = nil

        var chunks: [Data] = []
        while bytes.count >= VoiceAudio.chunkBytes {
            chunks.append(Data(bytes.prefix(VoiceAudio.chunkBytes)))
            bytes = Data(bytes.dropFirst(VoiceAudio.chunkBytes))
        }
        let rms = samples > 0 ? sqrt(sumSquares / Double(samples)) : 0
        let db: Float = rms > 0 ? Float(20 * log10(rms)) : -160
        return MicResult(chunks: chunks, db: db, seconds: seconds)
    }
}

/// Reports AVSpeechSynthesizer completion on the main actor. `stopSpeech()` clears the state
/// first, so its cancel is ignored; a cancel by the system counts as finished.
private final class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
    private let didFinish: @MainActor () -> Void

    init(didFinish: @escaping @MainActor () -> Void) {
        self.didFinish = didFinish
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [didFinish] in didFinish() }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor [didFinish] in didFinish() }
    }
}
