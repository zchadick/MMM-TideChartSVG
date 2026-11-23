/* MMM-TideChartSVG: ETSS surge forecast (Node side).
 *
 * ETSS (the NWS Extra-Tropical Storm Surge model) forecasts the total water level at about 565 NOAA stations:
 * the astronomical tide plus the modeled surge plus a correction from recent observations. The module adds
 * ETSS's forecast offset (total − tide, hourly) to NOAA's 6-minute predictions, so the result has the
 * prediction's shape and NOAA's datum and units.
 *
 * Data comes from the ETSS 2.0 web page's own backend (slosh.nws.noaa.gov/etsurge2.0): a station list (CSV)
 * and one station's data (JSON, by POST). Neither is a documented API, so ETSS is optional: the page shows
 * nothing when it fails.
 */
"use strict";

const TideTime = require("./tideTime.js");
const Subordinate = require("./subordinate.js");
const noaa = require("./noaa.js");

const ETSS_BASE = "https://slosh.nws.noaa.gov/etsurge2.0";
const STATION_LIST_URL = `${ETSS_BASE}/datafiles/master.csv`;
const DATA_URL = `${ETSS_BASE}/fixed/php/getData.php`;
const MISSING = 9999;
const FEET_TO_METERS = 0.3048;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Station list CSV → [{ id, name, lat, lon, obs, tide }] (obs/tide: whether ETSS has observations and tides there). */
function parseStationList (text) {
	const lines = String(text).trim().split(/\r?\n/);
	const header = lines.shift().split(",").map((h) => h.trim());
	const col = (name) => {
		const i = header.indexOf(name);
		if (i < 0) throw new Error(`ETSS: station list has no "${name}" column`);
		return i;
	};
	const [name, id, lat, lon, obs, tide] = ["Station Name", "Station ID", "Station Lat", "Station Lon", "Obs?", "Tide?"].map(col);
	return lines.map((line) => line.split(",")).map((f) => ({
		id: f[id].trim(),
		name: f[name].trim(),
		lat: Number(f[lat]),
		lon: Number(f[lon]),
		obs: f[obs].trim() === "1",
		tide: f[tide].trim() === "1"
	}));
}

/** Great-circle distance in km. */
function distanceKm (lat1, lon1, lat2, lon2) {
	const r = Math.PI / 180;
	const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
	return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/**
 * The nearest ETSS station that has both observations and tides (without observations, ETSS can't correct its
 * forecast; without tides, there's no offset). Returns { id, name, km }.
 */
function nearestStation (stations, lat, lon) {
	let best = null;
	for (const s of stations) {
		if (!s.obs || !s.tide) continue;
		const km = distanceKm(lat, lon, s.lat, s.lon);
		if (!best || km < best.km) best = { id: s.id, name: s.name, km };
	}
	if (!best) throw new Error("ETSS: no station with observations and tides in the station list");
	return best;
}

/** "202611222200" (UTC) → ms. */
function parseEtssTime (text) {
	const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(text));
	if (!m) throw new Error(`ETSS: unexpected time ${text}`);
	const [, y, mo, d, h, mi] = m.map(Number);
	return Date.UTC(y, mo - 1, d, h, mi);
}

/**
 * ETSS station data → hourly offsets [{ t, off }] (feet): total water level minus ETSS's tide, wherever both
 * are present. An unknown station comes back as empty arrays: an error.
 */
function parseOffsets (json, etssID) {
	const ok = json && Array.isArray(json.ts) && Array.isArray(json.twl) && Array.isArray(json.pred);
	const offsets = [];
	if (ok) {
		json.ts.forEach((ts, i) => {
			const twl = json.twl[i];
			const pred = json.pred[i];
			if (typeof twl === "number" && typeof pred === "number" && twl !== MISSING && pred !== MISSING) {
				offsets.push({ t: parseEtssTime(ts), off: twl - pred });
			}
		});
	}
	if (!offsets.length) throw new Error(`ETSS: no forecast for station ${etssID}`);
	return offsets;
}

/**
 * Prediction points with the offset added: interpolated linearly between ETSS's hours, and only where ETSS
 * covers them (no extrapolation).
 */
function adjustCurve (curve, offsets, scale = 1) {
	const out = [];
	let k = 0;
	for (const p of curve) {
		if (p.t < offsets[0].t || p.t > offsets[offsets.length - 1].t) continue;
		while (k + 1 < offsets.length && offsets[k + 1].t < p.t) k++;
		const a = offsets[k];
		const b = offsets[k + 1] || a;
		const off = b.t === a.t ? a.off : a.off + ((b.off - a.off) * (p.t - a.t)) / (b.t - a.t);
		out.push({ t: p.t, v: p.v + off * scale });
	}
	return out;
}

