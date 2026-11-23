"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const ChartSvg = require("../lib/chartSvg.js");
const { parsePredictions, parseObservations } = require("../lib/noaa.js");

function fixture (name) {
	return parsePredictions(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")));
}

const LA = "America/Los_Angeles";
const DATA = {
	start: Date.parse("2026-11-09T08:00:00Z"),
	mid: Date.parse("2026-11-10T08:00:00Z"),
	end: Date.parse("2026-11-11T08:00:00Z"),
	curve: fixture("curve-9445958.json"),
	hilo: fixture("hilo-9445958.json")
};
const OPTS = { width: 400, height: 400, timezone: LA, units: "english", datum: "MLLW", idPrefix: "m1" };

function count (svg, pattern) {
	return (svg.match(pattern) || []).length;
}

/** The same data shifted up so every height is positive. */
function allPositive () {
	const up = (p) => ({ ...p, v: p.v + 5 });
	return { ...DATA, curve: DATA.curve.map(up), hilo: DATA.hilo.map(up) };
}

// --- Structure -------------------------------------------------------------

test("one SVG with a small, fixed number of elements (not one per data point)", () => {
	const { svg } = ChartSvg.buildChart(DATA, OPTS);
	assert.match(svg, /^<svg [^>]*width="400" height="400" viewBox="0 0 400 400">/);
	assert.match(svg, /<\/svg>$/);
	assert.equal(count(svg, /class="tide-curve tide-curve-past"/g), 1);
	assert.equal(count(svg, /class="tide-curve tide-curve-future"/g), 1);
	assert.ok(count(svg, /<(path|line|circle|rect|text|tspan|g|stop|linearGradient|clipPath)\b/g) < 100);
});

test("ids are prefixed so they're unique on the page", () => {
	const { svg } = ChartSvg.buildChart(DATA, OPTS);
	for (const [, id] of svg.matchAll(/ id="([^"]+)"/g)) assert.match(id, /^m1-/);
	assert.match(svg, /clip-path="url\(#m1-past\)"/);
});

test("curve spans the plot's full width, inside the left gutter", () => {
	const { svg, scale } = ChartSvg.buildChart(DATA, OPTS);
	assert.equal(scale.plotWidth, 356);
	assert.match(svg, /<g transform="translate\(44,0\)">/);
	const d = /class="tide-curve tide-curve-future"[^>]* d="([^"]+)"/.exec(svg)[1];
	assert.match(d, /^M0,/);
	assert.match(d, / L356,[\d.]+$/);
	assert.equal(count(d, /[ML]/g), DATA.curve.length);
});

// --- Height axis -----------------------------------------------------------

test("height range always includes 0, even when every tide is above it", () => {
	const { svg, scale } = ChartSvg.buildChart(allPositive(), OPTS);
	assert.equal(scale.min, 0);
	const zeroY = Number(/class="tide-zero" x1="0" y1="([\d.]+)"/.exec(svg)[1]);
	assert.ok(Math.abs(zeroY - scale.bottom) < 0.1);
});

test("height range includes the mean sea level when set", () => {
	const { scale } = ChartSvg.buildChart(DATA, { ...OPTS, meanSeaLevel: 20 });
	assert.equal(scale.max, 20);
});

test("axis title names the datum and units", () => {
	assert.match(ChartSvg.buildChart(DATA, OPTS).svg, />Height above MLLW \(ft\)</);
	assert.match(ChartSvg.buildChart(DATA, { ...OPTS, units: "metric", datum: "MSL" }).svg, />Height above MSL \(m\)</);
});

