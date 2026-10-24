import SwiftUI

/// Civilian home: what is official right now, the household plan, and one-tap actions.
struct HomeView: View {
    let openTab: (AppTab) -> Void

    @Environment(MeetingPlanStore.self) private var store
    @State private var showingAbout = false

    private var plan: MeetingPlan { store.plan }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                hero

                alertsCard
                quickActions
                planCard
                practiceCard

                Label {
                    Text("CrisisTwin is not an emergency service. If you are in danger, call 911 and follow official instructions.")
                } icon: {
                    Image(systemName: "info.circle")
                }
                .font(.footnote)
                .foregroundStyle(Color.ctMuted)
                .padding(.horizontal, 4)
                .padding(.top, 4)
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 32)
            .frame(maxWidth: 640, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Color.ctBackground)
        // The logo header replaces the navigation bar, matching the web masthead.
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showingAbout) {
            NavigationStack { AboutView() }
        }
    }

    private var header: some View {
        HStack {
            BrandLogo()
                .frame(height: 32)
            Spacer()
            Button {
                showingAbout = true
            } label: {
                Image(systemName: "info")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.ctBrand)
                    .frame(width: 44, height: 44)
                    .background(Color.ctSurface, in: Circle())
                    .overlay(Circle().strokeBorder(Color.ctBorder, lineWidth: 1))
            }
            .accessibilityLabel("About CrisisTwin")
        }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Be ready together.")
                .font(.largeTitle.bold())
                .foregroundStyle(Color.ctInk)
        }
    }

    /// No official alert source is connected, so say so rather than implying "all clear".
    private var alertsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                IconBadge(systemImage: "exclamationmark.bubble", tint: HazardTone.info.color)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Official alerts")
                        .font(.headline)
                        .foregroundStyle(Color.ctInk)
                    StatusPill(text: "Not connected", systemImage: "antenna.radiowaves.left.and.right.slash", tone: .info)
                }
            }
            Text("Watch for Wireless Emergency Alerts and follow local evacuation orders.")
                .font(.subheadline)
                .foregroundStyle(Color.ctMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .ctCard()
        .accessibilityElement(children: .combine)
    }

    private var quickActions: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let primary = plan.primary {
                Link(destination: primary.directionsURL) {
                    ActionRow(
                        title: "Go to my meeting point",
                        detail: primary.name,
                        systemImage: "arrow.triangle.turn.up.right.diamond.fill",
                        prominent: true
                    )
                }
            } else {
                Button {
                    openTab(.plan)
                } label: {
                    ActionRow(
                        title: "Choose a meeting point",
                        systemImage: "mappin.and.ellipse",
                        prominent: true
                    )
                }
            }
            Button {
                openTab(.live)
            } label: {
                ActionRow(
                    title: "Report what you see",
                    systemImage: "exclamationmark.bubble",
                    prominent: false
                )
            }
            if plan.primary != nil {
                ShareLink(item: plan.shareText) {
                    ActionRow(
                        title: "Share my plan",
                        detail: plan.contacts.isEmpty ? nil : "\(plan.contacts.count) trusted contact\(plan.contacts.count == 1 ? "" : "s")",
                        systemImage: "square.and.arrow.up",
                        prominent: false
                    )
                }
            }
        }
        .buttonStyle(.plain)
    }

    private var planCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                IconBadge(systemImage: "figure.2", tint: .ctBrand)
                Text("My plan")
                    .font(.headline)
                    .foregroundStyle(Color.ctInk)
            }
            VStack(spacing: 0) {
                PlanSummaryRow(label: "Meet at", value: plan.primary?.name, systemImage: "1.circle")
                Divider().overlay(Color.ctBorder)
                PlanSummaryRow(label: "Backup", value: plan.backup?.name, systemImage: "2.circle")
                Divider().overlay(Color.ctBorder)
                PlanSummaryRow(
                    label: "Trusted contacts",
                    value: plan.contacts.isEmpty ? nil : "\(plan.contacts.count)",
                    systemImage: "person.2",
                    emptyText: "None yet"
                )
            }
            Button(plan.primary == nil ? "Set up my plan" : "Edit my plan") { openTab(.plan) }
                .buttonStyle(SecondaryButtonStyle())
        }
        .ctCard()
    }

    private var practiceCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                IconBadge(systemImage: "flame", tint: HazardTone.caution.color)
                Text("Practice with a simulated fire")
                    .font(.headline)
                    .foregroundStyle(Color.ctInk)
            }
            Text("Watch how a fire could spread. A simple model, not a forecast.")
                .font(.subheadline)
                .foregroundStyle(Color.ctMuted)
                .fixedSize(horizontal: false, vertical: true)
            Button("Open Practice") { openTab(.practice) }
                .buttonStyle(SecondaryButtonStyle())
        }
        .ctCard()
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

/// A rounded square holding a section icon, tinted to match the section.
private struct IconBadge: View {
    let systemImage: String
    let tint: Color

    @ScaledMetric(relativeTo: .headline) private var size: CGFloat = 36

    var body: some View {
        Image(systemName: systemImage)
            .font(.body.weight(.semibold))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// One line of the plan summary; an empty value reads as text, not just a muted color.
private struct PlanSummaryRow: View {
    let label: String
    let value: String?
    let systemImage: String
    var emptyText = "Not chosen"

    @ScaledMetric(relativeTo: .subheadline) private var iconWidth: CGFloat = 24

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: systemImage)
                .foregroundStyle(Color.ctMuted)
                .frame(width: iconWidth)
                .accessibilityHidden(true)
            Text(label)
                .foregroundStyle(Color.ctMuted)
            Spacer(minLength: 12)
            Text(value ?? emptyText)
                .fontWeight(value == nil ? .regular : .semibold)
                .foregroundStyle(value == nil ? Color.ctMuted : Color.ctInk)
                .italic(value == nil)
                .multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }
}

private extension Color {
    /// Text on a brand fill: white on deep green, deep green-black on the light dark-mode green.
    static let onBrand = Color(light: 0xFFFFFF, dark: 0x0F231E)
}

/// A large, full-width action with a text label, so meaning never depends on the icon or color alone.
private struct ActionRow: View {
    let title: String
    var detail: String?
    let systemImage: String
    let prominent: Bool

    @ScaledMetric(relativeTo: .title2) private var badge: CGFloat = 44

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.ctBrand)
                .frame(width: badge, height: badge)
                .background(prominent ? Color.onBrand : Color.ctBrand.opacity(0.1), in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(prominent ? Color.onBrand : Color.ctInk)
                if let detail {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(prominent ? Color.onBrand.opacity(0.85) : Color.ctMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.bold))
                .foregroundStyle(prominent ? Color.onBrand.opacity(0.8) : Color.ctMuted)
                .accessibilityHidden(true)
        }
        .padding(prominent ? 18 : 14)
        .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
        .background {
            let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
            if prominent {
                shape.fill(Color.ctBrand.gradient)
                    .shadow(color: Color.ctBrand.opacity(0.3), radius: 12, y: 6)
            } else {
                shape.fill(Color.ctSurface)
                    .overlay(shape.strokeBorder(Color.ctBorder.opacity(0.7), lineWidth: 1))
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}
