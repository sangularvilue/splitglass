import CoreLocation
import Foundation
import HealthKit
import os

/// The watch owns the workout.
///
/// `HKWorkoutSession` plus `HKLiveWorkoutBuilder` is the only place these
/// numbers exist first-hand, and it is the reason the HUD works on a treadmill:
/// distance, energy, heart rate and elapsed time all come from here, not from
/// GPS. The session is mirrored to the iPhone so the phone gets background
/// runtime and can relay to the glasses; the snapshot itself is built here and
/// pushed across, because the watch is where the truth is and mirroring's data
/// channel is far quicker than waiting for samples to sync.
///
/// The workout that lands in Fitness should be indistinguishable from one
/// started in the Workout app, so this does everything that app does:
///
///  - **Distance and energy** come from `HKLiveWorkoutDataSource` — Apple's own
///    collector, so the same GPS + pedometer fusion outdoors and the same
///    calibrated stride model on a treadmill. We add nothing to it.
///  - **A route** is recorded with `HKWorkoutRouteBuilder` for outdoor workouts,
///    so Fitness shows the map and elevation.
///  - **Running form** — power, stride length, ground contact time, vertical
///    oscillation — is switched on explicitly.
///  - **Auto-pause** outdoors when you stop, as the Workout app does by default.
///
/// What will still differ: Fitness lists the source as Splitglass rather than
/// Workout, as it does for every third-party app.
@MainActor
final class WorkoutManager: NSObject, ObservableObject {

    enum Phase: Equatable {
        case idle
        case requestingAuthorization
        case starting
        case running
        case paused
        case ending
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var snapshot: Snapshot = .idle()
    @Published private(set) var mirroring = false
    @Published private(set) var zoneSource: Snapshot.Zones.Source?
    @Published var settings = SplitglassSettings.load()

    private let healthStore = HKHealthStore()
    private let log = Logger(subsystem: "xyz.grannis.splitglass", category: "workout")
    private let cloud = CloudRelay()

    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var pushTimer: Timer?

    private var workoutId = "none"
    private var seq = 0
    private var indoor = false
    private var activity: Snapshot.Activity = .running

    // Latest values, updated as HealthKit collects them.
    private var heartRate: Double?
    private var distance: Double?
    private var energy: Double?
    private var speed: Double?
    private var steps: Double?
    private var zones: Snapshot.Zones?

    /// Set when mirroring has actually delivered something, so the watch knows
    /// whether it has to reach the relay itself.
    private var mirrorConfirmedAt: Date?

    // The route Fitness draws. Outdoor only.
    private let locationManager = CLLocationManager()
    private var routeBuilder: HKWorkoutRouteBuilder?
    private var routePoints = 0

    // Auto-pause. Distance is the signal: it is sampled throughout a running
    // workout and only ever goes up, where speed can simply stop arriving.
    private var lastDistanceValue: Double?
    private var lastDistanceMovedAt: Date?
    private var autoPaused = false
    private static let autoPauseAfter: TimeInterval = 6
    private static let autoPauseMinMove: Double = 3

    private var typesToRead: Set<HKObjectType> {
        var types: Set<HKObjectType> = [
            HKQuantityType(.heartRate),
            HKQuantityType(.activeEnergyBurned),
            HKQuantityType(.distanceWalkingRunning),
            HKQuantityType(.stepCount),
            HKQuantityType(.restingHeartRate),
            HKObjectType.activitySummaryType(),
        ]
        types.insert(HKQuantityType(.runningSpeed))
        for type in Self.runningFormTypes { types.insert(type) }
        return types
    }

    /// The Workout app records these on Series 6 and later; so do we.
    private static let runningFormTypes: [HKQuantityType] = [
        HKQuantityType(.runningPower),
        HKQuantityType(.runningStrideLength),
        HKQuantityType(.runningGroundContactTime),
        HKQuantityType(.runningVerticalOscillation),
    ]

    private var typesToShare: Set<HKSampleType> {
        [HKObjectType.workoutType(), HKSeriesType.workoutRoute()]
    }

