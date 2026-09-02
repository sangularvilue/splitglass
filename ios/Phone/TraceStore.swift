import Foundation
import os

/// The per-second readings this phone relayed, kept per workout.
///
/// HealthKit has the workout; this has what the glasses showed during it — pace,
/// heart rate and zone once a second — so History can draw the run as it was
/// run. Traces are matched to HealthKit workouts by time, not by id, because
/// HealthKit assigns its own UUID when the workout is saved.
struct TraceMeta: Codable, Identifiable, Equatable {
    let workoutId: String
    var start: Date
    var end: Date
    var count: Int
    var id: String { workoutId }
}

@MainActor
final class TraceStore {
    private let log = Logger(subsystem: "xyz.grannis.splitglass", category: "trace")
    private let directory: URL
    private(set) var index: [TraceMeta] = []

    private var currentId: String?
    private var current: [Snapshot] = []
    private var unflushed = 0

    /// Flush every so many readings, and always on `ended`, so a crash mid-run
    /// loses at most fifteen seconds.
    private static let flushEvery = 15
    private static let keepAtMost = 200

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        directory = base.appendingPathComponent("traces", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        index = loadIndex()
    }

    // MARK: Recording

    func record(_ snapshot: Snapshot) {
        if snapshot.workoutId != currentId {
            flush()
            currentId = snapshot.workoutId
            current = []
        }
        // Idle readings are heartbeat, not workout.
        guard snapshot.state != .idle else { return }
        current.append(snapshot)
        unflushed += 1
        if unflushed >= Self.flushEvery || snapshot.state == .ended { flush() }
    }

    func flush() {
        guard let id = currentId, !current.isEmpty, unflushed > 0 else { return }
        unflushed = 0
        do {
            let data = try JSONEncoder().encode(current)
            try data.write(to: fileURL(id), options: .atomic)
            let first = Date(timeIntervalSince1970: current.first!.at / 1000)
            let last = Date(timeIntervalSince1970: current.last!.at / 1000)
            upsert(TraceMeta(workoutId: id, start: first, end: last, count: current.count))
        } catch {
            log.error("trace write failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: Reading

    func load(_ id: String) -> [Snapshot] {
        guard let data = try? Data(contentsOf: fileURL(id)) else { return [] }
        return (try? JSONDecoder().decode([Snapshot].self, from: data)) ?? []
    }

    /// The trace that overlaps a HealthKit workout, if this phone relayed it.
    func trace(overlapping start: Date, _ end: Date) -> TraceMeta? {
        index.first { meta in
            meta.start <= end.addingTimeInterval(120) && meta.end >= start.addingTimeInterval(-120)
        }
    }

    func delete(_ id: String) {
        try? FileManager.default.removeItem(at: fileURL(id))
        index.removeAll { $0.workoutId == id }
        saveIndex()
    }

    // MARK: Index

    private func fileURL(_ id: String) -> URL {
        directory.appendingPathComponent("\(id).json")
    }

    private var indexURL: URL { directory.appendingPathComponent("index.json") }

    private func loadIndex() -> [TraceMeta] {
        guard let data = try? Data(contentsOf: indexURL),
              let list = try? JSONDecoder().decode([TraceMeta].self, from: data)
        else { return [] }
        return list.sorted { $0.start > $1.start }
    }

    private func upsert(_ meta: TraceMeta) {
        index.removeAll { $0.workoutId == meta.workoutId }
        index.insert(meta, at: 0)
        // Oldest traces go first; the workouts themselves stay in Health.
        while index.count > Self.keepAtMost, let oldest = index.last {
            try? FileManager.default.removeItem(at: fileURL(oldest.workoutId))
            index.removeLast()
        }
        saveIndex()
    }

    private func saveIndex() {
        if let data = try? JSONEncoder().encode(index) {
            try? data.write(to: indexURL, options: .atomic)
        }
    }
}
