import HealthKit

/// Reading zone boundaries back out of a configuration, in beats per minute.
///
/// `HKWorkoutZoneConfiguration` is created from `zoneBoundaries` and reads back
/// the same way. If a future SDK renames this, it is the one line in the project
/// to change: the watch uses it while recording, the phone uses it for history,
/// and both tolerate an empty result by showing zones without bpm ranges.
enum ZoneConfigurationReading {
    @available(watchOS 27.0, iOS 27.0, *)
    static func boundaries(of configuration: HKWorkoutZoneConfiguration) -> [Double] {
        let bpm = HKUnit.count().unitDivided(by: .minute())
        return configuration.zoneBoundaries.map { $0.doubleValue(for: bpm) }
    }
}
