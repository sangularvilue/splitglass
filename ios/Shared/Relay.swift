import Foundation
import os

/// Where the glasses look for readings.
///
/// The plugin tries the phone itself first (`http://127.0.0.1:8734`) and the
/// cloud relay second, so this app tries to satisfy both: it always serves the
/// latest snapshot locally, and it posts to the relay as well unless the user
/// has switched that off. Local costs nothing and works with no signal; the
/// relay is what makes it work when the plugin's own origin will not let it open
/// a plain-http connection.
enum RelayConfig {
    static let localPort: UInt16 = 8734
    static let defaultBaseURL = URL(string: "https://pace.grannis.xyz")!
    /// Readings older than this are not worth posting; the run is over.
    static let staleAfter: TimeInterval = 30
}

/// User-facing settings, shared between the phone and (via WatchConnectivity)
/// the watch.
struct PaceRailSettings: Codable, Equatable {
    /// Six characters from the plugin's Pair card.
    var pairCode: String = ""
    /// Post to the cloud relay as well as serving locally.
    var useCloudRelay: Bool = true
    var baseURL: URL = RelayConfig.defaultBaseURL
    /// Fallback zones only: ignored whenever HealthKit has the user's own.
    var maxHeartRate: Double = 185
    var restingHeartRate: Double = 55

    static let storageKey = "pacerail.settings"

    static func load(from defaults: UserDefaults = .standard) -> PaceRailSettings {
        guard let data = defaults.data(forKey: storageKey),
              let decoded = try? JSONDecoder().decode(PaceRailSettings.self, from: data)
        else { return PaceRailSettings() }
        return decoded
    }

    func save(to defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.storageKey)
    }

    var isPaired: Bool { pairCode.count == 6 }
}

/// Posts snapshots to the cloud relay.
///
/// Fire-and-forget with a short timeout: a run must never be held up by the
/// network, and a dropped reading is replaced by the next one a second later.
/// One request at a time, so a slow link cannot build a backlog.
actor CloudRelay {
    private let log = Logger(subsystem: "xyz.grannis.pacerail", category: "relay")
    private var inFlight = false
    private(set) var lastError: String?
    private(set) var lastPostedSeq: Int = -1

    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 4
        config.waitsForConnectivity = false
        config.allowsExpensiveNetworkAccess = true
        config.allowsConstrainedNetworkAccess = true
        return URLSession(configuration: config)
    }()

    func post(_ snapshot: Snapshot, settings: PaceRailSettings) async {
        guard settings.useCloudRelay, settings.isPaired else { return }
        guard !inFlight else { return }

        var request = URLRequest(url: settings.baseURL.appendingPathComponent("api/push"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        struct Envelope: Encodable {
            let code: String
            let snapshot: Snapshot
        }
        guard let body = try? JSONEncoder().encode(Envelope(code: settings.pairCode, snapshot: snapshot)) else { return }
        request.httpBody = body

        inFlight = true
        defer { inFlight = false }

        do {
            let (_, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                lastError = "relay HTTP \(http.statusCode)"
                log.warning("relay rejected snapshot: \(http.statusCode)")
            } else {
                lastError = nil
                lastPostedSeq = snapshot.seq
            }
        } catch {
            lastError = error.localizedDescription
            log.debug("relay post failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}

/// The one snapshot everything reads: the local HTTP server serves it, the
/// cloud relay posts it, and the UI shows it.
@MainActor
final class SnapshotStore: ObservableObject {
    @Published private(set) var latest: Snapshot?
    @Published private(set) var updatedAt: Date?

    /// Bumped by whoever produces snapshots, so a replay cannot go backwards.
    func accept(_ snapshot: Snapshot) {
        if let current = latest, current.workoutId == snapshot.workoutId, snapshot.seq <= current.seq {
            return
        }
        latest = snapshot
        updatedAt = Date()
    }

    var isFresh: Bool {
        guard let updatedAt else { return false }
        return Date().timeIntervalSince(updatedAt) < RelayConfig.staleAfter
    }

    var jsonBody: Data {
        struct Body: Encodable {
            let snapshot: Snapshot?
            let servedAt: Double
        }
        let body = Body(snapshot: latest, servedAt: Date().timeIntervalSince1970 * 1000)
        return (try? JSONEncoder().encode(body)) ?? Data("{\"snapshot\":null}".utf8)
    }
}
