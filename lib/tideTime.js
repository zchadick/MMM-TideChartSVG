/* MMM-TideChartSVG: time helpers (pure; used by node_helper and the page).
 * All instants are UTC milliseconds. Local times are in an IANA timezone, via Intl.
 */
(function (root) {
	"use strict";

	const partFormatters = new Map();
	const timeFormatters = new Map();
	const dayFormatters = new Map();

	function cached (map, timezone, make) {
		let formatter = map.get(timezone);
		if (!formatter) {
			formatter = make();
			map.set(timezone, formatter);
		}
		return formatter;
	}

	/** The mirror's own timezone (used when the config leaves `timezone` out). */
	function defaultTimezone () {
		return Intl.DateTimeFormat().resolvedOptions().timeZone;
	}

	/** True if `timezone` is a name Intl knows. */
	function isValidTimezone (timezone) {
		try {
			new Intl.DateTimeFormat("en-US", { timeZone: timezone });
			return true;
		} catch {
			return false;
		}
	}

	/** Local calendar date and clock time of an instant: { year, month (1-12), day, hour, minute }. */
	function localParts (ms, timezone) {
		const formatter = cached(partFormatters, timezone, () => new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric"
		}));
		const parts = {};
		for (const part of formatter.formatToParts(new Date(ms))) {
			if (part.type !== "literal") parts[part.type] = Number(part.value);
		}
		return parts;
	}

	/** Offset of the timezone from UTC at an instant, in ms. */
	function offsetAt (ms, timezone) {
		const p = localParts(ms, timezone);
		const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
		return asUtc - (ms - (ms % 1000));
	}

	/** The instant of a local date and time in the timezone. */
	function localToUtc (year, month, day, hour, minute, timezone) {
		const guess = Date.UTC(year, month - 1, day, hour, minute);
		let result = guess - offsetAt(guess, timezone);
		const corrected = guess - offsetAt(result, timezone);
		if (corrected !== result) result = corrected;
		return result;
	}

	/** Local midnight `daysAhead` days after the local date of `ms`. */
	function localMidnight (ms, timezone, daysAhead) {
		const p = localParts(ms, timezone);
		const date = new Date(Date.UTC(p.year, p.month - 1, p.day + daysAhead));
		return localToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 0, 0, timezone);
	}

	/**
	 * The chart's window: local midnight today to local midnight the day after tomorrow.
	 * `mid` is local midnight tomorrow (the day divider).
	 */
	function chartWindow (nowMs, timezone) {
		return {
			start: localMidnight(nowMs, timezone, 0),
			mid: localMidnight(nowMs, timezone, 1),
			end: localMidnight(nowMs, timezone, 2)
		};
	}

	/** The next 00:01 local time after `nowMs` (when the daily fetch runs). */
	function nextDailyRefresh (nowMs, timezone) {
		for (let daysAhead = 0; daysAhead <= 2; daysAhead++) {
			const p = localParts(nowMs, timezone);
			const date = new Date(Date.UTC(p.year, p.month - 1, p.day + daysAhead));
			const at = localToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 0, 1, timezone);
			if (at > nowMs) return at;
		}
		throw new Error("No next refresh found");
	}

	/** "15:42" (24-hour). */
	function formatTime (ms, timezone) {
		const formatter = cached(timeFormatters, timezone, () => new Intl.DateTimeFormat("en-GB", {
			timeZone: timezone,
			hourCycle: "h23",
			hour: "2-digit",
			minute: "2-digit"
		}));
		return formatter.format(new Date(ms));
	}

	/** "Mon". */
	function formatDay (ms, timezone) {
		const formatter = cached(dayFormatters, timezone, () => new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			weekday: "short"
		}));
		return formatter.format(new Date(ms));
	}

	const TideTime = {
		defaultTimezone,
		isValidTimezone,
		localParts,
		localToUtc,
		chartWindow,
		nextDailyRefresh,
		formatTime,
		formatDay
	};

	if (typeof module !== "undefined" && module.exports) {
		module.exports = TideTime;
	} else {
		root.TideTime = TideTime;
	}
}(typeof globalThis !== "undefined" ? globalThis : this));
