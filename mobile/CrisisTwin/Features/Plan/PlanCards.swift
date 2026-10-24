import MapKit
import MessageUI
import SwiftUI

// The Plan tab's cards (design-v2 item 1): the meeting-point hero, family, trusted contacts,
// and the shared pieces they use (pill buttons, card headers, avatars, status tones).

// MARK: - Shared pieces

/// The web kit's buttons as pills: brand-filled for the primary action, brand-soft otherwise.
struct PlanPillStyle: ButtonStyle {
    enum Kind { case primary, secondary }
    var kind: Kind = .secondary
    var fullWidth = false

    func makeBody(configuration: Configuration) -> some View {
        PillBody(configuration: configuration, kind: kind, fullWidth: fullWidth)
    }

    private struct PillBody: View {
        let configuration: Configuration
        let kind: Kind
        let fullWidth: Bool
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .font(.subheadline.weight(.semibold))
                .labelStyle(.titleAndIcon)
                .lineLimit(1)
                .foregroundStyle(kind == .primary ? Color.planOnBrand : Color.ctBrand)
                .padding(.horizontal, 18)
                .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: 44)
                .background(kind == .primary ? Color.ctBrand : Color.ctBrandSoft, in: Capsule())
                .contentShape(Capsule())
                .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
                .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
        }
    }
}

extension Color {
    /// Text and symbols on a brand fill: white on the deep green, ink on the dark theme's mint.
    static let planOnBrand = Color(light: 0xFFFFFF, dark: 0x070A0E)
}

/// A card's title row: the title, and an optional trailing control.
struct PlanCardHeader<Trailing: View>: View {
    let title: String
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Text(title)
                .font(.ctTitle)
                .foregroundStyle(Color.ctInk)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            trailing
        }
    }
}

extension PlanCardHeader where Trailing == EmptyView {
    init(_ title: String) {
        self.title = title
        self.trailing = EmptyView()
    }
}

/// A round 44 pt icon button in brand-soft, for card headers and row ends.
struct PlanIconButtonLabel: View {
    let systemImage: String
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 44

    var body: some View {
        Image(systemName: systemImage)
            .font(.body.weight(.semibold))
            .foregroundStyle(Color.ctBrand)
            .frame(width: size, height: size)
            .background(Color.ctBrandSoft, in: Circle())
            .contentShape(Circle())
    }
}

/// Initials in a circle, for family members and contacts.
struct PlanAvatar: View {
    let name: String
    var tint: Color = .ctInkMuted
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 36

    private var initials: String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap(\.first).map(String.init).joined()
        return letters.isEmpty ? "?" : letters.uppercased()
    }

    var body: some View {
        Text(initials)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(Color.ctSurfaceMuted, in: Circle())
            .overlay(Circle().strokeBorder(Color.ctBorderSubtle, lineWidth: 1))
            .accessibilityHidden(true)
    }
}

/// A hairline between rows inside a card.
struct PlanRowDivider: View {
    var leading: CGFloat = 0
    var body: some View {
        Rectangle()
            .fill(Color.ctBorderSubtle)
            .frame(height: 1)
            .padding(.leading, leading)
    }
}

extension MemberStatus {
    /// Status tone; the label always carries the meaning too.
    var planTone: Color {
        switch self {
        case .unknown: return .ctInkMuted
        case .safe, .atMeetingPoint: return .ctSuccess
        case .onTheWay: return .ctInfo
        case .needHelp: return .ctDanger
        }
    }

    var planSoft: Color {
        switch self {
        case .unknown: return .ctSurfaceMuted
        case .safe, .atMeetingPoint: return .ctSuccessSoft
        case .onTheWay: return .ctInfoSoft
        case .needHelp: return .ctDangerSoft
        }
    }
}

/// A member's status as a small tinted tag: symbol and words.
struct MemberStatusTag: View {
    let status: MemberStatus

    var body: some View {
        Label(status.label, systemImage: status.systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(status.planTone)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(status.planSoft, in: Capsule())
            .fixedSize()
    }
}

// MARK: - Meeting points (hero)

enum MeetingSlot: String, Identifiable {
    case primary, backup
    var id: String { rawValue }
    var number: Int { self == .primary ? 1 : 2 }
    var title: String { self == .primary ? "Primary meeting point" : "Backup meeting point" }
}

/// The hero: a map with the numbered meeting points, each point with Open in Maps, and Share.
/// Tapping a point edits it; its context menu also removes it.
struct MeetingPointCard: View {
    @Environment(MeetingPlanStore.self) private var store
    @Environment(FamilyStore.self) private var family
    @Environment(LocationProvider.self) private var location
    @State private var editing: MeetingSlot?
    @State private var composingMessage = false
    @State private var camera: MapCameraPosition = .region(PlanMap.defaultRegion)
    @ScaledMetric(relativeTo: .body) private var mapHeight: CGFloat = 210

