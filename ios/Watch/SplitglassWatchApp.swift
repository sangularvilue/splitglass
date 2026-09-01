import SwiftUI

@main
struct SplitglassWatchApp: App {
    @StateObject private var workout = WorkoutManager()

    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .environmentObject(workout)
                .task { await workout.requestAuthorization() }
        }
    }
}

/// The watch UI is deliberately thin: the glasses are the display, and anything
/// worth looking at on the wrist mid-run is already on the HUD. What this needs
/// to do is start the right kind of workout, say whether the numbers are getting
/// out, and stop.
struct WatchRootView: View {
    @EnvironmentObject private var workout: WorkoutManager
    @State private var indoor = false

    var body: some View {
        switch workout.phase {
        case .running, .paused:
            activeView
        default:
            startView
        }
    }

    private var startView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("Splitglass")
                    .font(.headline)

                if case .failed(let message) = workout.phase {
                    Text(message)
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }

                Toggle("Indoor", isOn: $indoor)
                    .font(.caption)

                Button {
                    Task { await workout.start(activity: .running, indoor: indoor) }
                } label: {
                    Label(indoor ? "Start treadmill run" : "Start outdoor run", systemImage: "figure.run")
                }
                .buttonStyle(.borderedProminent)

                Button {
                    Task { await workout.start(activity: .walking, indoor: indoor) }
                } label: {
                    Label("Walk", systemImage: "figure.walk")
                }

                if let source = workout.zoneSource {
                    Text(source == .apple ? "Zones: yours, from Health" : "Zones: estimated")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 4)
        }
    }

    private var activeView: some View {
        let snapshot = workout.snapshot
        return ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Circle()
                        .fill(workout.mirroring ? .green : .orange)
                        .frame(width: 7, height: 7)
                    Text(workout.mirroring ? "to phone" : "to relay")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(snapshot.state.rawValue)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                metric("Time", value: Self.duration(snapshot.elapsed))
                metric("Distance", value: snapshot.distance.map { String(format: "%.2f km", $0 / 1000) } ?? "—")
                metric("Heart rate", value: snapshot.heartRate.map { "\(Int($0)) bpm" } ?? "—")
                if let zones = snapshot.zones, let index = zones.currentIndex {
                    metric("Zone", value: "Z\(index + 1) of \(zones.count)")
                }

                HStack(spacing: 6) {
                    if workout.phase == .paused {
                        Button("Resume") { workout.resume() }
                    } else {
                        Button("Pause") { workout.pause() }
                    }
                    Button("End") { Task { await workout.end() } }
                        .tint(.red)
                }
                .font(.caption)
            }
            .padding(.horizontal, 4)
        }
    }

    private func metric(_ label: String, value: String) -> some View {
        HStack {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.system(.body, design: .rounded)).monospacedDigit()
        }
    }

    private static func duration(_ seconds: Double) -> String {
        let total = Int(seconds)
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, s)
            : String(format: "%d:%02d", m, s)
    }
}
