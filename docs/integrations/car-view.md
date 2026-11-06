# Car view (Android Auto / Android Automotive)

The car screen shows a **glanceable summary** of the same dashboard the phone
renders. It is not the renderer at another size: the Car App Library (CAL) gives
an IoT-category app templates only — lists, grids, panes, messages. There is no
chart template and no drawing surface.

Contract: [C-010](../contracts/C-010-car-projection.md). Decision:
[0033](../../changelog.d/0033-android-auto-iot.md).

## What is shown

| Phone panel | Car row |
|---|---|
| `StatChart` | `label · value unit · state` |
| `GaugeChart` | `label · value% · state` |
| `Table` | `label · value` |
| `TimeSeriesChart` | 24-cell **block sparkline** (`▁▂▃▄▅▆▇█`), plus last value and state badge |
| `Markdown` | **omitted**, counted |

Every omitted panel is counted and reported in the action strip ("3 chart(s)
hidden"), so the view never pretends to be the whole dashboard. A panel whose
query returns nothing renders `— · No data` — never a fabricated zero.

Tabs are filled in reading order (row, then band, then `x`, then `y`), capped at
10 rows each and 4 tabs (CAL limit). Overflow is counted, not dropped.

## Geometry

The car's screen is not the phone's. The screen reads:

- `ConstraintManager.getContentLimit(CONTENT_LIMIT_TYPE_LIST)` — how many rows
  the host will render; the app cannot raise it.
- `CarContext.getConfiguration()` — the head unit's `screenWidthDp` /
  `screenHeightDp`.

The phone's `Activity` metrics are never used for car layout.

Refresh is floored at 10 s (`REFRESH_FLOOR_SECONDS`); stale rows are marked.

## Verification

### Desktop Head Unit (Android Auto)

The DHU emulates a head unit against a phone. It needs the phone's Android Auto
head-unit server:

```sh
# 1. Enable Android Auto developer mode: Settings → Android Auto → About →
#    tap "Version and permission info" 10 times.
# 2. Android Auto overflow menu → "Start head unit server".
# 3. Forward the port and run the DHU.
adb -s <serial> forward tcp:5277 tcp:5277
cd "$ANDROID_HOME/extras/google/auto"
./desktop-head-unit --adb=127.0.0.1:5277 -c config/default.ini
```

`config/default.ini` is 800×480; `default_wide.ini` is 1280×720;
`default_1080p.ini` is 1920×1080. In the DHU console, `focus video` is required
before `screenshot <path>` works.

Note: the DHU renders the **phone's** Android Auto host. A sideloaded CAL app
appears there, but not in a real car launcher — "Allow unknown sources" does not
apply to CAL apps.

### Android Automotive OS emulator

AAOS runs the Templates Host natively, so no phone is involved:

```sh
sdkmanager --install 'system-images;android-35-ext15;android-automotive-playstore;arm64-v8a'
avdmanager create avd -n androdash_auto \
  -k 'system-images;android-35-ext15;android-automotive-playstore;arm64-v8a' \
  -d automotive_1024p_landscape
emulator -avd androdash_auto
adb -s emulator-5556 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5556 shell am start \
  -n com.mbicz.androdash/androidx.car.app.activity.CarAppActivity
```

AAOS runs apps in **user 10**, so a config seeded into user 0 is invisible to the
car view. Seed it for user 10, or launch `MainActivity --user 10` with the usual
`--es dashboard_url` / `--es prometheus_url` extras.

Capture with `adb shell screencap -p /sdcard/s.png` then `adb pull`; the template
renders into a `SurfaceView`, so `uiautomator dump` shows no text.

### Observed result

On the AAOS emulator (1024×768) against the mock Prometheus, the fleet dashboard
projected 7 panels / 5 series:

```
Fleet / Inference
Inference hosts           1 · Up 🟢
Temperatures              52 °C · Nominal 🟢
Memory pressure           29% · Nominal 🟢
GPU utilization           78% · Nominal 🟢
KV cache                  68% · Nominal 🟢
spark-gb10 · Output tok/s
▁▁▂▃▄▅▆▇████▇▆▅▄▃▂▁▁▂▃▄   3.8K tok/s 🟢
```

Block glyphs fill their whole cell, so the 24 cells tile into a continuous
filled area. Every cell is a block — never a space — because a space advances
8.00 px while a block advances 23.00 px, and one blank would shift the rest of
the row left. Blocks are fixed-width on the car font (23.00 px); emoji are
**not** (30/33/40 px), so they are only trailing status badges, never pixels.

Braille was tried first and rejected: it is fixed-width and packs a 2×4 dot
grid, but its dots are sparse by design, so on screen it renders as isolated
clusters with gaps rather than as a filled area.

`Model lanes` is `No data` because no inference engine is scraped in that setup —
correct behaviour, not a placeholder.

## Getting onto a real car

A Play Console account is required; `adb install` is not enough. See
[`../plans/car-screen.md`](../plans/car-screen.md#getting-onto-a-real-car).
Internal testing and internal app sharing skip the car form-factor review
entirely, so the 12-tester/14-day rule (which gates only public production) does
not block personal testing.

## Limits

- No drawn charts, no text panels, no custom drawing. A time series becomes a
  text sparkline, not a graph.
- 2–4 tabs, 10 rows per tab, 8 table rows per panel.
- IoT category only: `IT-1` permits viewing device state while driving. Declaring
  `NAVIGATION` or `POI` to obtain a surface is a misrepresentation and fails
  review (`NF-1`, `NF-2`, `PF-1`).
