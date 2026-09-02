import SwiftUI

/// Graphite ground, one accent — the glasses' own phosphor green — spent only on
/// numbers that are live or that came off the wrist. Matches the web companion.
enum Theme {
    static let ground  = Color(red: 0.078, green: 0.090, blue: 0.102)
    static let panel   = Color(red: 0.106, green: 0.125, blue: 0.141)
    static let panel2  = Color(red: 0.137, green: 0.165, blue: 0.184)
    static let edge    = Color(red: 0.180, green: 0.216, blue: 0.239)
    static let ink     = Color(red: 0.906, green: 0.922, blue: 0.910)
    static let ink2    = Color(red: 0.655, green: 0.694, blue: 0.678)
    static let ink3    = Color(red: 0.435, green: 0.478, blue: 0.463)
    static let live    = Color(red: 0.490, green: 0.878, blue: 0.478)
    static let liveDim = Color(red: 0.247, green: 0.478, blue: 0.243)
    static let warn    = Color(red: 0.878, green: 0.706, blue: 0.353)
    static let bad     = Color(red: 0.878, green: 0.541, blue: 0.431)

    /// Zones climb from dim to full green, so the ramp reads as effort.
    /// (Opacity rather than Color.mix, which needs iOS 18.)
    static func zone(_ index: Int, of count: Int) -> Color {
        let t = count <= 1 ? 1.0 : Double(index) / Double(count - 1)
        return live.opacity(0.35 + 0.65 * t)
    }
}

// MARK: - Type

extension Font {
    static func label(_ size: CGFloat = 10.5) -> Font {
        .system(size: size, weight: .semibold, design: .monospaced)
    }

    static func value(_ size: CGFloat = 26) -> Font {
        .system(size: size, weight: .medium, design: .rounded)
    }

    static func mono(_ size: CGFloat = 13) -> Font {
        .system(size: size, design: .monospaced)
    }
}

// MARK: - Components

/// A rounded panel. Border rather than shadow: this is an instrument, not a card.
struct Card<Content: View>: View {
    var title: String? = nil
    var trailing: String? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if title != nil || trailing != nil {
                HStack(alignment: .firstTextBaseline) {
                    if let title {
                        Text(title.uppercased())
                            .font(.label())
                            .tracking(1.3)
                            .foregroundStyle(Theme.ink3)
                    }
                    Spacer()
                    if let trailing {
                        Text(trailing)
                            .font(.mono(11))
                            .foregroundStyle(Theme.ink3)
                    }
                }
            }
            content()
        }
        .padding(14)
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.edge))
    }
}

/// Label above, value below. Tabular digits, so a column of them stays a column.
struct Tile: View {
    let label: String
    let value: String
    var unit: String = ""
    var live = true

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .font(.label())
                .tracking(1.2)
                .foregroundStyle(Theme.ink3)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(.value())
                    .monospacedDigit()
                    .foregroundStyle(live ? Theme.live : Theme.ink)
                if !unit.isEmpty {
                    Text(unit)
                        .font(.mono(11))
                        .foregroundStyle(Theme.ink3)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .background(Theme.panel)
    }
}

/// A grid of tiles separated by hairlines — the same `1px gap on an edge-coloured
/// ground` trick the web companion uses.
struct TileGrid: View {
    let tiles: [Tile]
    var columns = 2

    var body: some View {
        let rows = stride(from: 0, to: tiles.count, by: columns).map { Array(tiles[$0..<min($0 + columns, tiles.count)]) }
        VStack(spacing: 1) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 1) {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, tile in tile }
                    if row.count < columns {
                        ForEach(0..<(columns - row.count), id: \.self) { _ in
                            Color.clear.frame(maxWidth: .infinity)
                        }
                    }
                }
            }
        }
        .background(Theme.edge)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.edge))
    }
}

struct StatusRow: View {
    let label: String
    let ok: Bool
    let detail: String

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(ok ? Theme.live : Theme.warn)
                .frame(width: 8, height: 8)
            Text(label)
                .foregroundStyle(Theme.ink)
            Spacer()
            Text(detail)
                .font(.mono(12))
                .foregroundStyle(Theme.ink3)
                .lineLimit(1)
        }
        .font(.system(size: 15))
    }
}

/// Time in each zone as one segmented bar, plus a legend row of durations.
struct ZoneBar: View {
    let durations: [Double]
    var current: Int? = nil

    private var total: Double { max(1, durations.reduce(0, +)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            GeometryReader { geo in
                HStack(spacing: 1) {
                    ForEach(Array(durations.enumerated()), id: \.offset) { i, d in
                        Rectangle()
                            .fill(Theme.zone(i, of: durations.count))
                            .frame(width: max(d > 0 ? 2 : 0, geo.size.width * d / total))
                            .overlay(alignment: .top) {
                                if i == current {
                                    Rectangle().fill(Theme.ink).frame(height: 2)
                                }
                            }
                    }
                    Spacer(minLength: 0)
                }
            }
            .frame(height: 12)
            .clipShape(RoundedRectangle(cornerRadius: 2))

            HStack(spacing: 0) {
                ForEach(Array(durations.enumerated()), id: \.offset) { i, d in
                    VStack(spacing: 1) {
                        Text("Z\(i + 1)")
                            .font(.label(10))
                            .foregroundStyle(i == current ? Theme.live : Theme.ink3)
                        Text(Format.duration(d))
                            .font(.mono(11))
                            .monospacedDigit()
                            .foregroundStyle(Theme.ink2)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }
}

// MARK: - Formatting

enum Format {
    static func duration(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded()))
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }

    static func distance(_ metres: Double?, miles: Bool) -> String {
        guard let metres else { return "—" }
        return String(format: "%.2f", miles ? metres / 1609.344 : metres / 1000)
    }

    static func distanceUnit(miles: Bool) -> String { miles ? "mi" : "km" }

    /// Seconds per kilometre → `7:38`, in the unit the user reads.
    static func pace(_ secPerKm: Double?, miles: Bool) -> String {
        guard let secPerKm, secPerKm > 0, secPerKm < 3600 else { return "—" }
        let per = miles ? secPerKm * 1.609344 : secPerKm
        let m = Int(per / 60), s = Int((per - Double(m) * 60).rounded())
        return s == 60 ? "\(m + 1):00" : String(format: "%d:%02d", m, s)
    }

    static func paceUnit(miles: Bool) -> String { miles ? "/mi" : "/km" }

    static func pace(distance: Double?, seconds: Double) -> Double? {
        guard let distance, distance > 20, seconds > 5 else { return nil }
        return seconds / distance * 1000
    }

    static func bpm(_ value: Double?) -> String {
        guard let value else { return "—" }
        return String(Int(value.rounded()))
    }

    static func kcal(_ value: Double?) -> String {
        guard let value else { return "—" }
        return String(Int(value.rounded()))
    }

    static let day: Date.FormatStyle = .dateTime.weekday(.abbreviated).day().month(.abbreviated)
    static let time: Date.FormatStyle = .dateTime.hour().minute()
}
