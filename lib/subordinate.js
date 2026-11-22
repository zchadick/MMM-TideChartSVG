/* MMM-TideChartSVG: tide curves for subordinate stations (pure; Node side).
 *
 * NOAA publishes no curve for a subordinate station, only highs and lows: its reference (parent) station's
 * highs and lows shifted in time and scaled in height by two fixed corrections, one for highs and one for
 * lows. This builds the curve the same way from the parent's 6-minute curve.
 *
 * NOAA defines the corrections only at highs and lows. Between a high and the next low (or a low and the next
 * high), each point's correction is blended from one to the other by time: halfway in time between them, it
 * gets halfway between the two corrections. This is our choice, not NOAA's; see README.md ("Subordinate
 * stations") for what it means.
 */
"use strict";

const MINUTE = 60 * 1000;

/** Linear interpolation of `points` (sorted by t) at time t, which must be inside them. */
function valueAt (points, t) {
	const i = points.findIndex((p) => p.t >= t);
	if (i <= 0) return points[0].v;
	const a = points[i - 1];
	const b = points[i];
	return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

/**
 * The subordinate station's curve over start…end.
 * @param {Array<{t, v}>} refCurve the parent's 6-minute curve, covering more than start…end
 * @param {Array<{t, v, type}>} refHilo the parent's highs and lows over the same span
 * @param {{ timeHigh, timeLow, ratioHigh, ratioLow }} offsets minutes and height ratios
 * @returns {Array<{t, v}>} starting exactly at start and ending exactly at end
 */
function modelCurve (refCurve, refHilo, offsets, start, end) {
	const correction = {
		H: { dt: offsets.timeHigh * MINUTE, ratio: offsets.ratioHigh },
		L: { dt: offsets.timeLow * MINUTE, ratio: offsets.ratioLow }
	};
	const shifted = [];
	let k = 0;
	for (const p of refCurve) {
		while (k + 2 < refHilo.length && refHilo[k + 1].t <= p.t) k++;
		const a = refHilo[k];
		const b = refHilo[k + 1];
		if (!b || p.t < a.t || p.t > b.t) continue; // outside the parent's highs and lows: no correction known
		const w = (p.t - a.t) / (b.t - a.t);
		const ca = correction[a.type];
		const cb = correction[b.type];
		shifted.push({
			t: p.t + ca.dt + (cb.dt - ca.dt) * w,
			v: p.v * (ca.ratio + (cb.ratio - ca.ratio) * w)
		});
	}

	if (!shifted.length || shifted[0].t > start || shifted[shifted.length - 1].t < end) {
		throw new Error("NOAA: the reference station's predictions don't cover the whole chart");
	}
	return [{ t: start, v: valueAt(shifted, start) }]
		.concat(shifted.filter((p) => p.t > start && p.t < end))
		.concat([{ t: end, v: valueAt(shifted, end) }]);
}

module.exports = { modelCurve };
