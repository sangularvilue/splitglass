import SwiftUI

@main
struct PaceRailApp: App {
    @StateObject private var receiver = MirrorReceiver()

    var body: some Scene {
        WindowGroup {
            PhoneRootView()
                .environmentObject(receiver)
                .onAppear { receiver.activate() }
        }
    }
}

/// The phone app is a bridge with a status light. It exists to hold the pair
/// code, to serve the glasses on loopback, and to show plainly whether readings
/// are getting through — the workout is started on the watch and read on the
/// glasses.
struct PhoneRootView: View {
    @EnvironmentObject private var receiver: MirrorReceiver
    @State private var codeField = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Pair with the glasses") {
                    TextField("Six-character code", text: $codeField)
                        .textCase(.uppercase)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.characters)
                        .font(.system(.title2, design: .monospaced))
                        .onSubmit(savePairCode)

                    Button("Save code", action: savePairCode)
                        .disabled(normalizedCode.count != 6)

                    if receiver.settings.isPaired {
                        LabeledContent("Paired as", value: receiver.settings.pairCode)
                    }

                    Text("The code is on the Pace Rail plugin's own screen, under \u{201C}Pair the phone\u{201D}.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Status") {
                    statusRow("Watch mirroring", ok: receiver.isMirroring,
                              detail: receiver.isMirroring ? "receiving" : "start a workout on the watch")
                    statusRow("On-device server", ok: receiver.localServerRunning,
                              detail: receiver.localServerRunning ? "127.0.0.1:\(RelayConfig.localPort)" : "not listening")
                    statusRow("Cloud relay", ok: receiver.settings.useCloudRelay && receiver.lastRelayError == nil,
                              detail: receiver.settings.useCloudRelay
                                ? (receiver.lastRelayError ?? "posting")
                                : "off")
                    LabeledContent("Readings relayed", value: "\(receiver.receivedCount)")
                }

                if let snapshot = receiver.store.latest {
                    Section("Last reading") {
                        LabeledContent("State", value: snapshot.state.rawValue)
                        LabeledContent("Elapsed", value: String(format: "%.0f s", snapshot.elapsed))
                        if let distance = snapshot.distance {
                            LabeledContent("Distance", value: String(format: "%.2f km", distance / 1000))
                        }
                        if let heartRate = snapshot.heartRate {
                            LabeledContent("Heart rate", value: "\(Int(heartRate)) bpm")
                        }
                        if let zones = snapshot.zones {
                            LabeledContent("Zones", value: zones.source == .apple
                                ? "yours, from Health (\(zones.count))"
                                : "estimated (\(zones.count))")
                        }
                        LabeledContent("Fresh", value: receiver.store.isFresh ? "yes" : "no")
                    }
                }

                Section("Relay") {
                    Toggle("Use the cloud relay", isOn: Binding(
                        get: { receiver.settings.useCloudRelay },
                        set: { value in receiver.updateSettings { $0.useCloudRelay = value } }
                    ))
                    Text("""
                    Off, readings stay on this phone and the glasses read them over \
                    loopback — which needs nothing but Bluetooth, and works with no \
                    signal at all. On, they are also posted to \
                    \(receiver.settings.baseURL.host ?? "the relay"), which is what the \
                    glasses fall back to when the plugin is not allowed to open a \
                    plain-http connection.
                    """)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }

                Section("Heart-rate zones") {
                    Text("""
                    Zones come from Health, so the glasses show the same boundaries and \
                    the same time-in-zone the Fitness app will. The two numbers below are \
                    used only if Health has no zones for you at all.
                    """)
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                    Stepper(value: Binding(
                        get: { receiver.settings.maxHeartRate },
                        set: { value in receiver.updateSettings { $0.maxHeartRate = value } }
                    ), in: 120...230, step: 1) {
                        LabeledContent("Maximum", value: "\(Int(receiver.settings.maxHeartRate)) bpm")
                    }

                    LabeledContent("Resting", value: "\(Int(receiver.settings.restingHeartRate)) bpm")
                }
            }
            .navigationTitle("Pace Rail")
            .onAppear { codeField = receiver.settings.pairCode }
        }
    }

    private var normalizedCode: String {
        codeField.uppercased().filter { $0.isLetter || $0.isNumber }
    }

    private func savePairCode() {
        let code = normalizedCode
        guard code.count == 6 else { return }
        receiver.updateSettings { $0.pairCode = code }
        codeField = code
    }

    private func statusRow(_ label: String, ok: Bool, detail: String) -> some View {
        LabeledContent {
            Text(detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
        } label: {
            HStack(spacing: 8) {
                Circle()
                    .fill(ok ? Color.green : Color.orange)
                    .frame(width: 8, height: 8)
                Text(label)
            }
        }
    }
}
