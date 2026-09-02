import Foundation
import HealthKit
import os

/// Past workouts, out of Health.
///
/// Every run the watch has recorded — ours or the Workout app's — with the same
/// distance, energy and heart rate Fitness shows, because it is the same data.
/// When this phone relayed a workout, the per-second trace it kept is attached,
/// so the detail can also show pace and zone as they were on the glasses.
struct WorkoutSummary: Identifiable, Equatable {
    let id: UUID
    let start: Date
    let end: Date
    let activity: HKWorkoutActivityType
    let indoor: Bool
    let duration: TimeInterval
    let distance: Double?
    let energy: Double?
    let avgHeartRate: Double?
    let source: String
    let traceId: String?

    var paceSecPerKm: Double? { Format.pace(distance: distance, seconds: duration) }

    var activityName: String {
        switch activity {
        case .running: return indoor ? "Indoor run" : "Run"
        case .walking: return indoor ? "Indoor walk" : "Walk"
        case .hiking: return "Hike"
        case .cycling: return indoor ? "Indoor cycle" : "Cycle"
        default: return "Workout"
        }
    }

    var symbol: String {
        switch activity {
        case .running: return "figure.run"
        case .walking: return "figure.walk"
        case .hiking: return "figure.hiking"
        case .cycling: return "figure.outdoor.cycle"
        default: return "figure.mixed.cardio"
        }
    }

    static func == (a: WorkoutSummary, b: WorkoutSummary) -> Bool { a.id == b.id }
}

struct HeartRatePoint: Identifiable {
    var id: TimeInterval { t }
    /// Seconds from the start of the workout.
    let t: TimeInterval
    let bpm: Double
}

struct PacePoint: Identifiable {
    var id: TimeInterval { t }
    let t: TimeInterval
    let secPerKm: Double
}

struct ZoneSlice: Identifiable {
    var id: Int { index }
    let index: Int
    let seconds: Double
    let range: String
}

struct WorkoutDetail {
    let summary: WorkoutSummary
    let heartRate: [HeartRatePoint]
    let zones: [ZoneSlice]
    /// Bpm boundaries between zones, for the chart's rules.
    let zoneBoundaries: [Double]
    /// "Health" when HealthKit supplied the zones; "estimated" for our fallback.
    let zonesSource: String
    let pace: [PacePoint]
}

@MainActor
final class HistoryStore: ObservableObject {
    @Published private(set) var workouts: [WorkoutSummary] = []
    @Published private(set) var loading = false
    @Published private(set) var problem: String?

    let traces: TraceStore
    private let healthStore = HKHealthStore()
    private let log = Logger(subsystem: "xyz.grannis.splitglass", category: "history")
    private var byId: [UUID: HKWorkout] = [:]

    private static let shownActivities: Set<HKWorkoutActivityType> = [.running, .walking, .hiking, .cycling]

    init(traces: TraceStore) {
        self.traces = traces
    }

    // MARK: List

