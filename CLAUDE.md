# MMM-TideChartSVG

A MagicMirror² module that shows a tide chart for one NOAA station, covering today and
tomorrow (local time), drawn as an SVG. High and low tides are labeled with their time and
height, the observed water level is drawn over the predicted curve, and an overlay marks the
current time and water level. Optionally, the ETSS storm surge forecast is drawn when it
differs enough from the prediction.

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
  - New observations (every `observationInterval`) only change the observed line's `d` in
    place. The whole chart is rebuilt only when they change the height range or a labeled
    high/low (a few times a day). The ETSS line (every 3 hours) works the same way.
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
- `observationInterval`: how often the observed water level is fetched (default 15 min, in
  ms; at least 6 min, since NOAA publishes every 6 min). Observations are always on (no
  switch; see Rejected ideas).
- `etssThreshold`: height in chart units (default none = ETSS off: no station list, no
  fetches). Show the ETSS forecast when a coming high/low differs from the prediction by at
  least this much, either way. README suggests 1.0–1.5 ft (0.3–0.45 m), with Seattle data.
- `etssStation`: NOAA ID of the ETSS station (default none = the nearest with observations
  and tides).

The page checks the types of `meanSeaLevel`, `gridStep`, `extremeRange`,
`observationInterval`, `etssThreshold` and `etssStation` and shows a message instead of the
chart if one is wrong.

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
- **Observed water level:** subordinate stations have no gauge. The reference station's
  observations get the same corrections as the curve (`correctPoints`), with the reference
  station's highs/lows fetched alongside each time. Modeled, not measured.
- **ETSS:** the ETSS station nearest the *reference* station. The reference's prediction plus
  the ETSS offset then goes through the corrections (the height ratio scales the surge too).

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
  Observations: `obs-9445958.json` (Nov 9 08:00 → Nov 10 07:00 UTC, i.e. the Mon–Tue window up
  to Mon 23:00 PST), `obs-9447130.json` (Nov 21 08:00 → Nov 22 20:00 UTC, the reference
  station's readings with the day margin), `obs-error.json` (NOAA's answer for a station
  without a gauge). Also covered: the observation URL and parsing, both station types'
  observation fetch, and one shared startup step for both cycles.
- `subordinate.test.js`: corrections at highs and lows, blend by time, window edges, failure
  when the reference data doesn't cover the window, ±3-hour offsets with the real data, and
  `correctPoints` on points that don't cover the window (observations).
