"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const etss = require("../lib/etss.js");
const noaa = require("../lib/noaa.js");
const TideTime = require("../lib/tideTime.js");

function fixtureText (name) {
	return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

function fixture (name) {
	return JSON.parse(fixtureText(name));
}

// Fixtures: ETSS 2.0's station list (header and the Washington rows) and Seattle's ETSS data (Nov 21–26, 2026,
// fetched Nov 23 01:00 UTC); NOAA's records for Seattle, Bremerton and Eagle Harbor.
const SEATTLE = { stationID: "9447130", datum: "MLLW", units: "english", timezone: "America/Los_Angeles", etss: { station: null } };
const EAGLE = { ...SEATTLE, stationID: "9445882" };
const BREMERTON = { ...SEATTLE, stationID: "9445958" };
const NOW = Date.parse("2026-11-22T20:00:00Z"); // Sun 12:00 PST: the window is Nov 22 08:00 → Nov 24 08:00 UTC
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** A stand-in for NOAA and ETSS serving the fixtures. */
function fakeServers ({ fail = () => false } = {}) {
	const requested = [];
	const fetchFn = async (url, options = {}) => {
		const st = options.body ? options.body.get("st") : null;
		requested.push(st ? `${url} st=${st}` : url);
		if (fail(url, st)) return { ok: false, status: 500, json: async () => ({}), text: async () => "" };
		let body;
		if (url === etss.STATION_LIST_URL) body = fixtureText("etss-master.csv");
		else if (url === etss.DATA_URL) body = st === "9447130" ? fixtureText("etss-9447130.json") : JSON.stringify({ ts: [], pred: [], twl: [] });
		else {
			const meta = /\/stations\/(\d+)(\/tidepredoffsets)?\.json$/.exec(url);
			let name;
			if (meta) name = `${meta[2] ? "offsets" : "station"}-${meta[1]}.json`;
			else {
				const params = new URL(url).searchParams;
				name = `${params.get("interval") === "hilo" ? "hilo" : "curve"}-${params.get("station")}.json`;
			}
			body = fixtureText(name);
		}
		return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
	};
	const count = (pattern) => requested.filter((u) => pattern.test(u)).length;
	return { requested, fetchFn, count };
}

test("station list: one entry per row, with location and whether ETSS has observations and tides", () => {
	const list = etss.parseStationList(fixtureText("etss-master.csv"));
	assert.equal(list.length, 28);
	assert.deepEqual(list.find((s) => s.id === "9447130"), { id: "9447130", name: "Seattle-WA", lat: 47.6, lon: -122.34, obs: true, tide: true });
	assert.equal(list.find((s) => s.id === "9446291").obs, false); // Wauna: tides, no observations
	assert.throws(() => etss.parseStationList("Name,ID\nx,1"), /no "Station Name" column/);
});

test("nearest station: only stations with observations and tides", () => {
	const list = etss.parseStationList(fixtureText("etss-master.csv"));
	// Bremerton: the Shilshole buoy (19 km, no tides) and Wauna (20 km, no observations) are closer than Seattle.
	const bremerton = etss.nearestStation(list, 47.5617, -122.623);
	assert.equal(bremerton.id, "9447130");
	assert.ok(Math.abs(bremerton.km - 21.6) < 0.2);
	assert.equal(etss.nearestStation(list, 47.62, -122.515).id, "9447130"); // Eagle Harbor
	assert.throws(() => etss.nearestStation(list.filter((s) => !s.obs), 47.6, -122.3), /no station with observations and tides/);
});

test("ETSS times are UTC", () => {
	assert.equal(etss.parseEtssTime("202611222200"), Date.parse("2026-11-22T22:00:00Z"));
	assert.throws(() => etss.parseEtssTime("2026-11-22"), /unexpected time/);
});

test("offsets: total water level minus ETSS's tide, hourly; an unknown station is an error", () => {
	const offsets = etss.parseOffsets(fixture("etss-9447130.json"), "9447130");
	const at22 = offsets.find((o) => o.t === Date.parse("2026-11-22T22:00:00Z"));
	assert.ok(Math.abs(at22.off - (12.677 - 11.702)) < 1e-9);
	assert.ok(offsets.every((o, i) => i === 0 || o.t - offsets[i - 1].t === HOUR));
	assert.throws(() => etss.parseOffsets({ ts: [], pred: [], twl: [] }, "9445958"), /no forecast for station 9445958/);
	assert.throws(() => etss.parseOffsets({ ts: ["202611222200"], pred: [9999], twl: [1] }, "1"), /no forecast/);
});

test("adjusted curve: offset interpolated between hours, only where ETSS covers it, scaled for meters", () => {
	const offsets = [{ t: 0, off: 1 }, { t: HOUR, off: 2 }];
	const curve = [{ t: -6 * 60000, v: 5 }, { t: 0, v: 5 }, { t: HOUR / 2, v: 5 }, { t: HOUR, v: 5 }, { t: HOUR + 6 * 60000, v: 5 }];
	assert.deepEqual(etss.adjustCurve(curve, offsets), [{ t: 0, v: 6 }, { t: HOUR / 2, v: 6.5 }, { t: HOUR, v: 7 }]);
	assert.deepEqual(etss.adjustCurve([{ t: 0, v: 1 }], offsets, 0.3048), [{ t: 0, v: 1.3048 }]);
});

test("station choice: the config's station, else the one nearest the station (or its reference station)", async () => {
	const none = fakeServers();
	assert.deepEqual(await etss.chooseStation({ ...BREMERTON, etss: { station: "9444900" } }, { offsets: null }, none.fetchFn), { id: "9444900", name: null, km: null });
	assert.equal(none.requested.length, 0);

	const own = fakeServers();
	assert.equal((await etss.chooseStation(BREMERTON, { offsets: null }, own.fetchFn)).id, "9447130");
	assert.deepEqual(own.requested.sort(), [etss.STATION_LIST_URL, noaa.stationUrl("9445958")].sort());

	const sub = fakeServers();
	const station = await noaa.fetchStation(EAGLE, sub.fetchFn);
	sub.requested.length = 0;
	const chosen = await etss.chooseStation(EAGLE, station, sub.fetchFn);
	assert.equal(chosen.id, "9447130");
	assert.ok(chosen.km < 1); // measured from Seattle, Eagle Harbor's reference station
	assert.ok(sub.requested.includes(noaa.stationUrl("9447130")));
});

test("a station with its own predictions: prediction + ETSS offset, from the window's start to a day past its end", async () => {
	const { requested, fetchFn } = fakeServers();
	const curve = await etss.fetchEtssCurve(SEATTLE, { offsets: null }, "9447130", NOW, fetchFn);
	const window = TideTime.chartWindow(NOW, SEATTLE.timezone);
	assert.deepEqual(requested, [noaa.buildUrls(SEATTLE, window.start, window.end + DAY).curve, `${etss.DATA_URL} st=9447130`]);
	assert.ok(curve.every((p) => p.t >= window.start && p.t <= window.end + DAY));
	assert.equal(curve[0].t, window.start);

	const pred = noaa.parsePredictions(fixture("curve-9447130.json"));
	const at = (points, t) => points.find((p) => p.t === t).v;
	const t22 = Date.parse("2026-11-22T22:00:00Z");
	assert.ok(Math.abs(at(curve, t22) - (at(pred, t22) + (12.677 - 11.702))) < 1e-9);
});

test("meters: the offset (in feet) is converted", async () => {
	const { fetchFn } = fakeServers();
	const english = await etss.fetchEtssCurve(SEATTLE, { offsets: null }, "9447130", NOW, fetchFn);
	const metric = await etss.fetchEtssCurve({ ...SEATTLE, units: "metric" }, { offsets: null }, "9447130", NOW, fetchFn);
	// The fixture predictions are in feet either way; only the offset changes.
	const pred = noaa.parsePredictions(fixture("curve-9447130.json")).find((p) => p.t === english[10].t).v;
	assert.ok(Math.abs((metric[10].v - pred) - (english[10].v - pred) * 0.3048) < 1e-9);
});

test("a subordinate station: the reference station's adjusted curve, then the subordinate corrections", async () => {
	const { requested, fetchFn } = fakeServers();
	const station = await noaa.fetchStation(EAGLE, fetchFn);
	requested.length = 0;
	const curve = await etss.fetchEtssCurve(EAGLE, station, "9447130", NOW, fetchFn);
	const window = TideTime.chartWindow(NOW, EAGLE.timezone);
	const ref = noaa.buildUrls({ ...EAGLE, stationID: "9447130" }, window.start - noaa.REFERENCE_MARGIN_MS, window.end + DAY + noaa.REFERENCE_MARGIN_MS);
	assert.deepEqual(requested, [ref.curve, ref.hilo, `${etss.DATA_URL} st=9447130`]);

	// Same as correcting Seattle's adjusted curve directly.
	const adjusted = etss.adjustCurve(noaa.parsePredictions(fixture("curve-9447130.json")), etss.parseOffsets(fixture("etss-9447130.json"), "9447130"));
	const expected = require("../lib/subordinate.js").correctPoints(adjusted, noaa.parsePredictions(fixture("hilo-9447130.json")), station.offsets)
		.filter((p) => p.t >= window.start && p.t <= window.end + DAY);
	assert.deepEqual(curve, expected);
	assert.ok(curve.length > 400);
});

test("the ETSS fetch fails if any request fails, or ETSS has no forecast for the station", async () => {
	for (const failing of [etss.DATA_URL, "datagetter"]) {
		const { fetchFn } = fakeServers({ fail: (url) => url.includes(failing) });
		await assert.rejects(etss.fetchEtssCurve(SEATTLE, { offsets: null }, "9447130", NOW, fetchFn), /HTTP 500/);
	}
	await assert.rejects(etss.fetchEtssCurve(SEATTLE, { offsets: null }, "9445958", NOW, fakeServers().fetchFn), /no forecast for station 9445958/);
});

test("the ETSS source chooses the station once (retried until it works), then fetches only the forecast", async () => {
	let down = true;
	const logged = [];
	const { fetchFn, count } = fakeServers({ fail: (url) => down && url === etss.STATION_LIST_URL });
	const fetchData = etss.createEtssSource(SEATTLE, fetchFn, undefined, { info: (m) => logged.push(m) });
	await assert.rejects(fetchData(NOW), /HTTP 500/);
	down = false;
	const result = await fetchData(NOW);
	await fetchData(NOW);
	assert.equal(result.stationID, "9447130");
	assert.equal(result.etssStation, "9447130");
	assert.ok(result.curve.length > 400);
	assert.equal(count(/master\.csv/), 2); // the failed try and the one that worked
	assert.deepEqual(logged, ["ETSS station 9447130 (Seattle-WA, 0.3 km away)"]); // the list rounds Seattle's location
});
