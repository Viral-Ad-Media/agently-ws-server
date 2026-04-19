"use strict";

const { getSupabase } = require("./supabase");
const { makeOutboundCall } = require("./twilio");

const WEEKDAY_CODES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DEFAULT_TIMEZONE = "America/New_York";

let schedulerTimer = null;
let runInProgress = false;

function getLocalSnapshot(timezone = DEFAULT_TIMEZONE) {
  const now = new Date();
  const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const timeFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const weekdayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });

  const dateKey = dateFormatter.format(now);
  const hm = timeFormatter.format(now);
  const weekday = weekdayFormatter.format(now).slice(0, 3).toLowerCase();
  return { dateKey, hm, weekday, runKey: `${dateKey}-${hm}` };
}

function normalizeWindows(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((window) => ({
      weekdays: Array.isArray(window?.weekdays)
        ? window.weekdays.map((day) => String(day || "").toLowerCase()).filter(Boolean)
        : [],
      time: String(window?.time || "").slice(0, 5),
    }))
    .filter((window) => window.weekdays.length > 0 && /^\d{2}:\d{2}$/.test(window.time));
}

function isScheduleDue(schedule, snapshot) {
  const windows = normalizeWindows(schedule.windows);
  return windows.some((window) => window.time === snapshot.hm && window.weekdays.includes(snapshot.weekday));
}

async function fetchScheduleTargets(db, schedule) {
  if (schedule.target_type === "lead" && schedule.lead_id) {
    const { data } = await db
      .from("leads")
      .select("*")
      .eq("organization_id", schedule.organization_id)
      .eq("id", schedule.lead_id)
      .limit(1);
    return data || [];
  }

  if (schedule.target_type === "tag" && schedule.tag) {
    const { data } = await db
      .from("leads")
      .select("*")
      .eq("organization_id", schedule.organization_id)
      .contains("tags", [schedule.tag]);
    return data || [];
  }

  return [];
}

async function reserveRun(db, schedule, lead, snapshot) {
  const { data, error } = await db
    .from("lead_outreach_runs")
    .insert({
      organization_id: schedule.organization_id,
      schedule_id: schedule.id,
      lead_id: lead.id,
      voice_agent_id: schedule.voice_agent_id,
      run_key: snapshot.runKey,
      status: "queued",
      target_name: lead.name || "Unknown",
      target_phone: lead.phone || "",
    })
    .select()
    .single();

  if (!error) return data;

  const message = String(error.message || "").toLowerCase();
  if (message.includes("duplicate") || message.includes("unique")) return null;
  throw error;
}

async function updateRun(db, id, updates) {
  await db
    .from("lead_outreach_runs")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id);
}

async function executeDueSchedules() {
  if (runInProgress) return;
  runInProgress = true;

  try {
    const apiBase = (process.env.API_URL || "").replace(/\/$/, "");
    if (!apiBase) {
      console.warn("[Lead Scheduler] API_URL is not configured. Skipping scheduler tick.");
      return;
    }

    const db = getSupabase();
    const { data: schedules, error } = await db
      .from("lead_outreach_schedules")
      .select("*")
      .eq("is_active", true);

    if (error) throw error;
    if (!schedules || schedules.length === 0) return;

    for (const schedule of schedules) {
      const snapshot = getLocalSnapshot(schedule.timezone || DEFAULT_TIMEZONE);
      if (!isScheduleDue(schedule, snapshot)) continue;

      const { data: agent } = await db
        .from("voice_agents")
        .select("id, name, twilio_phone_number")
        .eq("id", schedule.voice_agent_id)
        .eq("organization_id", schedule.organization_id)
        .maybeSingle();

      if (!agent?.twilio_phone_number) continue;

      const leads = await fetchScheduleTargets(db, schedule);
      if (!leads.length) continue;

      for (const lead of leads) {
        if (!lead?.phone) continue;

        const reservedRun = await reserveRun(db, schedule, lead, snapshot);
        if (!reservedRun) continue;

        try {
          const params = new URLSearchParams({
            leadId: lead.id,
            scheduleId: schedule.id,
          });
          const context = [lead.assignment_context || "", schedule.extra_context || ""]
            .filter(Boolean)
            .join("\n\n");
          if (context) params.set("extraContext", context);

          const twimlUrl = `${apiBase}/api/twilio/outbound-twiml?${params.toString()}`;
          const result = await makeOutboundCall({
            from: agent.twilio_phone_number,
            to: lead.phone,
            twimlUrl,
          });

          await updateRun(db, reservedRun.id, {
            status: "initiated",
            twilio_call_sid: result.callSid,
            error_message: null,
          });

          await db
            .from("leads")
            .update({
              voice_agent_id: schedule.voice_agent_id,
              updated_at: new Date().toISOString(),
            })
            .eq("id", lead.id)
            .eq("organization_id", schedule.organization_id);
        } catch (error) {
          console.error("[Lead Scheduler] Failed to place call", {
            scheduleId: schedule.id,
            leadId: lead.id,
            message: error.message,
          });
          await updateRun(db, reservedRun.id, {
            status: "failed",
            error_message: error.message,
          });
        }
      }
    }
  } catch (error) {
    console.error("[Lead Scheduler] Tick failed:", error.message);
  } finally {
    runInProgress = false;
  }
}

function startLeadScheduler() {
  const enabled = (process.env.ENABLE_LEAD_SCHEDULER || "true").toLowerCase() !== "false";
  if (!enabled) {
    console.log("[Lead Scheduler] Disabled by environment variable.");
    return () => {};
  }
  if (schedulerTimer) return () => clearInterval(schedulerTimer);

  const intervalMs = Math.max(30_000, parseInt(process.env.LEAD_SCHEDULER_INTERVAL_MS || "60000", 10));
  void executeDueSchedules();
  schedulerTimer = setInterval(() => {
    void executeDueSchedules();
  }, intervalMs);

  console.log(`[Lead Scheduler] Running every ${intervalMs / 1000}s.`);

  return () => {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  };
}

module.exports = { startLeadScheduler, executeDueSchedules };
