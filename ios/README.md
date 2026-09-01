# Pace Rail — watch and phone

The watch owns the workout; the phone is a bridge. Nothing here computes a
metric: every number is HealthKit's, which is why the glasses agree with the
Fitness app and why the HUD works the same on a treadmill as on a road.

```
Apple Watch                          iPhone                        Even G2
─────────────                        ──────                        ───────
HKWorkoutSession                     mirrored HKWorkoutSession
HKLiveWorkoutBuilder  ──mirroring──▶ MirrorReceiver ──▶ LocalServer ──▶ plugin
  heart rate                           (background       127.0.0.1:8734    (loopback)
  distance, energy                      runtime for
  HKLiveWorkoutZoneUpdate               the workout)  ──▶ CloudRelay ──▶ pace.grannis.xyz
  → Snapshot (JSON)                                       POST /api/push        │
                                                                                ▼
                                                                        plugin polls or
                                                                        streams the relay
```

The watch builds each `Snapshot` and pushes it over the mirroring data channel
once a second. If mirroring never starts — phone left at home, iOS too old — the
watch posts to the relay itself, so the HUD still works.

## Build

```bash
brew install xcodegen
cd ios
export DEVELOPMENT_TEAM=XXXXXXXXXX     # your ten-character team id
xcodegen generate
open PaceRail.xcodeproj
```

The `.pbxproj` is generated rather than committed: `project.yml` is reviewable
and a project file is not. Two targets, `PaceRail` (iOS 17+) and `PaceRailWatch`
(watchOS 10+), the watch app embedded in the phone app.

Then in Xcode: select the watch scheme, pick your watch, run. HealthKit
capability comes from the entitlements files already in the repo; automatic
signing handles the rest. Deploying to a real watch needs the paid developer
account — free provisioning re-signs every seven days, which you do not want
mid-training-block.

## Set-up, once

1. Open the **Pace Rail** plugin on the glasses (or its companion page on the
   phone) and read the six-character code off the **Pair the phone** card.
2. Type it into the iPhone app and press Save.
3. Start a run on the watch. The phone should show *Watch mirroring: receiving*
   and the readings counter should climb.

## Heart-rate zones

`ZoneReader.swift` is the whole of it, and it has one rule: **the user's own
configuration always wins.**

- `builder.zoneConfiguration(for: .heartRate)` non-nil → the wearer has zones,
  either set by hand in Health Settings or computed by the system from their own
  heart-rate history. Nothing is installed, and the snapshot is labelled
  `apple`. The boundaries and the accumulated time-in-zone the glasses show are
  then the same figures the Fitness app will show for the workout.
- nil → we install a fallback configuration (50/60/70/80% of heart-rate reserve,
  using the wearer's measured resting heart rate) purely so HealthKit has
  something to accumulate against, and the snapshot is labelled `computed`. Both
  the HUD and the companion say so in words, so it can never be mistaken for
  Apple's.

Durations always come from `HKLiveWorkoutZoneUpdate` verbatim. Two accumulators
drift, and then the glasses and the Fitness app disagree — which is the one thing
this feature exists to avoid.

Zones need **iOS 27 / watchOS 27**; the code is behind `@available` checks, and
on an older OS the app sends no zone payload at all. The plugin then falls back
to its own estimate from the max-heart-rate setting, again clearly labelled.

## Four things to check on first build

None of this could be compiled or run from the machine it was written on
(Windows), so these are the places to look first rather than surprises to
discover later.

1. **`HKWorkoutZoneConfiguration.zoneBoundaries`** — `ZoneReader.boundaries(of:)`
   reads the boundaries back through the same name the initialiser takes. If the
   SDK spells it differently, that is the one line to fix; everything else works
   off `zones.count` and the durations, and the wire format already tolerates an
   empty `boundaries` array by dropping the bpm ranges from the zone screen.
2. **Mirrored-session background runtime on iOS.** A mirrored `HKWorkoutSession`
   is supposed to keep the iPhone app running for the length of the workout with
   nothing but the HealthKit entitlement. Verify it: start a run, lock the phone,
   put it in a pocket for five minutes, and confirm the readings counter is still
   climbing. If it is not, add a background mode and re-test.
3. **`sendToRemoteWorkoutSession(data:)` throughput.** One JSON snapshot a second
   is a light load, but if the channel rate-limits, drop to every two seconds in
   `WorkoutManager.startPushing()` — the plugin interpolates nothing, so the HUD
   simply updates half as often.
4. **Whether the glasses can reach loopback at all.** The plugin probes
   `http://127.0.0.1:8734/health` and falls back to the relay when the probe is
   blocked, which it will be if the Even app serves the plugin from an https
   origin. Check the plugin's log line: *"Local relay on the phone answered"*
   means the fast path is live. If it never appears, loopback is blocked and the
   relay is doing the work — everything still functions, just with a round trip
   through the network.

## Privacy

The watch keeps the workout in Health as it always would. Beyond that, a reading
leaves the phone only when the cloud relay is switched on, and then only under
the pair code, and the relay keeps exactly one reading per code with a six-hour
expiry and writes nothing to disk. Switch the relay off and nothing leaves the
device at all.
