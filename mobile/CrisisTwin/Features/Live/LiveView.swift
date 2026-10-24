import SwiftUI

/// Live tab: the public map of independently confirmed reports and a one-tap way to report what
/// you see (ADR 0011). Reports are observations, not instructions; official orders come first.
struct LiveView: View {
    @Environment(LiveStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingReport = false
    @State private var reportPrefill: ReportPrefill?
    @State private var showingMyReports = DebugLaunch.screen == "myreports"
    @State private var showingResponder = DebugLaunch.screen == "responder"

    var body: some View {
        LiveMapView(onReport: openReport)
            .safeAreaInset(edge: .top, spacing: 0) { statusBanner }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 10) {
                    StillTherePrompt()
                    reportButton
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
            }
            .navigationTitle("Live")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    NavigationLink {
                        ResponderView(onReport: openReport)
                    } label: {
                        Label(store.role == .responder ? "Tasks" : "Responder", systemImage: "person.badge.shield.checkmark")
                            .labelStyle(.titleAndIcon)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        MyReportsView()
                    } label: {
                        Label("My reports", systemImage: "list.bullet.rectangle")
                            .labelStyle(.titleAndIcon)
                    }
                }
            }
            .sheet(isPresented: $showingReport) {
                NavigationStack { ReportSheet(prefill: reportPrefill) }
            }
            .navigationDestination(isPresented: $showingMyReports) { MyReportsView() }
            .navigationDestination(isPresented: $showingResponder) { ResponderView(onReport: openReport) }
            .task { if DebugLaunch.screen == "report" { openReport(nil) } }
            .onAppear { store.startPolling() }
            .onDisappear { store.stopPolling() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { store.startPolling() } else { store.stopPolling() }
            }
    }

    private func openReport(_ prefill: ReportPrefill?) {
        reportPrefill = prefill
        showingReport = true
    }

    private var statusBanner: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label {
                Text(LiveIncident.drillLabel)
                    .foregroundStyle(Color.ctInk)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(HazardTone.caution.color)
            }
            .font(.footnote.weight(.semibold))
            if case .unavailable(let message) = store.connection {
                Label(message, systemImage: "wifi.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(Color.ctMuted)
            }
            if !store.pending.isEmpty {
                Label("\(store.pending.count) report\(store.pending.count == 1 ? "" : "s") waiting to send",
                      systemImage: "tray.and.arrow.up")
                    .font(.footnote)
                    .foregroundStyle(Color.ctMuted)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .background(HazardTone.caution.color.opacity(0.10), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(HazardTone.caution.color.opacity(0.35), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .padding(.horizontal, 16)
        .padding(.top, 6)
    }

    private var reportButton: some View {
        Button {
            openReport(nil)
        } label: {
            Label("Report what you see", systemImage: "exclamationmark.bubble.fill")
        }
        .buttonStyle(PrimaryButtonStyle())
        .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
    }
}