    func refresh(days: Int = 180) async {
        guard HKHealthStore.isHealthDataAvailable() else { problem = "Health unavailable"; return }
        loading = true
        defer { loading = false }

        let since = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? .distantPast
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.workout(HKQuery.predicateForSamples(withStart: since, end: nil, options: []))],
            sortDescriptors: [SortDescriptor(\.startDate, order: .reverse)],
            limit: 300
        )

        do {
            let results = try await descriptor.result(for: healthStore)
            var list: [WorkoutSummary] = []
            var map: [UUID: HKWorkout] = [:]
            for workout in results where Self.shownActivities.contains(workout.workoutActivityType) {
                map[workout.uuid] = workout
                list.append(summary(of: workout))
            }
            byId = map
            workouts = list
            problem = nil
        } catch {
            problem = error.localizedDescription
            log.error("workout query failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func summary(of workout: HKWorkout) -> WorkoutSummary {
        let bpm = HKUnit.count().unitDivided(by: .minute())
        let distanceType: HKQuantityType = workout.workoutActivityType == .cycling
            ? HKQuantityType(.distanceCycling)
            : HKQuantityType(.distanceWalkingRunning)
        let indoor = (workout.metadata?[HKMetadataKeyIndoorWorkout] as? NSNumber)?.boolValue ?? false
        return WorkoutSummary(
            id: workout.uuid,
            start: workout.startDate,
            end: workout.endDate,
            activity: workout.workoutActivityType,
            indoor: indoor,
            duration: workout.duration,
            distance: workout.statistics(for: distanceType)?.sumQuantity()?.doubleValue(for: .meter()),
            energy: workout.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity()?.doubleValue(for: .kilocalorie()),
            avgHeartRate: workout.statistics(for: HKQuantityType(.heartRate))?.averageQuantity()?.doubleValue(for: bpm),
            source: workout.sourceRevision.source.name,
            traceId: traces.trace(overlapping: workout.startDate, workout.endDate)?.workoutId
        )
    }

    // MARK: Detail

    func detail(for summary: WorkoutSummary, settings: SplitglassSettings) async -> WorkoutDetail {
        let bpmUnit = HKUnit.count().unitDivided(by: .minute())

        // Heart rate through the workout.
        var heartRate: [HeartRatePoint] = []
        let predicate = HKQuery.predicateForSamples(withStart: summary.start, end: summary.end, options: [])
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.quantitySample(type: HKQuantityType(.heartRate), predicate: predicate)],
            sortDescriptors: [SortDescriptor(\.startDate)]
        )
        if let samples = try? await descriptor.result(for: healthStore) {
            heartRate = samples.map {
                HeartRatePoint(t: $0.startDate.timeIntervalSince(summary.start), bpm: $0.quantity.doubleValue(for: bpmUnit))
            }
        }

        // Zones: Health's own when the workout carries them, else our estimate
        // from the heart-rate samples against the fallback boundaries.
        var zones: [ZoneSlice] = []
        var boundaries: [Double] = []
        var zonesSource = "estimated"

        if #available(iOS 27.0, *),
           let workout = byId[summary.id],
           let group = workout.zoneGroupsByType?[HKQuantityType(.heartRate)] {
            let count = group.configuration.zones.count
            var durations = [Double](repeating: 0, count: count)
            for entry in group.zoneDurations where entry.zone.index >= 0 && entry.zone.index < count {
                durations[entry.zone.index] = entry.duration
            }
            boundaries = ZoneConfigurationReading.boundaries(of: group.configuration)
            if boundaries.count != count - 1 { boundaries = [] }
            zones = durations.enumerated().map { i, seconds in
                ZoneSlice(index: i, seconds: seconds, range: Self.rangeLabel(boundaries, index: i, count: count))
            }
            zonesSource = "Health"
        } else if !heartRate.isEmpty {
            boundaries = Self.fallbackBoundaries(maxHeartRate: settings.maxHeartRate, restingHeartRate: settings.restingHeartRate)
            var durations = [Double](repeating: 0, count: boundaries.count + 1)
            for (i, point) in heartRate.enumerated() {
                // Each sample stands for the gap to the next one, capped so a
                // dropout does not count as ten minutes in one zone.
                let next = i + 1 < heartRate.count ? heartRate[i + 1].t : point.t + 5
                let span = min(15, max(0, next - point.t))
                durations[Self.zone(for: point.bpm, boundaries: boundaries)] += span
            }
            zones = durations.enumerated().map { i, seconds in
                ZoneSlice(index: i, seconds: seconds, range: Self.rangeLabel(boundaries, index: i, count: durations.count))
            }
        }

        // Pace, from the relayed trace if there is one, smoothed the way the
        // glasses smoothed it.
        var pace: [PacePoint] = []
        if let traceId = summary.traceId {
            let trace = traces.load(traceId)
            let origin = summary.start.timeIntervalSince1970 * 1000
            var ema: Double?
            var lastAt: Double?
            for snap in trace {
                guard let raw = snap.paceSecPerKm, raw > 0, raw < 1800 else { continue }
                if let e = ema, let l = lastAt {
                    let dt = max(0.05, min(10, (snap.at - l) / 1000))
                    ema = e + (1 - exp(-dt / 6)) * (raw - e)
                } else {
                    ema = raw
                }
                lastAt = snap.at
                pace.append(PacePoint(t: (snap.at - origin) / 1000, secPerKm: ema ?? raw))
            }
        }

        return WorkoutDetail(
            summary: summary,
            heartRate: heartRate,
            zones: zones,
            zoneBoundaries: boundaries,
            zonesSource: zonesSource,
            pace: pace
        )
    }

    // MARK: Zone maths (fallback only — the same formula ZoneReader installs on the watch)

    static func fallbackBoundaries(maxHeartRate: Double, restingHeartRate: Double) -> [Double] {
        let reserve = max(30, maxHeartRate - restingHeartRate)
        return [0.50, 0.60, 0.70, 0.80].map { (restingHeartRate + reserve * $0).rounded() }
    }

    static func zone(for bpm: Double, boundaries: [Double]) -> Int {
        for (i, b) in boundaries.enumerated() where bpm < b { return i }
        return boundaries.count
    }

    static func rangeLabel(_ boundaries: [Double], index: Int, count: Int) -> String {
        guard !boundaries.isEmpty else { return "" }
        let lower = index == 0 ? nil : boundaries[index - 1]
        let upper = index >= boundaries.count ? nil : boundaries[index]
        switch (lower, upper) {
        case (nil, let u?): return "<\(Int(u))"
        case (let l?, nil): return "\(Int(l))+"
        case (let l?, let u?): return "\(Int(l))–\(Int(u))"
        default: return ""
        }
    }
}