test("grid step: 2 ft or 0.5 m by default, or the configured value", () => {
	assert.equal(ChartSvg.defaultGridStep("english"), 2);
	assert.equal(ChartSvg.defaultGridStep("metric"), 0.5);

	const numbers = (svg) => [...svg.matchAll(/class="tide-scale[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1]);
	assert.deepEqual(numbers(ChartSvg.buildChart(DATA, OPTS).svg), ["0", "2", "4", "6", "8", "10"]);
	assert.deepEqual(numbers(ChartSvg.buildChart(DATA, { ...OPTS, gridStep: 5 }).svg), ["0", "5", "10"]);

	const metric = { ...DATA, curve: DATA.curve.map((p) => ({ ...p, v: p.v * 0.3048 })), hilo: DATA.hilo.map((p) => ({ ...p, v: p.v * 0.3048 })) };
	// Metric range is -0.47 … 3.63 m: grid lines every 0.5 m inside it.
	assert.deepEqual(numbers(ChartSvg.buildChart(metric, { ...OPTS, units: "metric" }).svg), ["0.0", "0.5", "1.0", "1.5", "2.0", "2.5", "3.0", "3.5"]);
});

test("grid lines: one path with the height levels (except 0) and the six-hour times", () => {
	const { svg } = ChartSvg.buildChart(DATA, OPTS);
	const d = /class="tide-grid" d="([^"]+)"/.exec(svg)[1];
	assert.equal(count(d, /H356/g), 5); // 2, 4, 6, 8, 10
	assert.equal(count(d, /V380/g), 6); // 06, 12, 18 on both days
});

// --- Shading and mean sea level ---------------------------------------------

test("without meanSeaLevel: one fading fill, no MSL line", () => {
	const { svg } = ChartSvg.buildChart(DATA, OPTS);
	assert.match(svg, /id="m1-fade"/);
	assert.doesNotMatch(svg, /tide-msl/);
	assert.doesNotMatch(svg, /tide-stop-below/);
});

test("with meanSeaLevel: dashed MSL line labeled without a value, colors above and below", () => {
	const { svg, scale } = ChartSvg.buildChart(DATA, { ...OPTS, meanSeaLevel: 6.78 });
	const y = ChartSvg.yOf(scale, 6.78).toFixed(1).replace(/\.0$/, "");
	assert.match(svg, new RegExp(`class="tide-msl" x1="0" y1="${y}"`));
	assert.match(svg, />MSL<\/text>/);
	assert.doesNotMatch(svg, />MSL [\d]/);
	assert.match(svg, /id="m1-above"/);
	assert.match(svg, /id="m1-below"/);
	assert.doesNotMatch(svg, /id="m1-fade"/);
});

test("shading is drawn for the past (faded) and the future", () => {
	const { svg } = ChartSvg.buildChart(DATA, OPTS);
	assert.match(svg, /<g class="tide-shade-past" opacity="0.35" clip-path="url\(#m1-past\)">/);
	assert.match(svg, /<g class="tide-shade-future" clip-path="url\(#m1-future\)">/);
});

// --- Highs, lows and extremes -----------------------------------------------

test("high and low labels: 24-hour time and one-decimal height, tagged with their time", () => {
	const { svg } = ChartSvg.buildChart(DATA, OPTS);
	assert.equal(count(svg, /class="tide-label tide-label-high"/g), 4);
	assert.equal(count(svg, /class="tide-label tide-label-low"/g), 4);
	assert.match(svg, /class="tide-label-time"[^>]*>05:44<\/tspan><tspan class="tide-label-height"[^>]*>11\.6 ft</);
	assert.match(svg, new RegExp(`class="tide-label tide-label-low" data-t="${Date.parse("2026-11-10T07:03:00Z")}"`));
});

test("labels stay inside the plot", () => {
	const { svg } = ChartSvg.buildChart(DATA, OPTS);
	for (const [, x] of svg.matchAll(/<tspan class="tide-label-[a-z]+" x="([\d.-]+)"/g)) {
		assert.ok(Number(x) >= 22 && Number(x) <= 334, `label x ${x}`);
	}
});

