import SwiftUI
import UIKit
import UserNotifications

/// Home's status hero (design option B): one card answering "is there an emergency near me?",
/// with the Evacuate button inside. It only says what the app knows: with location off, no
/// connection or no fix it says so instead of claiming all clear. The guidance detail opens on tap
/// while the zone has an order.
struct HomeStatusHero: View {
    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @Environment(AppRouter.self) private var router
    @Environment(\.openURL) private var openURL

    private struct Status {
        var symbol: String
        var tint: Color
        var soft: Color
        var title: String
        var detail: String?
        var busy = false
    }

    var body: some View {
        let status = currentStatus
        VStack(spacing: 14) {
            VStack(spacing: 8) {
                ZStack {
                    Circle().fill(status.soft)
                    if status.busy {
                        ProgressView()
                    } else {
                        Image(systemName: status.symbol)
                            .font(.system(size: 26, weight: .semibold))
                            .foregroundStyle(status.tint)
                    }
                }
                .frame(width: 60, height: 60)
                .accessibilityHidden(true)
                Text(status.title)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color.ctInk)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = status.detail {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(Color.ctInkMuted)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // Where the phone is, as a street address (looked up on the device), in every state.
                if let place = location.placeName {
                    Label("Near \(place)", systemImage: "location.fill")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.ctInk)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Color.ctSurfaceMuted, in: .capsule)
                        .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            action
            EvacuateButton(urgent: store.activeGuidance?.level == .evacuateNow)
        }
        .padding(.vertical, 6)
        .ctPanel()
    }

    /// A state's own next step: turn location on, retry, or open the order's detail.
    @ViewBuilder private var action: some View {
        if store.home == nil, !location.isAuthorized {
            let denied = location.authorization == .denied || location.authorization == .restricted
            Button(denied ? "Open Settings" : "Turn on location") {
                if denied, let url = URL(string: UIApplication.openSettingsURLString) {
                    openURL(url)
                } else {
                    location.requestPermission()
                    location.startUpdating()
                }
            }
            .buttonStyle(CTPillButtonStyle(prominent: false))
        } else if store.situation == nil, case .unavailable = store.connection {
            Button("Try again") { Task { await store.refresh() } }
                .buttonStyle(CTPillButtonStyle(prominent: false))
        } else if store.myZone != nil, store.activeGuidance != nil {
            Button("See what to do", action: router.openDetail)
                .buttonStyle(CTPillButtonStyle(prominent: false))
        }
    }

    private var currentStatus: Status {
        if store.home == nil, !location.isAuthorized {
            return Status(symbol: "location.slash", tint: .ctInkMuted, soft: .ctSurfaceMuted,
                          title: "Location is off",
                          detail: "Turn it on to check for emergencies where you are.")
        }
        guard store.situation != nil else {
            if case .unavailable = store.connection {
                return Status(symbol: "wifi.slash", tint: .ctInkMuted, soft: .ctSurfaceMuted,
                              title: "Can't check right now",
                              detail: "The CrisisTwin service isn't reachable.")
            }
            return Status(symbol: "", tint: .ctInkMuted, soft: .ctSurfaceMuted,
                          title: "Checking your area", busy: true)
        }
        guard store.home != nil || location.lastLocation != nil else {
            return Status(symbol: "", tint: .ctInkMuted, soft: .ctSurfaceMuted,
                          title: "Finding your location", busy: true)
        }
        guard store.myZone != nil else {
            return Status(symbol: "checkmark.shield", tint: .ctSuccess, soft: .ctSuccessSoft,
                          title: "No emergency near you",
                          detail: store.incidentTitle.map { "\($0) is not affecting your area." })
        }
        let incident = store.incidentTitle ?? ""
        if let guidance = store.activeGuidance {
            return Status(symbol: guidance.level.symbol, tint: guidance.level.glyph, soft: guidance.level.soft,
                          title: guidance.level.verdict(zone: nil), detail: incident)
        }
        return Status(symbol: "checkmark.shield", tint: .ctSuccess, soft: .ctSuccessSoft,
                      title: GuidanceLevel.none.verdict(zone: nil), detail: incident.isEmpty ? nil : incident)
    }
}

