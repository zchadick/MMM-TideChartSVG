/* global Module, Log, TideTime, ChartSvg */

/* MMM-TideChartSVG: browser side.
 * Draws the chart as an inline SVG. New data is built off-screen and swapped in with one replace, so the
 * chart never disappears. After the first draw the module calls updateDom only when the station name
 * (the header) changes; otherwise only the overlay changes, on its own interval.
 */
Module.register("MMM-TideChartSVG", {
	defaults: {
		stationID: null,
		stationName: null, // null = NOAA's name for the station
		timezone: null, // IANA name; null = the mirror's timezone
		units: "english", // "english" (ft) or "metric" (m)
		datum: "MLLW",
		meanSeaLevel: null, // height of mean sea level in the chart's units and datum; null = no MSL line
		gridStep: null, // height between grid lines; null = 2 ft or 0.5 m
		extremeRange: null, // [low, high]: tides below low or above high get a badge; null = off
		width: 400,
		height: 400,
		overlayUpdateInterval: 60 * 1000
	},

	getScripts () {
		return [this.file("lib/tideTime.js"), this.file("lib/chartSvg.js")];
	},

	getStyles () {
		return ["MMM-TideChartSVG.css"];
	},

	getHeader () {
		// A header set in config.js wins; otherwise the station's name once it's known.
		return this.data.header || this.config.stationName || this.stationName || "";
	},

	start () {
		this.tides = null;
		this.scale = null;
		this.overlay = null;
		this.overlayTimer = null;
		this.stationName = null;
		this.pending = null;
		this.problem = this.checkConfig();
		if (this.problem) {
			Log.error(`[${this.name}] ${this.problem}`);
			return;
		}
		this.timezone = this.config.timezone || TideTime.defaultTimezone();
		this.sendSocketNotification("REGISTER", {
			stationID: String(this.config.stationID),
			timezone: this.timezone,
			units: this.config.units === "metric" ? "metric" : "english",
			datum: this.config.datum
		});
	},

	checkConfig () {
		const c = this.config;
		if (!c.stationID) return "Set stationID in the module's config.";
		if (c.timezone && !TideTime.isValidTimezone(c.timezone)) {
			return `Unknown timezone "${c.timezone}". Use an IANA name such as "America/Los_Angeles".`;
		}
		if (c.meanSeaLevel !== null && typeof c.meanSeaLevel !== "number") return "meanSeaLevel must be a number.";
		if (c.gridStep !== null && !(typeof c.gridStep === "number" && c.gridStep > 0)) return "gridStep must be a number above 0.";
		if (c.extremeRange !== null) {
			const r = c.extremeRange;
			if (!Array.isArray(r) || r.length !== 2 || typeof r[0] !== "number" || typeof r[1] !== "number" || r[0] >= r[1]) {
				return "extremeRange must be [low, high], two numbers with low below high.";
			}
		}
		return null;
	},

	getDom () {
		if (!this.wrapper) {
			this.wrapper = document.createElement("div");
			this.wrapper.className = "tide-wrapper";
			this.chartBox = document.createElement("div");
			this.chartBox.className = "tide-chart-box";
			this.status = document.createElement("div");
			this.status.className = "tide-status dimmed xsmall";
			this.wrapper.append(this.chartBox, this.status);
			this.setStatus(this.problem || "Loading tides…");
			if (this.pending) {
				const { notification, payload } = this.pending;
				this.pending = null;
				this.handle(notification, payload);
			}
		}
		return this.wrapper;
	},

	socketNotificationReceived (notification, payload) {
		if (this.problem) return;
		if (!this.wrapper) {
			// Data arrived before MagicMirror asked for the DOM; draw it once the wrapper exists.
			this.pending = { notification, payload };
			return;
		}
		this.handle(notification, payload);
	},

	handle (notification, payload) {
		if (payload.stationID !== String(this.config.stationID)) {
			this.setStatus("Only one tide station per mirror is supported.");
			return;
		}
		if (notification === "TIDE_DATA") {
			this.draw(payload);
			this.updateStationName(payload.stationName || String(this.config.stationID));
		} else if (notification === "TIDE_ERROR") {
			this.setStatus(this.tides ? "(latest update failed)" : `Tide data unavailable: ${payload.message}`);
		}
	},

	updateStationName (name) {
		if (name === this.stationName) return;
		this.stationName = name;
		// Only the header changes; getDom returns the same wrapper, so the chart isn't rebuilt.
		if (!this.data.header && !this.config.stationName) this.updateDom(0);
	},

	draw (data) {
		const built = ChartSvg.buildChart(data, {
			width: this.config.width,
			height: this.config.height,
			timezone: this.timezone,
			units: data.units,
			datum: data.datum,
			meanSeaLevel: this.config.meanSeaLevel,
			gridStep: this.config.gridStep,
			extremeRange: this.config.extremeRange,
			idPrefix: this.identifier
		});

		const template = document.createElement("template");
		template.innerHTML = built.svg;
		const svg = template.content.firstElementChild;
		this.chartBox.replaceChildren(svg);

		this.tides = data;
		this.scale = built.scale;
		this.overlay = {
			group: svg.querySelector(".tide-overlay"),
			line: svg.querySelector(".tide-now-line"),
			dot: svg.querySelector(".tide-now-dot"),
			label: svg.querySelector(".tide-now-label"),
			clipPast: svg.querySelector(".tide-clip-past"),
			clipFuture: svg.querySelector(".tide-clip-future"),
			timed: Array.from(svg.querySelectorAll("[data-t]"))
		};
		this.setStatus("");
		this.updateOverlay();

		if (!this.overlayTimer) {
			this.overlayTimer = setInterval(() => this.updateOverlay(), this.config.overlayUpdateInterval);
		}
	},

	updateOverlay () {
		if (!this.overlay) return;
		const now = Date.now();
		const { group, line, dot, label, clipPast, clipFuture, timed } = this.overlay;

		// Past/future split: grey curve and faded shading up to now.
		const past = ChartSvg.pastWidth(this.scale, now);
		clipPast.setAttribute("width", past.toFixed(1));
		clipFuture.setAttribute("x", past.toFixed(1));
		clipFuture.setAttribute("width", (this.scale.plotWidth - past).toFixed(1));
		for (const el of timed) {
			el.classList.toggle("tide-past", Number(el.getAttribute("data-t")) < now);
		}

		const state = ChartSvg.overlayState(this.scale, this.tides.curve, now, this.tides.units);
		if (!state) {
			group.setAttribute("visibility", "hidden");
			return;
		}
		const x = state.x.toFixed(1);
		line.setAttribute("x1", x);
		line.setAttribute("x2", x);
		dot.setAttribute("cx", x);
		dot.setAttribute("cy", state.y.toFixed(1));
		label.setAttribute("x", state.labelX.toFixed(1));
		label.setAttribute("y", state.labelY.toFixed(1));
		label.setAttribute("text-anchor", state.anchor);
		label.textContent = state.label;
		group.setAttribute("visibility", "visible");
	},

	setStatus (text) {
		this.status.textContent = text;
		this.status.style.display = text ? "" : "none";
	}
});