    private var plan: MeetingPlan { store.plan }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PlanCardHeader(title: "Meeting points") {
                if let shared = family.family {
                    Label(shared.name, systemImage: "person.3.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.ctInkMuted)
                        .lineLimit(1)
                        .accessibilityLabel("Shared with \(shared.name)")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)

            map
                .frame(height: mapHeight)
                .overlay(alignment: .top) { PlanRowDivider() }
                .overlay(alignment: .bottom) { PlanRowDivider() }

            if plan.primary == nil {
                Button {
                    editing = .primary
                } label: {
                    Label("Choose where to meet", systemImage: "mappin.and.ellipse")
                }
                .buttonStyle(PlanPillStyle(kind: .primary, fullWidth: true))
                .padding(16)
            } else {
                VStack(spacing: 0) {
                    pointRow(.primary, point: plan.primary)
                    PlanRowDivider(leading: 64)
                    pointRow(.backup, point: plan.backup)
                }
                .padding(.vertical, 4)
                PlanRowDivider()
                shareButton
                    .padding(16)
            }

            if let message = store.errorMessage {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(Color.ctWarning)
                    .padding([.horizontal, .bottom], 16)
            }
        }
        .ctPanel(padding: 0)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .sheet(item: $editing) { slot in
            let current = slot == .primary ? plan.primary : plan.backup
            MeetingPointEditor(
                title: slot.title,
                point: current,
                onSave: { point in
                    store.update { plan in
                        if slot == .primary { plan.primary = point } else { plan.backup = point }
                    }
                    shareWithFamily()
                },
                onRemove: current == nil ? nil : { remove(slot) }
            )
        }
        .sheet(isPresented: $composingMessage) {
            MessageComposer(recipients: plan.contacts.compactMap(\.phone), body: plan.shareText)
                .ignoresSafeArea()
        }
        .onAppear { fitCamera() }
        .onChange(of: plan.primary) { fitCamera() }
        .onChange(of: plan.backup) { fitCamera() }
        // With no point yet, frame the person's area once their first fix arrives.
        .onChange(of: location.lastLocation == nil) { if plan.primary == nil { fitCamera() } }
    }

    // MARK: Map

