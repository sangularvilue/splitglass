import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var receiver: MirrorReceiver

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    Card(title: "Units") {
                        Picker("Units", selection: Binding(
                            get: { receiver.settings.useMiles },
                            set: { v in receiver.updateSettings { $0.useMiles = v } }
                        )) {
                            Text("Miles").tag(true)
                            Text("Kilometres").tag(false)
                        }
                        .pickerStyle(.segmented)
                    }

                    Card(title: "Relay") {
                        Toggle("Cloud relay", isOn: Binding(
                            get: { receiver.settings.useCloudRelay },
                            set: { v in receiver.updateSettings { $0.useCloudRelay = v } }
                        ))
                        .tint(Theme.liveDim)
                        row("Host", receiver.settings.baseURL.host ?? "—")
                        row("Loopback", "127.0.0.1:\(RelayConfig.localPort)")
                    }

                    Card(title: "Zone fallback", trailing: "used only if Health has no zones") {
                        Stepper(value: Binding(
                            get: { receiver.settings.maxHeartRate },
                            set: { v in receiver.updateSettings { $0.maxHeartRate = v } }
                        ), in: 120...230, step: 1) {
                            row("Max heart rate", "\(Int(receiver.settings.maxHeartRate)) bpm")
                        }
                        row("Resting heart rate", "\(Int(receiver.settings.restingHeartRate)) bpm")
                    }

                    Card(title: "Workout", trailing: "set on the watch") {
                        row("Auto-pause", receiver.settings.autoPause ? "on · outdoor" : "off")
                        row("Route", "recorded outdoors")
                        row("Saved to", "Fitness")
                    }

                    Card(title: "About") {
                        row("Version", Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—")
                        row("Traces kept", "\(receiver.traces.index.count)")
                    }
                }
                .padding(16)
            }
            .background(Theme.ground.ignoresSafeArea())
            .navigationTitle("Settings")
            .toolbarColorScheme(.dark, for: .navigationBar)
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.system(size: 15)).foregroundStyle(Theme.ink)
            Spacer()
            Text(value).font(.mono(12)).foregroundStyle(Theme.ink3)
        }
    }
}
