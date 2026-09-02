import Charts
import SwiftUI

/// Every workout Health has, newest first. Ours are marked; they carry a trace.
struct HistoryView: View {
    @EnvironmentObject private var history: HistoryStore
    @EnvironmentObject private var receiver: MirrorReceiver

    private var miles: Bool { receiver.settings.useMiles }

    var body: some View {
        NavigationStack {
            Group {
                if history.workouts.isEmpty && !history.loading {
                    emptyState
                } else {
                    list
                }
            }
            .background(Theme.ground.ignoresSafeArea())
            .navigationTitle("History")
            .toolbarColorScheme(.dark, for: .navigationBar)
            .refreshable { await history.refresh() }
        }
        .task { if history.workouts.isEmpty { await history.refresh() } }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            if let problem = history.problem {
                Text(problem).font(.mono(12)).foregroundStyle(Theme.warn)
            } else {
                Text("No workouts").font(.mono(13)).foregroundStyle(Theme.ink3)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var list: some View {
        List {
            ForEach(grouped, id: \.month) { section in
                Section {
                    ForEach(section.items) { item in
                        NavigationLink(value: item) {
                            HistoryRow(summary: item, miles: miles)
                        }
                        .listRowBackground(Theme.panel)
                        .listRowSeparatorTint(Theme.edge)
                    }
                } header: {
                    Text(section.month.uppercased())
                        .font(.label())
                        .tracking(1.3)
                        .foregroundStyle(Theme.ink3)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationDestination(for: WorkoutSummary.self) { summary in
            WorkoutDetailView(summary: summary)
        }
    }

    private struct MonthGroup { let month: String; let items: [WorkoutSummary] }

    private var grouped: [MonthGroup] {
        let style = Date.FormatStyle().month(.wide).year()
        var order: [String] = []
        var buckets: [String: [WorkoutSummary]] = [:]
        for w in history.workouts {
            let key = style.format(w.start)
            if buckets[key] == nil { order.append(key) }
            buckets[key, default: []].append(w)
        }
        return order.map { MonthGroup(month: $0, items: buckets[$0] ?? []) }
    }
}

extension WorkoutSummary: Hashable {
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

// MARK: - Row

struct HistoryRow: View {
    let summary: WorkoutSummary
    let miles: Bool

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 1) {
                Text(summary.start, format: .dateTime.day())
                    .font(.system(size: 20, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(Theme.ink)
                Text(summary.start, format: .dateTime.weekday(.abbreviated))
                    .font(.label(10))
                    .foregroundStyle(Theme.ink3)
            }
            .frame(width: 40, alignment: .leading)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Image(systemName: summary.symbol)
                        .font(.system(size: 12))
                        .foregroundStyle(summary.traceId != nil ? Theme.live : Theme.ink2)
                    Text(summary.activityName)
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.ink)
                    if summary.traceId != nil {
                        Text("SPLITGLASS")
                            .font(.label(8.5))
                            .tracking(1)
                            .foregroundStyle(Theme.live)
                    }
                }
                Text("\(Format.distance(summary.distance, miles: miles)) \(Format.distanceUnit(miles: miles)) · \(Format.duration(summary.duration))")
                    .font(.mono(12))
                    .monospacedDigit()
                    .foregroundStyle(Theme.ink2)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 3) {
                Text(Format.pace(summary.paceSecPerKm, miles: miles))
                    .font(.system(size: 17, weight: .medium, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(Theme.ink)
                Text(summary.avgHeartRate.map { "\(Int($0)) bpm" } ?? "—")
                    .font(.mono(11))
                    .foregroundStyle(Theme.ink3)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Detail

struct WorkoutDetailView: View {
    let summary: WorkoutSummary
    @EnvironmentObject private var history: HistoryStore
    @EnvironmentObject private var receiver: MirrorReceiver
    @State private var detail: WorkoutDetail?

    private var miles: Bool { receiver.settings.useMiles }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                summaryCard
                if let detail {
                    if !detail.zones.isEmpty { zonesCard(detail) }
                    if !detail.heartRate.isEmpty { heartRateCard(detail) }
                    if !detail.pace.isEmpty { paceCard(detail) }
                } else {
                    ProgressView().tint(Theme.live).padding(.top, 24)
                }
            }
            .padding(16)
        }
        .background(Theme.ground.ignoresSafeArea())
        .navigationTitle(summary.start.formatted(Format.day))
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task { detail = await history.detail(for: summary, settings: receiver.settings) }
    }

    private var summaryCard: some View {
        Card(title: summary.activityName, trailing: "\(summary.start.formatted(Format.time)) · \(summary.source)") {
            TileGrid(tiles: [
                Tile(label: "Distance", value: Format.distance(summary.distance, miles: miles), unit: Format.distanceUnit(miles: miles)),
                Tile(label: "Time", value: Format.duration(summary.duration)),
                Tile(label: "Avg pace", value: Format.pace(summary.paceSecPerKm, miles: miles), unit: Format.paceUnit(miles: miles)),
                Tile(label: "Avg HR", value: Format.bpm(summary.avgHeartRate), unit: "bpm"),
                Tile(label: "Energy", value: Format.kcal(summary.energy), unit: "kcal"),
                Tile(label: "Where", value: summary.indoor ? "Indoor" : "Outdoor", live: false),
            ], columns: 3)
        }
    }

    private func zonesCard(_ d: WorkoutDetail) -> some View {
        Card(title: "Zones", trailing: d.zonesSource) {
            ZoneBar(durations: d.zones.map(\.seconds))
            VStack(spacing: 6) {
                ForEach(d.zones) { z in
                    HStack {
                        Text("Z\(z.index + 1)").font(.mono(12)).foregroundStyle(Theme.zone(z.index, of: d.zones.count))
                        Text(z.range).font(.mono(12)).foregroundStyle(Theme.ink3)
                        Spacer()
                        Text(Format.duration(z.seconds)).font(.mono(12)).monospacedDigit().foregroundStyle(Theme.ink2)
                        Text("\(Int((z.seconds / max(1, d.zones.map(\.seconds).reduce(0, +)) * 100).rounded()))%")
                            .font(.mono(11)).monospacedDigit().foregroundStyle(Theme.ink3)
                            .frame(width: 40, alignment: .trailing)
                    }
                }
            }
        }
    }

    private func heartRateCard(_ d: WorkoutDetail) -> some View {
        let values = d.heartRate.map(\.bpm)
        let lo = max(40, (values.min() ?? 60) - 10)
        let hi = (values.max() ?? 180) + 10
        return Card(title: "Heart rate", trailing: "bpm") {
            Chart {
                ForEach(Array(d.zoneBoundaries.enumerated()), id: \.offset) { _, b in
                    RuleMark(y: .value("zone", b))
                        .lineStyle(StrokeStyle(lineWidth: 0.5, dash: [3, 3]))
                        .foregroundStyle(Theme.edge)
                }
                ForEach(d.heartRate) { p in
                    LineMark(x: .value("min", p.t / 60), y: .value("bpm", p.bpm))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(Theme.live)
                        .lineStyle(StrokeStyle(lineWidth: 1.5))
                }
            }
            .chartYScale(domain: lo...hi)
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 6)) { v in
                AxisGridLine().foregroundStyle(Theme.edge)
                AxisValueLabel().font(.mono(10)).foregroundStyle(Theme.ink3)
            } }
            .chartYAxis { AxisMarks(position: .leading) { _ in
                AxisGridLine().foregroundStyle(Theme.edge)
                AxisValueLabel().font(.mono(10)).foregroundStyle(Theme.ink3)
            } }
            .frame(height: 170)
        }
    }

    private func paceCard(_ d: WorkoutDetail) -> some View {
        let factor = miles ? 1.609344 : 1.0
        return Card(title: "Pace", trailing: "min\(Format.paceUnit(miles: miles)) · from the glasses") {
            Chart(d.pace) { p in
                LineMark(x: .value("min", p.t / 60), y: .value("pace", p.secPerKm * factor / 60))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(Theme.ink2)
                    .lineStyle(StrokeStyle(lineWidth: 1.5))
            }
            // Faster is up: a smaller minutes-per-unit figure sits higher.
            .chartYScale(domain: .automatic(includesZero: false, reversed: true))
            .chartYAxis { AxisMarks(position: .leading) { v in
                AxisGridLine().foregroundStyle(Theme.edge)
                AxisValueLabel {
                    if let m = v.as(Double.self) {
                        Text(Format.pace(m * 60 / factor, miles: miles)).font(.mono(10)).foregroundStyle(Theme.ink3)
                    }
                }
            } }
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 6)) { _ in
                AxisGridLine().foregroundStyle(Theme.edge)
                AxisValueLabel().font(.mono(10)).foregroundStyle(Theme.ink3)
            } }
            .frame(height: 150)
        }
    }
}
