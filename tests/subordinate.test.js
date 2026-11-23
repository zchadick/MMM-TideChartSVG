"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { modelCurve, correctPoints } = require("../lib/subordinate.js");
const noaa = require("../lib/noaa.js");

const H = 60 * 60 * 1000;
const MIN = 60 * 1000;

// A made-up parent: high 10 ft at 0 h, low 2 ft at 6 h, high 10 ft at 12 h; a curve point every hour.
const HILO = [{ t: 0, v: 10, type: "H" }, { t: 6 * H, v: 2, type: "L" }, { t: 12 * H, v: 10, type: "H" }];
const CURVE = [];
for (let h = 0; h <= 12; h++) CURVE.push({ t: h * H, v: 6 + 4 * Math.cos((Math.PI * h) / 6) });
// Exaggerated corrections so the blend is easy to see: highs +10 min ×1, lows +30 min ×2.
const OFFSETS = { timeHigh: 10, timeLow: 30, ratioHigh: 1, ratioLow: 2 };

function fixture (name) {
	return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

test("at a high and a low, the point gets exactly that tide's correction", () => {
	const curve = modelCurve(CURVE, HILO, OFFSETS, 10 * MIN, 12 * H);
	assert.deepEqual(curve[0], { t: 10 * MIN, v: 10 }); // the high: +10 min, ×1
	assert.ok(curve.some((p) => p.t === 6 * H + 30 * MIN && p.v === 4)); // the low: +30 min, ×2
});

test("between a high and a low, the correction is blended by time", () => {
	const curve = modelCurve(CURVE, HILO, OFFSETS, 10 * MIN, 12 * H);
	// 3 h is halfway in time from the high to the low: +20 min and ×1.5 on the parent's 6 ft.
	const half = curve.find((p) => p.t === 3 * H + 20 * MIN);
	assert.ok(half);
	assert.ok(Math.abs(half.v - 9) < 1e-9);
	// 1 h is a sixth of the way: +10 + 20/6 min, and ×(1 + 1/6).
	const sixth = curve.find((p) => Math.abs(p.t - (H + (10 + 20 / 6) * MIN)) < 1);
	assert.ok(sixth);
	assert.ok(Math.abs(sixth.v - (6 + 4 * Math.cos(Math.PI / 6)) * (7 / 6)) < 1e-9);
});

test("the curve starts and ends exactly at the window's edges, interpolated, with nothing outside", () => {
	const start = 2 * H;
	const end = 10 * H;
	const curve = modelCurve(CURVE, HILO, OFFSETS, start, end);
	assert.equal(curve[0].t, start);
	assert.equal(curve[curve.length - 1].t, end);
	for (let i = 1; i < curve.length; i++) assert.ok(curve[i].t > curve[i - 1].t);
	// 2 h lies between the parent's 1 h and 2 h points once shifted; it's interpolated between them.
	const parent = (h) => 6 + 4 * Math.cos((Math.PI * h) / 6);
	const t1 = H + (10 + 20 / 6) * MIN;
	const v1 = parent(1) * (7 / 6);
	const t2 = 2 * H + (10 + 40 / 6) * MIN;
	const v2 = parent(2) * (8 / 6);
	assert.ok(Math.abs(curve[0].v - (v1 + ((v2 - v1) * (start - t1)) / (t2 - t1))) < 1e-9);
	assert.ok(curve.every((p) => p.t >= start && p.t <= end));
});

test("fails rather than draw a partial curve when the parent's data doesn't cover the window", () => {
	assert.throws(() => modelCurve(CURVE, HILO, OFFSETS, 0, 12 * H), /don't cover the whole chart/); // starts before the first shifted point
	assert.throws(() => modelCurve(CURVE, HILO, OFFSETS, H, 13 * H), /don't cover the whole chart/);
	assert.throws(() => modelCurve([], HILO, OFFSETS, H, 2 * H), /don't cover the whole chart/);
});

test("with Seattle's real data, the one-day margin covers the window even for 3-hour offsets", () => {
	const refCurve = noaa.parsePredictions(fixture("curve-9447130.json"));
	const refHilo = noaa.parsePredictions(fixture("hilo-9447130.json"));
	const start = Date.parse("2026-11-22T08:00:00Z");
	const end = Date.parse("2026-11-24T08:00:00Z");
	for (const shift of [180, -180]) {
		const curve = modelCurve(refCurve, refHilo, { timeHigh: shift, timeLow: shift, ratioHigh: 1, ratioLow: 1 }, start, end);
		assert.equal(curve[0].t, start);
		assert.equal(curve[curve.length - 1].t, end);
	}
});

test("correctPoints corrects any points (e.g. observations), without needing them to cover a window", () => {
	const observed = [{ t: 0, v: 11 }, { t: 3 * H, v: 7 }]; // up to "now", 3 h in
	const corrected = correctPoints(observed, HILO, OFFSETS);
	assert.deepEqual(corrected[0], { t: 10 * MIN, v: 11 }); // at the high: +10 min, ×1
	assert.equal(corrected[1].t, 3 * H + 20 * MIN); // halfway to the low: +20 min, ×1.5
	assert.ok(Math.abs(corrected[1].v - 10.5) < 1e-9);
	assert.deepEqual(correctPoints([{ t: 13 * H, v: 5 }], HILO, OFFSETS), []); // after the last high/low: dropped
});