    private var map: some View {
        Map(position: $camera, interactionModes: []) {
            if let primary = plan.primary {
                Annotation(primary.name, coordinate: primary.coordinate) {
                    MeetingPin(slot: .primary)
                }
                .annotationTitles(.hidden)
            }
            if let backup = plan.backup {
                Annotation(backup.name, coordinate: backup.coordinate) {
                    MeetingPin(slot: .backup)
                }
                .annotationTitles(.hidden)
            }
            if plan.primary == nil {
                UserAnnotation()
            }
        }
        .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll))
        .mapControlVisibility(.hidden)
        .saturation(plan.primary == nil ? 0.4 : 1)
        .accessibilityElement()
        .accessibilityLabel(mapSummary)
    }

    private var mapSummary: String {
        switch (plan.primary, plan.backup) {
        case (nil, _): return "Map. No meeting point chosen yet."
        case (let primary?, nil): return "Map showing meeting point 1, \(primary.name)."
        case (let primary?, let backup?): return "Map showing meeting point 1, \(primary.name), and 2, \(backup.name)."
        }
    }

    /// Frame both points; with none, the person's area (or the demo area).
    private func fitCamera() {
        let points = [plan.primary, plan.backup].compactMap { $0?.coordinate }
        guard let first = points.first else {
            if let here = location.lastLocation?.coordinate {
                camera = .region(MKCoordinateRegion(center: here, latitudinalMeters: 4_000, longitudinalMeters: 4_000))
            } else {
                camera = .region(PlanMap.defaultRegion)
            }
            return
        }
        let lats = points.map(\.latitude), lons = points.map(\.longitude)
        let center = CLLocationCoordinate2D(latitude: (lats.min()! + lats.max()!) / 2,
                                            longitude: (lons.min()! + lons.max()!) / 2)
        // Pad around both points, but never zoom in past street level around a single point.
        let span = MKCoordinateSpan(latitudeDelta: max((lats.max()! - lats.min()!) * 1.9, 0.012),
                                    longitudeDelta: max((lons.max()! - lons.min()!) * 1.9, 0.012))
        camera = .region(MKCoordinateRegion(center: points.count == 1 ? first : center, span: span))
    }

    // MARK: Rows

    @ViewBuilder
    private func pointRow(_ slot: MeetingSlot, point: MeetingPoint?) -> some View {
        if let point {
            HStack(spacing: 12) {
                Button {
                    editing = slot
                } label: {
                    HStack(spacing: 12) {
                        MeetingPin(slot: slot)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(point.name)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Color.ctInk)
                                .multilineTextAlignment(.leading)
                            if !point.note.isEmpty {
                                Text(point.note)
                                    .font(.subheadline)
                                    .foregroundStyle(Color.ctInkMuted)
                                    .multilineTextAlignment(.leading)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 52)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(slot == .primary ? "Primary" : "Backup"): \(point.name)")
                .accessibilityHint("Edits this meeting point")
                .contextMenu {
                    Button("Change", systemImage: "pencil") { editing = slot }
                    Link(destination: point.directionsURL) {
                        Label("Open in Maps", systemImage: "arrow.triangle.turn.up.right.diamond")
                    }
                    Button("Remove", systemImage: "trash", role: .destructive) { remove(slot) }
                }

                Link(destination: point.directionsURL) {
                    PlanIconButtonLabel(systemImage: "arrow.triangle.turn.up.right.diamond.fill")
                }
                .accessibilityLabel("Open \(point.name) in Maps")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
        } else {
            Button {
                editing = slot
            } label: {
                HStack(spacing: 12) {
                    MeetingPin(slot: slot, empty: true)
                    Text("Add a backup")
                        .font(.body.weight(.medium))
                        .foregroundStyle(Color.ctBrand)
                    Spacer(minLength: 0)
                    Image(systemName: "plus")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.ctBrand)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 52)
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private var shareButton: some View {
        if plan.contacts.contains(where: { $0.phone != nil }) && MFMessageComposeViewController.canSendText() {
            Button {
                composingMessage = true
            } label: {
                Label("Text my plan to emergency contacts", systemImage: "message.fill")
            }
            .buttonStyle(PlanPillStyle(kind: .primary, fullWidth: true))
        } else {
            // Simulators and devices without Messages fall back to the share sheet.
            ShareLink(item: plan.shareText) {
                Label("Share plan", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(PlanPillStyle(kind: .primary, fullWidth: true))
        }
    }

    private func remove(_ slot: MeetingSlot) {
        store.update { plan in
            // Without a primary, the backup moves up rather than standing alone.
            if slot == .primary { plan.primary = plan.backup; plan.backup = nil } else { plan.backup = nil }
        }
        shareWithFamily()
    }

    /// In a family, meeting points are shared: send the new ones to the server.
    private func shareWithFamily() {
        guard family.isJoined else { return }
        let plan = store.plan
        Task { await family.setMeetingPoints(primary: plan.primary, backup: plan.backup) }
    }
}

/// The numbered pin used on the map and beside its row, so the two read as one without color.
struct MeetingPin: View {
    let slot: MeetingSlot
    var empty = false
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 36

    var body: some View {
        let primary = slot == .primary
        Text("\(slot.number)")
            .font(.subheadline.weight(.bold).monospacedDigit())
            .foregroundStyle(empty ? Color.ctInkMuted : primary ? Color.planOnBrand : Color.ctBrand)
            .frame(width: size, height: size)
            .background {
                if empty {
                    Circle().strokeBorder(Color.ctBorder, style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
                } else {
                    Circle()
                        .fill(primary ? Color.ctBrand : Color.ctSurfaceRaised)
                        .overlay(Circle().strokeBorder(primary ? Color.ctSurfaceRaised : Color.ctBrand, lineWidth: 2))
                        .shadow(color: .black.opacity(0.18), radius: 2, y: 1)
                }
            }
            .accessibilityHidden(true)
    }
}

// MARK: - Family

/// Family members and their status, with quick status and invite; create or join when none.
struct FamilyCard: View {
    let openFamily: (FamilyView.Mode) -> Void

    @Environment(FamilyStore.self) private var store
    @State private var tick = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let family = store.family {
                Button {
                    openFamily(.create)
                } label: {
                    PlanCardHeader(title: family.name) {
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Color.ctInkSubtle)
                    }
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens family")

                VStack(spacing: 0) {
                    ForEach(Array(family.members.enumerated()), id: \.element.id) { index, member in
                        if index > 0 { PlanRowDivider(leading: 48) }
                        FamilyMemberRow(member: member)
                    }
                }

                HStack(spacing: 10) {
                    if let me = family.members.first(where: \.isMe) {
                        statusMenu(me)
                    }
                    ShareLink(item: family.inviteText) {
                        Label("Invite", systemImage: "person.badge.plus")
                    }
                    .buttonStyle(PlanPillStyle(kind: .secondary))
                }
            } else {
                PlanCardHeader("Family")
                if store.isJoined {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 44)
                } else {
                    HStack(spacing: 10) {
                        Button { openFamily(.create) } label: {
                            Label("Create", systemImage: "person.3.fill")
                        }
                        .buttonStyle(PlanPillStyle(kind: .primary, fullWidth: true))
                        Button { openFamily(.join) } label: {
                            Label("Join", systemImage: "number")
                        }
                        .buttonStyle(PlanPillStyle(kind: .secondary, fullWidth: true))
                    }
                }
            }
            if let message = store.errorMessage {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(Color.ctWarning)
            }
        }
        .ctPanel()
        .sensoryFeedback(.selection, trigger: tick)
    }

    private func statusMenu(_ me: FamilyMember) -> some View {
        Menu {
            ForEach(MemberStatus.allCases.filter { $0 != .unknown }) { status in
                Button(role: status == .needHelp ? .destructive : nil) {
                    tick += 1
                    Task { await store.setStatus(status) }
                } label: {
                    if me.memberStatus == status {
                        Label(status.label, systemImage: "checkmark")
                    } else {
                        Label(status.label, systemImage: status.systemImage)
                    }
                }
            }
        } label: {
            Label("My status", systemImage: me.memberStatus == .unknown ? "person.fill.questionmark" : me.memberStatus.systemImage)
        }
        .menuStyle(.button)
        .buttonStyle(PlanPillStyle(kind: .primary))
        .accessibilityValue(me.memberStatus.label)
        .disabled(store.isWorking)
    }
}

// MARK: - Emergency contacts

/// People to tell the plan to, ideally outside the area: in a local disaster, calls and texts to a
/// distant contact often get through when local ones don't. The people you meet with are the family.
/// Picked from Contacts without the Contacts permission. Stored as `TrustedContact` (unchanged data).
struct TrustedContactsCard: View {
    @Environment(MeetingPlanStore.self) private var store
    @State private var pickingContact = false

    private var contacts: [TrustedContact] { store.plan.contacts }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            PlanCardHeader(title: "Emergency contacts") {
                if !contacts.isEmpty {
                    Button { pickingContact = true } label: {
                        PlanIconButtonLabel(systemImage: "plus")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Add an emergency contact")
                }
            }
            Text("Pick someone outside your area. Local phone lines can get busy in a disaster.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if contacts.isEmpty {
                Button { pickingContact = true } label: {
                    Label("Add emergency contact", systemImage: "person.crop.circle.badge.plus")
                }
                .buttonStyle(PlanPillStyle(kind: .secondary, fullWidth: true))
                .padding(.top, 4)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(contacts.enumerated()), id: \.element.id) { index, contact in
                        if index > 0 { PlanRowDivider(leading: 48) }
                        contactRow(contact)
                    }
                }
            }
        }
        .ctPanel()
        .background(ContactPicker(isPresented: $pickingContact) { contact in
            store.update { plan in
                if !plan.contacts.contains(where: { $0.id == contact.id }) { plan.contacts.append(contact) }
            }
        })
    }

    private func contactRow(_ contact: TrustedContact) -> some View {
        HStack(spacing: 12) {
            PlanAvatar(name: contact.name)
            VStack(alignment: .leading, spacing: 1) {
                Text(contact.name)
                    .foregroundStyle(Color.ctInk)
                Text(contact.phone ?? "No phone number")
                    .font(.subheadline)
                    .foregroundStyle(Color.ctInkMuted)
                    .monospacedDigit()
            }
            Spacer(minLength: 8)
            Menu {
                if let phone = contact.phone, let url = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })") {
                    Link(destination: url) { Label("Call", systemImage: "phone") }
                }
                Button("Remove", systemImage: "trash", role: .destructive) { remove(contact) }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.ctInkMuted)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .accessibilityLabel("Options for \(contact.name)")
        }
        .frame(minHeight: 52)
        .accessibilityElement(children: .contain)
        .contextMenu {
            Button("Remove", systemImage: "trash", role: .destructive) { remove(contact) }
        }
    }

    private func remove(_ contact: TrustedContact) {
        store.update { $0.contacts.removeAll { $0.id == contact.id } }
    }
}
