/* global Module, Log, TideTime, ChartSvg */

/* MMM-TideChartSVG: browser side.
 * Draws the chart as an inline SVG. New data is built off-screen and swapped in with one replace, so the
 * chart never disappears. After the first draw the module doesn't use updateDom; only the overlay changes
 * on its own interval.
 */
Module.register("MMM-TideChartSVG", {
	defaults: {
		stationID: null,
		timezone: null, // IANA name; null = the mirror's timezone
		units: "english", // "english" (ft) or "metric" (m)
		datum: "MLLW",
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

	start () {
		this.tides = null;
		this.scale = null;
		this.overlay = null;
		this.overlayTimer = null;
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
		if (!this.config.stationID) return "Set stationID in the module's config.";
		if (this.config.timezone && !TideTime.isValidTimezone(this.config.timezone)) {
			return `Unknown timezone "${this.config.timezone}". Use an IANA name such as "America/Los_Angeles".`;
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
		}
		return this.wrapper;
	},

	socketNotificationReceived (notification, payload) {
		if (this.problem || !this.wrapper) return;
		if (payload.stationID !== String(this.config.stationID)) {
			this.setStatus("Only one tide station per mirror is supported.");
			return;
		}
		if (notification === "TIDE_DATA") {
			this.draw(payload);
		} else if (notification === "TIDE_ERROR") {
			this.setStatus(this.tides ? "(latest update failed)" : `Tide data unavailable: ${payload.message}`);
		}
	},

	draw (data) {
		const built = ChartSvg.buildChart(data, {
			width: this.config.width,
			height: this.config.height,
			timezone: this.timezone,
			units: data.units
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
			label: svg.querySelector(".tide-now-label")
		};
		this.setStatus("");
		this.updateOverlay();

		if (!this.overlayTimer) {
			this.overlayTimer = setInterval(() => this.updateOverlay(), this.config.overlayUpdateInterval);
		}
	},

	updateOverlay () {
		if (!this.overlay) return;
		const state = ChartSvg.overlayState(this.scale, this.tides.curve, Date.now(), this.tides.units);
		const { group, line, dot, label } = this.overlay;
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
