import SwiftUI

/// The Map tab (ADR 0012): the full-bleed `IncidentMap`, the guidance drawer above the
/// accessory, and the floating glass controls (the Exercise tag top-leading; follow and Report on
/// the right edge) in one `GlassEffectContainer`. No navigation bar. Reads `LiveStore`,
/// `LocationProvider` and `AppRouter` from the environment.
struct IncidentView: View {
    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @Environment(AppRouter.self) private var router
    @Environment(\.reportZoom) private var reportZoom
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Measured drawer height; 0 without guidance.
    @State private var drawerHeight: CGFloat = 0

    init() {}

    private static let inset: CGFloat = 8
    private static let controlSize: CGFloat = 56

    private var myLocation: LonLat? {
        location.lastLocation.map { LonLat(lon: $0.coordinate.longitude, lat: $0.coordinate.latitude) }
    }

    private var bottomInset: CGFloat { drawerHeight > 0 ? drawerHeight + Self.inset : 0 }

    var body: some View {
        IncidentMap(
            situation: store.situation, myLocation: myLocation, guidance: store.activeGuidance,
            zone: store.myZone, task: store.currentTask, taskTarget: store.currentTask.flatMap(store.taskTarget))
            .safeAreaPadding(.bottom, bottomInset)
            .overlay(alignment: .bottom) { drawer }
            .overlay { controls }
            .animation(reduceMotion ? nil : .smooth, value: drawerHeight)
    }

    @ViewBuilder private var drawer: some View {
        if let guidance = store.activeGuidance {
            GuidanceSheet(guidance: guidance)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { drawerHeight = $0 }
                .padding(.horizontal, Self.inset)
                .padding(.bottom, Self.inset)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .onDisappear { drawerHeight = 0 }
        }
    }

    private var controls: some View {
        GlassEffectContainer(spacing: 12) {
            VStack(spacing: 0) {
                HStack {
                    if store.isExercise {
                        ExerciseTag()
                            .padding(.horizontal, 8)
                            .frame(minHeight: 36)
                            .glassEffect(.regular, in: .capsule)
                    }
                    Spacer()
                }
                Spacer()
                HStack {
                    Spacer()
                    VStack(spacing: 12) {
                        followButton
                        reportButton
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, bottomInset + 12)
        }
    }

    private var followButton: some View {
        Button {
            router.following.toggle()
        } label: {
            Image(systemName: router.following ? "location.fill" : "location")
                .font(.title3.weight(.semibold))
                .contentTransition(.symbolEffect(.replace))
                .frame(width: Self.controlSize, height: Self.controlSize)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .disabled(!location.isAuthorized)
        .accessibilityLabel(router.following ? "Stop following" : "Follow my location")
        .sensoryFeedback(.selection, trigger: router.following)
    }

    private var reportButton: some View {
        Button {
            router.openReport(from: "map-report")
        } label: {
            Label("Report", systemImage: "exclamationmark.bubble")
                .font(.headline)
                .padding(.horizontal, 20)
                .frame(height: Self.controlSize)
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .capsule)
        .reportZoomSource("map-report", in: reportZoom)
        .accessibilityLabel("Report what you see")
    }
}
