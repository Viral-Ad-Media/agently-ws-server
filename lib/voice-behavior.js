"use strict";

function asString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return "";
}

function normalizeSpaces(text) {
  return asString(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseName(text) {
  const value = normalizeSpaces(text);
  if (!value) return "";
  return value
    .split(" ")
    .map((part) => {
      if (!part) return part;
      if (/^[A-Z]{2,}$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function cleanRecipientNameForSpeech(name) {
  const raw = normalizeSpaces(name)
    .replace(/[<>"{}[\]()]/g, "")
    .replace(/^\s*(?:name|recipient|customer|lead)\s*[:=-]\s*/i, "")
    .trim();
  if (!raw) return "";
  const normalized = raw.toLowerCase();
  if (
    /^(?:outbound\s+)?(?:lead|customer|recipient|contact|caller|user|client|person|prospect|unknown|test|none|null|n\/a|na|not\s+provided|unknown\s+recipient)$/i.test(
      normalized,
    )
  ) {
    return "";
  }
  if (/^(?:\+?\d[\d\s().-]{5,}|[a-f0-9-]{16,})$/i.test(raw)) return "";
  return titleCaseName(raw).slice(0, 80);
}

function collapseDuplicateWords(text) {
  let output = asString(text);
  for (let i = 0; i < 4; i += 1) {
    output = output.replace(/\b([A-Za-z]{2,})\b(?:\s*[—-]\s*|\s+)\1\b/gi, "$1");
  }
  return output;
}

function collapseDuplicatePhrases(text) {
  let output = asString(text);
  const phrasePatterns = [
    /\b(about)\s+\1\b/gi,
    /\b(regarding)\s+\1\b/gi,
    /\b(concerning)\s+\1\b/gi,
    /\b(to)\s+\1\b/gi,
    /\b(for)\s+\1\b/gi,
    /\b(call(?:ing)?)\s+\1\b/gi,
    /\b(reach\s+out)\s+\1\b/gi,
    /\b(follow\s+up)\s+\1\b/gi,
  ];
  for (let i = 0; i < 3; i += 1) {
    for (const pattern of phrasePatterns)
      output = output.replace(pattern, "$1");
  }
  return output;
}

function removeInternalPurposePrefixes(text) {
  let value = normalizeSpaces(text)
    .replace(/^[-–—:;,.\s]+/, "")
    .replace(
      /^(?:hi|hello)?\s*(?:this\s+is\s+[^,.]{1,80}\s+from\s+[^,.]{1,80}\s+(?:and\s+)?)?(?:i|we)\s*(?:am|are|'m|'re)?\s*(?:calling|reaching\s*out|contacting|phoning)\s+from\s+[^,.]{1,80}\s+(?:because|to|about|regarding|concerning|for|in\s+order\s+to)\s+/i,
      "",
    )
    .replace(/^call\s+purpose\s*[:=-]\s*/i, "")
    .replace(/^purpose\s*[:=-]\s*/i, "")
    .replace(/^objective\s*[:=-]\s*/i, "")
    .replace(/^task\s*[:=-]\s*/i, "")
    .trim();

  for (let i = 0; i < 4; i += 1) {
    const before = value;
    value = value
      .replace(
        /^(?:you|the\s+agent|agent|assistant|ai|rep|representative|we|i|caller)\s*(?:are|am|is|'re|'m)?\s*(?:calling|reaching\s*out|reach\s*out|contacting|phoning)\s*(?:them|him|her|the\s+customer|the\s+recipient|the\s+lead)?\s*(?:because|to|about|regarding|concerning|for|in\s+order\s+to)?\s*/i,
        "",
      )
      .replace(
        /^(?:this\s+call|the\s+call)\s+(?:is|was)?\s*(?:for|about|regarding|concerning|to|because)?\s*/i,
        "",
      )
      .replace(/^for\s+the\s+purpose\s+of\s+/i, "")
      .replace(/^in\s+order\s+to\s+/i, "to ")
      .trim();
    if (value === before) break;
  }
  return value;
}

function sanitizeOutboundPurposeText(text, maxChars = 180) {
  let value = normalizeSpaces(text);
  if (!value) return "";

  const firstSentence = value.split(/(?<=[.!?])\s+/)[0] || value;
  value = firstSentence
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\breach\s*-?\s*out\b/gi, "reach out")
    .replace(/\breachout\b/gi, "reach out")
    .replace(/\bfollow\s*-?\s*up\b/gi, "follow up")
    .replace(/\bfollowup\b/gi, "follow up")
    .replace(/\bwellbeing\b/gi, "well-being")
    .replace(/\bcallre\b/gi, "care")
    .replace(/\bcust(?:omer)?\b/gi, "customer")
    .replace(/\bpls\b/gi, "please");

  value = removeInternalPurposePrefixes(value);
  value = value
    .replace(/^because\s+/i, "")
    .replace(/^the\s+purpose\s+of\s+/i, "")
    .replace(/^for\s+to\s+/i, "to ")
    .replace(/^to\s+for\s+the\s+purpose\s+of\s+/i, "to ")
    .replace(/\bto\s*,?\s*for\s+the\s+purpose\s+of\b/gi, "to")
    .replace(/\bbecause\s+to\b/gi, "to")
    .replace(/\bbecause\s+for\s+the\s+purpose\s+of\b/gi, "to")
    .replace(/\byou\s+are\s+calling\s+to\b/gi, "")
    .replace(/\byou\s+are\s+calling\s+about\b/gi, "about")
    .replace(/\babout\s+the\s+customer\s+about\b/gi, "about")
    .replace(
      /\babout\s+customer\s+well-being\b/gi,
      "about your well-being as a customer",
    )
    .replace(/\bcustomer\s+well-being\b/gi, "your well-being as a customer")
    .replace(/\bthe\s+customer\b/gi, "you");

  value = collapseDuplicatePhrases(collapseDuplicateWords(value))
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/^[,.;:!?\s-]+/, "")
    .replace(/[.?!]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  // If an operator wrote a bare noun phrase, keep it as a topic, not a script.
  value = value.replace(/^about\s+about\s+/i, "about ").trim();

  if (value.length > maxChars) {
    value = value.slice(0, maxChars - 1).replace(/[\s,;:.-]+$/, "") + "...";
  }
  return value;
}

function addRecipientPossessiveWhenNatural(text) {
  const value = asString(text);
  if (
    /^(appointment|booking|consultation|enrollment|order|payment|account|subscription|webinar|call|session)\b/i.test(
      value,
    )
  ) {
    return `your ${value}`;
  }
  return value;
}

function interpretOutboundPurposeForSpeech(text) {
  const purpose = sanitizeOutboundPurposeText(text, 260);
  const lower = purpose.toLowerCase();
  if (!purpose) return "";

  const hasWellness = /well[- ]?being|wellness|health/.test(lower);
  const hasCustomer = /customer|client|recipient|patient|member/.test(lower);
  const hasFollowup =
    /follow ?up|check[- ]?in|check in|outreach|reach out/.test(lower);
  const hasMonthly = /monthly|month/.test(lower);
  const hasSeason = /season|greeting|greetings|holiday/.test(lower);

  if (hasMonthly && hasWellness) {
    return "a quick monthly wellness check-in to see how you're doing and make sure everything is going well";
  }
  if (hasWellness && hasCustomer && hasFollowup) {
    return "a quick wellness follow-up to see how you're doing and make sure everything is going well";
  }
  if (hasWellness && hasFollowup) {
    return "a quick check-in about your well-being and how things are going";
  }
  if (hasSeason && hasWellness) {
    return "a quick seasonal greeting and wellness check-in";
  }
  if (hasSeason) {
    return "a quick seasonal greeting from our team";
  }
  return purpose;
}

function outboundGreetingReasonClause(text) {
  const interpretedPurpose = interpretOutboundPurposeForSpeech(text);
  const purpose = sanitizeOutboundPurposeText(interpretedPurpose || text, 180);
  if (!purpose) return "I'm calling to follow up briefly";
  if (/^a quick monthly wellness check-in/i.test(purpose))
    return `I'm calling for ${purpose}`;
  if (/^a quick (?:wellness|seasonal|check-in)/i.test(purpose))
    return `I'm reaching out for ${purpose}`;
  if (/^to\s+/i.test(purpose)) return `I'm calling ${purpose}`;
  if (/^(about|regarding|concerning)\s+/i.test(purpose)) {
    return `I'm calling ${purpose.replace(/^regarding\s+/i, "about ").replace(/^concerning\s+/i, "about ")}`;
  }
  if (/^for\s+/i.test(purpose)) {
    return `I'm calling about ${purpose.replace(/^for\s+/i, "")}`;
  }
  if (/^reach\s+out\s+about\s+/i.test(purpose)) {
    return `I'm reaching out about ${purpose.replace(/^reach\s+out\s+about\s+/i, "")}`;
  }
  if (/^reach\s+out\s+to\s+/i.test(purpose)) {
    return `I'm reaching out to ${purpose.replace(/^reach\s+out\s+to\s+/i, "")}`;
  }
  if (
    /^follow\s+up\s+(?:with\s+you\s+)?(?:about|regarding|on)\s+/i.test(purpose)
  ) {
    return `I'm following up about ${purpose.replace(/^follow\s+up\s+(?:with\s+you\s+)?(?:about|regarding|on)\s+/i, "")}`;
  }
  if (/^inquire\s+about\s+/i.test(purpose)) {
    return `I'm calling to ask about ${purpose.replace(/^inquire\s+about\s+/i, "")}`;
  }
  if (/^confirming\b/i.test(purpose)) {
    return `I'm calling to confirm ${addRecipientPossessiveWhenNatural(purpose.replace(/^confirming\b\s*/i, ""))}`;
  }
  if (/^checking\b/i.test(purpose)) {
    return `I'm calling to check ${purpose.replace(/^checking\b\s*/i, "")}`;
  }
  if (/^following\s+up\b/i.test(purpose)) {
    return `I'm following up ${purpose.replace(/^following\s+up\b\s*/i, "")}`;
  }
  if (/^[a-z]+ing\b/i.test(purpose)) return `I'm reaching out about ${purpose}`;
  if (
    /^(check|confirm|schedule|reschedule|follow|ask|remind|notify|inform|discuss|update|invite|verify|collect|share|see|help|offer|introduce|review|explain|request|complete|book|arrange)\b/i.test(
      purpose,
    )
  ) {
    return `I'm calling to ${purpose}`;
  }
  return `I'm reaching out about ${purpose}`;
}

function sentenceCaseStart(text) {
  const value = asString(text);
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function cleanAgentNameForSpeech(name) {
  const value = normalizeSpaces(name);
  if (!value) return "";
  if (
    /^(assistant|agent|ai agent|voice agent|virtual assistant|unknown|n\/?a)$/i.test(
      value,
    )
  )
    return "";
  if (/^(outbound|inbound)\s+(lead|caller|recipient)$/i.test(value)) return "";
  return value
    .replace(/[^a-z0-9 .'_-]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanOrganizationNameForSpeech(name) {
  const value = normalizeSpaces(name);
  if (!value) return "";
  if (/^(unknown|n\/?a|the business|the team)$/i.test(value)) return "";
  return value
    .replace(/[^a-z0-9 .'&_-]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCallerIdentityPhrase({
  agentName = "",
  organizationName = "",
} = {}) {
  const cleanAgent = cleanAgentNameForSpeech(agentName);
  const cleanOrganization = cleanOrganizationNameForSpeech(organizationName);
  if (cleanAgent && cleanOrganization)
    return `this is ${cleanAgent} from ${cleanOrganization}`;
  if (cleanOrganization) return `this is ${cleanOrganization}`;
  if (cleanAgent) return `this is ${cleanAgent}`;
  return "this is the team calling";
}

function buildInboundGreeting({ agentName = "", organizationName = "" } = {}) {
  const identity = buildCallerIdentityPhrase({ agentName, organizationName });
  const cleanOrganization = cleanOrganizationNameForSpeech(organizationName);
  if (cleanOrganization && cleanAgentNameForSpeech(agentName)) {
    return `Thank you for calling ${cleanOrganization}. ${sentenceCaseStart(identity)}. How can I help you today?`;
  }
  if (cleanOrganization)
    return `Thank you for calling ${cleanOrganization}. How can I help you today?`;
  return `Hello. ${sentenceCaseStart(identity)}. How can I help you today?`;
}

function buildOutboundGreeting({
  recipientName = "",
  agentName = "",
  organizationName = "",
  callPurpose = "",
} = {}) {
  const cleanRecipient = cleanRecipientNameForSpeech(recipientName);
  const identity = buildCallerIdentityPhrase({ agentName, organizationName });
  const reason = sentenceCaseStart(outboundGreetingReasonClause(callPurpose));
  const hello = cleanRecipient ? `Hello ${cleanRecipient}` : "Hello";
  return `${hello}, ${identity}. ${reason}. Do you have a quick moment to talk?`;
}

function hasInboundHelpdeskPhrase(text) {
  return /\b(?:how|what)\s+(?:can|may)\s+i\s+help\s+you(?:\s+with)?\s*(?:today|right\s+now|this\s+(?:morning|afternoon|evening))?\??/i.test(
    asString(text),
  );
}

function safeCustomOutboundGreeting(text) {
  const value = normalizeSpaces(text);
  if (!value) return "";
  if (/\boutbound\s+lead\b/i.test(value)) return "";
  if (hasInboundHelpdeskPhrase(value)) return "";
  if (/\bwho\s+(?:is\s+this|am\s+i\s+speaking\s+with)\b/i.test(value))
    return "";
  return value;
}

function repairOutboundPurposePhrasing(text) {
  return normalizeSpaces(text)
    .replace(
      /\b(I\s*(?:am|'m)\s+)?calling\s+because\s+to\b/gi,
      "I'm calling to",
    )
    .replace(
      /\b(I\s*(?:am|'m)\s+)?calling\s+because\s+for\s+the\s+purpose\s+of\b/gi,
      "I'm calling to",
    )
    .replace(
      /\b(I\s*(?:am|'m)\s+)?calling\s+to\s+for\s+the\s+purpose\s+of\b/gi,
      "I'm calling to",
    )
    .replace(
      /\b(I\s*(?:am|'m)\s+)?calling\s+to\s+inquire\s+about\s+you\s+are\s+calling\s+to\b/gi,
      "I'm calling to",
    )
    .replace(/\bto\s+for\s+the\s+purpose\s+of\b/gi, "to")
    .replace(/\bbecause\s+to\b/gi, "to")
    .replace(/\breachout\b/gi, "reach out")
    .replace(/\babout\s+about\b/gi, "about")
    .replace(/\bto\s+to\b/gi, "to")
    .replace(/\bfor\s+for\b/gi, "for")
    .replace(/\bwellbeing\b/gi, "well-being")
    .replace(/\bcallre\b/gi, "care")
    .replace(/\s+/g, " ")
    .trim();
}

function removeInboundHelpdeskPhrasesForOutbound(text) {
  let output = asString(text);
  const helpPhrase =
    /\b(?:how|what)\s+(?:can|may)\s+i\s+help\s+you(?:\s+with)?\s*(?:today|right\s+now|this\s+(?:morning|afternoon|evening))?\??/gi;
  output = output.replace(helpPhrase, "");
  output = output.replace(
    /\b(?:thank\s+you\s+for\s+calling|thanks\s+for\s+calling|you(?:'ve| have)\s+reached)\b[^.!?]*[.!?]?/gi,
    "",
  );
  output = output.replace(/\bhello\s+outbound\s+lead[,.!?:;\s]*/gi, "Hello, ");
  output = output.replace(/\boutbound\s+lead\b/gi, "");
  output = output.replace(
    /\s+hello\s+this\s+is\s+[^.!?]{1,80}(?:[.!?]|\s*[-–—]\s*)?$/i,
    "",
  );
  output = output.replace(
    /(^|[.!?]\s+)hello\s+this\s+is\s+[^.!?]{1,80}(?:[.!?]|\s*[-–—]\s*)/gi,
    "$1",
  );
  return output
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function repairOutboundAssistantText(text, context = {}) {
  let output = repairOutboundPurposePhrasing(text);
  output = removeInboundHelpdeskPhrasesForOutbound(output);
  const recipient = cleanRecipientNameForSpeech(
    firstNonEmpty(context.recipientName, context.targetName),
  );
  if (recipient) {
    output = output.replace(/\bHello\s*,\s*/i, `Hello ${recipient}, `);
  }
  output = collapseDuplicatePhrases(collapseDuplicateWords(output))
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([.!?]){2,}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!output || output === "Hello,") {
    return "Do you have a quick moment to talk?";
  }
  return output;
}

function outboundBehaviorRules({ callPurpose = "", recipientName = "" } = {}) {
  const cleanPurpose = sanitizeOutboundPurposeText(callPurpose, 320);
  const cleanName = cleanRecipientNameForSpeech(recipientName);
  return [
    "OUTBOUND BEHAVIOR CONTRACT:",
    "- We called them. Do not behave like an inbound receptionist.",
    cleanName
      ? `- Known recipient: ${cleanName}. Use this name naturally; do not ask who they are unless they correct you.`
      : "- If no safe recipient name is available, greet with 'Hello' only. Never say placeholders like 'outbound lead', 'customer', or 'unknown recipient'.",
    "- Opening order: greet by safe name if available, introduce yourself and the business, state the recipient-facing reason, then ask if they have a quick moment.",
    "- Never open with 'How can I help you today?', 'Who is this?', or any inbound receptionist greeting.",
    "- Treat call purpose as internal notes. Understand it and convert it into natural customer-facing speech. Do not read malformed operator text verbatim.",
    cleanPurpose
      ? `- Recipient-facing call reason: ${cleanPurpose}`
      : "- If the purpose is missing, say you are calling to follow up briefly.",
    "- After the opening, stop and listen. One short question at a time.",
    "- If interrupted, stop speaking, listen fully, acknowledge the concern, then continue briefly only if appropriate.",
    "- If they ask why you called or say they did not request it, apologize for the interruption, explain the reason once, then offer callback, message-taking, opt-out, or ending the call.",
    "- Save only actual message/callback/opt-out details, not the whole transcript.",
  ].join("\n");
}

function inboundBehaviorRules() {
  return [
    "INBOUND BEHAVIOR CONTRACT:",
    "- They called the business. A receptionist-style greeting is appropriate.",
    "- Open warmly, then ask how you can help.",
    "- Listen first and answer the caller's question using business knowledge and FAQs.",
    "- Ask for name/contact details only when needed for follow-up, message-taking, appointment handling, or unresolved questions.",
    "- Do not use outbound language like 'I'm calling because...' or ask whether now is a good time.",
    "- If a human follow-up is needed, collect a concise message and callback details.",
  ].join("\n");
}

module.exports = {
  cleanRecipientNameForSpeech,
  sanitizeOutboundPurposeText,
  interpretOutboundPurposeForSpeech,
  outboundGreetingReasonClause,
  cleanAgentNameForSpeech,
  cleanOrganizationNameForSpeech,
  buildCallerIdentityPhrase,
  buildInboundGreeting,
  buildOutboundGreeting,
  hasInboundHelpdeskPhrase,
  safeCustomOutboundGreeting,
  repairOutboundPurposePhrasing,
  repairOutboundAssistantText,
  outboundBehaviorRules,
  inboundBehaviorRules,
};