    // ── Authorisation ──

    func requestAuthorization() async {
        guard HKHealthStore.isHealthDataAvailable() else {
            phase = .failed("Health data is not available on this device")
            return
        }
        phase = .requestingAuthorization
        do {
            try await healthStore.requestAuthorization(toShare: typesToShare, read: typesToRead)
            await loadRestingHeartRate()
            phase = .idle
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Resting heart rate feeds the fallback zone maths only. Apple's own zones,
    /// when present, are used exactly as they are.
    private func loadRestingHeartRate() async {
        let query = HKSampleQueryDescriptor(
            predicates: [.quantitySample(type: HKQuantityType(.restingHeartRate))],
            sortDescriptors: [SortDescriptor(\.endDate, order: .reverse)],
            limit: 1
        )
        do {
            guard let sample = try await query.result(for: healthStore).first else { return }
            let bpm = HKUnit.count().unitDivided(by: .minute())
            settings.restingHeartRate = sample.quantity.doubleValue(for: bpm)
            settings.save()
        } catch {
            log.debug("no resting heart rate available: \(error.localizedDescription, privacy: .public)")
        }
    }

    // ── Start / stop ──

    func start(activity: Snapshot.Activity = .running, indoor: Bool = false) async {
        guard session == nil else { return }
        phase = .starting
        self.activity = activity
        self.indoor = indoor
        self.workoutId = UUID().uuidString
        self.seq = 0
        resetMetrics()

        let configuration = HKWorkoutConfiguration()
        configuration.activityType = Self.hkActivity(activity)
        configuration.locationType = indoor ? .indoor : .outdoor

        do {
            let session = try HKWorkoutSession(healthStore: healthStore, configuration: configuration)
            let builder = session.associatedWorkoutBuilder()
            let dataSource = HKLiveWorkoutDataSource(healthStore: healthStore, workoutConfiguration: configuration)
            // Apple's default set for running already covers distance, energy,
            // heart rate and speed; the form metrics are opt-in.
            for type in Self.runningFormTypes {
                dataSource.enableCollection(for: type, predicate: nil)
            }
            builder.dataSource = dataSource
            session.delegate = self
            builder.delegate = self

            self.session = session
            self.builder = builder

            if !indoor { startRoute() }

            // Zones must be arranged before collection starts.
            if #available(watchOS 27.0, *) {
                zoneSource = await ZoneReader.prepare(
                    builder: builder,
                    maxHeartRate: settings.maxHeartRate,
                    restingHeartRate: settings.restingHeartRate
                )
                log.info("zone source: \(self.zoneSource?.rawValue ?? "none", privacy: .public)")
            }

            let start = Date()
            session.startActivity(with: start)
            try await builder.beginCollection(at: start)

            // Mirroring gives the iPhone live data and, just as importantly,
            // background runtime for the length of the workout.
            do {
                try await session.startMirroringToCompanionDevice()
                mirroring = true
            } catch {
                mirroring = false
                log.warning("mirroring unavailable, watch will reach the relay itself: \(error.localizedDescription, privacy: .public)")
            }

            phase = .running
            startPushing()
        } catch {
            phase = .failed(error.localizedDescription)
            session = nil
            builder = nil
        }
    }

    func pause() {
        session?.pause()
    }

    func resume() {
        session?.resume()
    }

    func end() async {
        guard let session, let builder else { return }
        phase = .ending
        stopPushing()
        stopRoute()
        session.end()
        do {
            try await builder.endCollection(at: Date())
            try await builder.addMetadata([HKMetadataKeyIndoorWorkout: indoor])
            let workout = try await builder.finishWorkout()
            // The route has to be attached to the saved workout, so it comes last.
            if let workout, let routeBuilder, routePoints > 0 {
                do {
                    try await routeBuilder.finishRoute(with: workout, metadata: nil)
                    log.info("route saved: \(self.routePoints) points")
                } catch {
                    log.error("saving the route failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        } catch {
            log.error("finishing the workout failed: \(error.localizedDescription, privacy: .public)")
        }
        routeBuilder = nil
        // One last reading, so the glasses show 'ended' rather than freezing on
        // the last live value.
        seq += 1
        snapshot = buildSnapshot(state: .ended)
        await push(snapshot)
        self.session = nil
        self.builder = nil
        phase = .idle
    }

    private func resetMetrics() {
        heartRate = nil
        distance = nil
        energy = nil
        speed = nil
        steps = nil
        zones = nil
        mirrorConfirmedAt = nil
        lastDistanceValue = nil
        lastDistanceMovedAt = nil
        autoPaused = false
        routePoints = 0
    }

    // ── Route ──

    private func startRoute() {
        routeBuilder = HKWorkoutRouteBuilder(healthStore: healthStore, device: nil)
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        locationManager.activityType = .fitness
        locationManager.allowsBackgroundLocationUpdates = true
        if locationManager.authorizationStatus == .notDetermined {
            locationManager.requestWhenInUseAuthorization()
        }
        locationManager.startUpdatingLocation()
    }

    private func stopRoute() {
        locationManager.stopUpdatingLocation()
    }

    // ── Auto-pause ──

    /// Outdoors only, matching the Workout app's default. Six seconds without the
    /// distance moving pauses; the next few metres resume. The pause and resume
    /// land in the workout as events, so Fitness shows them.
    private func evaluateAutoPause(now: Date = Date()) {
        guard settings.autoPause, !indoor, let session else { return }
        guard let distance else { return }

        if let last = lastDistanceValue, distance - last >= Self.autoPauseMinMove {
            lastDistanceValue = distance
            lastDistanceMovedAt = now
            if autoPaused, session.state == .paused {
                session.resume()
                autoPaused = false
                log.info("auto-resume")
            }
            return
        }
        if lastDistanceValue == nil { lastDistanceValue = distance; lastDistanceMovedAt = now; return }

        if session.state == .running, let movedAt = lastDistanceMovedAt,
           now.timeIntervalSince(movedAt) >= Self.autoPauseAfter {
            session.pause()
            autoPaused = true
            log.info("auto-pause")
        }
    }

    // ── Pushing ──

    private func startPushing() {
        stopPushing()
        let timer = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in await self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        pushTimer = timer
    }

    private func stopPushing() {
        pushTimer?.invalidate()
        pushTimer = nil
    }

    private func tick() async {
        guard let session else { return }
        evaluateAutoPause()
        let state: Snapshot.State
        switch session.state {
        case .running: state = .running
        case .paused, .prepared: state = .paused
        case .ended, .stopped: state = .ended
        default: state = .idle
        }
        seq += 1
        snapshot = buildSnapshot(state: state)
        await push(snapshot)
    }

    private func buildSnapshot(state: Snapshot.State) -> Snapshot {
        let elapsed = builder?.elapsedTime(at: Date()) ?? 0
        let cadence: Double? = {
            guard let steps, elapsed > 30 else { return nil }
            return steps / (elapsed / 60)
        }()
        return Snapshot(
            seq: seq,
            workoutId: workoutId,
            state: state,
            activity: activity,
            indoor: indoor,
            elapsed: elapsed,
            distance: distance,
            heartRate: heartRate,
            energy: energy,
            paceSecPerKm: Snapshot.pace(fromSpeed: speed) ?? Snapshot.pace(distance: distance, elapsed: elapsed),
            cadence: cadence,
            zones: zones
        )
    }

    /// Straight across the mirroring channel when the phone is listening;
    /// otherwise the watch reaches the relay itself, so a phone left at home
    /// does not mean a blank HUD.
    private func push(_ snapshot: Snapshot) async {
        guard let data = snapshot.jsonData else { return }

        if mirroring, let session {
            do {
                try await session.sendToRemoteWorkoutSession(data: data)
                mirrorConfirmedAt = Date()
                return
            } catch {
                log.debug("mirror send failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        // Either mirroring never started, or it has stopped answering.
        let recentlyMirrored = mirrorConfirmedAt.map { Date().timeIntervalSince($0) < 5 } ?? false
        if !recentlyMirrored {
            await cloud.post(snapshot, settings: settings)
        }
    }

    private static func hkActivity(_ activity: Snapshot.Activity) -> HKWorkoutActivityType {
        switch activity {
        case .running: return .running
        case .walking: return .walking
        case .cycling: return .cycling
        case .hiking: return .hiking
        case .other: return .other
        }
    }
}

// ── Location delegate: the route ──

extension WorkoutManager: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        // The Workout app is equally picky: a fix worse than 50 m draws a route
        // that wanders through buildings.
        let usable = locations.filter { $0.horizontalAccuracy > 0 && $0.horizontalAccuracy <= 50 }
        guard !usable.isEmpty else { return }
        Task { @MainActor in
            guard let routeBuilder else { return }
            do {
                try await routeBuilder.insertRouteData(usable)
                routePoints += usable.count
            } catch {
                log.debug("route insert failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            log.debug("location: \(error.localizedDescription, privacy: .public)")
        }
    }
}

// ── Session delegate ──

extension WorkoutManager: HKWorkoutSessionDelegate {
    nonisolated func workoutSession(
        _ workoutSession: HKWorkoutSession,
        didChangeTo toState: HKWorkoutSessionState,
        from fromState: HKWorkoutSessionState,
        date: Date
    ) {
        Task { @MainActor in
            switch toState {
            case .running: phase = .running
            case .paused: phase = .paused
            case .ended, .stopped: phase = .idle
            default: break
            }
            await tick()
        }
    }

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        Task { @MainActor in
            phase = .failed(error.localizedDescription)
            stopPushing()
        }
    }
}

// ── Builder delegate ──

extension WorkoutManager: HKLiveWorkoutBuilderDelegate {
    nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}

    nonisolated func workoutBuilder(
        _ workoutBuilder: HKLiveWorkoutBuilder,
        didCollectDataOf collectedTypes: Set<HKSampleType>
    ) {
        // Snapshot the values on this thread, then hand them to the main actor.
        var newHeartRate: Double?
        var newDistance: Double?
        var newEnergy: Double?
        var newSpeed: Double?
        var newSteps: Double?

        let bpm = HKUnit.count().unitDivided(by: .minute())

        for type in collectedTypes {
            guard let quantityType = type as? HKQuantityType,
                  let statistics = workoutBuilder.statistics(for: quantityType)
            else { continue }

            switch quantityType {
            case HKQuantityType(.heartRate):
                newHeartRate = statistics.mostRecentQuantity()?.doubleValue(for: bpm)
            case HKQuantityType(.distanceWalkingRunning):
                newDistance = statistics.sumQuantity()?.doubleValue(for: .meter())
            case HKQuantityType(.activeEnergyBurned):
                newEnergy = statistics.sumQuantity()?.doubleValue(for: .kilocalorie())
            case HKQuantityType(.stepCount):
                newSteps = statistics.sumQuantity()?.doubleValue(for: .count())
            case HKQuantityType(.runningSpeed):
                newSpeed = statistics.mostRecentQuantity()?
                    .doubleValue(for: HKUnit.meter().unitDivided(by: .second()))
            default:
                break
            }
        }

        Task { @MainActor in
            if let newHeartRate { heartRate = newHeartRate }
            if let newDistance { distance = newDistance }
            if let newEnergy { energy = newEnergy }
            if let newSpeed { speed = newSpeed }
            if let newSteps { steps = newSteps }
        }
    }

    /// HealthKit's own zone totals. Taken verbatim — see ZoneReader.
    @available(watchOS 27.0, *)
    nonisolated func workoutBuilder(
        _ workoutBuilder: HKLiveWorkoutBuilder,
        didUpdateWorkoutZone zoneUpdate: HKLiveWorkoutZoneUpdate
    ) {
        Task { @MainActor in
            let source = zoneSource ?? .apple
            if let mapped = ZoneReader.snapshotZones(from: zoneUpdate, source: source) {
                zones = mapped
            }
        }
    }
}
