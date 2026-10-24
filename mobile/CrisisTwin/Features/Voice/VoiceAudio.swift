import AVFoundation
import Foundation
import Observation

/// Microphone capture and speaker playback for voice mode. Records 16 kHz mono 16-bit WAV with an
/// end-of-speech detector (silence after speech), and plays the server's WAV reply or, failing
/// that, speaks text on-device. Audio is held in a temporary file only while recording; nothing
/// is kept.
///
/// Main-actor only. The AVAudioSession is `.playAndRecord` and is active only while recording or
/// playing, so other apps' audio resumes in between.
@MainActor @Observable
final class VoiceAudio {
    enum Permission { case undetermined, granted, denied }

    private(set) var permission: Permission
    private(set) var isRecording = false
    private(set) var isPlaying = false
    /// 0...1 input level while recording, for the UI's pulsing ring.
    private(set) var level: Float = 0

    /// Called once per recording with the WAV bytes, or nil when nothing was said or it was too
    /// short. Not called by `cancelRecording()`.
    @ObservationIgnored var onFinishedRecording: ((Data?) -> Void)?

    // MARK: Tuning

    /// How often the input level is read.
    private static let meterInterval: Duration = .milliseconds(50)
    /// `averagePower` above this (dB, 0 is full scale) counts as speech; room noise sits below.
    private static let speechThresholdDB: Float = -35
    /// Input levels from `floorDB` (silent) to `ceilingDB` (loud) map onto 0...1 for the UI.
    private static let floorDB: Float = -55
    private static let ceilingDB: Float = -10
    /// Silence this long after speech ends the recording.
    private static let endSilence: TimeInterval = 1.2
    /// Give up if nothing was heard by now.
    private static let noSpeechTimeout: TimeInterval = 4
    /// Hard cap on one recording (about 640 KB of WAV, under the server's 1 MB limit).
    private static let maxDuration: TimeInterval = 20
    /// Less speech than this in total is treated as a cough or a tap, not a request.
    private static let minSpeech: TimeInterval = 0.25

