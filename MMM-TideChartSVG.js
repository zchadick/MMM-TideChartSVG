/* global Module, Log, TideTime, ChartSvg */

/* MMM-TideChartSVG: browser side.
 * Draws the chart as an inline SVG. New data is built off-screen and swapped in with one replace, so the
 * chart never disappears. After the first draw the module calls updateDom only when the station name
 * (the header) changes; otherwise only the overlay changes, on its own interval. New observations only
 * change the observed line, unless they change the height range or a labeled high/low (then the chart is
 * rebuilt).
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
		overlayUpdateInterval: 60 * 1000,
		observationInterval: 15 * 60 * 1000 // how often the observed water level is fetched; at least 6 minutes
	},

	getScripts () {
		return [this.file("lib/tideTime.js"), this.file("lib/chartSvg.js")];
	},

	getStyles () {
		return ["MMM-TideChartSVG.css"];
	},

	getHeader () {
		// A header set in config.js wins; otherwise the station's name once it's known.
		// "*" marks a curve modeled from a reference station (subordinate stations), whatever the header.
		const header = this.data.header || this.config.stationName || this.stationName || "";
		return header && this.modeled ? `${header}*` : header;
	},

	start () {
		this.tides = null;
		this.observations = [];
		this.latestObservedAt = null;
		this.scale = null;
		this.chartKey = null;
		this.overlay = null;
		this.overlayTimer = null;
		this.stationName = null;
		this.modeled = false;
		this.pending = [];
		this.statusText = "";
		this.noteText = "";
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
			datum: this.config.datum,
			observationInterval: this.config.observationInterval
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
		if (!(typeof c.observationInterval === "number" && c.observationInterval >= 6 * 60 * 1000)) {
			return "observationInterval must be a number of milliseconds, at least 360000 (6 minutes).";
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
			// Data that arrived before MagicMirror asked for the DOM, in the order it came.
			for (const { notification, payload } of this.pending.splice(0)) this.handle(notification, payload);
		}
		return this.wrapper;
	},

	socketNotificationReceived (notification, payload) {
		if (this.problem) return;
		if (!this.wrapper) {
			// Data arrived before MagicMirror asked for the DOM; handle it once the wrapper exists.
			this.pending.push({ notification, payload });
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
			this.tides = payload;
			this.setStatus("");
			this.render(true);
			this.updateStationName(payload.stationName || String(this.config.stationID), Boolean(payload.modeled));
		} else if (notification === "TIDE_OBSERVATIONS") {
			this.observations = payload.observations;
			const latest = this.observations[this.observations.length - 1];
			if (latest && (!this.latestObservedAt || latest.t > this.latestObservedAt)) this.latestObservedAt = latest.t;
			if (this.tides) this.render(false);
		} else if (notification === "TIDE_ERROR") {
			this.setStatus(this.tides ? "(latest update failed)" : `Tide data unavailable: ${payload.message}`);
		}
	},

	updateStationName (name, modeled) {
		if (name === this.stationName && modeled === this.modeled) return;
		const showsName = !this.data.header && !this.config.stationName;
		const headerChanges = modeled !== this.modeled || showsName;
		this.stationName = name;
		this.modeled = modeled;
		// Only the header changes; getDom returns the same wrapper, so the chart isn't rebuilt.
		if (headerChanges) this.updateDom(0);
	},

	/**
	 * Draw the chart with the latest predictions and observations. Unless `rebuild` is set, only the observed
	 * line changes, as long as the height range and the labeled highs/lows stay the same.
	 */
	render (rebuild) {
		const tides = this.tides;
		const observations = this.observations.filter((p) => p.t >= tides.start && p.t <= tides.end);
		const data = { ...tides, hilo: ChartSvg.shownExtremes(tides.hilo, observations), observations };
		const opts = {
			width: this.config.width,
			height: this.config.height,
			timezone: this.timezone,
			units: tides.units,
			datum: tides.datum,
			meanSeaLevel: this.config.meanSeaLevel,
			gridStep: this.config.gridStep,
			extremeRange: this.config.extremeRange,
			idPrefix: this.identifier
		};
		const scale = ChartSvg.makeScale(data, opts);
		const key = JSON.stringify([data.hilo, scale.min, scale.max]);
		if (!rebuild && key === this.chartKey) {
			this.overlay.observed.setAttribute("d", ChartSvg.observedPath(this.scale, observations));
			this.updateOverlay();
			return;
		}

		const built = ChartSvg.buildChart(data, opts);
		const template = document.createElement("template");
		template.innerHTML = built.svg;
		const svg = template.content.firstElementChild;
		this.chartBox.replaceChildren(svg);

		this.chartKey = key;
		this.scale = built.scale;
		this.overlay = {
			group: svg.querySelector(".tide-overlay"),
			line: svg.querySelector(".tide-now-line"),
			dot: svg.querySelector(".tide-now-dot"),
			label: svg.querySelector(".tide-now-label"),
			observed: svg.querySelector(".tide-observed"),
			clipPast: svg.querySelector(".tide-clip-past"),
			clipFuture: svg.querySelector(".tide-clip-future"),
			timed: Array.from(svg.querySelectorAll("[data-t]"))
		};
		this.updateOverlay();

		if (!this.overlayTimer) {
			this.overlayTimer = setInterval(() => this.updateOverlay(), this.config.overlayUpdateInterval);
		}
	},

	updateOverlay () {
		if (!this.overlay) return;
		const now = Date.now();
		const { group, line, dot, label, clipPast, clipFuture, timed } = this.overlay;

		this.noteText = ChartSvg.observationNote(this.latestObservedAt, now, this.timezone);
		this.showStatus();

		// Past/future split: grey curve and faded shading up to now.
		const past = ChartSvg.pastWidth(this.scale, now);
		clipPast.setAttribute("width", past.toFixed(1));
		clipFuture.setAttribute("x", past.toFixed(1));
		clipFuture.setAttribute("width", (this.scale.plotWidth - past).toFixed(1));
		for (const el of timed) {
			el.classList.toggle("tide-past", Number(el.getAttribute("data-t")) < now);
		}

		const latest = this.observations[this.observations.length - 1] || null;
		const state = ChartSvg.overlayState(this.scale, this.tides.curve, now, this.tides.units, latest);
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

	/** The status line: an error or loading message, then the note about old observations if any. */
	setStatus (text) {
		this.statusText = text;
		this.showStatus();
	},

	showStatus () {
		const text = [this.statusText, this.noteText].filter(Boolean).join(" ");
		if (this.status.textContent === text) return;
		this.status.textContent = text;
		this.status.style.display = text ? "" : "none";
	}
});
