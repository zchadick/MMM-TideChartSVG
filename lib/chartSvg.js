/* MMM-TideChartSVG: builds the chart's SVG markup and places the overlay (pure; used by the page and tests).
 * Coordinates: x is time (window start → 0, end → width); y is height (max → top of plot, min → bottom).
 */
(function (root) {
	"use strict";

	const TideTime = typeof module !== "undefined" && module.exports ? require("./tideTime.js") : root.TideTime;

	const LABEL_SPACE = 34; // room for a two-line high/low label above or below the curve
	const DAY_ROW = 18; // row at the bottom for day names
	const TICK_LENGTH = 5;
	const LABEL_EDGE = 22; // keep label centers this far from the left/right edges

	function n (value) {
		return (Math.round(value * 10) / 10).toString();
	}

	function unitLabel (units) {
		return units === "metric" ? "m" : "ft";
	}

	/** "7.2 ft" (one decimal; never "-0.0"). */
	function formatHeight (value, units) {
		return `${(Math.round(value * 10) / 10 + 0).toFixed(1)} ${unitLabel(units)}`;
	}

	function clamp (value, low, high) {
		return Math.min(Math.max(value, low), high);
	}

	/** Scale for a data set and chart size. */
	function makeScale (data, width, height) {
		let min = Infinity;
		let max = -Infinity;
		for (const p of data.curve.concat(data.hilo)) {
			if (p.v < min) min = p.v;
			if (p.v > max) max = p.v;
		}
		if (min === max) {
			min -= 1;
			max += 1;
		}
		return {
			start: data.start,
			end: data.end,
			width,
			height,
			top: LABEL_SPACE,
			bottom: height - DAY_ROW - LABEL_SPACE,
			axis: height - DAY_ROW,
			min,
			max
		};
	}

	function xOf (scale, t) {
		return ((t - scale.start) / (scale.end - scale.start)) * scale.width;
	}

	function yOf (scale, v) {
		return scale.top + ((scale.max - v) / (scale.max - scale.min)) * (scale.bottom - scale.top);
	}

	function curvePath (scale, curve) {
		return curve.map((p, i) => `${i === 0 ? "M" : "L"}${n(xOf(scale, p.t))},${n(yOf(scale, p.v))}`).join(" ");
	}

	function ticksPath (scale, data, timezone) {
		const parts = [`M0,${n(scale.axis)} H${n(scale.width)}`];
		for (const dayStart of [data.start, data.mid]) {
			const d = TideTime.localParts(dayStart, timezone);
			for (const hour of [6, 12, 18]) {
				const t = TideTime.localToUtc(d.year, d.month, d.day, hour, 0, timezone);
				parts.push(`M${n(xOf(scale, t))},${n(scale.axis)} v-${TICK_LENGTH}`);
			}
		}
		return parts.join(" ");
	}

	function hiloMarkup (scale, point, timezone, units) {
		const isHigh = point.type === "H";
		const kind = isHigh ? "high" : "low";
		const x = xOf(scale, point.t);
		const y = yOf(scale, point.v);
		const labelX = n(clamp(x, LABEL_EDGE, scale.width - LABEL_EDGE));
		const line1 = isHigh ? y - 20 : y + 16;
		const line2 = isHigh ? y - 6 : y + 30;
		return `<circle class="tide-point tide-point-${kind}" cx="${n(x)}" cy="${n(y)}" r="2.5"/>`
			+ `<text class="tide-label tide-label-${kind}" text-anchor="middle">`
			+ `<tspan x="${labelX}" y="${n(line1)}">${TideTime.formatTime(point.t, timezone)}</tspan>`
			+ `<tspan x="${labelX}" y="${n(line2)}">${formatHeight(point.v, units)}</tspan>`
			+ "</text>";
	}

	/**
	 * Build the chart.
	 * @param {object} data { start, mid, end, curve: [{t, v}], hilo: [{t, v, type}] }
	 * @param {object} opts { width, height, timezone, units }
	 * @returns {{ svg: string, scale: object }}
	 */
	function buildChart (data, { width, height, timezone, units }) {
		const scale = makeScale(data, width, height);
		const line = curvePath(scale, data.curve);
		const first = data.curve[0];
		const last = data.curve[data.curve.length - 1];
		const fill = `${line} L${n(xOf(scale, last.t))},${n(scale.bottom)} L${n(xOf(scale, first.t))},${n(scale.bottom)} Z`;
		const divider = n(xOf(scale, data.mid));
		const dayY = n(height - 4);

		const svg = `<svg xmlns="http://www.w3.org/2000/svg" class="tide-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
			+ `<path class="tide-fill" d="${fill}"/>`
			+ `<path class="tide-ticks" d="${ticksPath(scale, data, timezone)}"/>`
			+ `<line class="tide-divider" x1="${divider}" y1="0" x2="${divider}" y2="${n(scale.axis)}"/>`
			+ `<path class="tide-curve" d="${line}"/>`
			+ data.hilo.map((p) => hiloMarkup(scale, p, timezone, units)).join("")
			+ `<text class="tide-day" text-anchor="middle" x="${n(xOf(scale, (data.start + data.mid) / 2))}" y="${dayY}">${TideTime.formatDay(data.start, timezone)}</text>`
			+ `<text class="tide-day" text-anchor="middle" x="${n(xOf(scale, (data.mid + data.end) / 2))}" y="${dayY}">${TideTime.formatDay(data.mid, timezone)}</text>`
			+ "<g class=\"tide-overlay\" visibility=\"hidden\">"
			+ `<line class="tide-now-line" x1="0" y1="0" x2="0" y2="${n(scale.axis)}"/>`
			+ "<circle class=\"tide-now-dot\" cx=\"0\" cy=\"0\" r=\"4\"/>"
			+ "<text class=\"tide-now-label\" x=\"0\" y=\"0\"></text>"
			+ "</g>"
			+ "</svg>";

		return { svg, scale };
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
		const nearRight = x > scale.width - 70;

		return {
			x,
			y,
			value,
			rising,
			label: `${rising ? "↑" : "↓"} ${formatHeight(value, units)}`,
			labelX: nearRight ? x - 8 : x + 8,
			labelY: clamp(y - 8, 12, scale.axis - 4),
			anchor: nearRight ? "end" : "start"
		};
	}

	const ChartSvg = { buildChart, overlayState, formatHeight, makeScale, xOf, yOf };

	if (typeof module !== "undefined" && module.exports) {
		module.exports = ChartSvg;
	} else {
		root.ChartSvg = ChartSvg;
	}
}(typeof globalThis !== "undefined" ? globalThis : this));
