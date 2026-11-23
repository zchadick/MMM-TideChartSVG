"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFetchCycle, createRepeatingCycle, RETRY_MS } = require("../lib/fetchCycle.js");

const LA = "America/Los_Angeles";

/** A fake clock and timer: one pending timer at a time, run by hand. */
function fakeTimers (startMs) {
	const clock = { now: startMs, pending: null, cleared: 0 };
	clock.setTimer = (fn, delay) => {
		clock.pending = { fn, at: clock.now + delay, delay };
		return clock.pending;
	};
	clock.clearTimer = (timer) => {
		if (clock.pending === timer) clock.pending = null;
		clock.cleared++;
	};
	clock.fire = async () => {
		const { fn, at } = clock.pending;
		clock.now = at;
		clock.pending = null;
		await fn();
	};
	return clock;
}

const quietLog = { error () {} };

function setup (startIso, outcomes) {
	const clock = fakeTimers(Date.parse(startIso));
	const sent = [];
	const fetchTimes = [];
	const cycle = createFetchCycle({
		timezone: LA,
		now: () => clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		log: quietLog,
		send: (name, data) => sent.push({ name, data }),
		fetchData: async (nowMs) => {
			fetchTimes.push(nowMs);
			const outcome = outcomes.shift();
			if (outcome instanceof Error) throw outcome;
			return { ok: outcome };
		}
	});
	return { clock, sent, fetchTimes, cycle };
}

test("fetches at start, then at the next 00:01 local time", async () => {
	const { clock, sent, fetchTimes, cycle } = setup("2026-11-09T23:30:00Z", ["first", "second"]);
	await cycle.start();
	assert.deepEqual(sent, [{ name: "TIDE_DATA", data: { ok: "first" } }]);
	assert.equal(new Date(clock.pending.at).toISOString(), "2026-11-10T08:01:00.000Z");

	await clock.fire();
	assert.equal(new Date(fetchTimes[1]).toISOString(), "2026-11-10T08:01:00.000Z");
	assert.equal(sent[1].name, "TIDE_DATA");
	assert.equal(new Date(clock.pending.at).toISOString(), "2026-11-11T08:01:00.000Z");
});

test("after a failure, retries every hour until it works, then goes back to 00:01", async () => {
	const { clock, sent, cycle } = setup("2026-11-10T08:01:00Z", [new Error("down"), new Error("still down"), "ok"]);
	await cycle.start();
	assert.deepEqual(sent[0], { name: "TIDE_ERROR", data: { message: "down" } });
	assert.equal(clock.pending.delay, RETRY_MS);

	await clock.fire();
	assert.equal(sent[1].name, "TIDE_ERROR");
	assert.equal(clock.pending.delay, RETRY_MS);

	await clock.fire();
	assert.equal(sent[2].name, "TIDE_DATA");
	assert.equal(new Date(clock.pending.at).toISOString(), "2026-11-11T08:01:00.000Z");
});

test("stop clears the pending timer and nothing more is scheduled", async () => {
	const { clock, cycle } = setup("2026-11-09T23:30:00Z", ["first"]);
	await cycle.start();
	assert.ok(clock.pending);
	cycle.stop();
	assert.equal(clock.pending, null);
	assert.equal(clock.cleared, 1);
});

// --- Observed water level: a fixed interval -----------------------------------

const FIFTEEN_MIN = 15 * 60 * 1000;

function setupRepeating (outcomes) {
	const clock = fakeTimers(Date.parse("2026-11-09T20:00:00Z"));
	const sent = [];
	const logged = [];
	const log = { info: (m) => logged.push(`info: ${m}`), warn: (m) => logged.push(`warn: ${m}`), error: (m) => logged.push(`error: ${m}`) };
	const cycle = createRepeatingCycle({
		intervalMs: FIFTEEN_MIN,
		notification: "TIDE_OBSERVATIONS",
		label: "Observed water level",
		now: () => clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		log,
		send: (name, data) => sent.push({ name, data }),
		fetchData: async () => {
			const outcome = outcomes.shift();
			if (outcome instanceof Error) throw outcome;
			return { ok: outcome };
		}
	});
	return { clock, sent, logged, cycle };
}

test("observations: fetched at start, then every interval", async () => {
	const { clock, sent, cycle } = setupRepeating(["a", "b"]);
	await cycle.start();
	assert.deepEqual(sent, [{ name: "TIDE_OBSERVATIONS", data: { ok: "a" } }]);
	assert.equal(clock.pending.delay, FIFTEEN_MIN);
	await clock.fire();
	assert.equal(sent.length, 2);
	assert.equal(clock.pending.delay, FIFTEEN_MIN);
});

test("observations: a failure sends nothing, keeps the interval, and logs only when it starts and ends", async () => {
	const { clock, sent, logged, cycle } = setupRepeating([new Error("no sensor"), new Error("no sensor"), "back"]);
	await cycle.start();
	await clock.fire();
	assert.deepEqual(sent, []);
	assert.equal(clock.pending.delay, FIFTEEN_MIN);
	assert.deepEqual(logged, ["warn: Observed water level unavailable, retrying every 15 min: no sensor"]);
	await clock.fire();
	assert.equal(sent.length, 1);
	assert.deepEqual(logged.slice(1), ["info: Observed water level: working again"]);
});

test("observations: stop clears the pending timer", async () => {
	const { clock, cycle } = setupRepeating(["a"]);
	await cycle.start();
	cycle.stop();
	assert.equal(clock.pending, null);
	assert.equal(clock.cleared, 1);
});
