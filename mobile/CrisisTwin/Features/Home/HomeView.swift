import SwiftUI

/// Civilian home: what is official right now, the household plan, and one-tap actions.
struct HomeView: View {
    let openTab: (AppTab) -> Void

    @Environment(MeetingPlanStore.self) private var store
    @State private var showingAbout = false

    private var plan: MeetingPlan { store.plan }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    BrandLogo()
                        .frame(height: 36)
                    Spacer()
                    Button {
                        showingAbout = true
                    } label: {
                        Image(systemName: "info.circle")
                            .font(.title2)
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("About CrisisTwin")
                }
                .padding(.bottom, 4)

                VStack(alignment: .leading, spacing: 8) {
                    Text("HOUSEHOLD READINESS")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text("Be ready together.")
                        .font(.largeTitle.bold())
                    Text("Plan where your household meets, and practice with a simulated wildfire.")
                        .foregroundStyle(.secondary)
                }

                alertsCard
                quickActions
                planCard
                practiceCard

                Text("CrisisTwin is a planning aid, not an emergency service. In an emergency, follow official instructions and call 911 if you are in danger.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(20)
            .frame(maxWidth: 640, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Color("WorkspaceBackground"))
        // The logo header replaces the navigation bar, matching the web masthead.
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showingAbout) {
            NavigationStack { AboutView() }
        }
    }

    /// No official alert source is connected, so say so rather than implying "all clear".
    private var alertsCard: some View {
        Card {
            Label("Official alerts", systemImage: "exclamationmark.bubble")
                .font(.headline)
            Text("Not connected in this app yet. Watch for Wireless Emergency Alerts and follow evacuation orders from your local emergency services.")
                .foregroundStyle(.secondary)
        }
    }

    private var quickActions: some View {
        VStack(spacing: 12) {
            if let primary = plan.primary {
                Link(destination: primary.directionsURL) {
                    ActionRow(
                        title: "Go to my meeting point",
                        detail: primary.name,
                        systemImage: "arrow.triangle.turn.up.right.diamond.fill",
                        prominent: true
                    )
                }
                ShareLink(item: plan.shareText) {
                    ActionRow(
                        title: "Share my plan",
                        detail: plan.contacts.isEmpty ? "Send it to the people you trust" : "\(plan.contacts.count) trusted contact\(plan.contacts.count == 1 ? "" : "s")",
                        systemImage: "square.and.arrow.up",
                        prominent: false
                    )
                }
            } else {
                Button {
                    openTab(.plan)
                } label: {
                    ActionRow(
                        title: "Choose a meeting point",
                        detail: "Then you can get directions and share your plan in one tap",
                        systemImage: "mappin.and.ellipse",
                        prominent: true
                    )
                }
            }
        }
        .buttonStyle(.plain)
    }

    private var planCard: some View {
        Card {
            Label("My plan", systemImage: "figure.2")
                .font(.headline)
            LabeledContent("Meet at", value: plan.primary?.name ?? "Not chosen")
            LabeledContent("Backup", value: plan.backup?.name ?? "Not chosen")
            LabeledContent("Trusted contacts", value: "\(plan.contacts.count)")
            Button(plan.primary == nil ? "Set up my plan" : "Edit my plan") { openTab(.plan) }
                .buttonStyle(.bordered)
        }
    }

    private var practiceCard: some View {
        Card {
            Label("Practice with a simulated fire", systemImage: "flame")
                .font(.headline)
            Text("Pick where a fire starts and how the wind blows, then watch how it could spread over two hours. It's a simple illustrative model, not a forecast.")
                .foregroundStyle(.secondary)
            Button("Open Practice") { openTab(.practice) }
                .buttonStyle(.bordered)
        }
    }
}

/// The shared CrisisTwin lockup from the web app (`app/public/brand`). It is drawn in deep
/// green for light backgrounds, so dark mode renders it as a light single-color mark.
private struct BrandLogo: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if colorScheme == .dark {
                Image("Logo").resizable().renderingMode(.template).foregroundStyle(.white)
            } else {
                Image("Logo").resizable()
            }
        }
        .aspectRatio(contentMode: .fit)
        .accessibilityLabel("CrisisTwin")
    }
}

private struct Card<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .background(.background, in: RoundedRectangle(cornerRadius: 16))
    }
}

/// A large, full-width action with a text label, so meaning never depends on the icon or color alone.
private struct ActionRow: View {
    let title: String
    let detail: String
    let systemImage: String
    let prominent: Bool

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.title2)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).opacity(0.85)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).opacity(0.6)
        }
        .foregroundStyle(prominent ? Color.white : Color.primary)
        .padding()
        .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
        .background(prominent ? Color.accentColor : Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
        .contentShape(RoundedRectangle(cornerRadius: 16))
    }
}