/// The household plan as four tiles under the hero; each opens Plan.
struct HomePlanTiles: View {
    @Environment(MeetingPlanStore.self) private var plan
    @Environment(FamilyStore.self) private var family
    @Environment(AppRouter.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @State private var notifications: UNAuthorizationStatus?

    var body: some View {
        let contacts = plan.plan.contacts.count
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            tile("mappin.and.ellipse", "Meet at", plan.plan.primary?.name ?? "Not set")
            tile("person.3", "Family", family.family?.name ?? "Not set up")
            tile("phone", "Emergency contacts", contacts == 0 ? "None yet" : "\(contacts)")
            tile("bell", "Alerts", notificationsWord)
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        }
    }

    private var notificationsWord: String {
        switch notifications {
        case .authorized, .provisional, .ephemeral: return "On"
        case nil: return "…"
        default: return "Off"
        }
    }

    private func tile(_ symbol: String, _ label: String, _ value: String) -> some View {
        Button { router.tab = .plan } label: {
            VStack(alignment: .leading, spacing: 6) {
                Image(systemName: symbol)
                    .font(.title3)
                    .foregroundStyle(Color.ctBrand)
                    .frame(height: 24, alignment: .leading)
                    .accessibilityHidden(true)
                Text(label)
                    .font(.caption)
                    .foregroundStyle(Color.ctInkMuted)
                Text(value)
                    .font(.headline)
                    .foregroundStyle(Color.ctInk)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .ctPanel(padding: 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens your plan")
    }
}

// MARK: - Home address

/// Home's "Your address": the simulated home whose point stands in for GPS (`LiveStore.home`), its
/// household and drawn story. The order and route above it are the live situation's for that zone.
struct HomeAddressPanel: View {
    @Environment(LiveStore.self) private var store
    @State private var picking = false

    var body: some View {
        if let home = store.home {
            HomePanel(title: "Your address") {
                VStack(alignment: .leading, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(home.address)
                            .font(.headline)
                            .foregroundStyle(Color.ctInk)
                        if let zone = home.zone.name {
                            Text(zone)
                                .font(.subheadline)
                                .foregroundStyle(Color.ctInkMuted)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    let household = [home.householdLine, home.status].compactMap { $0 }.filter { !$0.isEmpty }
                    if !household.isEmpty {
                        Text(household.joined(separator: " · "))
                            .font(.subheadline)
                            .foregroundStyle(Color.ctInk)
                    }
                    if !home.story.isEmpty {
                        DisclosureGroup("Their story") {
                            VStack(alignment: .leading, spacing: 4) {
                                ForEach(Array(home.story.enumerated()), id: \.offset) { _, line in
                                    Text(line.prefix(1).uppercased() + line.dropFirst())
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                            .font(.subheadline)
                            .foregroundStyle(Color.ctInkMuted)
                            .padding(.top, 4)
                        }
                        .font(.subheadline.weight(.semibold))
                        .tint(Color.ctBrand)
                    }
                    Text("Simulated household, made-up address.")
                        .font(.caption)
                        .foregroundStyle(Color.ctInkMuted)
                    FollowOnMapButton(personId: home.id)
                }
            } accessory: {
                Button("Change") { picking = true }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.ctBrand)
                    .frame(minHeight: 44)
            }
            .sheet(isPresented: $picking) { HomeAddressPicker() }
            .task(id: home.id) {
                while !Task.isCancelled {
                    await store.refreshHome()
                    try? await Task.sleep(for: .seconds(30))
                }
            }
        }
    }
}

/// Settings: which address the app checks, a simulated home or this phone's location.
struct HomeAddressCard: View {
    @Environment(LiveStore.self) private var store
    @State private var picking = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PlanCardHeader("Address")
            Button { picking = true } label: {
                HStack {
                    Text(store.home?.address ?? "My location")
                        .foregroundStyle(Color.ctInk)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .foregroundStyle(Color.ctInkMuted)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Choose the address to check")
        }
        .font(.subheadline)
        .ctPanel()
        .sheet(isPresented: $picking) { HomeAddressPicker() }
    }
}

/// Search the drill's simulated homes, or go back to this phone's location.
struct HomeAddressPicker: View {
    @Environment(LiveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var homes: [DrillHome] = []
    @State private var total = 0
    @State private var failed = false
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        store.setHome(nil)
                        dismiss()
                    } label: {
                        row(Label("My location", systemImage: "location"), selected: store.home == nil)
                    }
                }
                Section {
                    if loading && homes.isEmpty {
                        ProgressView().frame(maxWidth: .infinity)
                    } else if failed {
                        Text("Can't load addresses right now.").foregroundStyle(Color.ctInkMuted)
                    } else if homes.isEmpty {
                        Text(query.isEmpty ? "This drill has no simulated homes." : "No address matches.")
                            .foregroundStyle(Color.ctInkMuted)
                    }
                    ForEach(homes) { home in
                        Button {
                            store.setHome(home)
                            dismiss()
                        } label: {
                            row(VStack(alignment: .leading, spacing: 2) {
                                Text(home.address).foregroundStyle(Color.ctInk)
                                Text([home.zone.name, home.householdLine].compactMap { $0 }
                                        .filter { !$0.isEmpty }.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(Color.ctInkMuted)
                            }, selected: store.home?.id == home.id)
                        }
                    }
                } footer: {
                    Text(total > homes.count
                         ? "Simulated households, made-up addresses. \(homes.count) of \(total) shown."
                         : "Simulated households, made-up addresses.")
                }
            }
            .searchable(text: $query, prompt: "Street")
            .navigationTitle("Address")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task(id: query) {
                if !query.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
                guard !Task.isCancelled else { return }
                loading = true
                do {
                    let result = try await store.homes(q: query, limit: 100)
                    guard !Task.isCancelled else { return }
                    homes = result.homes
                    total = result.total
                    failed = false
                } catch {
                    if !Task.isCancelled { failed = true }
                }
                loading = false
            }
        }
    }

    private func row(_ content: some View, selected: Bool) -> some View {
        HStack {
            content
            Spacer(minLength: 8)
            if selected {
                Image(systemName: "checkmark")
                    .foregroundStyle(Color.ctBrand)
                    .accessibilityLabel("Selected")
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

// MARK: - Follow a simulated person

/// Starts following a simulated person of the drill and shows them on Map, the camera on them.
@MainActor
private func followOnMap(_ personId: String, store: LiveStore, router: AppRouter) {
    store.startFollowing(personId)
    router.following = true
    router.tab = .map
}

/// Home's "Follow on Map" for the simulated person whose address is shown: starts following them,
/// or says they are followed and stops.
struct FollowOnMapButton: View {
    let personId: String
    @Environment(LiveStore.self) private var store
    @Environment(AppRouter.self) private var router

    var body: some View {
        let followed = store.followedPersonId == personId
        Button {
            if followed {
                store.stopFollowing()
                router.following = false
            } else {
                followOnMap(personId, store: store, router: router)
            }
        } label: {
            Label(followed ? "Stop following on Map" : "Follow this simulated person on Map",
                  systemImage: followed ? "xmark.circle" : "location.viewfinder")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .tint(Color.ctBrand)
        .accessibilityHint("Watch this simulated household leave on the map")
    }
}

/// Map's "Following ..." pill: who is followed (always labelled as a simulated person), what they
/// are doing now, the minutes to go and Stop. Tap the text to put the camera back on them.
struct FollowedPersonPill: View {
    @Environment(LiveStore.self) private var store
    @Environment(AppRouter.self) private var router

    var body: some View {
        if store.followedPersonId != nil {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                HStack(spacing: 8) {
                    Button { router.following = true } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Following \(title)")
                                .font(.subheadline.weight(.semibold))
                                .lineLimit(1)
                            Text(detail(at: context.date))
                                .font(.caption)
                                .foregroundStyle(Color.ctInkMuted)
                                .lineLimit(2)
                        }
                        .foregroundStyle(Color.ctInk)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Button("Stop") {
                        store.stopFollowing()
                        router.following = false
                    }
                    .buttonStyle(.glass)
                    .accessibilityLabel("Stop following")
                }
                .padding(.leading, 16)
                .padding(.trailing, 8)
                .padding(.vertical, 8)
                .glassEffect(.regular, in: .rect(cornerRadius: 22))
                .accessibilityElement(children: .contain)
            }
        }
    }

    /// The server's label, always read as a simulated person.
    private var title: String {
        guard let label = store.followedTrack?.label, !label.isEmpty else { return "Simulated person" }
        return label.localizedCaseInsensitiveContains("simulated") ? label : "Simulated person \(label)"
    }

    /// "Driving out, 7 min to go · ETA 7 min": the status the server words, then the minutes to go
    /// counted down between polls (left out when the status already says them).
    private func detail(at date: Date) -> String {
        guard let track = store.followedTrack else { return store.followError ?? "Finding them…" }
        var parts = [track.status.isEmpty ? track.phase : track.status]
        if track.isEnRoute, !track.status.contains("to go"), let eta = store.followedEtaMinutes(at: date) {
            parts.append(eta == 0 ? "arriving" : "ETA \(eta) min")
        }
        if let error = store.followError { parts.append(error) }
        return parts.joined(separator: " · ")
    }
}

/// Pick a simulated person of the drill to follow on Map: the drill's simulated households (the
/// same list as the address picker), with their made-up address, zone, household and status.
struct FollowPersonPicker: View {
    @Environment(LiveStore.self) private var store
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var homes: [DrillHome] = []
    @State private var total = 0
    @State private var failed = false
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
                if store.followedPersonId != nil {
                    Section {
                        Button(role: .destructive) {
                            store.stopFollowing()
                            router.following = false
                            dismiss()
                        } label: {
                            Label("Stop following", systemImage: "xmark.circle")
                                .frame(minHeight: 44)
                        }
                    }
                } else if let error = store.followError {
                    Section { Text(error).foregroundStyle(Color.ctInkMuted) }
                }
                Section {
                    if loading && homes.isEmpty {
                        ProgressView().frame(maxWidth: .infinity)
                    } else if failed {
                        Text("Can't load people right now.").foregroundStyle(Color.ctInkMuted)
                    } else if homes.isEmpty {
                        Text(query.isEmpty ? "This drill has no simulated people." : "No one matches.")
                            .foregroundStyle(Color.ctInkMuted)
                    }
                    ForEach(homes) { home in
                        Button {
                            followOnMap(home.id, store: store, router: router)
                            dismiss()
                        } label: {
                            row(home)
                        }
                    }
                } footer: {
                    Text(total > homes.count
                         ? "Simulated people of the drill, made-up addresses; routes are model estimates. \(homes.count) of \(total) shown."
                         : "Simulated people of the drill, made-up addresses; routes are model estimates.")
                }
            }
            .searchable(text: $query, prompt: "Street")
            .navigationTitle("Follow a simulated person")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task(id: query) {
                if !query.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
                guard !Task.isCancelled else { return }
                loading = true
                do {
                    let result = try await store.homes(q: query, limit: 100)
                    guard !Task.isCancelled else { return }
                    homes = result.homes
                    total = result.total
                    failed = false
                } catch {
                    if !Task.isCancelled { failed = true }
                }
                loading = false
            }
        }
    }

    private func row(_ home: DrillHome) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(home.address).foregroundStyle(Color.ctInk)
                Text([home.zone.name, home.householdLine, home.status].compactMap { $0 }
                        .filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(Color.ctInkMuted)
                Text("Simulated person")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.ctBrand)
            }
            Spacer(minLength: 8)
            if store.followedPersonId == home.id {
                Image(systemName: "checkmark")
                    .foregroundStyle(Color.ctBrand)
                    .accessibilityLabel("Following")
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}
