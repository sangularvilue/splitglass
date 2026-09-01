import Foundation

/// The wire contract with the glasses plugin.
///
/// Keep this in step with `src/types.ts`. The keys are deliberately short: this
/// goes out about once a second and may be crossing a cellular link.
///
/// Everything here originates in HealthKit on the watch, which is the whole
/// point — the numbers are identical indoors and out, and the zones are the
/// user's own zones rather than anything this app invented.
struct Snapshot: Codable, Equatable {
    enum State: String, Codable { case idle, running, paused, ended }
    enum Activity: String, Codable { case running, walking, cycling, hiking, other }

    struct Zones: Codable, Equatable {
        enum Source: String, Codable {
            /// The user's own zones out of Health — same as the Fitness app.
            case apple
            /// Our fallback, when HealthKit has no preferred configuration.
            case computed
        }

        var source: Source
        var count: Int
        var currentIndex: Int?
        /// Upper bounds in bpm, `count - 1` of them. May be empty when the
        /// boundaries could not be read; the glasses then show zone labels and
        /// durations without bpm ranges.
        var boundaries: [Double]
        /// Seconds accumulated in each zone, `count` of them.
        var durations: [Double]
    }

    let v: Int
    var seq: Int
    var at: Double
    var workoutId: String
    var state: State
    var activity: Activity
    var indoor: Bool
    var elapsed: Double
    var distance: Double?
    var heartRate: Double?
    var energy: Double?
    var paceSecPerKm: Double?
    var cadence: Double?
    var zones: Zones?

    init(
        seq: Int,
        workoutId: String,
        state: State,
        activity: Activity,
        indoor: Bool,
        elapsed: Double,
        distance: Double? = nil,
        heartRate: Double? = nil,
        energy: Double? = nil,
        paceSecPerKm: Double? = nil,
        cadence: Double? = nil,
        zones: Zones? = nil,
        at: Date = Date()
    ) {
        self.v = 1
        self.seq = seq
        self.at = at.timeIntervalSince1970 * 1000
        self.workoutId = workoutId
        self.state = state
        self.activity = activity
        self.indoor = indoor
        self.elapsed = elapsed
        self.distance = distance
        self.heartRate = heartRate
        self.energy = energy
        self.paceSecPerKm = paceSecPerKm
        self.cadence = cadence
        self.zones = zones
    }

    static func idle() -> Snapshot {
        Snapshot(seq: 0, workoutId: "none", state: .idle, activity: .other, indoor: false, elapsed: 0)
    }
}

extension Snapshot {
    /// Seconds per kilometre from a speed in metres per second.
    static func pace(fromSpeed metresPerSecond: Double?) -> Double? {
        guard let speed = metresPerSecond, speed > 0.3 else { return nil }
        return 1000 / speed
    }

    /// Seconds per kilometre from cumulative distance and elapsed time.
    static func pace(distance: Double?, elapsed: Double) -> Double? {
        guard let distance, distance > 20, elapsed > 5 else { return nil }
        return elapsed / distance * 1000
    }

    var jsonData: Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = []
        return try? encoder.encode(self)
    }

    static func decode(_ data: Data) -> Snapshot? {
        try? JSONDecoder().decode(Snapshot.self, from: data)
    }
}
