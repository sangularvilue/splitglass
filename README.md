# Splitglass

A live heads-up display for an Apple Watch workout on Even Realities G2 glasses.

Every number on the HUD comes from HealthKit on the watch — heart rate,
heart-rate zone, time in zone, distance, energy, elapsed time — so the display is
identical on a treadmill and on a road, and the zones are **your** zones out of
Health rather than a second opinion. GPS is used for exactly one thing, the
breadcrumb map, and that is the only part of the app a treadmill cannot feed.

```
Apple Watch ──HKWorkoutSession mirroring──▶ iPhone ──▶ loopback ──▶ Even G2
                                                   └─▶ relay ────────┘
```

## The four screens

Left temple steps back, right temple steps forward; the ring advances. Long press
opens Lap / Next screen / Restart plan / Miles-km / Close.

| | |
|---|---|
| **Run** | Distance, elapsed and heart rate at full brightness; pace, average and energy a step down; the current step of the plan across the middle; zone histogram and status at the foot. |
| **Splits** | Every finished split in a native scrolling list — number, label, time, pace, average heart rate. |
| **Zones** | Time in each zone with its bpm range, marked with where you are now. Labelled with whose maths it is. |
| **Map** | The track you have actually run, north up, with your heading, an optional GPX route to follow, and how far off it you are. Outdoor only. |

There is no font size on the G2 — the firmware draws one 27px face — so emphasis
is carried by `textColor` (0–4) and by position. A two-line tile in a single
container is the unit of layout, because that is what keeps a column aligned
under a proportional font.

## Workouts

| group | built-ins |
|---|---|
| Distance | 5K, 10K, Half, Marathon — cut into whole miles or km plus a finish step |
| Time | 30, 45, 60, 90 min, Open run |
| Intervals | 8×400m, 6×800m, 4×1mi, Tempo 20 |
| Zones | Ladder (5 Z1 / 20 Z2 / 3 Z4 / 2 Z5), Easy Z2, Threshold 4×6, Pyramid |

Custom: an interval builder, and a zone-block field that takes `5@1 20@2 3@4 2@5`
(minutes at zone, in display zones). **Save to library** keeps it under its own
name, mirrored to host storage so it survives a packaged cold launch.

Zone steps are timed steps with a zone to hold — the clock runs whether or not you
are in the zone, and the HUD says `hold Z2 ✓`, `· ease` or `· push`. A target is
clamped to the zone count Health actually reported, so a five-zone preset still
works for someone with three or seven.

The (i) button on the Plan card opens the zone reference: feel, purpose and share
of weekly time per zone.

## Layout

```
src/types.ts      the wire contract, twinned with ios/Shared/Snapshot.swift
src/wire.ts       parsing, defensive: a bad field costs one number, never a throw
src/workout.ts    the reducer — plan, step progress, splits. Pure.
src/library.ts    built-in workouts, saved workouts, the zone guide
src/zones.ts      zone presentation, plus the last-resort fallback
src/screens.ts    every screen as data. Pure, so it can be checked.
src/glasses.ts    pages, page turns, gestures, the long-press menu, image sends
src/map.ts        GPS track store and the canvas → 4-bit greyscale renderer
src/transport.ts  loopback → SSE → polling, in that order
src/main.ts       the companion: pair code, plan editor, GPX, live mirror, log
api/              the relay: push, state, stream, health (Upstash Redis)
ios/              the watch and phone apps (XcodeGen; see ios/README.md)
checks/           regression checks that run on a laptop
```

## Checks

```bash
npm run check
```

- `check:workout` drives whole sessions through the reducer: distance intervals
  on treadmill distance, time intervals, a 60-second packet gap that has to close
  every step it spans, replayed packets, laps, Apple zones used verbatim, the
  fallback's arithmetic, pace round-trips, and malformed wire payloads.
- `check:screens` builds every screen with realistic and adversarial data — nine
  zones, no heart rate, indoor with no distance, both unit systems — and runs each
  through the SDK's own page validator *and* real font measurement
  (`@evenrealities/pretext`), so a layout that would clip a number or blow the
  8-container page budget fails here rather than at mile four.

Both found real bugs while being written: step boundaries were snapping to
"wherever the packet landed" rather than where the target actually fell, which
skipped any step shorter than the gap between readings; and three HUD lines
overflowed 576px once a route deviation and a two-digit distance turned up
together.

## Deploying

The plugin and the relay are one Vercel project.

```bash
npm run build
npx vercel --prod --yes          # → splitglass.grannis.xyz
```

Set these on the Vercel project first, or the relay returns 502:

```
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

For the glasses:

```bash
npm run pack                     # → out.ehpk, upload at hub.evenrealities.com
```

A packaged `.ehpk` has no backend of its own, so `serverOrigin()` switches to the
absolute `https://splitglass.grannis.xyz` when the page is not being served from
grannis.xyz. Requires Even App 2.2.9+ and SDK 0.0.14 (long-press menus,
`textColor`, `EventSourceType`, phone location).

### Relay cost

Polling is one Redis read a second per run, and the phone posts one write a
second — roughly 4,800 commands for a 40-minute run, which is most of an Upstash
free-tier day. Two ways to avoid it: leave **Try the phone first** on so the
glasses read the phone directly over loopback and never touch Redis at all, or
turn the cloud relay off on the phone entirely.

## Known limits

- **The plugin must stay foreground on the phone.** Even Hub plugins render only
  while foreground and a backgrounded WebView stalls its network calls. Pocket
  the phone with the Even app open and the screen locked, and test that before
  designing anything around it — it is the one thing that could sink the app.
- **Zones need iOS 27 / watchOS 27.** Below that the watch sends no zone payload
  and the plugin estimates from a max-heart-rate setting, labelled as such.
- **GPS pace is not used.** Instantaneous pace comes from HealthKit's own running
  speed, falling back to distance over elapsed. The GPS track is drawn, and its
  distance is shown beside the watch's only when the two disagree by more than 4%.
- **The map is an image**, so it costs about a thousand times what a text line
  costs on a 10–30 KB/s link. It redraws every six seconds by default, and only
  when the drawing has actually changed.
