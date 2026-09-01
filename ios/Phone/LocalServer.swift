import Foundation
import Network
import os

/// A very small HTTP server on 127.0.0.1, so the glasses can read the workout
/// without the reading ever leaving the phone.
///
/// This is the best transport when it is available: a few milliseconds of
/// latency, no relay, no signal required — a treadmill in a basement works
/// exactly as well as a road. Whether the plugin is *allowed* to use it depends
/// on the origin the Even app serves the plugin from: a page loaded over https
/// cannot open a plain-http connection, so the plugin probes this and quietly
/// falls back to the relay when the probe is blocked. Nothing here needs to know
/// which happened.
///
/// Two routes, both read-only:
///   GET /health  → {"ok":true}
///   GET /state   → {"snapshot":{...}}
final class LocalServer {
    private let log = Logger(subsystem: "xyz.grannis.splitglass", category: "local")
    private let queue = DispatchQueue(label: "xyz.grannis.splitglass.local")
    private var listener: NWListener?
    private let bodyProvider: () -> Data

    private(set) var isRunning = false

    /// `bodyProvider` is called on every request, so the server never holds a
    /// stale copy of the snapshot.
    init(bodyProvider: @escaping () -> Data) {
        self.bodyProvider = bodyProvider
    }

    func start(port: UInt16 = RelayConfig.localPort) {
        guard listener == nil else { return }
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        // Loopback only: this must not be reachable from the network the phone
        // happens to be on.
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .init(rawValue: port)!)

        do {
            let listener = try NWListener(using: parameters)
            listener.newConnectionHandler = { [weak self] connection in
                self?.handle(connection)
            }
            listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    self.isRunning = true
                    self.log.info("local server listening on 127.0.0.1:\(port)")
                case .failed(let error):
                    self.isRunning = false
                    self.log.error("local server failed: \(error.localizedDescription, privacy: .public)")
                case .cancelled:
                    self.isRunning = false
                default:
                    break
                }
            }
            listener.start(queue: queue)
            self.listener = listener
        } catch {
            log.error("local server could not start: \(error.localizedDescription, privacy: .public)")
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        isRunning = false
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, _, _ in
            guard let self else { connection.cancel(); return }
            let request = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let response = self.response(for: request)
            connection.send(content: response, completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }

    private func response(for request: String) -> Data {
        // First line only: "GET /state HTTP/1.1".
        let path = request
            .split(separator: "\r\n", maxSplits: 1, omittingEmptySubsequences: false)
            .first?
            .split(separator: " ")
            .dropFirst()
            .first
            .map(String.init) ?? "/"

        switch path {
        case "/health":
            return Self.http(status: "200 OK", body: Data(#"{"ok":true,"app":"splitglass"}"#.utf8))
        case "/state":
            return Self.http(status: "200 OK", body: bodyProvider())
        default:
            return Self.http(status: "404 Not Found", body: Data(#"{"error":"no such route"}"#.utf8))
        }
    }

    private static func http(status: String, body: Data) -> Data {
        // The plugin may be running from a different origin, so the permissive
        // CORS header is not optional. This only ever serves loopback, and only
        // ever the current workout reading.
        let headers = """
        HTTP/1.1 \(status)\r
        Content-Type: application/json\r
        Content-Length: \(body.count)\r
        Cache-Control: no-store\r
        Access-Control-Allow-Origin: *\r
        Connection: close\r
        \r

        """
        return Data(headers.utf8) + body
    }
}
