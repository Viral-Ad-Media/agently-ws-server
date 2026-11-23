"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTwilioVoicePrompt } = require("../lib/context-builder");

test("caller prompt includes the owner playbook and booking safety boundary", () => {
  const prompt = buildTwilioVoicePrompt({
    agentRow: {
      name: "Mimi",
      language: "English",
      qualification_playbook: "Ask whether they are the decision maker and what timeline they need.",
      qualification_rules: {
        booking_criteria: "The caller explicitly requests an available appointment.",
        disqualify_signals: ["outside service area"],
      },
    },
    organization: { name: "Nutra Wellness" },
    faqs: [],
    relevantChunks: [],
    linkedChatbots: [],
  });

  assert.match(prompt, /LEAD QUALIFICATION PLAYBOOK/);
  assert.match(prompt, /decision maker/);
  assert.match(prompt, /score never creates an appointment/i);
  assert.match(prompt, /explicitly requests an available appointment/);
  assert.match(prompt, /outside service area/);
});

test("agents without a playbook keep qualification instructions out of the prompt", () => {
  const prompt = buildTwilioVoicePrompt({
    agentRow: { name: "Mimi", language: "English" },
    organization: { name: "Nutra Wellness" },
    faqs: [],
    relevantChunks: [],
    linkedChatbots: [],
  });
  assert.doesNotMatch(prompt, /LEAD QUALIFICATION PLAYBOOK/);
});
