/* MMM-TideChartSVG: NOAA CO-OPS tide predictions (Node side).
 * Requests use UTC (time_zone=gmt); results are { t: UTC ms, v: height } plus `type` ("H"/"L") for highs and lows.
 * At startup the station's name and type are fetched once (fetchStation); a subordinate station's curve is then
 * modeled from its reference station's (see subordinate.js).
 */
"use strict";

const TideTime = require("./tideTime.js");
const Subordinate = require("./subordinate.js");

const API_BASE = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const METADATA_BASE = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations";
const APPLICATION = "MMM-TideChartSVG";
const REFERENCE_MARGIN_MS = 24 * 60 * 60 * 1000; // extra reference data on each side of the window

function pad (n) {
	return String(n).padStart(2, "0");
}

/** NOAA date format in UTC: "20261109 08:00". */
function noaaDate (ms) {
	const d = new Date(ms);
	return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "2026-11-09 13:44" (UTC) → ms. */
function parseNoaaTime (text) {
	const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text);
	if (!match) throw new Error(`Unexpected NOAA time: ${text}`);
	const [, y, mo, d, h, mi] = match.map(Number);
	return Date.UTC(y, mo - 1, d, h, mi);
}

/** URLs for the curve (6-minute predictions) and the high/low list, covering start…end. */
function buildUrls ({ stationID, datum, units }, start, end) {
	const params = [
		["begin_date", noaaDate(start)],
		["end_date", noaaDate(end)],
		["station", stationID],
		["product", "predictions"],
		["datum", datum],
		["time_zone", "gmt"],
		["units", units],
		["format", "json"],
		["application", APPLICATION]
	];
	const query = params.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
	return {
		curve: `${API_BASE}?${query}`,
		hilo: `${API_BASE}?${query}&interval=hilo`
	};
}

/** NOAA JSON → [{ t, v, type? }]. NOAA reports problems as `{ error: { message } }`, often with HTTP 200. */
function parsePredictions (json) {
	if (json && json.error) {
		throw new Error(`NOAA: ${String(json.error.message || "unknown error").trim()}`);
	}
	if (!json || !Array.isArray(json.predictions)) {
		throw new Error("NOAA: response has no predictions");
	}
	return json.predictions.map((p) => {
		const point = { t: parseNoaaTime(p.t), v: Number(p.v) };
		if (p.type) point.type = p.type;
		return point;
	});
}

/** Station metadata URL (name, state, location). */
function stationUrl (stationID) {
	return `${METADATA_BASE}/${encodeURIComponent(String(stationID))}.json`;
}

/** Station metadata → "Bremerton, WA" (or just the name), or null if missing. */
function parseStationName (json) {
	const station = json && Array.isArray(json.stations) ? json.stations[0] : null;
	if (!station || !station.name) return null;
	return station.state ? `${station.name}, ${station.state}` : station.name;
}

async function getJson (url, fetchFn) {
	const response = await fetchFn(url);
	if (!response.ok) throw new Error(`NOAA: HTTP ${response.status}`);
	return response.json();
}

/** Tide-prediction offsets URL: whether the station is subordinate, its reference station and corrections. */
function offsetsUrl (stationID) {
	return `${METADATA_BASE}/${encodeURIComponent(String(stationID))}/tidepredoffsets.json`;
}

/**
 * Offsets → null for a station with its own predictions (type "R"), or the corrections for a subordinate one
 * (type "S"): { referenceID, timeHigh, timeLow (minutes), ratioHigh, ratioLow }. Only ratio ("R") height
 * corrections are supported; added-feet ("A") ones are an error.
 */