test("extremes: badges only for highs above / lows below the range (strictly)", () => {
	assert.equal(ChartSvg.extremeKind(13.1, [-3, 13]), "high");
	assert.equal(ChartSvg.extremeKind(13.0, [-3, 13]), null);
	assert.equal(ChartSvg.extremeKind(-3.0, [-3, 13]), null);
	assert.equal(ChartSvg.extremeKind(-3.1, [-3, 13]), "low");
	assert.equal(ChartSvg.extremeKind(-9, null), null);

	assert.equal(count(ChartSvg.buildChart(DATA, OPTS).svg, /tide-badge/g), 0);
	const { svg } = ChartSvg.buildChart(DATA, { ...OPTS, extremeRange: [-1.5, 11.6] });
	// Highs above 11.6: 11.895 (Tue 06:24). Lows below -1.5: -1.545 (Tue 23:37); -1.494 isn't.
	assert.equal(count(svg, /class="tide-badge tide-badge-high"/g), 1);
	assert.equal(count(svg, /class="tide-badge tide-badge-low"/g), 1);
	assert.match(svg, /class="tide-label tide-label-high tide-extreme tide-extreme-high"[^>]*><tspan[^>]*>06:24</);
	assert.match(svg, /class="tide-point tide-point-low tide-extreme tide-extreme-low"/);

	// The pill sits behind the height line only, sized to the height text ("11.9 ft": 7 characters).
	const pill = svg.match(/class="tide-badge tide-badge-high"[^>]*x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="17" rx="8.5"/);
	assert.ok(pill);
	assert.equal(Number(pill[3]), 7 * 7 + 10);
	const label = svg.match(/class="tide-label tide-label-high tide-extreme tide-extreme-high"[^>]*><tspan class="tide-label-time" x="([\d.-]+)" y="([\d.-]+)">[^<]*<\/tspan><tspan class="tide-label-height" x="[\d.-]+" y="([\d.-]+)">11\.9 ft</);
	assert.ok(label);
	assert.ok(Math.abs(Number(pill[2]) + 12.5 - Number(label[3])) < 0.01);
	assert.ok(Math.abs(Number(pill[1]) + Number(pill[3]) / 2 - Number(label[1])) < 0.01);
});

// --- X-axis -----------------------------------------------------------------

test("x-axis: hour labels under the six-hour ticks and the day names at the start of each day", () => {
	const { svg } = ChartSvg.buildChart(DATA, OPTS);
	const hours = [...svg.matchAll(/class="tide-hour"[^>]*>(\d\d)</g)].map((m) => m[1]);
	assert.deepEqual(hours, ["06", "12", "18", "06", "12", "18"]);
	assert.match(svg, /class="tide-day" x="4" y="394">Mon</);
	assert.match(svg, /class="tide-day" x="182" y="394">Tue</);
	assert.match(svg, /class="tide-divider" x1="178" y1="0" x2="178"/);
});

// --- Overlay ----------------------------------------------------------------

test("heights format to one decimal without -0.0", () => {
	assert.equal(ChartSvg.formatHeight(7.249, "english"), "7.2 ft");
	assert.equal(ChartSvg.formatHeight(-0.04, "english"), "0.0 ft");
	assert.equal(ChartSvg.formatHeight(2.25, "metric"), "2.3 m");
});

test("overlay: interpolated height and arrow at a known time", () => {
	const { scale } = ChartSvg.buildChart(DATA, OPTS);
	const state = ChartSvg.overlayState(scale, DATA.curve, Date.parse("2026-11-09T08:03:00Z"), "english");
	assert.ok(Math.abs(state.value - (0.286 + 0.479) / 2) < 1e-9);
	assert.equal(state.rising, true);
	assert.equal(state.label, "↑ 0.4 ft");
	assert.equal(state.labelX, state.x + 11);

	const falling = ChartSvg.overlayState(scale, DATA.curve, Date.parse("2026-11-09T15:00:00Z"), "english");
	assert.equal(falling.rising, false);
	assert.match(falling.label, /^↓ /);
});

test("overlay: hidden outside the window; label flips left near the right edge", () => {
	const { scale } = ChartSvg.buildChart(DATA, OPTS);
	assert.equal(ChartSvg.overlayState(scale, DATA.curve, DATA.start - 1, "english"), null);
	assert.equal(ChartSvg.overlayState(scale, DATA.curve, DATA.end + 1, "english"), null);
	assert.equal(ChartSvg.overlayState(scale, DATA.curve, DATA.end - 60 * 1000, "english").anchor, "end");
});

