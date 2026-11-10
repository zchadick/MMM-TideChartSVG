/* MMM-TideChartSVG: Node side. Owns the fetch cycle for the one station. */
"use strict";

const NodeHelper = require("node_helper");
const Log = require("logger");
const { fetchTides } = require("./lib/noaa.js");
const { createFetchCycle } = require("./lib/fetchCycle.js");

module.exports = NodeHelper.create({
	start () {
		this.settings = null;
		this.cycle = null;
		this.latest = null;
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "REGISTER") return;

		if (!this.settings) {
			this.settings = payload;
			Log.info(`Station ${payload.stationID}, timezone ${payload.timezone}`);
			this.cycle = createFetchCycle({
				timezone: payload.timezone,
				fetchData: (nowMs) => fetchTides(this.settings, nowMs),
				send: (name, data) => this.sendResult(name, data),
				log: Log
			});
			this.cycle.start();
			return;
		}

		if (String(payload.stationID) !== String(this.settings.stationID)) {
			Log.warn(`Only one station per mirror is supported; ignoring station ${payload.stationID}`);
		}
		// A page that registers later (e.g. a reload) gets the latest result right away.
		if (this.latest) this.sendSocketNotification(this.latest.name, this.latest.data);
	},

	sendResult (name, data) {
		const tagged = { ...data, stationID: String(this.settings.stationID) };
		if (name === "TIDE_DATA" || !this.latest) this.latest = { name, data: tagged };
		this.sendSocketNotification(name, tagged);
	},

	stop () {
		if (this.cycle) this.cycle.stop();
	}
});
