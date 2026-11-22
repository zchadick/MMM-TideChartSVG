# MMM-TideChartSVG

A MagicMirror² module that shows a tide chart for one NOAA station, covering today and
tomorrow (local time), drawn as an SVG. High and low tides are labeled with their time and
height, and an overlay marks the current time and tide level.

The repo is public. Machine-specific notes live in a git-ignored `CLAUDE.local.md`.

## Working rules

- **No refactoring, drive-by cleanups, reformatting, or renames.** Change only what the
  task requires, so each pull request stays small and easy to review and merge.
- **Prefer the simplest solution.** Choose simple over flexible, and don't add code for
  unusual edge cases unless asked.
- **Periodically evaluate the architecture.** When a new feature would be better served
  by rearchitecting (rather than layering more onto the current design), call it out with
  the trade-offs. Do **not** implement a rearchitecture without explicit instructions.
- **Look for edge cases where the module breaks down, and consider disallowing them.**
  Before adding complexity to support an edge case, consider whether it should simply be
  explicitly unsupported and documented instead. Raise the choice rather than defaulting
  to support.
- **Bias toward simplicity over edge cases.** Look for edge cases where the module breaks
  down, raise them, and document for each whether it will be handled or left unsupported.
  By default prefer the simpler design: an unusual case is explicitly unsupported (with a
  clear error and a note in README.md) rather than handled with extra code. Don't get
  stuck on edge cases.
- **Tests use Node's built-in `node:test`;** no test-framework dependency. New or changed
  behavior gets tests.
- **No personal information in the repo.** Keep personal paths, host names and any
  credentials out of commits (they belong in `config/config.js` or `CLAUDE.local.md`).
- **Keep README.md up to date.** Any change to behavior, configuration options or
  defaults, install/update steps, display rules, or limitations updates the README in the
  same pull request.
- **Flag when `screenshot.png` is out of date.** If a change alters what the module looks
  like on screen, say so in the pull request and remind the maintainer to retake the
  screenshot. When a new screenshot is added, strip its metadata first.
- **Keep this file current, not historical.** Describe how things work now, plus open
  work. No completion history: git and the pull requests hold that. Exception: brief
  "Rejected ideas" notes that stop a rejected idea from being proposed again.
- **Check the history to understand why things are the way they are** (`git log`,
  `git blame`, pull requests, `git log -p -- CLAUDE.md`) before changing or questioning a
  design decision.

## Runtime

- Designed for a Raspberry Pi 3B+ (1 GB RAM, slow quad-core ARM CPU). Treat memory and CPU
  as scarce:
  - Build the full chart only when new data arrives, never on a timer.
  - The overlay (current-time line, current level) redraws on its own config interval and
    updates only its own elements in place, never the whole chart.
  - Keep the number of DOM and SVG nodes small. Use a single path for the tide curve, not
    one element per data point.
  - No heavy dependencies: no charting libraries (no Chart.js), and add only npm packages
    that are really needed.
  - Keep only the data the chart uses; don't hold on to old data sets.
  - Avoid leaks: clear timers and remove listeners when they're replaced.
- MagicMirror requires Node >= 22.21.1. `fetch` is used natively (no HTTP library).
  Timezone conversion uses the built-in `Intl` (no date library).

## Configuration

Settings go in the module's entry in `config/config.js`. `stationID`, `units` and `datum`
match MMM-NOAATides; `timezone` is deliberately not their `time` (NOAA's `lst_ldt`), since
it takes an IANA name.

- `stationID` (required): NOAA station ID (test stations: `9445958`, Bremerton, WA; subordinate:
  `9445882`, Eagle Harbor, Bainbridge Island, WA, reference station `9447130`, Seattle)
- `stationName`: header text; default NOAA's name (`"Bremerton, WA"`), else the station ID.
  A `header` on the module entry (MagicMirror's own option) wins over both.
- `timezone`: IANA name (e.g. `"America/Los_Angeles"`); defaults to the mirror's timezone
- `units`: `"english"` (ft, default) or `"metric"` (m)
- `datum`: NOAA height baseline (default `"MLLW"`; see Open work). Subordinate stations: MLLW
  only (NOAA publishes nothing else for them); any other datum is an error.
- `meanSeaLevel`: MSL height in the chart's units and datum (default none; 9445958 uses 6.78 ft
  above MLLW). Turns on the MSL line and MSL shading.
- `gridStep`: height between grid lines (default 2 ft / 0.5 m by `units`)
- `extremeRange`: `[low, high]` (default none; 9445958 uses `[-3.0, 13.0]`). Strictly below
  `low` or above `high` is extreme.
- `width`, `height`: chart size in px (default 400 × 400)
- `overlayUpdateInterval`: how often the current-time overlay redraws (default 60 s, in ms)

The page checks the types of `meanSeaLevel`, `gridStep` and `extremeRange` and shows a
message instead of the chart if one is wrong.

## Design constraint: one station

One station per MagicMirror installation. The first instance to register sets the station;
an instance with a different station is ignored with a log warning and shows "Only one tide
station per mirror is supported." Documented in README.md ("Limitations"); keep them in sync.

## Subordinate stations

NOAA publishes no curve for a subordinate station (offsets `type: "S"`), only highs and lows
derived from a reference station's with two fixed corrections (high and low: minutes of time
shift and a height ratio). Documented in README.md ("Subordinate stations", "Limitations");
keep them in sync.

