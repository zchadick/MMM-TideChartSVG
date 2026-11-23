/* MMM-TideChartSVG: Node side. Owns the fetch cycles (daily predictions, observed water levels, and the ETSS surge
 * forecast when a threshold is set) for the one station. */
"use strict";

const NodeHelper = require("node_helper");
const Log = require("logger");
const { createStationLoader, createTideSource, createObservationSource } = require("./lib/noaa.js");
const { createEtssSource } = require("./lib/etss.js");
const { createFetchCycle, createRepeatingCycle } = require("./lib/fetchCycle.js");

const ETSS_INTERVAL_MS = 3 * 60 * 60 * 1000; // ETSS runs 4 times a day, each arriving a few hours late

module.exports = NodeHelper.create({
	start () {
		this.settings = null;
		this.cycle = null;
		this.observationCycle = null;
		this.etssCycle = null;
		this.latest = null;
		this.latestObservations = null;
		this.latestEtss = null;
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
			if (payload.etss) {
				this.etssCycle = createRepeatingCycle({
					intervalMs: ETSS_INTERVAL_MS,
					notification: "TIDE_ETSS",
					label: "ETSS surge forecast",
					fetchData: createEtssSource(this.settings, fetch, loadStation, Log),
					send: (name, data) => this.sendResult(name, data),
					log: Log
				});
			}
			this.cycle.start();
			this.observationCycle.start();
			if (this.etssCycle) this.etssCycle.start();
			return;
		}

		if (String(payload.stationID) !== String(this.settings.stationID)) {
			Log.warn(`Only one station per mirror is supported; ignoring station ${payload.stationID}`);
		}
		// A page that registers later (e.g. a reload) gets the latest results right away.
		if (this.latest) this.sendSocketNotification(this.latest.name, this.latest.data);
		if (this.latestObservations) this.sendSocketNotification("TIDE_OBSERVATIONS", this.latestObservations);
		if (this.latestEtss) this.sendSocketNotification("TIDE_ETSS", this.latestEtss);
	},

	sendResult (name, data) {
		const tagged = { ...data, stationID: String(this.settings.stationID) };
		if (name === "TIDE_OBSERVATIONS") {
			this.latestObservations = tagged;
		} else if (name === "TIDE_ETSS") {
			this.latestEtss = tagged;
		} else if (name === "TIDE_DATA" || !this.latest) {
			this.latest = { name, data: tagged };
		}
		this.sendSocketNotification(name, tagged);
	},

	stop () {
		if (this.cycle) this.cycle.stop();
		if (this.observationCycle) this.observationCycle.stop();
		if (this.etssCycle) this.etssCycle.stop();
	}
});