async function getText (url, fetchFn, options) {
	const response = await fetchFn(url, options);
	if (!response.ok) throw new Error(`ETSS: HTTP ${response.status}`);
	return response.text();
}

async function fetchStationData (etssID, fetchFn) {
	const text = await getText(DATA_URL, fetchFn, { method: "POST", body: new URLSearchParams({ st: etssID }) });
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error("ETSS: station data isn't JSON");
	}
	return parseOffsets(json, etssID);
}

/** Station metadata → { lat, lon }. */
async function stationLocation (stationID, fetchFn) {
	const json = await noaa.getJson(noaa.stationUrl(stationID), fetchFn);
	const station = json && Array.isArray(json.stations) ? json.stations[0] : null;
	if (!station || typeof station.lat !== "number" || typeof station.lng !== "number") {
		throw new Error(`NOAA: no location for station ${stationID}`);
	}
	return { lat: station.lat, lon: station.lng };
}

/**
 * Which ETSS station to use: the config's `etss.station` if set, else the one nearest the station (for a
 * subordinate station, nearest its reference station).
 */
async function chooseStation (config, station, fetchFn) {
	if (config.etss && config.etss.station) return { id: String(config.etss.station), name: null, km: null };
	const anchorID = station.offsets ? station.offsets.referenceID : config.stationID;
	const [list, where] = await Promise.all([getText(STATION_LIST_URL, fetchFn), stationLocation(anchorID, fetchFn)]);
	return nearestStation(parseStationList(list), where.lat, where.lon);
}

/**
 * The ETSS-adjusted curve from the window's start to a day past its end (so it still covers the window after
 * midnight, until the next ETSS fetch). A subordinate station: the reference station's prediction plus the
 * offset, then the subordinate corrections (so the height ratio scales the surge too).
 */
async function fetchEtssCurve (config, station, etssID, nowMs, fetchFn) {
	const window = TideTime.chartWindow(nowMs, config.timezone);
	const start = window.start;
	const end = window.end + DAY_MS;
	const scale = config.units === "metric" ? FEET_TO_METERS : 1;
	const { offsets } = station;
	let curve;
	if (!offsets) {
		const [predJson, etssOffsets] = await Promise.all([
			noaa.getJson(noaa.buildUrls(config, start, end).curve, fetchFn),
			fetchStationData(etssID, fetchFn)
		]);
		curve = adjustCurve(noaa.parsePredictions(predJson), etssOffsets, scale);
	} else {
		const ref = noaa.buildUrls({ ...config, stationID: offsets.referenceID }, start - noaa.REFERENCE_MARGIN_MS, end + noaa.REFERENCE_MARGIN_MS);
		const [refCurveJson, refHiloJson, etssOffsets] = await Promise.all([
			noaa.getJson(ref.curve, fetchFn),
			noaa.getJson(ref.hilo, fetchFn),
			fetchStationData(etssID, fetchFn)
		]);
		const adjusted = adjustCurve(noaa.parsePredictions(refCurveJson), etssOffsets, scale);
		curve = Subordinate.correctPoints(adjusted, noaa.parsePredictions(refHiloJson), offsets);
	}
	curve = curve.filter((p) => p.t >= start && p.t <= end);
	if (!curve.length) throw new Error(`ETSS: station ${etssID}'s forecast doesn't cover the chart`);
	return curve;
}

/**
 * The fetch the ETSS cycle runs: chooses the ETSS station once (retried on each fetch until it works), then
 * fetches the adjusted curve. Result: { stationID, etssStation, curve: [{ t, v }] }.
 */
function createEtssSource (config, fetchFn = fetch, loadStation = noaa.createStationLoader(config, fetchFn), log = console) {
	let chosen = null;
	return async function fetchData (nowMs) {
		const station = await loadStation();
		if (!chosen) {
			chosen = await chooseStation(config, station, fetchFn);
			const where = chosen.km === null ? "set in config" : `${chosen.name}, ${chosen.km.toFixed(1)} km away`;
			log.info(`ETSS station ${chosen.id} (${where})`);
		}
		const curve = await fetchEtssCurve(config, station, chosen.id, nowMs, fetchFn);
		return { stationID: String(config.stationID), etssStation: chosen.id, curve };
	};
}

module.exports = {
	STATION_LIST_URL,
	DATA_URL,
	parseStationList,
	distanceKm,
	nearestStation,
	parseEtssTime,
	parseOffsets,
	adjustCurve,
	chooseStation,
	fetchEtssCurve,
	createEtssSource
};