- **Curve:** the reference station's 6-minute curve with the corrections applied
  (`lib/subordinate.js`). Labels are the station's own published highs and lows. The modeled
  curve reproduces them exactly (checked for Eagle Harbor).
- **Decision: blend by time.** NOAA defines the corrections only at highs and lows. Between
  them, each point's correction is blended by time from one tide's correction to the next.
  Rejected: blending by height (needs a clamp where the 6-minute curve overshoots a published
  extreme; no visible gain). Weakness: neither is NOAA's method; for Eagle Harbor the two differ
  by ≤ 0.03 ft, but for a station whose high and low corrections differ a lot, the in-between
  curve is less certain. The shape is always the reference station's.
- **Fail rather than show inaccurate data:** any failed request (station's highs/lows, reference
  curve or highs/lows) fails the whole fetch; no fallback to a highs/lows-only curve.
- **Unsupported, with descriptive errors:** "A" (added-feet) height offsets; a `datum` other
  than MLLW. These retry hourly like any other error.
- **Header:** `*` after whatever header is shown (NOAA name, `stationName` or `header`).

## Testing

Automated (`tests/`), from the module directory: `node --test` (or `npm test`). No network
needed.
- `tideTime.test.js`: the two-day window (including 23/25-hour daylight-time days and other
  timezones), the next 00:01 refresh, label formats, timezone validation.
- `noaa.test.js`: request URLs, parsing, NOAA error responses, station name, offsets
  (subordinate or not, "A" and incomplete offsets), the startup step (both requests required,
  MLLW-only datum for subordinate stations), `fetchTides` for both station types with a
  stand-in `fetch` (exact requests; modeled curve passes through the published highs/lows; no
  fallback when a request fails), and `createTideSource` (startup step once, retried until it
  works). Fixtures in `tests/fixtures/` are real responses: 9445958 (Nov 9–10, 2026, Pacific,
  plus station metadata and offsets); 9445882 (Nov 22–23, 2026: highs/lows, station metadata,
  offsets) and its reference 9447130 (curve and highs/lows, Nov 21–24 UTC with the day margin).
- `subordinate.test.js`: corrections at highs and lows, blend by time, window edges, failure
  when the reference data doesn't cover the window, and ±3-hour offsets with the real data.
- `fetchCycle.test.js`: fetch at start, 00:01 schedule, hourly retry, stop; fake clock and timers.
- `chartSvg.test.js`: SVG markup (element count, prefixed ids, gutter), height range always
  including 0 and MSL, axis title, grid steps (default and configured, ft and m), shading with
  and without MSL, past/future split, labels, extreme badges (strict bounds), x-axis labels,
  and overlay placement, interpolation and past width.

`node_helper.js` and `MMM-TideChartSVG.js` are thin and need MagicMirror itself; they're
checked by the manual test.

Manual: run `node --run server` from the MagicMirror root and open http://localhost:8080.
Check the module's log lines in the server output. Stop the server when done.

## Data source

NOAA CO-OPS Tides & Currents data API (`api.tidesandcurrents.noaa.gov/api/prod/datagetter`),
tide predictions. Requests use UTC (`time_zone=gmt`); times are converted to the configured
timezone only for display.

Station metadata API, fetched once at startup (both required; until they work, the error
shows and the whole step retries hourly with the fetch):
- `.../mdapi/prod/webapi/stations/{id}.json`: the station's `name` and `state` for the header
  (no name → the header shows the station ID). Its shape differs between station kinds
  (e.g. no `type` for water-level stations like 9445958), so it isn't used for the type.
- `.../stations/{id}/tidepredoffsets.json`: same shape for every station. `type` `"R"`
  (own predictions) or `"S"` (subordinate: `refStationId`, `timeOffsetHighTide`/`LowTide` in
  minutes, `heightOffsetHighTide`/`LowTide`, `heightAdjustedType` `"R"` ratio or `"A"` added).

Other station reference data on the same API (not used by the module):
- `datums.json`: MHHW, MLLW, etc., plus HAT/LAT (highest/lowest astronomical tide) and
  record observed max/min. Values are relative to station datum (STND); subtract MLLW to
  get heights on the chart's baseline.
- `floodlevels.json`: NWS minor/moderate/major flood levels; may be null for some stations.

## Architecture

