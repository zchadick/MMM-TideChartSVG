"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const ChartSvg = require("../lib/chartSvg.js");
const { parsePredictions } = require("../lib/noaa.js");

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
