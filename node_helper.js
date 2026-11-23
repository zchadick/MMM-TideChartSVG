/* MMM-TideChartSVG: Node side. Owns the fetch cycles (daily predictions, observed water levels) for the one station. */
"use strict";

const NodeHelper = require("node_helper");
const Log = require("logger");
const { createStationLoader, createTideSource, createObservationSource } = require("./lib/noaa.js");
const { createFetchCycle, createRepeatingCycle } = require("./lib/fetchCycle.js");

module.exports = NodeHelper.create({
	start () {
		this.settings = null;
		this.cycle = null;
		this.observationCycle = null;
		this.latest = null;
		this.latestObservations = null;
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "REGISTER") return;

		if (!this.settings) {
			this.settings = payload;
			Log.info(`Station ${payload.stationID}, timezone ${payload.timezone}`);
			const loadStation = createStationLoader(this.settings);
			this.cycle = createFetchCycle({
				timezone: payload.timezone,
				fetchData: createTideSource(this.settings, fetch, loadStation),
				send: (name, data) => this.sendResult(name, data),
				log: Log
			});
			this.observationCycle = createRepeatingCycle({
				intervalMs: payload.observationInterval,
				notification: "TIDE_OBSERVATIONS",
				label: "Observed water level",
				fetchData: createObservationSource(this.settings, fetch, loadStation),
				send: (name, data) => this.sendResult(name, data),
				log: Log
			});
			this.cycle.start();
			this.observationCycle.start();
			return;
		}

		if (String(payload.stationID) !== String(this.settings.stationID)) {
			Log.warn(`Only one station per mirror is supported; ignoring station ${payload.stationID}`);
		}
		// A page that registers later (e.g. a reload) gets the latest results right away.
		if (this.latest) this.sendSocketNotification(this.latest.name, this.latest.data);
		if (this.latestObservations) this.sendSocketNotification("TIDE_OBSERVATIONS", this.latestObservations);
	},

	sendResult (name, data) {
		const tagged = { ...data, stationID: String(this.settings.stationID) };
		if (name === "TIDE_OBSERVATIONS") {
			this.latestObservations = tagged;
		} else if (name === "TIDE_DATA" || !this.latest) {
			this.latest = { name, data: tagged };
		}
		this.sendSocketNotification(name, tagged);
	},

	stop () {
		if (this.cycle) this.cycle.stop();
		if (this.observationCycle) this.observationCycle.stop();
	}
});
