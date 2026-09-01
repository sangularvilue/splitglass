import Foundation
import HealthKit
import os

/// The phone's job: receive, serve, relay.
///
/// A mirrored `HKWorkoutSession` is what makes this possible. When the watch
/// calls `startMirroringToCompanionDevice()`, HealthKit hands the iPhone a
/// session object here — and, crucially, background runtime for as long as the
/// workout lasts, which a plain app would not get. The watch then pushes each
/// snapshot across the session's data channel; the phone serves it on loopback
/// for the glasses and posts it to the relay.
///
/// The phone deliberately does no arithmetic. Every number was computed on the
/// watch from HealthKit, so there is exactly one authority and the glasses cannot
/// disagree with the Fitness app.
@MainActor
final class MirrorReceiver: NSObject, ObservableObject {

    @Published private(set) var mirroredSession: HKWorkoutSession?
    @Published private(set) var receivedCount = 0
    @Published private(set) var lastRelayError: String?
    @Published private(set) var localServerRunning = false
    @Published var settings = SplitglassSettings.load()

    let store = SnapshotStore()

    private let healthStore = HKHealthStore()
    private let log = Logger(subsystem: "xyz.grannis.splitglass", category: "mirror")
    private let cloud = CloudRelay()
    private var localServer: LocalServer?

    var isMirroring: Bool { mirroredSession != nil }

    /// Called once at launch. The handler stays installed for the life of the
    /// process, so a workout started on the watch later still finds us.
    func activate() {
        startLocalServer()

        healthStore.workoutSessionMirroringStartHandler = { [weak self] session in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.log.info("mirrored workout session started")
                session.delegate = self
                self.mirroredSession = session
            }
        }

        Task { await requestAuthorization() }
    }

    /// The phone needs read access even though it does no collecting: without it
    /// HealthKit will not hand over a mirrored session.
    private func requestAuthorization() async {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let read: Set<HKObjectType> = [
            HKQuantityType(.heartRate),
            HKQuantityType(.activeEnergyBurned),
            HKQuantityType(.distanceWalkingRunning),
            HKObjectType.workoutType(),
        ]
        do {
            try await healthStore.requestAuthorization(toShare: [], read: read)
        } catch {
            log.warning("health authorisation refused: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func startLocalServer() {
        guard localServer == nil else { return }
        let server = LocalServer { [store] in
            // Hop to the main actor for the read; the body provider is called on
            // the server's own queue.
            MainActor.assumeIsolated { store.jsonBody }
        }
        server.start()
        localServer = server
        // The listener goes ready asynchronously.
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(400))
            localServerRunning = server.isRunning
        }
    }

    func updateSettings(_ update: (inout SplitglassSettings) -> Void) {
        var next = settings
        update(&next)
        settings = next
        next.save()
    }

    private func accept(_ snapshot: Snapshot) async {
        store.accept(snapshot)
        receivedCount += 1
        await cloud.post(snapshot, settings: settings)
        lastRelayError = await cloud.lastError
    }
}

extension MirrorReceiver: HKWorkoutSessionDelegate {
    nonisolated func workoutSession(
        _ workoutSession: HKWorkoutSession,
        didChangeTo toState: HKWorkoutSessionState,
        from fromState: HKWorkoutSessionState,
        date: Date
    ) {
        Task { @MainActor in
            if toState == .ended || toState == .stopped {
                log.info("mirrored session ended")
                mirroredSession = nil
            }
        }
    }

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        Task { @MainActor in
            log.error("mirrored session failed: \(error.localizedDescription, privacy: .public)")
            mirroredSession = nil
        }
    }

    /// Snapshots arrive here, already built on the watch.
    nonisolated func workoutSession(
        _ workoutSession: HKWorkoutSession,
        didReceiveDataFromRemoteWorkoutSession data: [Data]
    ) {
        Task { @MainActor in
            for payload in data {
                guard let snapshot = Snapshot.decode(payload) else {
                    log.debug("undecodable payload from the watch, ignored")
                    continue
                }
                await accept(snapshot)
            }
        }
    }
}
