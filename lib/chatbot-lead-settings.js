"use strict";

/**
 * Website chat lead collection, as the tenant set it in Messenger.
 *
 *  - chatbots.collect_leads (master switch; lead_capture_enabled is kept in
 *    step with it) decides whether the chat may collect visitor details at all.
 *  - chatbots.lead_capture_fields lists which details to collect.
 *
 * Every path that can create a lead from chat, show the details form, or tell
 * the AI what to ask for reads this one helper, so "off" means off everywhere
 * and only the chosen details are ever requested or stored.
 */

const LEAD_FIELD_OPTIONS = ["name", "email", "phone", "reason"];
const DEFAULT_LEAD_FIELDS = ["name", "email", "phone"];
const CONTACT_FIELDS = ["email", "phone"];

const FIELD_WORDS = {
  name: "name",
  email: "email address",
  phone: "phone number",
  reason: "what they need help with",
};

function normalizeLeadFields(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const picked = [
    ...new Set(
      list
        .map((item) => String(item || "").trim().toLowerCase())
        .filter((item) => LEAD_FIELD_OPTIONS.includes(item)),
    ),
  ];
  // Keep a stable, readable order.
  const ordered = LEAD_FIELD_OPTIONS.filter((field) => picked.includes(field));
  return ordered.length ? ordered : [...DEFAULT_LEAD_FIELDS];
}

function chatbotLeadSettings(row = {}) {
  return {
    enabled: row?.collect_leads !== false && row?.lead_capture_enabled !== false,
    fields: normalizeLeadFields(row?.lead_capture_fields),
  };
}

/** For saving from the dashboard: a lead is only useful with a way to reach them. */
function validateLeadFieldsForSave(value) {
  const fields = normalizeLeadFields(value);
  if (!fields.some((field) => CONTACT_FIELDS.includes(field))) {
    const error = new Error("Choose at least email or phone so you can reach the visitor.");
    error.status = 400;
    throw error;
  }
  return fields;
}

function joinWords(words) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function leadFieldsSentence(fields) {
  return joinWords(normalizeLeadFields(fields).map((field) => FIELD_WORDS[field]));
}

function contactFieldsSentence(fields) {
  const contact = normalizeLeadFields(fields).filter((field) => CONTACT_FIELDS.includes(field));
  return contact.map((field) => FIELD_WORDS[field]).join(" or ") || "email address or phone number";
}

/** The prompt lines that tell the chat AI what it may ask for. */
function leadCapturePromptLines(settings) {
  if (!settings?.enabled) {
    return [
      "- Lead collection is switched OFF for this business. Never ask the visitor for their name, email, phone number or any other contact details, and never offer to 'take their details' or 'have someone follow up'.",
      "- If they want a quote, booking or follow-up, point them to the business's own contact options from the knowledge above (phone, email, booking page) instead.",
    ];
  }
  return [
    `- When the visitor wants a quote, callback, booking, appointment, human support, a follow-up, or leaves a message, collect ONLY these details: ${leadFieldsSentence(settings.fields)}. Never ask for anything else.`,
    `- At least their ${contactFieldsSentence(settings.fields)} is needed so the team can reply. Do not ask again once provided.`,
  ];
}

module.exports = {
  LEAD_FIELD_OPTIONS,
  DEFAULT_LEAD_FIELDS,
  normalizeLeadFields,
  chatbotLeadSettings,
  validateLeadFieldsForSave,
  leadFieldsSentence,
  contactFieldsSentence,
  leadCapturePromptLines,
};
