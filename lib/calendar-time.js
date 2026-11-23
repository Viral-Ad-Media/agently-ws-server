"use strict";

function validZone(zone) {
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); return zone || "UTC"; }
  catch { return "UTC"; }
}

function dateInZone(now, zone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: validZone(zone), year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function midnight(date, zone) {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: validZone(zone), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const delta = target - local;
    if (!delta) break;
    guess += delta;
  }
  return new Date(guess);
}

function calendarWindow(date, days, zone = "UTC", now = new Date()) {
  const text = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? date : dateInZone(now, zone);
  const endDay = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(endDay.getTime())) throw new Error("Invalid calendar date");
  endDay.setUTCDate(endDay.getUTCDate() + days);
  return { fromISO: midnight(text, zone).toISOString(), toISO: midnight(endDay.toISOString().slice(0, 10), zone).toISOString() };
}

module.exports = { calendarWindow, dateInZone, validZone };
