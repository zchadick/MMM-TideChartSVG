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

	function n (value) {
		return (Math.round(value * 10) / 10).toString();
	}

	function clamp (value, low, high) {
		return Math.min(Math.max(value, low), high);
	}

	function unitLabel (units) {
		return units === "metric" ? "m" : "ft";
	}

	/** "7.2 ft" (one decimal; never "-0.0"). */
	function formatHeight (value, units) {
		return `${(Math.round(value * 10) / 10 + 0).toFixed(1)} ${unitLabel(units)}`;
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

	/** Scale for a data set and chart size. The range always includes 0 and the mean sea level. */
	function makeScale (data, { width, height, meanSeaLevel = null }) {
		let min = 0;
		let max = 0;
		for (const p of data.curve.concat(data.hilo)) {
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

	function hiloMarkup (scale, point, { timezone, units, extremeRange }) {
		const kind = point.type === "H" ? "high" : "low";
		const extreme = extremeKind(point.v, extremeRange);
		const extremeClass = extreme ? ` tide-extreme tide-extreme-${extreme}` : "";
		const timed = ` data-t="${point.t}"`;
		const x = xOf(scale, point.t);
		const y = yOf(scale, point.v);
		const labelX = n(clamp(x, LABEL_EDGE, scale.plotWidth - LABEL_EDGE));
		const line1 = kind === "high" ? y - 20 : y + 16;
		const line2 = kind === "high" ? y - 6 : y + 30;
		const time = TideTime.formatTime(point.t, timezone);
		const height = formatHeight(point.v, units);

		let out = `<circle class="tide-point tide-point-${kind}${extremeClass}"${timed} cx="${n(x)}" cy="${n(y)}" r="2.5"/>`;
		if (extreme) {
			// Badge behind the label; width estimated from the text (13px bold condensed ≈ 7px per character).
			const w = Math.max(time.length, height.length) * 7 + 12;
			out += `<rect class="tide-badge tide-badge-${extreme}"${timed} x="${n(Number(labelX) - w / 2)}" y="${n(line1 - 12)}" width="${n(w)}" height="${n(line2 - line1 + 17)}" rx="4"/>`;
		}
		out += `<text class="tide-label tide-label-${kind}${extremeClass}"${timed} text-anchor="middle">`
			+ `<tspan class="tide-label-time" x="${labelX}" y="${n(line1)}">${time}</tspan>`
			+ `<tspan class="tide-label-height" x="${labelX}" y="${n(line2)}">${height}</tspan>`
			+ "</text>";
		return out;
	}

	/**
	 * Build the chart.
	 * @param {object} data { start, mid, end, curve: [{t, v}], hilo: [{t, v, type}] }
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
	 * Where the overlay goes at `nowMs`, or null if now is outside the chart.
	 * @returns {{ x, y, value, rising, label, labelX, labelY, anchor } | null}
	 */
	function overlayState (scale, curve, nowMs, units) {
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
		const value = a.v + ((b.v - a.v) * (nowMs - a.t)) / (b.t - a.t);
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