    private static let recordingSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 16_000,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
    ]

    private struct AudioFailure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    // MARK: State

    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var recordingURL: URL?
    @ObservationIgnored private var meterTask: Task<Void, Never>?
    @ObservationIgnored private var speechTime: TimeInterval = 0
    @ObservationIgnored private var lastSpeechAt: TimeInterval = 0
    @ObservationIgnored private var lastTickAt: TimeInterval = 0

    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var playerDelegate: PlayerDelegate?
    @ObservationIgnored private var synthesizer: AVSpeechSynthesizer?
    @ObservationIgnored private var speechDelegate: SpeechDelegate?
    @ObservationIgnored private var playbackFinished: (() -> Void)?

    init() {
        permission = Self.currentPermission()
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

    // MARK: Recording

    /// Starts recording 16 kHz mono 16-bit linear PCM WAV to a temporary file, with metering on.
    /// Stops by itself after about 1.2 s of silence once speech was heard, after about 4 s if
    /// nothing was heard (fires nil), or at 20 s. Throws if the session or recorder cannot start.
    func startRecording() throws {
        guard !isRecording else { return }
        permission = Self.currentPermission()
        guard permission == .granted else {
            throw AudioFailure(message: "Microphone access is off. Turn it on in Settings, or type instead.")
        }
        stopPlayback()

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-\(UUID().uuidString).wav")
        do {
            try Self.activateSession()
            let recorder = try AVAudioRecorder(url: url, settings: Self.recordingSettings)
            recorder.isMeteringEnabled = true
            guard recorder.prepareToRecord(), recorder.record() else {
                throw AudioFailure(message: "The microphone could not start. Try again, or type instead.")
            }
            self.recorder = recorder
        } catch {
            try? FileManager.default.removeItem(at: url)
            deactivateIfIdle()
            throw error
        }
        recordingURL = url
        speechTime = 0
        lastSpeechAt = 0
        lastTickAt = 0
        level = 0
        isRecording = true
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.tick()
                try? await Task.sleep(for: VoiceAudio.meterInterval)
            }
        }
    }

    /// Stops now and fires `onFinishedRecording` (nil if too little was said).
    func stopRecording() {
        finishRecording(deliver: true)
    }

    /// Stops, fires no callback, and deletes the file.
    func cancelRecording() {
        finishRecording(deliver: false)
    }

    private func tick() {
        guard isRecording, let recorder else { return }
        // A phone call or another app can take the microphone; the recorder then stops by itself.
        guard recorder.isRecording else {
            finishRecording(deliver: true)
            return
        }
        recorder.updateMeters()
        let power = recorder.averagePower(forChannel: 0)
        let now = recorder.currentTime
        level = min(1, max(0, (power - Self.floorDB) / (Self.ceilingDB - Self.floorDB)))
        if power > Self.speechThresholdDB {
            speechTime += max(0, now - lastTickAt)
            lastSpeechAt = now
        }
        lastTickAt = now

        let heard = speechTime >= Self.minSpeech
        if now >= Self.maxDuration
            || (heard && now - lastSpeechAt >= Self.endSilence)
            || (!heard && now - lastSpeechAt >= Self.noSpeechTimeout) {
            finishRecording(deliver: true)
        }
    }

    private func finishRecording(deliver: Bool) {
        guard isRecording else { return }
        meterTask?.cancel()
        meterTask = nil
        recorder?.stop()
        recorder = nil
        isRecording = false
        level = 0

        var wav: Data?
        if let url = recordingURL {
            if deliver, speechTime >= Self.minSpeech { wav = try? Data(contentsOf: url) }
            try? FileManager.default.removeItem(at: url)
        }
        recordingURL = nil
        deactivateIfIdle()
        if deliver { onFinishedRecording?(wav) }
    }

    // MARK: Playback

    /// Plays a WAV (the server's spoken reply). `onFinish` fires when it ends, or at once if the
    /// audio cannot be played; it does not fire after `stopPlayback()`.
    func play(wav: Data, onFinish: @escaping () -> Void) {
        stopPlayback()
        do {
            try Self.activateSession()
            let player = try AVAudioPlayer(data: wav)
            let delegate = PlayerDelegate { [weak self, weak player] in
                guard let self, let player, self.player === player else { return }
                self.finishPlayback()
            }
            player.delegate = delegate
            guard player.prepareToPlay(), player.play() else {
                throw AudioFailure(message: "Playback could not start.")
            }
            self.player = player
            playerDelegate = delegate
            playbackFinished = onFinish
            isPlaying = true
        } catch {
            deactivateIfIdle()
            onFinish()
        }
    }

    /// On-device AVSpeechSynthesizer fallback when the server sent no audio. Same `onFinish`
    /// rules as `play(wav:onFinish:)`.
    func speakLocally(_ text: String, onFinish: @escaping () -> Void) {
        stopPlayback()
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            onFinish()
            return
        }
        // A failure to activate is not fatal: the synthesizer can still speak.
        try? Self.activateSession()
        let synthesizer = AVSpeechSynthesizer()
        let delegate = SpeechDelegate { [weak self, weak synthesizer] in
            guard let self, let synthesizer, self.synthesizer === synthesizer else { return }
            self.finishPlayback()
        }
        synthesizer.delegate = delegate
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
        self.synthesizer = synthesizer
        speechDelegate = delegate
        playbackFinished = onFinish
        isPlaying = true
        synthesizer.speak(utterance)
    }

    /// Stops whatever is playing without calling its `onFinish`.
    func stopPlayback() {
        player?.stop()
        player = nil
        playerDelegate = nil
        synthesizer?.stopSpeaking(at: .immediate)
        synthesizer = nil
        speechDelegate = nil
        playbackFinished = nil
        guard isPlaying else { return }
        isPlaying = false
        deactivateIfIdle()
    }

    private func finishPlayback() {
        let finished = playbackFinished
        player = nil
        playerDelegate = nil
        synthesizer = nil
        speechDelegate = nil
        playbackFinished = nil
        isPlaying = false
        deactivateIfIdle()
        finished?()
    }

    // MARK: Session

    private static func activateSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
    }

    private func deactivateIfIdle() {
        guard !isRecording, !isPlaying else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// Reports AVAudioPlayer completion on the main actor.
private final class PlayerDelegate: NSObject, AVAudioPlayerDelegate {
    private let didFinish: @MainActor () -> Void

    init(didFinish: @escaping @MainActor () -> Void) {
        self.didFinish = didFinish
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [didFinish] in didFinish() }
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor [didFinish] in didFinish() }
    }
}

/// Reports AVSpeechSynthesizer completion on the main actor. A cancel is not completion:
/// `stopPlayback()` already cleared the state.
private final class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
    private let didFinish: @MainActor () -> Void

    init(didFinish: @escaping @MainActor () -> Void) {
        self.didFinish = didFinish
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [didFinish] in didFinish() }
    }
}
