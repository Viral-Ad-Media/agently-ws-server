"use strict";

/**
 * A hard cap on simultaneous ElevenLabs voice sessions.
 *
 * There was no limiter at all before this: nothing stopped the app from
 * opening more ElevenLabs streams than the account's plan allows. The
 * failure mode isn't a clean rejection -- calls that exceed the plan's
 * concurrency go silent mid-conversation, because the provider refuses new
 * audio while an agent is speaking on-line to a real caller.
 *
 * This gates at call-start, not per-utterance: once a call is locked to a
 * voice provider (see [voice-provider] selected in twilio-media-stream.js),
 * it keeps that provider for the whole conversation, so the natural place
 * to enforce the ceiling is the same decision point, before the caller
 * hears anything. A call that can't get an ElevenLabs slot starts on the
 * OpenAI fallback instead -- a different voice, not a dropped call.
 *
 * ELEVENLABS_MAX_CONCURRENT_STREAMS should be set below your ElevenLabs
 * plan's real concurrency limit (check the ElevenLabs dashboard --
 * Subscription -- the number isn't reliably exposed via their API). Leave
 * at least one stream of headroom: this process's own voice previews
 * (POST /api/messenger/voice-preview) also count against the same account
 * limit and aren't tracked here.
 */

let active = 0;

function maxConcurrentStreams() {
  const n = Number(process.env.ELEVENLABS_MAX_CONCURRENT_STREAMS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
}

/** Reserve a slot for a call about to start on ElevenLabs. Synchronous, non-blocking:
 *  returns false immediately rather than making a live call wait. */
function tryAcquireForCall(callSid) {
  if (active >= maxConcurrentStreams()) {
    console.warn("[elevenlabs-concurrency] at capacity, falling back", {
      callSid,
      active,
      max: maxConcurrentStreams(),
    });
    return false;
  }
  active += 1;
  return true;
}

/** Release the slot when the call ends. Idempotent guard against double-release. */
function releaseForCall(callSid, released) {
  if (released?.done) return;
  if (released) released.done = true;
  active = Math.max(0, active - 1);
  console.log("[elevenlabs-concurrency] released", { callSid, active });
}

function currentActive() {
  return active;
}

module.exports = { tryAcquireForCall, releaseForCall, currentActive, maxConcurrentStreams };
