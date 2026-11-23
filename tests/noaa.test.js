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

test("station name comes from NOAA's station metadata", () => {
	assert.equal(noaa.stationUrl("9445958"), "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9445958.json");
	assert.equal(noaa.parseStationName(fixture("station-9445958.json")), "Bremerton, WA");
	assert.equal(noaa.parseStationName({ stations: [{ name: "Somewhere" }] }), "Somewhere");
	assert.equal(noaa.parseStationName({}), null);
});

// Eagle Harbor, Bainbridge Island: a subordinate station of Seattle (9447130). Fixtures cover Nov 22–23, 2026.
const EAGLE = { ...CONFIG, stationID: "9445882" };
const EAGLE_NOW = Date.parse("2026-11-22T20:00:00Z");
const BREMERTON_NOW = Date.parse("2026-11-09T23:30:00Z");

/**
 * A stand-in for NOAA serving the fixtures: station records, offsets, and predictions by station and interval.
 * `fail(url)` → true makes that request an HTTP 500; `override` replaces a fixture's contents by file name.
 */
function fakeNoaa ({ fail = () => false, override = {} } = {}) {
	const requested = [];
	const fetchFn = async (url) => {
		requested.push(url);
		if (fail(url)) return { ok: false, status: 500, json: async () => ({}) };
		let name;
		const meta = /\/stations\/(\d+)(\/tidepredoffsets)?\.json$/.exec(url);
		if (meta) {
			name = `${meta[2] ? "offsets" : "station"}-${meta[1]}.json`;
		} else {
			const params = new URL(url).searchParams;
			const kind = params.get("product") === "water_level" ? "obs" : params.get("interval") === "hilo" ? "hilo" : "curve";
			name = `${kind}-${params.get("station")}.json`;
		}
		const json = name in override ? override[name] : fixture(name);
		return { ok: true, status: 200, json: async () => json };
	};
	const count = (pattern) => requested.filter((url) => pattern.test(url)).length;
	return { requested, fetchFn, count };
}

const STATION_REQUEST = /\/mdapi\//;
const isOffsets = (url) => url.endsWith("/tidepredoffsets.json");

test("offsets say whether a station is subordinate, and give its reference station and corrections", () => {
	assert.equal(noaa.offsetsUrl("9445882"), "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9445882/tidepredoffsets.json");
	assert.deepEqual(noaa.parseOffsets(fixture("offsets-9445882.json"), "9445882"), {
		referenceID: "9447130",
		timeHigh: 4,
		timeLow: 5,
		ratioHigh: 1,
		ratioLow: 1.02
	});
	assert.equal(noaa.parseOffsets(fixture("offsets-9445958.json"), "9445958"), null); // Bremerton has its own predictions
});