test("past width follows now and stays inside the plot", () => {
	const { scale } = ChartSvg.buildChart(DATA, OPTS);
	assert.equal(ChartSvg.pastWidth(scale, DATA.start - 1000), 0);
	assert.equal(ChartSvg.pastWidth(scale, DATA.mid), 178);
	assert.equal(ChartSvg.pastWidth(scale, DATA.end + 1000), 356);
});

// --- Observed water level ----------------------------------------------------

// Bremerton's real readings for the same window, up to Mon 23:00 PST (Nov 10, 07:00 UTC). The water ran
// about a foot above the predictions.
const OBS = parseObservations(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "obs-9445958.json"), "utf8")));
const MIN = 60 * 1000;

test("shown highs/lows: observed once clear, predicted otherwise", () => {
	const shown = ChartSvg.shownExtremes(DATA.hilo, OBS);
	assert.equal(shown.length, DATA.hilo.length);
	// Monday's three highs/lows are observed: own time and height, NOAA's kept in `predicted`.
	assert.deepEqual(shown.slice(0, 3).map((p) => [new Date(p.t).toISOString(), p.v, p.type]), [
		["2026-11-09T13:36:00.000Z", 12.608, "H"],
		["2026-11-09T18:54:00.000Z", 7.651, "L"],
		["2026-11-10T00:18:00.000Z", 11.834, "H"]
	]);
	assert.deepEqual(shown[0].predicted, { t: DATA.hilo[0].t, v: DATA.hilo[0].v });
	// 07:03 UTC low: the readings end at 07:00, still falling, so it stays predicted; and so does everything later.
	assert.deepEqual(shown.slice(3), DATA.hilo.slice(3));
	assert.equal(ChartSvg.shownExtremes(DATA.hilo, []), DATA.hilo);
});

test("shown highs/lows: an observed high needs 30 minutes of readings after it", () => {
	const high = DATA.hilo[0]; // 13:44 UTC
	const upTo = (end) => OBS.filter((p) => p.t <= end);
	const observedPeak = Date.parse("2026-11-09T13:36:00Z");
	assert.equal(ChartSvg.shownExtremes([high], upTo(observedPeak + 24 * MIN))[0], high);
	assert.equal(ChartSvg.shownExtremes([high], upTo(observedPeak + 30 * MIN))[0].t, observedPeak);
});

test("shown highs/lows: no observed value when the highest reading is at the end of the search (no turn yet)", () => {
	const high = DATA.hilo[0];
	const rising = [];
	for (let t = high.t - 90 * MIN; t <= high.t + 90 * MIN; t += 6 * MIN) rising.push({ t, v: (t - high.t) / MIN });
	assert.equal(ChartSvg.shownExtremes([high], rising)[0], high);
});

test("the observed line is one path; empty when there are no observations", () => {
	const { svg } = ChartSvg.buildChart({ ...DATA, observations: OBS }, OPTS);
	const d = /class="tide-observed" d="([^"]*)"/.exec(svg)[1];
	assert.equal(count(d, /[ML]/g), OBS.length);
	assert.equal(count(svg, /class="tide-observed"/g), 1);
	assert.match(ChartSvg.buildChart(DATA, OPTS).svg, /class="tide-observed" d=""/);
	assert.equal(ChartSvg.observedPath(null, []), "");
});

test("the height range covers the observations", () => {
	const high = OBS.map((p) => ({ ...p, v: p.v + 10 }));
	const { scale } = ChartSvg.buildChart({ ...DATA, observations: high }, OPTS);
	assert.equal(scale.max, Math.max(...high.map((p) => p.v)));
});

