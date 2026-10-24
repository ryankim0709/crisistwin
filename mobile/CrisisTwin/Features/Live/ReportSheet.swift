import CoreLocation
import SwiftUI

/// "Report what you see": where it is (the minimap pin), what it is, how bad, send. Works
/// offline; the store saves the draft on the phone first (ADR 0011).
///
/// With `editing`, the same form opens on one of this phone's reports and saves the changes
/// instead: an unsent draft changes on the phone only, a sent one with `PATCH me/reports/{id}`.
struct ReportSheet: View {
    var prefill: ReportPrefill? = nil
    var editing: ReportEditTarget? = nil

    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @Environment(\.dismiss) private var dismiss

    private static let noteLimit = 280

    @State private var kind: ReportKind?
    @State private var severity: ReportSeverity?
    @State private var note = ""
    /// Where the report will be placed.
    @State private var pin: LonLat?
    /// The pin is the device's own fix (not moved, not prefilled).
    @State private var pinFromGPS = false
    @State private var accuracyM: Double?
    /// When the place was captured on this device.
    @State private var capturedAt = Date()
    @State private var sentKind: ReportKind?
    @State private var drawn = false
    /// Edit mode: the save request is in flight, why the last save failed, and whether the
    /// server said the report is locked.
    @State private var saving = false
    @State private var saveError: String?
    @State private var locked = false
    @State private var started = false
    @State private var tick = 0

