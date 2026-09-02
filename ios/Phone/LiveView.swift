import SwiftUI

/// What is happening right now: whether the chain is up, and the reading that is
/// on the glasses this second.
struct LiveView: View {
    @EnvironmentObject private var receiver: MirrorReceiver
    @State private var codeField = ""
    @State private var editingCode = false

    private var miles: Bool { receiver.settings.useMiles }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                header
                pairCard
                statusCard
                readingCard
            }
            .padding(16)
        }
        .background(Theme.ground.ignoresSafeArea())
        .onAppear { codeField = receiver.settings.pairCode }
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Splitglass")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Theme.ink)
            Spacer()
            statePill
        }
        .padding(.horizontal, 2)
    }

    private var statePill: some View {
        let s = receiver.store.latest
        let running = s?.state == .running
        let text = s.map { $0.state.rawValue + ($0.indoor ? " · indoor" : "") } ?? "idle"
        return Text(text.uppercased())
            .font(.label(10))
            .tracking(1.2)
            .foregroundStyle(running ? Theme.live : Theme.ink3)
            .padding(.vertical, 5)
            .padding(.horizontal, 10)
            .overlay(Capsule().strokeBorder(running ? Theme.liveDim : Theme.edge))
    }

    // MARK: Pair

    private var pairCard: some View {
        Card(title: "Pair") {
            if receiver.settings.isPaired && !editingCode {
                HStack {
                    Text(receiver.settings.pairCode)
                        .font(.system(size: 28, weight: .semibold, design: .monospaced))
                        .tracking(4)
                        .foregroundStyle(Theme.live)
                    Spacer()
                    Button("Change") { editingCode = true }
                        .buttonStyle(.bordered)
                        .tint(Theme.ink3)
                }
            } else {
                HStack(spacing: 10) {
                    TextField("Code", text: $codeField)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.system(size: 24, weight: .semibold, design: .monospaced))
                        .tracking(3)
                        .foregroundStyle(Theme.ink)
                        .padding(10)
                        .background(Theme.panel2, in: RoundedRectangle(cornerRadius: 7))
                        .onSubmit(save)
                    Button("Save", action: save)
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.liveDim)
                        .disabled(normalized.count != 6)
                }
            }
        }
    }

    private var normalized: String {
        codeField.uppercased().filter { $0.isLetter || $0.isNumber }
    }

    private func save() {
        guard normalized.count == 6 else { return }
        receiver.updateSettings { $0.pairCode = normalized }
        codeField = normalized
        editingCode = false
    }

    // MARK: Status

    private var statusCard: some View {
        Card(title: "Chain", trailing: "\(receiver.receivedCount) readings") {
            VStack(spacing: 10) {
                StatusRow(label: "Watch", ok: receiver.isMirroring,
                          detail: receiver.isMirroring ? "mirroring" : "start a workout")
                StatusRow(label: "Loopback", ok: receiver.localServerRunning,
                          detail: receiver.localServerRunning ? "127.0.0.1:\(RelayConfig.localPort)" : "off")
                StatusRow(label: "Relay",
                          ok: receiver.settings.useCloudRelay && receiver.lastRelayError == nil,
                          detail: receiver.settings.useCloudRelay ? (receiver.lastRelayError ?? "posting") : "off")
            }
        }
    }

    // MARK: Reading

    private var readingCard: some View {
        let s = receiver.store.latest
        let fresh = receiver.store.isFresh
        return Card(title: "Now", trailing: s.map { Format.time.format(Date(timeIntervalSince1970: $0.at / 1000)) }) {
            TileGrid(tiles: [
                Tile(label: "Distance", value: Format.distance(s?.distance, miles: miles), unit: Format.distanceUnit(miles: miles), live: fresh),
                Tile(label: "Time", value: s.map { Format.duration($0.elapsed) } ?? "—", live: fresh),
                Tile(label: "Heart rate", value: Format.bpm(s?.heartRate), unit: "bpm", live: fresh),
                Tile(label: "Pace", value: Format.pace(s?.paceSecPerKm, miles: miles), unit: Format.paceUnit(miles: miles), live: fresh),
                Tile(label: "Energy", value: Format.kcal(s?.energy), unit: "kcal", live: fresh),
                Tile(label: "Zone", value: s?.zones?.currentIndex.map { "Z\($0 + 1)" } ?? "—",
                     unit: s?.zones?.source == .apple ? "Health" : (s?.zones == nil ? "" : "est."), live: fresh),
            ])

            if let zones = s?.zones {
                ZoneBar(durations: zones.durations, current: zones.currentIndex)
                    .padding(.top, 4)
            }
        }
    }
}