test("an observed high/low gets a dotted connector to the predicted one, and its label goes outside both", () => {
	const shown = ChartSvg.shownExtremes(DATA.hilo, OBS);
	const { svg, scale } = ChartSvg.buildChart({ ...DATA, hilo: shown, observations: OBS }, OPTS);
	assert.equal(count(svg, /class="tide-connector"/g), 3);
	const y = (v) => ChartSvg.yOf(scale, v);
	const labelLine2 = (t) => Number(new RegExp(`data-t="${t}" text-anchor="middle"><tspan[^>]*>[^<]*<\/tspan><tspan class="tide-label-height" x="[0-9.]+" y="([0-9.-]+)"`).exec(svg)[1]);

	// 13:36 high, observed 12.6 above predicted 11.6: label above the observed point.
	assert.ok(Math.abs(labelLine2(shown[0].t) - (y(12.608) - 6)) < 0.1);
	// 18:54 low, observed 7.7 above predicted 7.0: label below the predicted (lower) point.
	assert.ok(Math.abs(labelLine2(shown[1].t) - (y(7.015) + 30)) < 0.1);
	assert.match(svg, /class="tide-label-height"[^>]*>12\.6 ft</);
	const connector = /class="tide-connector" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/.exec(svg).slice(1).map(Number);
	assert.ok(Math.abs(connector[0] - ChartSvg.xOf(scale, DATA.hilo[0].t)) < 0.1);
	assert.ok(Math.abs(connector[1] - y(DATA.hilo[0].v)) < 0.1);
	assert.ok(Math.abs(connector[3] - y(12.608)) < 0.1);
});

test("a high observed below its prediction is labeled above the predicted point", () => {
	const high = { ...DATA.hilo[0], v: 10, predicted: { t: DATA.hilo[0].t, v: 11.557 } };
	const { svg, scale } = ChartSvg.buildChart({ ...DATA, hilo: [high] }, OPTS);
	const line2 = Number(/<tspan class="tide-label-height" x="[\d.]+" y="([\d.-]+)"/.exec(svg)[1]);
	assert.ok(Math.abs(line2 - (ChartSvg.yOf(scale, 11.557) - 6)) < 0.1);
});

test("badges follow the shown (observed) value", () => {
	const shown = ChartSvg.shownExtremes(DATA.hilo, OBS);
	// Predicted 11.557 is inside [-3, 12]; observed 12.608 is above it.
	const { svg } = ChartSvg.buildChart({ ...DATA, hilo: shown }, { ...OPTS, extremeRange: [-3, 12] });
	assert.match(svg, new RegExp(`class="tide-badge tide-badge-high" data-t="${shown[0].t}"`));
});

test("overlay: the current value is the latest observation if under an hour old, else the prediction", () => {
	const { scale } = ChartSvg.buildChart(DATA, OPTS);
	const now = Date.parse("2026-11-09T15:00:00Z");
	const predicted = ChartSvg.overlayState(scale, DATA.curve, now, "english");
	const fresh = ChartSvg.overlayState(scale, DATA.curve, now, "english", { t: now - 20 * MIN, v: 12.34 });
	assert.equal(fresh.value, 12.34);
	assert.equal(fresh.label, "↓ 12.3 ft"); // the arrow still follows the predicted curve (falling here)
	assert.ok(Math.abs(fresh.y - ChartSvg.yOf(scale, 12.34)) < 1e-9);
	const old = ChartSvg.overlayState(scale, DATA.curve, now, "english", { t: now - 61 * MIN, v: 12.34 });
	assert.equal(old.value, predicted.value);
});

test("note when the latest observation is more than 6 hours old", () => {
	const latest = Date.parse("2026-11-09T16:12:00Z"); // Mon 08:12 PST
	assert.equal(ChartSvg.observationNote(latest, latest + 6 * 60 * MIN, LA), "");
	assert.equal(ChartSvg.observationNote(latest, latest + 6 * 60 * MIN + 1, LA), "Observations not updated since Mon 08:12");
	assert.equal(ChartSvg.observationNote(null, latest, LA), "");
});

// --- ETSS surge forecast -----------------------------------------------------