test("added-feet (\"A\") offsets and incomplete offsets are errors", () => {
	const eagle = fixture("offsets-9445882.json");
	assert.throws(() => noaa.parseOffsets({ ...eagle, heightAdjustedType: "A" }, "9445882"),
		/Station 9445882 is a subordinate station whose heights are corrected by adding a fixed amount to reference station 9447130's \("A" offsets\)\. Only .*\("R" offsets\) are supported/);
	assert.throws(() => noaa.parseOffsets({ ...eagle, heightOffsetLowTide: null }, "9445882"), /incomplete tide-prediction offsets/);
	assert.throws(() => noaa.parseOffsets({ ...eagle, refStationId: "" }, "9445882"), /incomplete tide-prediction offsets/);
});

test("the startup step gets the name and the offsets", async () => {
	const { fetchFn, count } = fakeNoaa();
	const eagle = await noaa.fetchStation(EAGLE, fetchFn);
	assert.equal(eagle.stationName, "Eagle Harbor, Bainbridge Island, WA");
	assert.equal(eagle.offsets.referenceID, "9447130");
	const bremerton = await noaa.fetchStation(CONFIG, fetchFn);
	assert.deepEqual(bremerton, { stationName: "Bremerton, WA", offsets: null });
	assert.equal(count(STATION_REQUEST), 4);
});

test("the startup step fails if either request fails", async () => {
	await assert.rejects(noaa.fetchStation(CONFIG, fakeNoaa({ fail: isOffsets }).fetchFn), /HTTP 500/);
	await assert.rejects(noaa.fetchStation(CONFIG, fakeNoaa({ fail: (url) => url.endsWith("/9445958.json") }).fetchFn), /HTTP 500/);
});

test("a station record without a name gives no name (the page then shows the station ID)", async () => {
	const { fetchFn } = fakeNoaa({ override: { "station-9445958.json": { stations: [{}] } } });
	const station = await noaa.fetchStation(CONFIG, fetchFn);
	assert.equal(station.stationName, null);
});

test("a subordinate station with a datum other than MLLW is an error; other stations may use any datum", async () => {
	const { fetchFn } = fakeNoaa();
	await assert.rejects(noaa.fetchStation({ ...EAGLE, datum: "MSL" }, fetchFn),
		/Station 9445882 is a subordinate station: NOAA publishes its predictions only with datum "MLLW", but the config sets datum "MSL"/);
	const bremerton = await noaa.fetchStation({ ...CONFIG, datum: "MSL" }, fetchFn);
	assert.equal(bremerton.offsets, null);
});

test("a station with its own predictions: the daily fetch makes the same two requests as before", async () => {
	const { requested, fetchFn } = fakeNoaa();
	const data = await noaa.fetchTides(CONFIG, { stationName: "Bremerton, WA", offsets: null }, BREMERTON_NOW, fetchFn);
	assert.deepEqual(requested, Object.values(noaa.buildUrls(CONFIG, data.start, data.end)));
	assert.equal(data.stationName, "Bremerton, WA");
	assert.equal(data.modeled, false);
	assert.equal(data.start, Date.parse("2026-11-09T08:00:00Z"));
	assert.equal(data.mid, Date.parse("2026-11-10T08:00:00Z"));
	assert.equal(data.end, Date.parse("2026-11-11T08:00:00Z"));
	assert.deepEqual(data.curve, noaa.parsePredictions(fixture("curve-9445958.json")));
	assert.deepEqual(data.hilo, noaa.parsePredictions(fixture("hilo-9445958.json")));
	assert.equal(data.stationID, "9445958");
	assert.equal(data.units, "english");
});

test("a subordinate station: its own highs and lows, and a curve modeled from the reference station", async () => {
	const { requested, fetchFn } = fakeNoaa();
	const station = await noaa.fetchStation(EAGLE, fetchFn);
	requested.length = 0;
	const data = await noaa.fetchTides(EAGLE, station, EAGLE_NOW, fetchFn);

	// Requests: Eagle Harbor's highs/lows over the window; Seattle's curve and highs/lows with a day's margin.
	const own = noaa.buildUrls(EAGLE, data.start, data.end);
	const ref = noaa.buildUrls({ ...EAGLE, stationID: "9447130" }, data.start - noaa.REFERENCE_MARGIN_MS, data.end + noaa.REFERENCE_MARGIN_MS);
	assert.deepEqual(requested, [own.hilo, ref.curve, ref.hilo]);
	assert.equal(new URL(ref.curve).searchParams.get("begin_date"), "20261121 08:00");
	assert.equal(new URL(ref.curve).searchParams.get("end_date"), "20261125 08:00");

	assert.equal(data.modeled, true);
	assert.equal(data.stationName, "Eagle Harbor, Bainbridge Island, WA");
	assert.deepEqual(data.hilo, noaa.parsePredictions(fixture("hilo-9445882.json")));
	assert.equal(data.curve[0].t, data.start);
	assert.equal(data.curve[data.curve.length - 1].t, data.end);

	// The modeled curve passes through every one of NOAA's published Eagle Harbor highs and lows.
	for (const p of data.hilo) {
		const i = data.curve.findIndex((c) => c.t >= p.t);
		const a = data.curve[i - 1];
		const b = data.curve[i];
		const v = a.v + ((b.v - a.v) * (p.t - a.t)) / (b.t - a.t);
		assert.ok(Math.abs(v - p.v) < 0.02, `${new Date(p.t).toISOString()}: curve ${v.toFixed(3)}, NOAA ${p.v}`);
	}
});

test("a subordinate station fails, with no fallback, if any of its requests fails", async () => {
	const station = await noaa.fetchStation(EAGLE, fakeNoaa().fetchFn);
	for (const failing of ["9447130", "9445882"]) {
		for (const interval of ["hilo", null]) {
			if (failing === "9445882" && interval === null) continue; // Eagle Harbor's curve isn't requested
			const fail = (url) => !STATION_REQUEST.test(url) && new URL(url).searchParams.get("station") === failing
				&& new URL(url).searchParams.get("interval") === interval;
			await assert.rejects(noaa.fetchTides(EAGLE, station, EAGLE_NOW, fakeNoaa({ fail }).fetchFn), /HTTP 500/);
		}
	}
});

test("the tide source runs the startup step once, then only the daily requests", async () => {
	for (const [config, now] of [[CONFIG, BREMERTON_NOW], [EAGLE, EAGLE_NOW]]) {
		const { fetchFn, count } = fakeNoaa();
		const fetchData = noaa.createTideSource(config, fetchFn);
		for (let day = 0; day < 3; day++) await fetchData(now);
		assert.equal(count(STATION_REQUEST), 2, config.stationID);
	}
});

test("the tide source retries the startup step on the next fetch after it fails", async () => {
	let down = true;
	const { fetchFn, count } = fakeNoaa({ fail: (url) => down && isOffsets(url) });
	const fetchData = noaa.createTideSource(EAGLE, fetchFn);
	await assert.rejects(fetchData(EAGLE_NOW), /HTTP 500/);
	down = false;
	const data = await fetchData(EAGLE_NOW);
	assert.equal(data.modeled, true);
	await fetchData(EAGLE_NOW);
	assert.equal(count(STATION_REQUEST), 4); // two for the failed try, two for the one that worked, none after
});

test("the tide source keeps retrying a permanent error like any other", async () => {
	const { fetchFn, count } = fakeNoaa();
	const fetchData = noaa.createTideSource({ ...EAGLE, datum: "MHHW" }, fetchFn);
	await assert.rejects(fetchData(EAGLE_NOW), /only with datum "MLLW"/);
	await assert.rejects(fetchData(EAGLE_NOW), /only with datum "MLLW"/);
	assert.equal(count(STATION_REQUEST), 4);
});

test("fetchTides fails on an HTTP error", async () => {
	const fakeFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
	await assert.rejects(noaa.fetchTides(CONFIG, { stationName: null, offsets: null }, Date.now(), fakeFetch), /HTTP 503/);
});

// --- Observed water level ----------------------------------------------------

// Fixtures: Bremerton's readings over its window up to Nov 10, 07:00 UTC; Seattle's (Eagle Harbor's reference)
// from a day before Eagle Harbor's window up to Nov 22, 20:00 UTC; and NOAA's answer for a station without a sensor.
const BREMERTON_OBS_NOW = Date.parse("2026-11-10T07:00:00Z"); // Mon 23:00 PST

test("the observation URL asks for UTC water levels from start to now", () => {
	const url = new URL(noaa.buildObservationUrl(CONFIG, Date.parse("2026-11-09T08:00:00Z"), BREMERTON_OBS_NOW));
	assert.equal(`${url.origin}${url.pathname}`, noaa.API_BASE);
	assert.equal(url.searchParams.get("product"), "water_level");
	assert.equal(url.searchParams.get("begin_date"), "20261109 08:00");
	assert.equal(url.searchParams.get("end_date"), "20261110 07:00");
	assert.equal(url.searchParams.get("station"), "9445958");
	assert.equal(url.searchParams.get("datum"), "MLLW");
	assert.equal(url.searchParams.get("time_zone"), "gmt");
	assert.equal(url.searchParams.get("units"), "english");
	assert.equal(url.searchParams.get("format"), "json");
});

test("parses observations, skipping readings with no value", () => {
	const obs = noaa.parseObservations(fixture("obs-9445958.json"));
	assert.equal(obs.length, 231);
	assert.deepEqual(obs[0], { t: Date.parse("2026-11-09T08:00:00Z"), v: Number(fixture("obs-9445958.json").data[0].v) });
	assert.equal(obs[230].t, BREMERTON_OBS_NOW);
	const gappy = { data: [{ t: "2026-11-09 08:00", v: "1.5" }, { t: "2026-11-09 08:06", v: "" }, { t: "2026-11-09 08:12", v: "1.7" }] };
	assert.deepEqual(noaa.parseObservations(gappy).map((p) => p.v), [1.5, 1.7]);
});

test("a station without observations, and other NOAA errors, become errors", () => {
	assert.throws(() => noaa.parseObservations(fixture("obs-error.json")), /NOAA: There is no MLLW for the station: 9445882/);
	assert.throws(() => noaa.parseObservations({}), /no water level data/);
});

test("a station with a sensor: one request, from the window's start to now", async () => {
	const { requested, fetchFn } = fakeNoaa();
	const result = await noaa.fetchObservations(CONFIG, { stationName: "Bremerton, WA", offsets: null }, BREMERTON_OBS_NOW, fetchFn);
	assert.deepEqual(requested, [noaa.buildObservationUrl(CONFIG, Date.parse("2026-11-09T08:00:00Z"), BREMERTON_OBS_NOW)]);
	assert.equal(result.stationID, "9445958");
	assert.equal(result.start, Date.parse("2026-11-09T08:00:00Z"));
	assert.equal(result.end, Date.parse("2026-11-11T08:00:00Z"));
	assert.deepEqual(result.observations, noaa.parseObservations(fixture("obs-9445958.json")));
});

test("a subordinate station: the reference station's observations with the same corrections", async () => {
	const { requested, fetchFn } = fakeNoaa();
	const station = await noaa.fetchStation(EAGLE, fetchFn);
	requested.length = 0;
	const result = await noaa.fetchObservations(EAGLE, station, EAGLE_NOW, fetchFn);

	// Seattle's readings from a day before the window, and Seattle's highs/lows (for the corrections).
	const refConfig = { ...EAGLE, stationID: "9447130" };
	assert.deepEqual(requested, [
		noaa.buildObservationUrl(refConfig, result.start - noaa.REFERENCE_MARGIN_MS, EAGLE_NOW),
		noaa.buildUrls(refConfig, result.start - noaa.REFERENCE_MARGIN_MS, result.end + noaa.REFERENCE_MARGIN_MS).hilo
	]);
	assert.equal(result.stationID, "9445882");

	// Trimmed to the window's start … now; each reading 4–5 minutes later and ×1.00–1.02 (Eagle Harbor's corrections).
	const obs = result.observations;
	assert.ok(obs.length > 100);
	assert.ok(obs.every((p) => p.t >= result.start && p.t <= EAGLE_NOW));
	const seattle = noaa.parseObservations(fixture("obs-9447130.json"));
	const noon = seattle.find((p) => p.t === Date.parse("2026-11-22T12:00:00Z"));
	const moved = obs.find((p) => p.t >= noon.t + 4 * 60000 && p.t <= noon.t + 5 * 60000);
	assert.ok(moved, "Seattle's 12:00 reading appears 4–5 minutes later");
	assert.ok(moved.v >= noon.v * 1.0 - 1e-9 && moved.v <= noon.v * 1.02 + 1e-9);
});

test("an observation fetch fails if its request fails", async () => {
	const { fetchFn } = fakeNoaa({ override: { "obs-9445958.json": fixture("obs-error.json") } });
	await assert.rejects(noaa.fetchObservations(CONFIG, { stationName: null, offsets: null }, BREMERTON_OBS_NOW, fetchFn), /There is no MLLW/);
	const failing = fakeNoaa({ fail: (url) => /water_level/.test(url) });
	const station = await noaa.fetchStation(EAGLE, failing.fetchFn);
	await assert.rejects(noaa.fetchObservations(EAGLE, station, EAGLE_NOW, failing.fetchFn), /HTTP 500/);
});

test("the daily and observation fetches share one startup step, even when they start together", async () => {
	const { fetchFn, count } = fakeNoaa();
	const loadStation = noaa.createStationLoader(CONFIG, fetchFn);
	const tides = noaa.createTideSource(CONFIG, fetchFn, loadStation);
	const observations = noaa.createObservationSource(CONFIG, fetchFn, loadStation);
	await Promise.all([tides(BREMERTON_OBS_NOW), observations(BREMERTON_OBS_NOW)]);
	await observations(BREMERTON_OBS_NOW);
	assert.equal(count(STATION_REQUEST), 2); // the station record and its offsets, once
});
