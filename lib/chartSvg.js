/* MMM-TideChartSVG: builds the chart's SVG markup and places the overlay (pure; used by the page and tests).
 *
 * Layout (width × height): a left gutter for the height scale and axis title, the plot to its right, and a
 * row for the x-axis labels at the bottom. Plot coordinates: x is time (window start → 0, end → plotWidth);
 * y is height (max → top of the plot, min → bottom). The height range always includes 0 (and the mean sea
 * level when set). Colors live in the CSS; the markup only carries classes.
 */
(function (root) {
	"use strict";

	const TideTime = typeof module !== "undefined" && module.exports ? require("./tideTime.js") : root.TideTime;

	const GUTTER = 44; // left: height numbers and the rotated axis title
	const AXIS_ROW = 20; // bottom: hour and day labels
	const LABEL_SPACE = 34; // room for a two-line high/low label above or below the curve
	const LABEL_EDGE = 22; // keep label centers this far from the plot's left/right edges
	const FILL_OPACITY = 0.55; // strongest shading, fading to 0
	const SHADE_PAST_OPACITY = 0.35;
	const MINUTE = 60 * 1000;
	const OBSERVED_SEARCH_MS = 90 * MINUTE; // look for the observed high/low this far either side of the predicted one
	const OBSERVED_SETTLE_MS = 30 * MINUTE; // ...and use it once the latest reading is this far past it
	const OBSERVED_FRESH_MS = 60 * MINUTE; // the current value is observed if the latest reading is this recent
	const OBSERVED_STALE_MS = 6 * 60 * MINUTE; // note on the page when the latest reading is older than this

	function n (value) {
		return (Math.round(value * 10) / 10).toString();
	}

	function clamp (value, low, high) {
		return Math.min(Math.max(value, low), high);
	}

	function unitLabel (units) {
		return units === "metric" ? "m" : "ft";
	}

	/** "7.2 ft" (one decimal; never "-0.0"); with `mark`, "7.2* ft". */
	function formatHeight (value, units, mark = "") {
		return `${(Math.round(value * 10) / 10 + 0).toFixed(1)}${mark} ${unitLabel(units)}`;
	}

	/** Grid step when the config doesn't set one: 2 ft, or 0.5 m. */
	function defaultGridStep (units) {
		return units === "metric" ? 0.5 : 2;
	}

	/** "high" / "low" if a height is outside extremeRange [low, high] (strictly), else null. */
	function extremeKind (value, extremeRange) {
		if (!extremeRange) return null;
		if (value < extremeRange[0]) return "low";
		if (value > extremeRange[1]) return "high";
		return null;
	}

	/**
	 * Scale for a data set and chart size. The range always includes 0 and the mean sea level, and covers the
	 * curve, the highs and lows (shown and predicted), the observed water level and the ETSS curve when shown.
	 */
	function makeScale (data, { width, height, meanSeaLevel = null }) {
		let min = 0;
		let max = 0;
		const predicted = data.hilo.filter((p) => p.predicted).map((p) => p.predicted);
		for (const p of data.curve.concat(data.hilo, predicted, data.observations || [], data.etss || [])) {
			if (p.v < min) min = p.v;
			if (p.v > max) max = p.v;
		}
		if (meanSeaLevel !== null && meanSeaLevel !== undefined) {
			min = Math.min(min, meanSeaLevel);
			max = Math.max(max, meanSeaLevel);
		}
		if (min === max) max += 1;
		return {
			start: data.start,
			end: data.end,
			gutter: GUTTER,
			plotWidth: width - GUTTER,
			width,
			height,
			top: LABEL_SPACE,
			bottom: height - AXIS_ROW - LABEL_SPACE,
			axis: height - AXIS_ROW,
			min,
			max
		};
	}

	function xOf (scale, t) {
		return ((t - scale.start) / (scale.end - scale.start)) * scale.plotWidth;
	}

	function yOf (scale, v) {
		return scale.top + ((scale.max - v) / (scale.max - scale.min)) * (scale.bottom - scale.top);
	}

	/** Heights of the horizontal grid lines: every multiple of `step` inside the range. */
	function gridLevels (scale, step) {
		const levels = [];
		for (let k = Math.ceil(scale.min / step - 1e-9); k * step <= scale.max + 1e-9; k++) {
			levels.push(Number((k * step).toFixed(6)));
		}
		return levels;
	}

	/** 06:00, 12:00 and 18:00 local on both days. */
	function sixHourTicks (data, timezone) {
		const ticks = [];
		for (const dayStart of [data.start, data.mid]) {
			const d = TideTime.localParts(dayStart, timezone);
			for (const hour of [6, 12, 18]) {
				ticks.push({ t: TideTime.localToUtc(d.year, d.month, d.day, hour, 0, timezone), hour });
			}
		}
		return ticks;
	}

	function scaleNumber (value, step) {
		const decimals = step < 1 ? (String(step).split(".")[1] || "").length : 0;
		return (value + 0).toFixed(decimals);
	}

	function curvePath (scale, curve) {
		return curve.map((p, i) => `${i === 0 ? "M" : "L"}${n(xOf(scale, p.t))},${n(yOf(scale, p.v))}`).join(" ");
	}

	/**
	 * A high or low: its point, label (and badge if extreme). A shown value that differs from the prediction
	 * (`point.predicted`, e.g. the observed high) gets a dotted connector to the predicted one, and the label
	 * goes outside both: above the higher point for a high, below the lower one for a low.
	 */
	function hiloMarkup (scale, point, { timezone, units, extremeRange }) {
		const kind = point.type === "H" ? "high" : "low";
		const extreme = extremeKind(point.v, extremeRange);
		const extremeClass = extreme ? ` tide-extreme tide-extreme-${extreme}` : "";
		const timed = ` data-t="${point.t}"`;
		const x = xOf(scale, point.t);
		const y = yOf(scale, point.v);
		const other = point.predicted;
		const outer = !other ? point.v : kind === "high" ? Math.max(point.v, other.v) : Math.min(point.v, other.v);
		const labelY = yOf(scale, outer);
		const labelX = n(clamp(x, LABEL_EDGE, scale.plotWidth - LABEL_EDGE));
		const line1 = kind === "high" ? labelY - 20 : labelY + 16;
		const line2 = kind === "high" ? labelY - 6 : labelY + 30;
		const time = TideTime.formatTime(point.t, timezone);
		const height = formatHeight(point.v, units, point.etss ? "*" : "");

		let out = "";
		if (other) {
			out += `<line class="tide-connector" x1="${n(xOf(scale, other.t))}" y1="${n(yOf(scale, other.v))}" x2="${n(x)}" y2="${n(y)}"/>`;
		}
		out += `<circle class="tide-point tide-point-${kind}${extremeClass}"${timed} cx="${n(x)}" cy="${n(y)}" r="2.5"/>`;
		if (extreme) {
			// Pill behind the height only; width estimated from the text (13px bold condensed ≈ 7px per character).
			const w = height.length * 7 + 10;
			out += `<rect class="tide-badge tide-badge-${extreme}"${timed} x="${n(Number(labelX) - w / 2)}" y="${n(line2 - 12.5)}" width="${n(w)}" height="17" rx="8.5"/>`;
		}
		out += `<text class="tide-label tide-label-${kind}${extremeClass}"${timed} text-anchor="middle">`
			+ `<tspan class="tide-label-time" x="${labelX}" y="${n(line1)}">${time}</tspan>`
			+ `<tspan class="tide-label-height" x="${labelX}" y="${n(line2)}">${height}</tspan>`
			+ "</text>";
		return out;
	}

	/**
	 * The highest (or lowest, for a low) of `points` within 90 minutes of a predicted high/low, or null if there
	 * is none or it is at either end of those points (the series hasn't turned there).
	 */
	function extremeNear (points, h) {
		const near = points.filter((p) => Math.abs(p.t - h.t) <= OBSERVED_SEARCH_MS);
		if (near.length < 3) return null;
		let best = 0;
		for (let i = 1; i < near.length; i++) {
			if (h.type === "H" ? near[i].v > near[best].v : near[i].v < near[best].v) best = i;
		}
		return best === 0 || best === near.length - 1 ? null : near[best];
	}

	/**
	 * The highs and lows to label, each with `predicted` holding NOAA's when it differs:
	 * - observed: once it is clear in the readings (extremeNear) and the latest reading is at least 30 minutes
	 *   after it;
	 * - otherwise, when the ETSS curve is shown, its high/low (`etss: true`, labeled with "*");
	 * - otherwise the prediction.
	 * @param {Array<{t, v, type}>} hilo predicted highs and lows
	 * @param {Array<{t, v}>} observations sorted by t (may be empty)
	 * @param {Array<{t, v}>|null} etss the ETSS curve when shown
	 */
	function shownExtremes (hilo, observations, etss = null) {
		const hasObs = Boolean(observations && observations.length);
		const latest = hasObs ? observations[observations.length - 1].t : null;
		if (!hasObs && !(etss && etss.length)) return hilo;
		return hilo.map((h) => {
			const observed = hasObs ? extremeNear(observations, h) : null;
			if (observed && latest - observed.t >= OBSERVED_SETTLE_MS) {
				return { t: observed.t, v: observed.v, type: h.type, predicted: { t: h.t, v: h.v } };
			}
			const forecast = etss && etss.length ? extremeNear(etss, h) : null;
			if (forecast) return { t: forecast.t, v: forecast.v, type: h.type, predicted: { t: h.t, v: h.v }, etss: true };
			return h;
		});
	}

	/**
	 * Whether to show the ETSS curve: at some predicted high or low still ahead (at or after now), the ETSS
	 * curve's high/low differs from the prediction by at least `threshold` (either way).
	 */
	function etssShown (hilo, etss, nowMs, threshold) {
		if (!etss || !etss.length || typeof threshold !== "number") return false;
		return hilo.some((h) => {
			if (h.t < nowMs) return false;
			const forecast = extremeNear(etss, h);
			return Boolean(forecast) && Math.abs(forecast.v - h.v) >= threshold;
		});
	}

	/** "d" of the observed water level path ("" when there are none). */
	function observedPath (scale, observations) {
		return observations && observations.length ? curvePath(scale, observations) : "";
	}

	/** "d" of the ETSS curve's path ("" when it isn't shown). */
	function etssPath (scale, etss) {
		return observedPath(scale, etss);
	}

	/** Note for the page when the latest observation is more than 6 hours old, else "". */
	function observationNote (latestMs, nowMs, timezone) {
		if (!latestMs || nowMs - latestMs <= OBSERVED_STALE_MS) return "";
		return `Observations not updated since ${TideTime.formatDay(latestMs, timezone)} ${TideTime.formatTime(latestMs, timezone)}`;
	}

	/**
	 * Build the chart.
	 * @param {object} data { start, mid, end, curve: [{t, v}], hilo: [{t, v, type, predicted?, etss?}],
	 *   observations?: [{t, v}], etss?: [{t, v}] (the ETSS curve when shown) }
	 * @param {object} opts { width, height, timezone, units, datum, meanSeaLevel, gridStep, extremeRange, idPrefix }
	 * @returns {{ svg: string, scale: object }}
	 */
	function buildChart (data, opts) {
		const {
			width,
			height,
			timezone,
			units,
			datum = "MLLW",
			meanSeaLevel = null,
			gridStep = null,
			extremeRange = null,
			idPrefix = "tide"
		} = opts;
		const hasMsl = meanSeaLevel !== null && meanSeaLevel !== undefined;
		const scale = makeScale(data, { width, height, meanSeaLevel: hasMsl ? meanSeaLevel : null });
		const W = scale.plotWidth;
		const step = gridStep || defaultGridStep(units);
		const levels = gridLevels(scale, step);
		const ticks = sixHourTicks(data, timezone);
		const id = (name) => `${idPrefix}-${name}`;
		const y = (v) => n(yOf(scale, v));
		const line = curvePath(scale, data.curve);

		// Past/future clips; the page moves their edge to "now" on every overlay update.
		let defs = `<clipPath id="${id("past")}"><rect class="tide-clip-past" x="0" y="0" width="0" height="${height}"/></clipPath>`
			+ `<clipPath id="${id("future")}"><rect class="tide-clip-future" x="0" y="0" width="${n(W)}" height="${height}"/></clipPath>`;

		// Shading: without MSL, one color fading toward the bottom; with MSL, one color above and one below,
		// both fading toward the MSL line.
		let shade;
		let mslMarkup = "";
		if (hasMsl) {
			const ym = yOf(scale, meanSeaLevel);
			defs += `<linearGradient id="${id("above")}" gradientUnits="userSpaceOnUse" x1="0" y1="${y(scale.max)}" x2="0" y2="${n(ym)}">`
				+ `<stop offset="0" class="tide-stop-above" stop-opacity="${FILL_OPACITY}"/><stop offset="1" class="tide-stop-above" stop-opacity="0"/></linearGradient>`
				+ `<linearGradient id="${id("below")}" gradientUnits="userSpaceOnUse" x1="0" y1="${n(ym)}" x2="0" y2="${y(scale.min)}">`
				+ `<stop offset="0" class="tide-stop-below" stop-opacity="0"/><stop offset="1" class="tide-stop-below" stop-opacity="${FILL_OPACITY}"/></linearGradient>`
				+ `<clipPath id="${id("above-msl")}"><rect x="0" y="0" width="${n(W)}" height="${n(ym)}"/></clipPath>`
				+ `<clipPath id="${id("below-msl")}"><rect x="0" y="${n(ym)}" width="${n(W)}" height="${n(height - ym)}"/></clipPath>`;
			const area = `${line} L${n(W)},${n(ym)} L0,${n(ym)} Z`;
			shade = `<path fill="url(#${id("above")})" clip-path="url(#${id("above-msl")})" d="${area}"/>`
				+ `<path fill="url(#${id("below")})" clip-path="url(#${id("below-msl")})" d="${area}"/>`;
			mslMarkup = `<line class="tide-msl" x1="0" y1="${n(ym)}" x2="${n(W)}" y2="${n(ym)}"/>`
				+ `<text class="tide-msl-label" x="${n(W - 3)}" y="${n(ym - 4)}" text-anchor="end">MSL</text>`;
		} else {
			defs += `<linearGradient id="${id("fade")}" gradientUnits="userSpaceOnUse" x1="0" y1="${y(scale.max)}" x2="0" y2="${n(scale.bottom)}">`
				+ `<stop offset="0" class="tide-stop-fill" stop-opacity="${FILL_OPACITY}"/><stop offset="1" class="tide-stop-fill" stop-opacity="0"/></linearGradient>`;
			shade = `<path fill="url(#${id("fade")})" d="${line} L${n(W)},${n(scale.bottom)} L0,${n(scale.bottom)} Z"/>`;
		}

		const grid = levels.filter((v) => v !== 0).map((v) => `M0,${y(v)} H${n(W)}`)
			.concat(ticks.map((k) => `M${n(xOf(scale, k.t))},0 V${n(scale.axis)}`)).join(" ");
		const divider = n(xOf(scale, data.mid));
		const axisTicks = ticks.map((k) => `M${n(xOf(scale, k.t))},${n(scale.axis)} v4`).join(" ") + ` M${divider},${n(scale.axis)} v8`;
		const labelRow = n(scale.axis + 14);

		const plot = `<path class="tide-grid" d="${grid}"/>`
			+ `<g class="tide-shade-past" opacity="${SHADE_PAST_OPACITY}" clip-path="url(#${id("past")})">${shade}</g>`
			+ `<g class="tide-shade-future" clip-path="url(#${id("future")})">${shade}</g>`
			+ mslMarkup
			+ `<line class="tide-zero" x1="0" y1="${y(0)}" x2="${n(W)}" y2="${y(0)}"/>`
			+ `<line class="tide-divider" x1="${divider}" y1="0" x2="${divider}" y2="${n(scale.axis)}"/>`
			+ `<path class="tide-curve tide-curve-past" clip-path="url(#${id("past")})" d="${line}"/>`
			+ `<path class="tide-curve tide-curve-future" clip-path="url(#${id("future")})" d="${line}"/>`
			+ `<path class="tide-etss" clip-path="url(#${id("future")})" d="${etssPath(scale, data.etss)}"/>`
			+ `<path class="tide-observed" d="${observedPath(scale, data.observations)}"/>`
			+ data.hilo.map((p) => hiloMarkup(scale, p, { timezone, units, extremeRange })).join("")
			+ `<path class="tide-axis-ticks" d="${axisTicks}"/>`
			+ ticks.map((k) => `<text class="tide-hour" data-t="${k.t}" x="${n(xOf(scale, k.t))}" y="${labelRow}" text-anchor="middle">${String(k.hour).padStart(2, "0")}</text>`).join("")
			+ `<text class="tide-day" x="4" y="${labelRow}">${TideTime.formatDay(data.start, timezone)}</text>`
			+ `<text class="tide-day" x="${n(Number(divider) + 4)}" y="${labelRow}">${TideTime.formatDay(data.mid, timezone)}</text>`
			+ "<g class=\"tide-overlay\" visibility=\"hidden\">"
			+ `<line class="tide-now-line" x1="0" y1="0" x2="0" y2="${n(scale.axis)}"/>`
			+ "<circle class=\"tide-now-dot\" cx=\"0\" cy=\"0\" r=\"5.5\"/>"
			+ "<text class=\"tide-now-label\" x=\"0\" y=\"0\"></text>"
			+ "</g>";

		const gutter = levels.map((v) => `<text class="tide-scale${v === 0 ? " tide-scale-zero" : ""}" x="${GUTTER - 6}" y="${n(yOf(scale, v) + 4)}" text-anchor="end">${scaleNumber(v, step)}</text>`).join("")
			+ `<text class="tide-axis-title" transform="translate(11 ${n((scale.top + scale.bottom) / 2)}) rotate(-90)" text-anchor="middle">Height above ${datum} (${unitLabel(units)})</text>`;

		const svg = `<svg xmlns="http://www.w3.org/2000/svg" class="tide-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
			+ `<defs>${defs}</defs>`
			+ `<g transform="translate(${GUTTER},0)">${plot}</g>`
			+ gutter
			+ "</svg>";

		return { svg, scale };
	}

	/** Width of the "past" part of the plot at `nowMs` (0 before the window, full width after it). */
	function pastWidth (scale, nowMs) {
		return clamp(xOf(scale, nowMs), 0, scale.plotWidth);
	}

	/**
	 * Where the overlay goes at `nowMs`, or null if now is outside the chart. The height is the latest observation
	 * (`latest`, { t, v }) if it is under an hour old, else the predicted curve's; the arrow follows the curve.
	 * @returns {{ x, y, value, rising, label, labelX, labelY, anchor } | null}
	 */
	function overlayState (scale, curve, nowMs, units, latest = null) {
		if (curve.length < 2 || nowMs < curve[0].t || nowMs > curve[curve.length - 1].t) return null;
		if (nowMs < scale.start || nowMs > scale.end) return null;

		let low = 0;
		let high = curve.length - 1;
		while (high - low > 1) {
			const middle = (low + high) >> 1;
			if (curve[middle].t <= nowMs) low = middle;
			else high = middle;
		}
		const a = curve[low];
		const b = curve[high];
		const observed = latest && latest.t <= nowMs && nowMs - latest.t <= OBSERVED_FRESH_MS;
		const value = observed ? latest.v : a.v + ((b.v - a.v) * (nowMs - a.t)) / (b.t - a.t);
		const rising = b.v >= a.v;
		const x = xOf(scale, nowMs);
		const y = yOf(scale, value);
		const nearRight = x > scale.plotWidth - 70;

		return {
			x,
			y,
			value,
			rising,
			label: `${rising ? "↑" : "↓"} ${formatHeight(value, units)}`,
			labelX: nearRight ? x - 11 : x + 11,
			labelY: clamp(y - 8, 12, scale.axis - 4),
			anchor: nearRight ? "end" : "start"
		};
	}

	const ChartSvg = {
		buildChart,
		shownExtremes,
		etssShown,
		observedPath,
		etssPath,
		observationNote,
		overlayState,
		pastWidth,
		formatHeight,
		defaultGridStep,
		extremeKind,
		makeScale,
		gridLevels,
		xOf,
		yOf
	};

	if (typeof module !== "undefined" && module.exports) {
		module.exports = ChartSvg;
	} else {
		root.ChartSvg = ChartSvg;
	}
}(typeof globalThis !== "undefined" ? globalThis : this));