    var body: some View {
        Group {
            if let sentKind {
                confirmation(for: sentKind)
            } else {
                form
            }
        }
        .ctScreenBackground()
        .navigationTitle(sentKind != nil ? "" : editing == nil ? "Report" : "Edit report")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                if sentKind == nil { Button(role: .close) { dismiss() } }
            }
        }
        .presentationDetents([.large])
        .presentationBackground(Color.ctBackground)
        .interactiveDismissDisabled(saving)
        .sensoryFeedback(.selection, trigger: tick)
        .sensoryFeedback(.success, trigger: sentKind) { _, new in new != nil }
        .task { await start() }
        // A fix that lands after the sheet opened places the pin, unless the person already did.
        .onChange(of: location.lastLocation) { _, fix in
            guard pin == nil, started, let fix else { return }
            adopt(fix)
        }
    }

    // MARK: Form

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                placeCard
                kindGrid
                if let kind { details(for: kind) }
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 16)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) { sendBar }
    }

    /// The minimap and, under it, the words for where the pin is.
    private var placeCard: some View {
        VStack(spacing: 0) {
            ReportLocationMap(
                pin: $pin,
                here: store.lastCoord,
                kind: kind,
                situation: store.situation,
                route: store.activeGuidance?.route?.line ?? [],
                onMove: {
                    pinFromGPS = false
                    accuracyM = nil
                    capturedAt = Date()
                },
                onLocate: { Task { await useCurrentLocation() } })
            .frame(height: 210)
            Rectangle().fill(Color.ctBorder).frame(height: 1)
            placeLine
        }
        .background(Color.ctSurface)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.ctBorder, lineWidth: 1))
    }

    private var placeLine: some View {
        let words = place
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: pinFromGPS ? "location.fill" : "mappin.and.ellipse")
                .foregroundStyle(Color.ctBrand)
                .frame(width: 22)
                .accessibilityHidden(true)
            Text(words.primary)
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.ctInk)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if let secondary = words.secondary {
                Text(secondary)
                    .font(.subheadline)
                    .foregroundStyle(Color.ctInkMuted)
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 48)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Report goes here: \([words.primary, words.secondary].compactMap { $0 }.joined(separator: ", "))")
    }

    /// The road when one is known, then the pin's offset from the person.
    private var place: (primary: String, secondary: String?) {
        guard let pin else { return ("Move the map to place the pin", nil) }
        let offset = store.offsetFromHere(pin)
        if let road = store.nearestRoad(to: pin) { return (road, offset) }
        if pinFromGPS || offset == "Your location" { return ("Your location", nil) }
        return (offset ?? "Pinned on the map", nil)
    }

    private var kindGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
            ForEach(ReportKind.allCases) { option in
                KindTile(kind: option, selected: kind == option) {
                    tick += 1
                    withAnimation(.snappy(duration: 0.2)) { select(option) }
                }
            }
        }
    }

    @ViewBuilder
    private func details(for kind: ReportKind) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if kind == .helpNeeded {
                Label("If you are in danger, call 911.", systemImage: "phone.fill")
                    .font(.headline)
                    .foregroundStyle(Color.ctDanger)
            }
            if kind.hasSeverity {
                HStack(spacing: 6) { severityChips }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("How bad is it?")
            }
            TextField("Note (optional)", text: $note, axis: .vertical)
                .lineLimit(1...4)
                .padding(.horizontal, 12)
                .padding(.vertical, 12)
                .frame(minHeight: 44)
                .background(Color.ctSurfaceSunken, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.ctBorderSubtle))
                .onChange(of: note) { _, value in
                    if value.count > Self.noteLimit { note = String(value.prefix(Self.noteLimit)) }
                }
        }
        .ctPanel(padding: 14)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    @ViewBuilder private var severityChips: some View {
        ForEach(ReportSeverity.allCases) { option in
            let on = severity == option
            Button {
                tick += 1
                withAnimation(.snappy(duration: 0.2)) { severity = on ? nil : option }
            } label: {
                Text(Self.shortTitle(option))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(on ? Color.ctBackground : Color.ctInk)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .padding(.horizontal, 8)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(on ? Color.ctBrand : Color.ctBrandSoft, in: .capsule)
                    .contentShape(.capsule)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(option.title)
            .accessibilityAddTraits(on ? .isSelected : [])
        }
    }

    /// Chip words; the full title is the accessibility label.
    private static func shortTitle(_ severity: ReportSeverity) -> String {
        switch severity {
        case .full: return "Fully blocked"
        case .partial: return "One lane"
        case .slow: return "Slow"
        }
    }

    /// New reports need a kind and a pin; edits also need a change, and wait for the save.
    private var ready: Bool {
        guard kind != nil, pin != nil else { return false }
        guard let editing else { return true }
        return !saving && !locked && !changes(from: editing).isEmpty
    }

    private var sendBar: some View {
        VStack(spacing: 8) {
            if let saveError {
                Label(saveError, systemImage: locked ? "lock.fill" : "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(Color.ctWarning)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button {
                if let editing { save(editing) } else { send() }
            } label: {
                Label(editing == nil ? "Send" : saving ? "Saving" : "Save",
                      systemImage: editing == nil ? "paperplane.fill" : "checkmark")
                    .font(.headline)
                    .foregroundStyle(ready ? Color.ctBackground : Color.ctInkSubtle)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(ready ? Color.ctBrand : Color.ctSurfaceMuted, in: .capsule)
                    .contentShape(.capsule)
            }
            .buttonStyle(.plain)
            .disabled(!ready)
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(Color.ctBackground)
    }

    // MARK: Confirmation

    private func confirmation(for kind: ReportKind) -> some View {
        let queued = !store.pending.isEmpty
        let title = editing != nil ? "Saved" : queued ? "Saved, sends when online" : "Sent"
        return VStack(spacing: 16) {
            Spacer()
            ZStack {
                if drawn {
                    Image(systemName: "checkmark.circle")
                        .font(.system(size: 72, weight: .regular))
                        .foregroundStyle(Color.ctSuccess)
                        .transition(.symbolEffect(.drawOn))
                }
            }
            .frame(height: 88)
            .accessibilityHidden(true)
            Text(title)
                .font(.title2.bold())
                .foregroundStyle(Color.ctInk)
            if kind == .helpNeeded {
                Text("If you are in danger, call 911.")
                    .font(.headline)
                    .foregroundStyle(Color.ctDanger)
            }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .onAppear {
            withAnimation { drawn = true }
            AccessibilityNotification.Announcement(title + ".").post()
        }
        .task {
            try? await Task.sleep(for: .milliseconds(1500))
            dismiss()
        }
    }

    // MARK: Actions

    private func select(_ option: ReportKind) {
        kind = option
        if !option.hasSeverity { severity = nil }
    }

    /// Applies the prefill once, then takes a fix if access is already granted. It never shows the
    /// permission prompt on its own.
    private func start() async {
        guard !started else { return }
        started = true
        if let editing {
            select(editing.kind)
            severity = editing.severity
            note = editing.note ?? ""
            pin = editing.location.coord
            pinFromGPS = false
            accuracyM = editing.location.accuracyM
            capturedAt = editing.observedAt
            return
        }
        if let prefill {
            if let coord = prefill.coord, coord.isValid {
                pin = coord
                pinFromGPS = false
                capturedAt = Date()
            }
            if let kind = prefill.kind { select(kind) }
        }
        if pin == nil, let last = location.lastLocation {
            adopt(last)
        } else if pin == nil, location.isAuthorized {
            await useCurrentLocation()
        }
        #if DEBUG
        if let raw = UserDefaults.standard.string(forKey: "reporttap"), let option = ReportKind(rawValue: raw) {
            select(option)
        }
        #endif
    }

    private func useCurrentLocation() async {
        do {
            adopt(try await location.currentLocation())
        } catch {
            if let last = location.lastLocation { adopt(last) }
        }
    }

    /// Puts the pin on a device fix. Observed now: the fix can be the last one from continuous
    /// updates, which pause while the device is still, so its own timestamp may be minutes old.
    private func adopt(_ fix: CLLocation) {
        pin = LonLat(lon: fix.coordinate.longitude, lat: fix.coordinate.latitude)
        pinFromGPS = true
        accuracyM = fix.horizontalAccuracy
        capturedAt = Date()
    }

    private func send() {
        guard let kind, let pin else { return }
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let draft = ReportDraft(
            incidentId: store.incidentId,
            kind: kind,
            severity: kind.hasSeverity ? severity : nil,
            location: ReportLocation(coord: pin, accuracyM: pinFromGPS ? accuracyM : nil),
            taskId: prefill?.taskId,
            note: trimmed.isEmpty ? nil : trimmed,
            observedAt: capturedAt
        )
        store.submit(draft)
        sentKind = kind
    }

    /// The fields that differ from the report being edited; empty when nothing changed.
    private func changes(from target: ReportEditTarget) -> ReportPatch {
        guard let kind, let pin else { return ReportPatch() }
        var patch = ReportPatch()
        if kind != target.kind { patch.kind = kind }
        let newSeverity = kind.hasSeverity ? severity : nil
        if newSeverity != target.severity { patch.severity = .some(newSeverity) }
        let newNote = Self.cleanNote(note)
        if newNote != Self.cleanNote(target.note ?? "") { patch.note = .some(newNote) }
        if pin != target.location.coord {
            patch.location = ReportLocation(coord: pin, accuracyM: pinFromGPS ? accuracyM : nil)
        }
        return patch
    }

    private static func cleanNote(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Saves an edit. A draft changes in the outbox at once; a sent report waits for the server,
    /// and a 409 locks the form with the server's reason.
    private func save(_ target: ReportEditTarget) {
        let patch = changes(from: target)
        guard let kind, !patch.isEmpty, !saving else { return }
        saveError = nil
        switch target {
        case .draft(var draft):
            if let kind = patch.kind { draft.kind = kind }
            if let severity = patch.severity { draft.severity = severity }
            if let note = patch.note { draft.note = note }
            if let location = patch.location { draft.location = location }
            do {
                try store.updateDraft(draft)
                sentKind = kind
            } catch {
                saveError = error.localizedDescription
            }
        case .report(let report):
            saving = true
            Task {
                defer { saving = false }
                do {
                    try await store.editReport(report, patch: patch)
                    sentKind = kind
                } catch LiveAPIError.reportLocked {
                    locked = true
                    saveError = LiveAPIError.reportLocked.localizedDescription
                } catch is CancellationError {
                } catch {
                    saveError = error.localizedDescription
                }
            }
        }
    }
}

/// One report kind in the grid: its symbol and name on a panel; selected reads brand with a check.
private struct KindTile: View {
    let kind: ReportKind
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: kind.systemImage)
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(kind.symbolColor)
                    .frame(width: 26)
                    .accessibilityHidden(true)
                Text(kind.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.ctInk)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.ctBrand)
                        .transition(.scale.combined(with: .opacity))
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
            .background(selected ? Color.ctBrandSoft : Color.ctSurface,
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(selected ? Color.ctBrand : Color.ctBorder, lineWidth: selected ? 2 : 1))
            .contentShape(.rect(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Report \(kind.title.lowercased())")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

#Preview {
    NavigationStack { ReportSheet() }
        .environment(LiveStore())
        .environment(LocationProvider())
}
