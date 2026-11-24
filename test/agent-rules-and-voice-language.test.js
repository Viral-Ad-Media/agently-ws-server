"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { agentRuleLines, normalizeAgentRules } = require("../lib/context-builder");
const { voiceLanguageRule, normalizeLanguageCode } = require("../lib/realtime-proxy");

test("lead capture defaults ON and asks for name, number and reason", () => {
  const text = agentRuleLines({}, { hasTransfer: false }).join("\n");
  assert.match(text, /Lead capture is ON/);
  assert.match(text, /name, best callback number and reason/);
});

test("lead capture OFF tells the agent not to ask for contact details", () => {
  const text = agentRuleLines({ captureAllLeads: false }).join("\n");
  assert.match(text, /Lead capture is OFF/);
  assert.doesNotMatch(text, /Lead capture is ON/);
});

test("auto escalation only matters when a transfer number exists", () => {
  assert.doesNotMatch(agentRuleLines({ autoEscalate: true }, { hasTransfer: false }).join("\n"), /escalation/i);
  assert.match(agentRuleLines({ autoEscalate: true }, { hasTransfer: true }).join("\n"), /Proactive escalation is ON/);
  assert.match(agentRuleLines({ autoEscalate: false }, { hasTransfer: true }).join("\n"), /Proactive escalation is OFF/);
});

test("legacy call instructions are still honoured; the raw JSON keys are not dumped", () => {
  const text = agentRuleLines({ callInstructions: "Mention the spring offer", agentPrompt: "x" }).join("\n");
  assert.match(text, /Mention the spring offer/);
  assert.doesNotMatch(text, /agentPrompt|captureAllLeads|\{/);
});

test("rules stored as a JSON string are parsed", () => {
  assert.deepEqual(normalizeAgentRules('{"autoEscalate":true}'), { autoEscalate: true });
  assert.deepEqual(normalizeAgentRules("nonsense"), {});
  assert.deepEqual(normalizeAgentRules(null), {});
});

test("voice language rule follows the visitor's widget choice", () => {
  assert.equal(normalizeLanguageCode("ES"), "es");
  assert.equal(normalizeLanguageCode("xx"), "");
  assert.match(voiceLanguageRule("es", ["en", "es"]), /Speak Spanish\. If the visitor clearly speaks English/);
  assert.match(voiceLanguageRule("fr", []), /Speak only French/);
  assert.match(voiceLanguageRule("", []), /Speak only English/);
});
