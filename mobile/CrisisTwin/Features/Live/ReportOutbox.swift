import Foundation

/// On-device queue of reports the server has not accepted yet, saved as JSON in Application Support.
/// A draft leaves the queue only when the server accepts it; failures keep it for a later flush.
@MainActor
final class ReportOutbox {
    enum SendResult {
        case accepted
        /// Network, rate limit, or server trouble: keep the draft and stop this flush.
        case retryLater
        /// The server refused this draft itself: keep it, skip it, and stop retrying it automatically.
        case rejected
        case cancelled
    }

    private(set) var drafts: [ReportDraft] = []
    var onChange: (() -> Void)?

    private let fileURL: URL
    private var flushing = false
    private var retry: [UUID: (attempts: Int, notBefore: Date)] = [:]

    /// Automatic flushes give up on a draft after this many failures; an explicit flush still tries.
    private static let autoRetryLimit = 8
    private static let baseBackoff: TimeInterval = 5
    private static let maxBackoff: TimeInterval = 300

    init(fileURL: URL? = nil) {
        self.fileURL = fileURL ?? URL.applicationSupportDirectory.appendingPathComponent("live-outbox.json")
        load()
    }

    /// Saves the draft before anything is sent. If the disk write fails the draft is still queued in
    /// memory so it can be sent this session.
    func enqueue(_ draft: ReportDraft) {
        guard !drafts.contains(where: { $0.clientId == draft.clientId }) else { return }
        drafts.append(draft)
        persist()
        onChange?()
    }

    /// Sends queued drafts oldest first, one at a time. Returns how many the server accepted.
    /// Only one flush runs at a time; a call during a flush returns 0. With `force`, backoff and the
    /// automatic retry limit are ignored.
    func flush(force: Bool, send: (ReportDraft) async -> SendResult) async -> Int {
        guard !flushing else { return 0 }
        flushing = true
        defer { flushing = false }

        var attempted = Set<UUID>()
        var accepted = 0
        while let draft = drafts.first(where: { !attempted.contains($0.clientId) && isDue($0, force: force) }) {
            attempted.insert(draft.clientId)
            switch await send(draft) {
            case .accepted:
                drafts.removeAll { $0.clientId == draft.clientId }
                retry[draft.clientId] = nil
                accepted += 1
                persist()
                onChange?()
            case .retryLater:
                recordFailure(draft, permanent: false)
                return accepted
            case .rejected:
                recordFailure(draft, permanent: true)
            case .cancelled:
                return accepted
            }
        }
        return accepted
    }

    private func isDue(_ draft: ReportDraft, force: Bool) -> Bool {
        if force { return true }
        guard let state = retry[draft.clientId] else { return true }
        return state.attempts < Self.autoRetryLimit && state.notBefore <= Date()
    }

    private func recordFailure(_ draft: ReportDraft, permanent: Bool) {
        let attempts = permanent ? Self.autoRetryLimit : (retry[draft.clientId]?.attempts ?? 0) + 1
        let delay = min(Self.baseBackoff * pow(2, Double(attempts - 1)), Self.maxBackoff)
        retry[draft.clientId] = (attempts, Date().addingTimeInterval(delay))
    }

    private func persist() {
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try LiveJSON.encoder.encode(drafts).write(to: fileURL, options: [.atomic, .completeFileProtection])
        } catch {
            // The drafts stay queued in memory; the next change tries the write again.
        }
    }

    private func load() {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        do {
            drafts = try LiveJSON.decoder.decode([ReportDraft].self, from: Data(contentsOf: fileURL))
        } catch {
            // Keep the unreadable file instead of overwriting it with an empty queue.
            let aside = fileURL.deletingPathExtension().appendingPathExtension("unreadable.json")
            try? FileManager.default.removeItem(at: aside)
            try? FileManager.default.moveItem(at: fileURL, to: aside)
        }
    }
}
