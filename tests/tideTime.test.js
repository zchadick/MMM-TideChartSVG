"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const TideTime = require("../lib/tideTime.js");

const LA = "America/Los_Angeles";
const HOUR = 60 * 60 * 1000;

test("chart window is local midnight today to local midnight the day after tomorrow", () => {
	const now = Date.parse("2026-11-09T23:30:00Z"); // 15:30 PST, Nov 9
	const w = TideTime.chartWindow(now, LA);
	assert.equal(new Date(w.start).toISOString(), "2026-11-09T08:00:00.000Z");
	assert.equal(new Date(w.mid).toISOString(), "2026-11-10T08:00:00.000Z");
	assert.equal(new Date(w.end).toISOString(), "2026-11-11T08:00:00.000Z");
});

test("chart window uses the local date, not the UTC date", () => {
	const now = Date.parse("2026-11-10T03:00:00Z"); // still Nov 9 in Seattle (19:00 PST)
	const w = TideTime.chartWindow(now, LA);
	assert.equal(new Date(w.start).toISOString(), "2026-11-09T08:00:00.000Z");
});

test("chart window spans 49 hours when daylight time ends", () => {
	const now = Date.parse("2026-11-01T12:00:00Z"); // Nov 1, 2026: 25-hour day in Seattle
	const w = TideTime.chartWindow(now, LA);
	assert.equal(new Date(w.start).toISOString(), "2026-11-01T07:00:00.000Z");
	assert.equal(new Date(w.mid).toISOString(), "2026-11-02T08:00:00.000Z");
	assert.equal(w.end - w.start, 49 * HOUR);
});

test("chart window spans 47 hours when daylight time starts", () => {
	const now = Date.parse("2026-03-08T18:00:00Z"); // Mar 8, 2026: 23-hour day in Seattle
	const w = TideTime.chartWindow(now, LA);
	assert.equal(w.end - w.start, 47 * HOUR);
});

test("next daily refresh is the next 00:01 local time", () => {
	const afternoon = Date.parse("2026-11-09T23:30:00Z");
	assert.equal(new Date(TideTime.nextDailyRefresh(afternoon, LA)).toISOString(), "2026-11-10T08:01:00.000Z");

	const justAfterMidnight = Date.parse("2026-11-10T08:00:30Z"); // 00:00:30 local
	assert.equal(new Date(TideTime.nextDailyRefresh(justAfterMidnight, LA)).toISOString(), "2026-11-10T08:01:00.000Z");

	const atRefresh = Date.parse("2026-11-10T08:01:00Z");
	assert.equal(new Date(TideTime.nextDailyRefresh(atRefresh, LA)).toISOString(), "2026-11-11T08:01:00.000Z");
});

test("works for other timezones", () => {
	const now = Date.parse("2026-11-09T12:00:00Z");
	assert.equal(new Date(TideTime.chartWindow(now, "America/New_York").start).toISOString(), "2026-11-09T05:00:00.000Z");
	assert.equal(new Date(TideTime.chartWindow(now, "Pacific/Honolulu").start).toISOString(), "2026-11-09T10:00:00.000Z");
	assert.equal(new Date(TideTime.chartWindow(now, "UTC").start).toISOString(), "2026-11-09T00:00:00.000Z");
});

test("labels: 24-hour time and short day name", () => {
	const t = Date.parse("2026-11-09T21:44:00Z");
	assert.equal(TideTime.formatTime(t, LA), "13:44");
	assert.equal(TideTime.formatTime(Date.parse("2026-11-10T08:05:00Z"), LA), "00:05");
	assert.equal(TideTime.formatDay(t, LA), "Mon");
});

test("timezone validation", () => {
	assert.equal(TideTime.isValidTimezone(LA), true);
	assert.equal(TideTime.isValidTimezone("Not/AZone"), false);
	assert.equal(typeof TideTime.defaultTimezone(), "string");
});