- `node_helper.js`: Node side, thin. The first `REGISTER` (stationID, timezone, units,
  datum; the page fills in the default timezone) starts the fetch cycle; later
  registrations get the latest result right away. Results are tagged with `stationID`.
- `lib/fetchCycle.js`: fetch at start; after a success, again at the next 00:01 local time;
  after a failure, every hour until it works. Sends `TIDE_DATA` or `TIDE_ERROR`.
- `lib/noaa.js`: builds the two requests (6-minute curve and `interval=hilo`) over the
  window, in UTC, and parses them into `{ t: UTC ms, v, type? }`. `fetchStation` is the
  startup step (name and offsets); `createTideSource` runs it on the first fetch (and each
  fetch until it works), keeps the result, and then makes only the daily requests. For a
  subordinate station the daily fetch is its own highs/lows plus the reference station's
  curve and highs/lows with a day's margin on each side; the result has `modeled: true`.
  NOAA reports problems as `{ error: { message } }`, often with HTTP 200.
- `lib/subordinate.js`: models a subordinate station's curve from the reference station's
  (pure); trims it to the window.
- `lib/tideTime.js`: timezone math with `Intl` (window, next 00:01, labels). Shared by Node
  and the page (UMD-style: `module.exports` or a `TideTime` global).
- `lib/chartSvg.js`: builds the SVG markup string and the overlay positions (pure; shared
  the same way as `ChartSvg`).
- `MMM-TideChartSVG.js`: browser side. `getDom` builds the wrapper once and always returns
  it. New data: markup is parsed off-screen in a `<template>` and swapped in with one
  `replaceChildren`, so the chart never disappears. `updateDom` is called only when the
  header (station name, or the `*` for a modeled curve) changes; since `getDom` returns the same wrapper, the chart isn't
  rebuilt. Data that arrives before `getDom` is kept and drawn when the wrapper exists. The
  overlay timer moves the now-line, dot and label, moves the past/future clip edge, and
  toggles `tide-past` on every element with a `data-t` (highs/lows, badges, hour labels).
- **Don't overwrite MagicMirror's module properties** (e.g. `this.data`, which holds the
  module's position and header; overwriting it kept the module off screen).
- `MMM-TideChartSVG.css`: all colors. Standard MagicMirror greys and whites; blue `#7fa7c9`
  and sand `#d8c8a0` from MMM-WaStateFerry's map, red `#ff6b6b` and purple `#c77dff` from its
  delay colors. Gradient colors are set on `<stop>` classes; opacity is in the markup.
- `tests/`: automated tests.

## Display rules

- **Window:** two full calendar days in the configured timezone, from 00:00 today to 00:00
  the day after tomorrow.
- **Header:** the station name (MagicMirror's standard module header), followed by `*` when
  the curve is modeled (subordinate stations).
- **Layout:** a 44 px left gutter (height numbers at each grid line, rotated title "Height
  above <datum> (<unit>)"), the plot, and a 20 px x-axis row at the bottom.
- **Height range:** always includes 0 and `meanSeaLevel`; the 0 line is always drawn.
- **Grid:** very faint, at every `gridStep` and every 6 hours.
- **Shading:** without MSL, blue fading toward the bottom. With MSL, only between the curve
  and the MSL line: blue above, sand below, fading toward the line; dashed MSL line labeled
  "MSL" (no value).
- **Past:** up to now, the curve is grey, the shading faint (same colors), and high/low
  labels and hour labels grey.
- **High/low labels:** time (24-hour, e.g. `15:42`) and height to one decimal place
  (e.g. `7.2 ft`): time in light grey, height in blue.
- **Extreme tides:** the label sits on a badge, red for highs and purple for lows; once in
  the past, the badge becomes an outline. Badge width is estimated from the text length.
- **X-axis:** one row; the day name starts each day, then `06`, `12`, `18` under short
  ticks; a taller tick and a dashed divider at midnight.
- **Overlay:** a vertical line at the current time, a blue dot with a white outline on the
  curve, and the current height with a rising or falling arrow.
- **Errors:** an error before any data shows the error message; after data has loaded, a
  failed update keeps the last chart and adds "(latest update failed)".

## Open work

To decide once real data can be compared:
- **Curve resolution:** 6-minute predictions vs. hourly vs. curve from high/low only.
- **Datum:** which height baseline to display (MLLW is NOAA's default for predictions).

## Rejected ideas

Ideas that were considered and rejected, with the reason, so they aren't proposed again.

- **Chart.js:** too heavy for the Pi; the module draws its own SVG.
- **A user-set number of hours to display:** the window is always today plus tomorrow.
- **Building the chart in Node as an SVG file shown with `<img>`:** it adds disk writes,
  caching and coordinate-matching between two layers. The chart is small enough that
  inline SVG costs little.
- **Refreshing data on a timer (e.g. every 6 hours):** predictions don't change during the
  day; one fetch at start and one at 00:01 is enough.
