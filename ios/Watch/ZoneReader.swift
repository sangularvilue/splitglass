import Foundation
import HealthKit

/// Heart-rate zones, out of HealthKit.
///
/// From iOS 27 / watchOS 27 HealthKit owns zones: `HKWorkoutZoneConfiguration`
/// carries the boundaries the user actually has (either set by hand in Health
/// Settings or computed by the system from their own heart-rate history), and
/// `HKLiveWorkoutZoneUpdate` carries the live zone and the running per-zone
/// totals. Using them is what makes the glasses agree with the Fitness app
/// afterwards, rather than showing a second opinion.
///
/// Two rules hold everywhere in this file:
///
///  1. **The user's own configuration always wins.** We only ever install a
///     configuration of our own when HealthKit has none, and when we do, the
///     snapshot is labelled `computed` so the HUD can say whose maths it is.
///  2. **HealthKit's durations are used verbatim.** We never accumulate time in
///     zone ourselves while HealthKit is doing it, because two accumulators
///     drift and then the glasses and the Fitness app disagree.
///
/// Everything is behind an availability check, so on an older OS the app simply
/// sends no zone payload and the plugin falls back to its own estimate.
enum ZoneReader {

    /// Boundaries the SDK hands back, in beats per minute.
    ///
    /// `HKWorkoutZoneConfiguration` is created from `zoneBoundaries`, and reads
    /// back the same way. If a future SDK renames this, it is the one line here
    /// to change — everything else works off `zones.count` and the durations.
    @available(watchOS 27.0, iOS 27.0, *)
    static func boundaries(of configuration: HKWorkoutZoneConfiguration) -> [Double] {
        let bpm = HKUnit.count().unitDivided(by: .minute())
        return configuration.zoneBoundaries.map { $0.doubleValue(for: bpm) }
    }

    /// Zones as computed from the wearer's own maximum and resting heart rate.
    ///
    /// Used only to give HealthKit *something* to accumulate against when the
    /// user has no preferred configuration. Boundaries sit at 50/60/70/80% of
    /// heart-rate reserve — a common convention, and explicitly not Apple's,
    /// which is why the snapshot says `computed`.
    @available(watchOS 27.0, iOS 27.0, *)
    static func fallbackConfiguration(maxHeartRate: Double, restingHeartRate: Double) -> HKWorkoutZoneConfiguration? {
        let reserve = max(30, maxHeartRate - restingHeartRate)
        let thresholds = [0.50, 0.60, 0.70, 0.80].map { restingHeartRate + reserve * $0 }
        let bpm = HKUnit.count().unitDivided(by: .minute())
        let quantities = thresholds.map { HKQuantity(unit: bpm, doubleValue: $0.rounded()) }
        return try? HKWorkoutZoneConfiguration(
            quantityType: HKQuantityType(.heartRate),
            zoneBoundaries: quantities
        )
    }

    /// Whether HealthKit already has zones for this wearer.
    ///
    /// Returns `.apple` when it does — nothing to install, the user's own
    /// configuration is already in force for this workout. Returns `.computed`
    /// after installing our fallback. Returns nil when zones are unavailable at
    /// all, in which case the plugin does its own arithmetic.
    @available(watchOS 27.0, iOS 27.0, *)
    static func prepare(
        builder: HKLiveWorkoutBuilder,
        maxHeartRate: Double,
        restingHeartRate: Double
    ) async -> Snapshot.Zones.Source? {
        let heartRate = HKQuantityType(.heartRate)

        // A custom configuration has to be installed before beginCollection, and
        // only when there is no preferred one to respect.
        do {
            if try await builder.zoneConfiguration(for: heartRate) != nil {
                return .apple
            }
        } catch {
            return nil
        }

        guard let fallback = fallbackConfiguration(maxHeartRate: maxHeartRate, restingHeartRate: restingHeartRate) else {
            return nil
        }
        do {
            try await builder.setCustomZoneConfiguration(fallback, for: heartRate)
            return .computed
        } catch {
            return nil
        }
    }

    /// Turn a live zone update into the wire shape.
    @available(watchOS 27.0, iOS 27.0, *)
    static func snapshotZones(
        from update: HKLiveWorkoutZoneUpdate,
        source: Snapshot.Zones.Source
    ) -> Snapshot.Zones? {
        guard let group = update.zoneGroup else { return nil }
        let count = group.configuration.zones.count
        guard count >= 2 else { return nil }

        // HealthKit's own totals, in the configuration's own order.
        var durations = [Double](repeating: 0, count: count)
        for entry in group.zoneDurations {
            let index = entry.zone.index
            if index >= 0 && index < count { durations[index] = entry.duration }
        }

        let bounds = boundaries(of: group.configuration)
        return Snapshot.Zones(
            source: source,
            count: count,
            currentIndex: update.currentZoneDuration?.zone.index,
            // Empty rather than wrong: the plugin shows labels and durations
            // without bpm ranges if the boundaries could not be read.
            boundaries: bounds.count == count - 1 ? bounds : [],
            durations: durations
        )
    }
}
