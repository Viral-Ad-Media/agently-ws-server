"use strict";

function clearConfirmation(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value || /\b(no|don't|do not|not yet|cancel|wait|but|instead|actually)\b/.test(value)) return false;
  return /^(yes|yeah|yep|sure|okay|ok|please do|that works|sounds good|go ahead|book it|confirm)(\b|[,.!])/i.test(value);
}

function signature(name, args) {
  return JSON.stringify([name, Object.keys(args).sort().map((key) => [key, args[key]])]);
}

// Bind approval to a staged action and the *audio turn*, not ASR arrival order.
// ASR may complete after the model has already started a response or tool call.
function createVoiceConfirmation({ timeoutMs = 4000 } = {}) {
  let pending = null;
  let previewSpoken = false;
  let turn = null;
  let generation = 0;
  return {
    agentSpoke() { if (pending) previewSpoken = true; },
    speechStarted(itemId) {
      if (turn?.resolve) turn.resolve("");
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      turn = { itemId, generation, eligible: Boolean(pending && previewSpoken), text: null, done, resolve };
    },
    transcribed(itemId, text) {
      if (!turn || (turn.itemId && itemId && turn.itemId !== itemId)) return;
      turn.text = String(text || "");
      turn.resolve(turn.text);
    },
    async authorize(name, args) {
      const key = signature(name, args);
      if (!pending || pending !== key) {
        pending = key;
        generation += 1;
        previewSpoken = false;
        return false;
      }
      const candidate = turn;
      if (!candidate?.eligible || candidate.generation !== generation) return false;
      let timer;
      const text = candidate.text ?? await Promise.race([
        candidate.done,
        new Promise((resolve) => { timer = setTimeout(() => resolve(""), timeoutMs); }),
      ]);
      clearTimeout(timer);
      if (turn !== candidate || pending !== key || !clearConfirmation(text)) return false;
      // One approval cannot authorize another mutation or a duplicate dispatch.
      pending = null;
      previewSpoken = false;
      generation += 1;
      return true;
    },
  };
}

module.exports = { clearConfirmation, createVoiceConfirmation };