- `etss.test.js`: station list parsing, nearest station (skips stations without observations
  or tides), offsets (total − tide, hourly; unknown station = error), interpolation and
  meters, station choice (config, own location, reference station's location), the adjusted
  curve for both station types (exact requests; a day past the window), failures, and the
  source choosing the station once. Fixtures: `etss-master.csv` (the real list's header and
  Washington rows), `etss-9447130.json` (Seattle, fetched Nov 23 01:00 UTC, trimmed to
  Nov 21–26), `station-9447130.json` and `offsets-9447130.json`.
- `fetchCycle.test.js`: fetch at start, 00:01 schedule, hourly retry, stop; the observation
  cycle (fixed interval, failures send nothing and log only when they start and end); fake
  clock and timers.
- `chartSvg.test.js`: SVG markup (element count, prefixed ids, gutter), height range always
  including 0 and MSL, axis title, grid steps (default and configured, ft and m), shading with
  and without MSL, past/future split, labels, extreme badges (strict bounds), x-axis labels,
  and overlay placement, interpolation and past width. Observations: which highs/lows become
  observed (30-minute rule, no turn yet), the observed path, range stretching, connectors and
  outer label placement, badges on observed values, the current value (fresh vs. over an
  hour old), and the 6-hour note. ETSS: labels (`*`, connectors, badges; observed wins), the
  dashed path and range, and the threshold rule (either way, lows count, only coming ones).

`node_helper.js` and `MMM-TideChartSVG.js` are thin and need MagicMirror itself; they're
checked by the manual test.

Manual: run `node --run server` from the MagicMirror root and open http://localhost:8080.
Check the module's log lines in the server output. Stop the server when done.

## Data source

NOAA CO-OPS Tides & Currents data API (`api.tidesandcurrents.noaa.gov/api/prod/datagetter`):
tide predictions (`product=predictions`) and observed water level (`product=water_level`,
6-minute preliminary readings, ~5 min behind; `{ data: [{ t, v, s, f, q }] }`, `v` may be
empty; a station without a gauge answers with an error such as "There is no MLLW for the
station"). Requests use UTC (`time_zone=gmt`); times are converted to the configured timezone
only for display.

Station metadata API, fetched once at startup (both required; until they work, the error
shows and the whole step retries hourly with the fetch):
- `.../mdapi/prod/webapi/stations/{id}.json`: the station's `name` and `state` for the header
  (no name → the header shows the station ID). Its shape differs between station kinds
  (e.g. no `type` for water-level stations like 9445958), so it isn't used for the type.
- `.../stations/{id}/tidepredoffsets.json`: same shape for every station. `type` `"R"`
  (own predictions) or `"S"` (subordinate: `refStationId`, `timeOffsetHighTide`/`LowTide` in
  minutes, `heightOffsetHighTide`/`LowTide`, `heightAdjustedType` `"R"` ratio or `"A"` added).

ETSS surge forecast: ETSS 2.0's web-page backend (`slosh.nws.noaa.gov/etsurge2.0/`), not a
documented API, so ETSS is optional and failures only leave the line off:
- `datafiles/master.csv`: the station list (`Station Name`, `Station ID` = NOAA ID,
  `Station Lat`/`Lon`, datums, `Obs?`, `Tide?`, ...), about 565 stations.
- POST `fixed/php/getData.php` with `st=<NOAA id>`: JSON (served as `text/html`) with arrays
  `ts` (`YYYYMMDDHHmm` UTC, 6-minute), `pred`, `ss`, `anom`, `obs`, `twl` (9999 = missing;
  `ss`/`anom`/`twl` hourly; feet above MLLW). About 5 days back to 4 days ahead; the forecast
  part starts after ETSS's last observation. `twl = pred + ss + anom`. An unknown station
  returns empty arrays. It updates every few hours (model runs 00/06/12/18Z).

Other station reference data on the same API (not used by the module):
- `datums.json`: MHHW, MLLW, etc., plus HAT/LAT (highest/lowest astronomical tide) and
  record observed max/min. Values are relative to station datum (STND); subtract MLLW to
  get heights on the chart's baseline.
- `floodlevels.json`: NWS minor/moderate/major flood levels; may be null for some stations.

## Architecture

- `node_helper.js`: Node side, thin. The first `REGISTER` (stationID, timezone, units,
  datum, observationInterval, `etss` = `{ station }` or null; the page fills in the default
  timezone) starts the fetch cycles, which share one startup step (`createStationLoader`):
  predictions, observations, and (when `etss` is set) ETSS every 3 hours (`TIDE_ETSS`). Later
  registrations get the latest results right away. Results are tagged with `stationID`.
- `lib/fetchCycle.js`: `createFetchCycle` (predictions): fetch at start; after a success,
  again at the next 00:01 local time; after a failure, every hour until it works. Sends
  `TIDE_DATA` or `TIDE_ERROR`. `createRepeatingCycle` (observations): fetch at start, then
  every interval; sends `TIDE_OBSERVATIONS` on success, nothing on failure, and logs only
  when failures start and end.
- `lib/noaa.js`: builds the two requests (6-minute curve and `interval=hilo`) over the
  window, in UTC, and parses them into `{ t: UTC ms, v, type? }`. `fetchStation` is the
  startup step (name and offsets); `createTideSource` runs it on the first fetch (and each
  fetch until it works), keeps the result, and then makes only the daily requests. For a
  subordinate station the daily fetch is its own highs/lows plus the reference station's
  curve and highs/lows with a day's margin on each side; the result has `modeled: true`.
  `fetchObservations`: readings from the window's start to now (subordinate: the reference
  station's from a day earlier, corrected and trimmed). `createStationLoader` keeps the
  startup step's result and shares one in-flight request between both cycles.
  NOAA reports problems as `{ error: { message } }`, often with HTTP 200.
- `lib/etss.js`: ETSS station list, nearest station, offsets (total − tide, hourly), and the
  adjusted curve: the 6-minute prediction (subordinate: the reference's, then `correctPoints`)
  plus the offset interpolated between hours, from the window's start to a day past its end
  (so it still covers the chart after midnight until the next fetch). `createEtssSource`
  chooses the station once (retried until it works) and logs the choice.
- `lib/subordinate.js`: `correctPoints` applies the corrections to any of the reference
  station's points (curve or observations); `modelCurve` uses it and trims to the window
  (pure).
- `lib/tideTime.js`: timezone math with `Intl` (window, next 00:01, labels). Shared by Node
  and the page (UMD-style: `module.exports` or a `TideTime` global).
- `lib/chartSvg.js`: builds the SVG markup string and the overlay positions (pure; shared
  the same way as `ChartSvg`). Also `shownExtremes` (which highs/lows are observed or ETSS),
  `etssShown` (the threshold rule), `observedPath`/`etssPath` (the lines' `d`) and
  `observationNote` (the 6-hour note).
- `MMM-TideChartSVG.js`: browser side. `getDom` builds the wrapper once and always returns
  it. New data: markup is parsed off-screen in a `<template>` and swapped in with one
  `replaceChildren`, so the chart never disappears. `updateDom` is called only when the
  header (station name, or the `*` for a modeled curve) changes; since `getDom` returns the same wrapper, the chart isn't
  rebuilt. Data that arrives before `getDom` is kept and drawn when the wrapper exists. The
  overlay timer moves the now-line, dot and label, moves the past/future clip edge,
  toggles `tide-past` on every element with a `data-t` (highs/lows, badges, hour labels),
  and updates the note about old observations. `render` builds the chart from the latest
  predictions, observations and ETSS curve; otherwise it only replaces the observed and ETSS
  paths' `d`, unless the shown highs/lows, the height range or the ETSS visibility changed
  (then it rebuilds). Whether ETSS is shown is decided when ETSS data or new predictions
  arrive, not on every redraw.
  The status line shows an error/loading message and the observation note together.
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
- **Height range:** always includes 0 and `meanSeaLevel`; the 0 line is always drawn. It
  also covers the observed readings and the shown and predicted highs/lows (it stretches;
  nothing is clipped).
- **Grid:** very faint, at every `gridStep` and every 6 hours.
- **Shading:** without MSL, blue fading toward the bottom. With MSL, only between the curve
  and the MSL line: blue above, sand below, fading toward the line; dashed MSL line labeled
  "MSL" (no value).
- **Past:** up to now, the curve is grey, the shading faint (same colors), and high/low
  labels and hour labels grey.
- **High/low labels:** time (24-hour, e.g. `15:42`) and height to one decimal place
  (e.g. `7.2 ft`): time in light grey, height in blue.
- **Observed water level:** a grey line (`#777`, 3 px), lighter and thicker than the past
  curve, from the window's start to the latest reading.
- **Observed highs/lows:** a past high/low shows the observed extreme (its own time and
  height) once it is clear: the highest/lowest reading within ±90 min of the predicted time,
  not at either end of those readings, and the latest reading ≥ 30 min after it. Otherwise
  the prediction. A faint dotted connector (`#999`, 1 px, `1 3`, 70% opacity) joins the
  predicted point to the observed one; highs are labeled above the higher point, lows below
  the lower one. Badge rules apply to the shown value.
- **ETSS:** when shown, a muted red dashed line (`#b86b6b`, 1.75 px, `5 4`) from now to the
  end of the window. Highs/lows not yet observed show the ETSS curve's extreme with `*` right
  after the number (`12.4* ft`), with the same connector and label placement. The header's
  `*` (modeled curve) can appear too; accepted.
- **Extreme tides:** the label sits on a badge, red for highs and purple for lows; once in
  the past, the badge becomes an outline. Badge width is estimated from the text length.
- **X-axis:** one row; the day name starts each day, then `06`, `12`, `18` under short
  ticks; a taller tick and a dashed divider at midnight.
- **Overlay:** a vertical line at the current time, a blue dot with a white outline, and the
  current height with a rising or falling arrow. The height (and the dot) is the latest
  observation if it is under an hour old, otherwise the predicted curve's; the arrow follows
  the predicted curve.
- **Errors:** an error before any data shows the error message; after data has loaded, a
  failed update keeps the last chart and adds "(latest update failed)". Failed observation
  fetches are silent; when the latest observation is over 6 hours old the status line adds
  "Observations not updated since <day> <HH:MM>".

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
- **Refreshing predictions on a timer (e.g. every 6 hours):** predictions don't change during
  the day; one fetch at start and one at 00:01 is enough. (Observed and ETSS data change
  during the day and have their own timers.)
- **A switch to turn off observed water levels:** not implemented; they're always shown when
  the station (or its reference station) has them.
- **Clipping observed/ETSS values that go beyond the predicted height range** (with labels
  moved inside the curve when they don't fit): labels collide and lines still get cut off.
  The range stretches instead.
- **An ETSS threshold as a percent of the predicted high:** it depends on the datum (MLLW vs
  MSL), is meaningless near 0, and surge doesn't scale with tide height. It's an absolute
  height instead.
