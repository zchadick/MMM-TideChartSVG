/* MMM-TideChartSVG: NOAA CO-OPS tide predictions (Node side).
 * Requests use UTC (time_zone=gmt); results are { t: UTC ms, v: height } plus `type` ("H"/"L") for highs and lows.
 */
"use strict";

const TideTime = require("./tideTime.js");

const API_BASE = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const METADATA_BASE = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations";
const APPLICATION = "MMM-TideChartSVG";

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

/**
 * Fetch today's and tomorrow's predictions (local days in `config.timezone`), plus the station's name.
 * The name is optional: if its request fails, `stationName` is null and the predictions still count.
 */
async function fetchTides (config, nowMs, fetchFn = fetch) {
	const window = TideTime.chartWindow(nowMs, config.timezone);
	const urls = buildUrls(config, window.start, window.end);
	const name = getJson(stationUrl(config.stationID), fetchFn).then(parseStationName, () => null);
	const [curveJson, hiloJson, stationName] = await Promise.all([getJson(urls.curve, fetchFn), getJson(urls.hilo, fetchFn), name]);
	return {
		stationID: String(config.stationID),
		stationName,
		units: config.units,
		datum: config.datum,
		timezone: config.timezone,
		...window,
		curve: parsePredictions(curveJson),
		hilo: parsePredictions(hiloJson)
	};
}

module.exports = { API_BASE, noaaDate, parseNoaaTime, buildUrls, parsePredictions, stationUrl, parseStationName, fetchTides };
