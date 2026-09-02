import SwiftUI

@main
struct SplitglassApp: App {
    @StateObject private var receiver: MirrorReceiver
    @StateObject private var history: HistoryStore

    init() {
        let receiver = MirrorReceiver()
        _receiver = StateObject(wrappedValue: receiver)
        _history = StateObject(wrappedValue: HistoryStore(traces: receiver.traces))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(receiver)
                .environmentObject(history)
                .preferredColorScheme(.dark)
                .tint(Theme.live)
                .onAppear { receiver.activate() }
        }
    }
}

/// Three tabs. Live is the chain and the reading on the glasses now; History is
/// every workout Health has, with ours marked; Settings is the rest.
struct RootView: View {
    var body: some View {
        TabView {
            LiveView()
                .tabItem { Label("Live", systemImage: "waveform.path.ecg") }
            HistoryView()
                .tabItem { Label("History", systemImage: "clock.arrow.circlepath") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "slider.horizontal.3") }
        }
        .toolbarBackground(Theme.panel, for: .tabBar)
        .toolbarColorScheme(.dark, for: .tabBar)
    }
}
