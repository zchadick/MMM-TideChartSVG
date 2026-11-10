"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const noaa = require("../lib/noaa.js");

function fixture (name) {
	return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

const CONFIG = { stationID: "9445958", datum: "MLLW", units: "english", timezone: "America/Los_Angeles" };

test("URLs ask for UTC predictions over the window, with and without interval=hilo", () => {
	const urls = noaa.buildUrls(CONFIG, Date.parse("2026-11-09T08:00:00Z"), Date.parse("2026-11-11T08:00:00Z"));
	const curve = new URL(urls.curve);
	assert.equal(`${curve.origin}${curve.pathname}`, noaa.API_BASE);
	assert.equal(curve.searchParams.get("begin_date"), "20261109 08:00");
	assert.equal(curve.searchParams.get("end_date"), "20261111 08:00");
	assert.equal(curve.searchParams.get("station"), "9445958");
	assert.equal(curve.searchParams.get("product"), "predictions");
	assert.equal(curve.searchParams.get("datum"), "MLLW");
	assert.equal(curve.searchParams.get("time_zone"), "gmt");
	assert.equal(curve.searchParams.get("units"), "english");
	assert.equal(curve.searchParams.get("format"), "json");
	assert.equal(curve.searchParams.get("interval"), null);
	assert.equal(new URL(urls.hilo).searchParams.get("interval"), "hilo");
});

test("parses the 6-minute curve", () => {
	const curve = noaa.parsePredictions(fixture("curve-9445958.json"));
	assert.equal(curve.length, 481);
	assert.deepEqual(curve[0], { t: Date.parse("2026-11-09T08:00:00Z"), v: 0.286 });
	assert.equal(curve[480].t, Date.parse("2026-11-11T08:00:00Z"));
});

test("parses highs and lows with their type", () => {
	const hilo = noaa.parsePredictions(fixture("hilo-9445958.json"));
	assert.equal(hilo.length, 8);
	assert.deepEqual(hilo[0], { t: Date.parse("2026-11-09T13:44:00Z"), v: 11.557, type: "H" });
	assert.deepEqual(hilo[3], { t: Date.parse("2026-11-10T07:03:00Z"), v: -1.494, type: "L" });
});

test("NOAA error responses become errors", () => {
	assert.throws(() => noaa.parsePredictions(fixture("error.json")), /NOAA: The station is not a valid station/);
	assert.throws(() => noaa.parsePredictions({}), /no predictions/);
});

test("fetchTides fetches both feeds for the local two-day window", async () => {
	const requested = [];
	const fakeFetch = async (url) => {
		requested.push(url);
		const name = url.includes("interval=hilo") ? "hilo-9445958.json" : "curve-9445958.json";
		return { ok: true, status: 200, json: async () => fixture(name) };
	};
	const data = await noaa.fetchTides(CONFIG, Date.parse("2026-11-09T23:30:00Z"), fakeFetch);
	assert.equal(requested.length, 2);
	assert.equal(data.start, Date.parse("2026-11-09T08:00:00Z"));
	assert.equal(data.mid, Date.parse("2026-11-10T08:00:00Z"));
	assert.equal(data.end, Date.parse("2026-11-11T08:00:00Z"));
	assert.equal(data.curve.length, 481);
	assert.equal(data.hilo.length, 8);
	assert.equal(data.stationID, "9445958");
	assert.equal(data.units, "english");
});

test("fetchTides fails on an HTTP error", async () => {
	const fakeFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
	await assert.rejects(noaa.fetchTides(CONFIG, Date.now(), fakeFetch), /HTTP 503/);
});
