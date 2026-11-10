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
const OPTS = { width: 400, height: 400, timezone: LA, units: "english" };

function count (svg, pattern) {
	return (svg.match(pattern) || []).length;
}

test("chart is one SVG with a single curve path and a small number of elements", () => {
	const { svg } = ChartSvg.buildChart(DATA, OPTS);
	assert.match(svg, /^<svg [^>]*width="400" height="400" viewBox="0 0 400 400">/);
	assert.match(svg, /<\/svg>$/);
	assert.equal(count(svg, /class="tide-curve"/g), 1);
	assert.equal(count(svg, /class="tide-fill"/g), 1);
	// Fixed parts + 2 elements per high/low; well under one element per data point.
	assert.ok(count(svg, /<(path|line|circle|text|tspan|g)\b/g) < 60);
});

test("curve spans the full width, from window start to end", () => {
	const { svg } = ChartSvg.buildChart(DATA, OPTS);
	const d = /class="tide-curve" d="([^"]+)"/.exec(svg)[1];
	assert.match(d, /^M0,/);
	assert.match(d, / L400,[\d.]+$/);
	assert.equal(count(d, /[ML]/g), DATA.curve.length);
});

test("high and low labels show 24-hour time and one-decimal height", () => {
	const { svg } = ChartSvg.buildChart(DATA, OPTS);
	assert.equal(count(svg, /class="tide-label tide-label-high"/g), 4);
	assert.equal(count(svg, /class="tide-label tide-label-low"/g), 4);
	assert.match(svg, />05:44<\/tspan><tspan [^>]*>11\.6 ft</); // 13:44 UTC = 05:44 PST
	assert.match(svg, />23:03<\/tspan><tspan [^>]*>-1\.5 ft</);
});

test("day names and the midnight divider", () => {
	const { svg } = ChartSvg.buildChart(DATA, OPTS);
	assert.match(svg, />Mon<\/text>/);
	assert.match(svg, />Tue<\/text>/);
	assert.match(svg, /class="tide-divider" x1="200" y1="0" x2="200"/);
});

test("labels stay inside the chart's width", () => {
	const { svg } = ChartSvg.buildChart(DATA, OPTS);
	for (const [, x] of svg.matchAll(/<tspan x="([\d.-]+)"/g)) {
		assert.ok(Number(x) >= 22 && Number(x) <= 378, `label x ${x}`);
	}
});

test("heights format to one decimal without -0.0", () => {
	assert.equal(ChartSvg.formatHeight(7.249, "english"), "7.2 ft");
	assert.equal(ChartSvg.formatHeight(-0.04, "english"), "0.0 ft");
	assert.equal(ChartSvg.formatHeight(2.25, "metric"), "2.3 m");
});

test("overlay: position and interpolated height at a known time", () => {
	const { scale } = ChartSvg.buildChart(DATA, OPTS);
	const now = Date.parse("2026-11-09T08:03:00Z"); // halfway between the first two points
	const state = ChartSvg.overlayState(scale, DATA.curve, now, "english");
	assert.ok(Math.abs(state.value - (0.286 + 0.479) / 2) < 1e-9);
	assert.equal(state.rising, true);
	assert.ok(state.x > 0 && state.x < 1);
	assert.equal(state.label, "↑ 0.4 ft");
});

test("overlay: falling arrow after a high", () => {
	const { scale } = ChartSvg.buildChart(DATA, OPTS);
	const state = ChartSvg.overlayState(scale, DATA.curve, Date.parse("2026-11-09T15:00:00Z"), "english");
	assert.equal(state.rising, false);
	assert.match(state.label, /^↓ /);
});

test("overlay: hidden outside the window; label flips left near the right edge", () => {
	const { scale } = ChartSvg.buildChart(DATA, OPTS);
	assert.equal(ChartSvg.overlayState(scale, DATA.curve, DATA.start - 1, "english"), null);
	assert.equal(ChartSvg.overlayState(scale, DATA.curve, DATA.end + 1, "english"), null);
	const late = ChartSvg.overlayState(scale, DATA.curve, DATA.end - 60 * 1000, "english");
	assert.equal(late.anchor, "end");
});
