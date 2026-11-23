/* MMM-TideChartSVG: when to fetch (Node side).
 * Predictions: fetch now; after a success, again at the next 00:01 local time; after a failure, every hour
 * until it works. Observed water levels: fetch now, then on a fixed interval (createRepeatingCycle).
 */
"use strict";

const TideTime = require("./tideTime.js");

const RETRY_MS = 60 * 60 * 1000;

/**
 * @param {object} deps
 * @param {(nowMs: number) => Promise<object>} deps.fetchData
 * @param {(notification: string, payload: object) => void} deps.send
 * @param {string} deps.timezone
 * @param {() => number} [deps.now]
 * @param {Function} [deps.setTimer]
 * @param {Function} [deps.clearTimer]
 * @param {object} [deps.log]
 */
function createFetchCycle ({ fetchData, send, timezone, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = console }) {
	let timer = null;
	let stopped = false;

	function schedule (delayMs) {
		if (stopped) return;
		timer = setTimer(run, Math.max(0, delayMs));
	}

	async function run () {
		timer = null;
		try {
			const data = await fetchData(now());
			send("TIDE_DATA", data);
			schedule(TideTime.nextDailyRefresh(now(), timezone) - now());
		} catch (error) {
			log.error(`Fetch failed, retrying in 1 hour: ${error.message}`);
			send("TIDE_ERROR", { message: error.message });
			schedule(RETRY_MS);
		}
	}

	return {
		start: run,
		stop () {
			stopped = true;
			if (timer) clearTimer(timer);
			timer = null;
		}
	};
}

/**
 * Fetch now, then every `intervalMs` whether or not it worked (observed water levels). A success is sent as
 * `notification`; a failure sends nothing (the page keeps what it has). Failures are logged only when they
 * start and when they end, so a station without observations doesn't fill the log.
 * @param {object} deps same as createFetchCycle, plus `intervalMs`, `notification` and `label` (for the log)
 */
function createRepeatingCycle ({ fetchData, send, intervalMs, notification, label, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = console }) {
	let timer = null;
	let stopped = false;
	let failing = false;

	async function run () {
		timer = null;
		try {
			const data = await fetchData(now());
			if (failing) log.info(`${label}: working again`);
			failing = false;
			send(notification, data);
		} catch (error) {
			if (!failing) log.warn(`${label} unavailable, retrying every ${Math.round(intervalMs / 60000)} min: ${error.message}`);
			failing = true;
		}
		if (!stopped) timer = setTimer(run, intervalMs);
	}

	return {
		start: run,
		stop () {
			stopped = true;
			if (timer) clearTimer(timer);
			timer = null;
		}
	};
}

module.exports = { createFetchCycle, createRepeatingCycle, RETRY_MS };