function parseOffsets (json, stationID) {
	if (!json || json.type !== "S") return null;
	const kind = json.heightAdjustedType;
	if (kind === "A") {
		throw new Error(`Station ${stationID} is a subordinate station whose heights are corrected by adding a fixed amount `
			+ `to reference station ${json.refStationId}'s ("A" offsets). Only stations corrected by a ratio ("R" offsets) `
			+ "are supported; see the README's Limitations.");
	}
	const numbers = [json.timeOffsetHighTide, json.timeOffsetLowTide, json.heightOffsetHighTide, json.heightOffsetLowTide];
	if (kind !== "R" || !json.refStationId || !numbers.every((x) => typeof x === "number")) {
		throw new Error(`NOAA: incomplete tide-prediction offsets for subordinate station ${stationID}`);
	}
	return {
		referenceID: String(json.refStationId),
		timeHigh: json.timeOffsetHighTide,
		timeLow: json.timeOffsetLowTide,
		ratioHigh: json.heightOffsetHighTide,
		ratioLow: json.heightOffsetLowTide
	};
}

/**
 * Startup step: the station's name and offsets (null unless subordinate). Both requests are required.
 * NOAA publishes a subordinate station's predictions only with datum MLLW, so any other datum is an error.
 */
async function fetchStation (config, fetchFn = fetch) {
	const [stationJson, offsetsJson] = await Promise.all([
		getJson(stationUrl(config.stationID), fetchFn),
		getJson(offsetsUrl(config.stationID), fetchFn)
	]);
	const offsets = parseOffsets(offsetsJson, config.stationID);
	if (offsets && config.datum !== "MLLW") {
		throw new Error(`Station ${config.stationID} is a subordinate station: NOAA publishes its predictions only with `
			+ `datum "MLLW", but the config sets datum "${config.datum}". Set datum to "MLLW" (or remove it).`);
	}
	return { stationName: parseStationName(stationJson), offsets };
}

/**
 * Fetch today's and tomorrow's predictions (local days in `config.timezone`) for a station from fetchStation.
 * A subordinate station gets its own highs and lows, and a curve modeled from its reference station's curve
 * (`modeled: true`). Any failed request fails the whole fetch.
 */
async function fetchTides (config, station, nowMs, fetchFn = fetch) {
	const window = TideTime.chartWindow(nowMs, config.timezone);
	const urls = buildUrls(config, window.start, window.end);
	const { offsets } = station;
	let curve;
	let hilo;
	if (!offsets) {
		const [curveJson, hiloJson] = await Promise.all([getJson(urls.curve, fetchFn), getJson(urls.hilo, fetchFn)]);
		curve = parsePredictions(curveJson);
		hilo = parsePredictions(hiloJson);
	} else {
		const ref = buildUrls({ ...config, stationID: offsets.referenceID }, window.start - REFERENCE_MARGIN_MS, window.end + REFERENCE_MARGIN_MS);
		const [hiloJson, refCurveJson, refHiloJson] = await Promise.all([
			getJson(urls.hilo, fetchFn),
			getJson(ref.curve, fetchFn),
			getJson(ref.hilo, fetchFn)
		]);
		hilo = parsePredictions(hiloJson);
		curve = Subordinate.modelCurve(parsePredictions(refCurveJson), parsePredictions(refHiloJson), offsets, window.start, window.end);
	}
	return {
		stationID: String(config.stationID),
		stationName: station.stationName,
		modeled: Boolean(offsets),
		units: config.units,
		datum: config.datum,
		timezone: config.timezone,
		...window,
		curve,
		hilo
	};
}

/**
 * The fetch the cycle runs: the startup step on the first call (and again on each call until it succeeds),
 * then only the daily predictions, reusing the station it found.
 */
function createTideSource (config, fetchFn = fetch) {
	let station = null;
	return async function fetchData (nowMs) {
		if (!station) station = await fetchStation(config, fetchFn);
		return fetchTides(config, station, nowMs, fetchFn);
	};
}

module.exports = {
	API_BASE,
	REFERENCE_MARGIN_MS,
	noaaDate,
	parseNoaaTime,
	buildUrls,
	parsePredictions,
	stationUrl,
	parseStationName,
	offsetsUrl,
	parseOffsets,
	fetchStation,
	fetchTides,
	createTideSource
};