// A stand-in ETSS curve: the prediction plus 1.5 ft.
const ETSS = DATA.curve.map((p) => ({ t: p.t, v: p.v + 1.5 }));

test("shown highs/lows: the ETSS high/low (marked) where nothing is observed yet; observed ones win", () => {
	const etssOnly = ChartSvg.shownExtremes(DATA.hilo, [], ETSS);
	assert.ok(etssOnly.every((p, i) => p.etss && p.predicted.v === DATA.hilo[i].v && Math.abs(p.v - (DATA.hilo[i].v + 1.5)) < 0.05));

	const both = ChartSvg.shownExtremes(DATA.hilo, OBS, ETSS);
	assert.equal(both.filter((p) => p.etss).length, 5); // Monday's first three are observed (see above)
	assert.deepEqual(both.slice(0, 3), ChartSvg.shownExtremes(DATA.hilo, OBS).slice(0, 3));
	assert.equal(ChartSvg.shownExtremes(DATA.hilo, [], null), DATA.hilo);
});

test("ETSS labels get * right after the number, a connector, and badges by the ETSS value", () => {
	const shown = ChartSvg.shownExtremes(DATA.hilo, [], ETSS);
	const { svg } = ChartSvg.buildChart({ ...DATA, hilo: shown, etss: ETSS }, { ...OPTS, extremeRange: [-3, 13] });
	assert.match(svg, /class="tide-label-height"[^>]*>13\.1\* ft</); // Mon 05:44 high: predicted 11.6
	assert.equal(count(svg, /\* ft</g), 8);
	assert.equal(count(svg, /class="tide-connector"/g), 8);
	assert.equal(count(svg, /class="tide-badge tide-badge-high"/g), 2); // 13.1 and 13.4 are above 13
	assert.equal(ChartSvg.formatHeight(-0.04, "metric", "*"), "0.0* m");
});

test("the ETSS line: one dashed path drawn from now on (future clip); empty when not shown; covered by the range", () => {
	const { svg, scale } = ChartSvg.buildChart({ ...DATA, etss: ETSS }, OPTS);
	const d = /class="tide-etss" clip-path="url\(#m1-future\)" d="([^"]*)"/.exec(svg)[1];
	assert.equal(count(d, /[ML]/g), ETSS.length);
	assert.equal(scale.max, Math.max(...ETSS.map((p) => p.v)));
	assert.match(ChartSvg.buildChart(DATA, OPTS).svg, /class="tide-etss" clip-path="url\(#m1-future\)" d=""/);
	assert.equal(ChartSvg.etssPath(null, null), "");
});

test("ETSS is shown when a coming high or low differs by at least the threshold, either way", () => {
	const start = DATA.start;
	assert.equal(ChartSvg.etssShown(DATA.hilo, ETSS, start, 1.5), true);
	assert.equal(ChartSvg.etssShown(DATA.hilo, ETSS, start, 1.6), false);
	const lower = DATA.curve.map((p) => ({ t: p.t, v: p.v - 1.5 }));
	assert.equal(ChartSvg.etssShown(DATA.hilo, lower, start, 1.5), true);
	// Only highs/lows still ahead count: after the last one, nothing.
	assert.equal(ChartSvg.etssShown(DATA.hilo, ETSS, DATA.hilo[DATA.hilo.length - 1].t + 1, 1), false);
	// Lows count too: raise only the curve around the last low (Tue 23:37 PST), by 2 ft.
	const last = DATA.hilo[DATA.hilo.length - 1];
	const lowOnly = DATA.curve.map((p) => ({ t: p.t, v: p.v + (Math.abs(p.t - last.t) <= 3 * 60 * MIN ? 2 : 0) }));
	assert.equal(last.type, "L");
	assert.equal(ChartSvg.etssShown(DATA.hilo, lowOnly, start, 1.9), true);
	assert.equal(ChartSvg.etssShown(DATA.hilo, ETSS, start, null), false);
	assert.equal(ChartSvg.etssShown(DATA.hilo, null, start, 1), false);
});
