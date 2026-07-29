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
    .replace(/\bwelcom(e)?\b/gi, "welcome")
    .replace(/\bwelcomes\b/gi, "welcome")
    .replace(/\bonbo(?:a)?rd(?:ing)?\b/gi, "onboard")
    .replace(/\bcustm(?:er)?\b/gi, "customer")
    .replace(/\bcutomer(s)?\b/gi, "customer$1")
    .replace(/\bcustomerse\b/gi, "customers")
    .replace(/\bbusines\b/gi, "business")
    .replace(/\bservic(?:e)?s?\b/gi, (m) =>
      /s$/i.test(m) ? "services" : "service",
    )
    .replace(/\bthier\b/gi, "their")
    .replace(/\btel\b/gi, "tell")
    .replace(/\babt\b/gi, "about")
    .replace(/\bn\b/gi, "and")
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

function purposeExplicitlyMentionsProducts(text) {
  return /\b(product|products|service|services|supplement|supplements|buy|purchase|purchasing|order|shop|store|item|items|pricing|price|quote|package|packages)\b/i.test(
    asString(text),
  );
}

function purposeExplicitlyMentionsWebinar(text) {
  return /\b(webinar|seminar|training|event|session|class|workshop|masterclass)\b/i.test(
    asString(text),
  );
}

function interpretOutboundPurposeForSpeech(text) {
  const purpose = sanitizeOutboundPurposeText(text, 260);
  const lower = purpose.toLowerCase();
  if (!purpose) return "";

  const productIntent = purposeExplicitlyMentionsProducts(purpose);
  const webinarIntent = purposeExplicitlyMentionsWebinar(purpose);
  const hasWellness = /well[- ]?being|wellness|health|doing|feeling/.test(
    lower,
  );
  const hasCustomer =
    /customer|client|recipient|patient|member|lead|contact/.test(lower);
  const hasFollowup =
    /follow ?up|check[- ]?in|check in|check[- ]?on|checking on|outreach|reach out|ask how|how (?:he|she|they|you) (?:is|are)|doing today|make sure (?:they|he|she|you|the customer|the client)/.test(
      lower,
    );
  const isWellnessCheckIn =
    /check(?:ing)?[- ]?(?:in|on)\b|make sure (?:they|he|she|you|the customer|the client)(?:'re| are| is)?\s*(?:ok|okay|good|alright|all right|fine|well|doing)/.test(
      lower,
    );
  const hasMonthly = /monthly|month/.test(lower);
  const hasSeason = /season|greeting|greetings|holiday/.test(lower);

  if (webinarIntent) {
    return "the webinar or event mentioned for this outreach";
  }

  // "check on the customer / make sure they're good" is a wellness check-in.
  // Render it in second person so the agent says "you", never "the customer".
  if (isWellnessCheckIn && !productIntent) {
    return "a quick check-in to see how you're doing today";
  }

  if (productIntent && hasWellness) {
    return purpose;
  }

  if (productIntent) {
    return purpose;
  }

  // General SaaS default: checking on well-being must not become a sales pitch.
  if (
    /ask\s+(?:for|about)\s+(?:their|his|her|your)\s+well[- ]?being/i.test(lower)
  ) {
    return "a quick check-in to see how you're doing today";
  }

  if (
    /\bcall\s+\w+\s+to\s+ask\s+how\s+(?:he|she|they)\s+(?:is|are)\s+doing\s+today\b/i.test(
      lower,
    )
  ) {
    return "a quick check-in to see how you're doing today";
  }

  if (/\bask\s+how\s+(?:he|she|they|you)\s+(?:is|are)\s+doing\b/i.test(lower)) {
    return "a quick check-in to see how you're doing today";
  }

  if (hasMonthly && hasWellness) {
    return "a quick monthly check-in to see how you're doing today";
  }
  if (hasWellness && hasCustomer && hasFollowup) {
    return "a quick follow-up to see how you're doing today";
  }
  if (hasWellness && hasFollowup) {
    return "a quick check-in to see how you're doing today";
  }
  if (hasSeason && hasWellness) {
    return "a quick seasonal greeting and check-in";
  }
  if (hasSeason) {
    return "a quick seasonal greeting from our team";
  }
  return purpose;
}

function humanizeOutboundPurposeForSpeech(text, maxChars = 180) {
  return sanitizeOutboundPurposeText(
    interpretOutboundPurposeForSpeech(text) || text,
    maxChars,
  );
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
  const raw = normalizeSpaces(name)
    .replace(/[<>"{}[\]()]/g, "")
    .replace(/^\s*(?:agent|assistant|rep|representative|name)\s*[:=-]\s*/i, "")
    .trim();
  if (!raw) return "";
  if (
    /^(?:ai|bot|robot|assistant|virtual\s+assistant|test|unknown|none|null|n\/a|na)$/i.test(
      raw,
    )
  )
    return "";
  if (/^(?:\+?\d[\d\s().-]{5,}|[a-f0-9-]{16,})$/i.test(raw)) return "";
  return titleCaseName(raw).slice(0, 80);
}

function cleanOrganizationNameForSpeech(name) {
  const raw = normalizeSpaces(name)
    .replace(/[<>"{}[\]]/g, "")
    .replace(/^\s*(?:organization|company|business|tenant)\s*[:=-]\s*/i, "")
    .trim();
  if (!raw) return "";
  if (
    /^(?:business|company|organization|tenant|test|unknown|none|null|n\/a|na)$/i.test(
      raw,
    )
  )
    return "";
  if (/^[a-f0-9-]{16,}$/i.test(raw)) return "";
  return raw.slice(0, 120);
}

function sameSpokenName(left = "", right = "") {
  const normalize = (value) =>
    normalizeSpaces(value)
      .toLowerCase()
      .replace(/\b(?:assistant|agent|representative|rep|team)\b/g, "")
      .replace(/[^a-z0-9]+/g, "")
      .trim();
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && a === b);
}

function buildCallerIdentityPhrase({
  agentName = "",
  organizationName = "",
} = {}) {
  const agent = cleanAgentNameForSpeech(agentName);
  const org = cleanOrganizationNameForSpeech(organizationName);
  // Guard against bad upstream fallbacks such as "Bob from Bob".
  // If both fields collapse to the same spoken value, use the agent name only;
  // never invent a duplicate business identity.
  if (agent && org && sameSpokenName(agent, org)) return agent;
  if (agent && org) return `${agent} from ${org}`;
  if (agent) return agent;
  if (org) return `${org}`;
  return "the team";
}

function buildInboundGreeting({ agentName = "", organizationName = "" } = {}) {
  const agent = cleanAgentNameForSpeech(agentName);
  const org = cleanOrganizationNameForSpeech(organizationName);
  if (agent && org)
    return `Hello, thank you for calling ${org}. This is ${agent}. How can I help you today?`;
  if (org)
    return `Hello, thank you for calling ${org}. How can I help you today?`;
  if (agent) return `Hello, this is ${agent}. How can I help you today?`;
  return "Hello, thank you for calling. How can I help you today?";
}

/* ══════════════════════════════════════════════════════════════════════════
 * MANDATORY SELF-INTRODUCTION
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Rule: on EVERY call, inbound or outbound, the agent must introduce itself,
 * using the configured greeting whenever one is attached.
 *
 * Two failures produced the reported symptom of "it never introduces itself":
 *
 *   1. The configured greeting was never consulted for inbound calls.
 *      preparedOpeningGreetingForCall() called buildInboundGreeting(), which
 *      synthesises a line purely from names and ignores voice_agents.greeting.
 *      Whatever the tenant typed in the dashboard was discarded before the
 *      call even started.
 *
 *   2. When neither name resolved, the synthesised line collapsed to
 *      "Hello, thank you for calling. How can I help you today?" — no business,
 *      no agent, no introduction at all. This is the exact line customers were
 *      hearing.
 *
 * ensureAgentIntroduction() is the backstop. It takes whatever greeting was
 * chosen and guarantees an introduction survives, whether the greeting came
 * from the dashboard, from pre-call intelligence, or from a synthesiser.
 *
 * It is deliberately conservative: if the greeting already names the business
 * or the agent, it is returned untouched. Rewriting a tenant's own wording
 * would be worse than the bug.
 */
function textMentions(haystack, needle) {
  const value = String(needle || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!value || value.length < 2) return false;
  return String(haystack || "")
    .toLowerCase()
    .includes(value);
}

function ensureAgentIntroduction(
  greeting,
  { agentName = "", organizationName = "", direction = "inbound" } = {},
) {
  const agent = cleanAgentNameForSpeech(agentName);
  const org = cleanOrganizationNameForSpeech(organizationName);
  let text = String(greeting || "")
    .replace(/\s+/g, " ")
    .trim();

  // Nothing configured and nothing generated — build the strongest line the
  // available names allow rather than falling through to an anonymous one.
  if (!text) {
    return String(direction || "").toLowerCase() === "outbound"
      ? buildOutboundGreeting({ agentName: agent, organizationName: org })
      : buildInboundGreeting({ agentName: agent, organizationName: org });
  }

  const namesAgent = agent ? textMentions(text, agent) : false;
  const namesOrg = org ? textMentions(text, org) : false;

  // Already introduces itself in some form. Leave the tenant's wording alone.
  if (namesAgent || namesOrg) return text;

  // Nothing to introduce with. Better an un-named greeting than an invented
  // business name — never fabricate identity on a live call.
  if (!agent && !org) return text;

  let introduction = "";
  if (agent && org) introduction = `This is ${agent} from ${org}.`;
  else if (agent) introduction = `This is ${agent}.`;
  else introduction = `You've reached ${org}.`;

  /*
   * Splice the introduction in immediately after the opening salutation, so it
   * reads as speech rather than two sentences bolted together — and so the
   * caller learns who they are speaking to FIRST, which is the whole point.
   *
   * The salutation match is length-bounded on purpose. An unbounded
   * "[^.!?]*" swallows the entire first sentence, which pushes the
   * introduction to the very end of the greeting: "Hi there, quick call about
   * your order. This is Fin." — technically an introduction, but the listener
   * has already heard the pitch before finding out who is calling.
   */
  const salutation =
    /^((?:hello|hi|hey|good morning|good afternoon|good evening|welcome|greetings)[^,.!?]{0,24})[,.!]\s*/i;
  const match = text.match(salutation);
  if (match) {
    const head = match[1].replace(/[,\s]+$/, "").trim();
    let tail = text.slice(match[0].length).trim();
    // The tail was mid-sentence before the splice ("...order" from "Hi there,
    // quick call about your order"). It now starts a sentence, so it has to be
    // capitalised or the agent audibly reads a fragment.
    if (tail) tail = tail.charAt(0).toUpperCase() + tail.slice(1);
    return `${head}. ${introduction}${tail ? ` ${tail}` : ""}`
      .replace(/\s+/g, " ")
      .trim();
  }

  return `${introduction} ${text}`.replace(/\s+/g, " ").trim();
}

/**
 * The single entry point both servers use to decide what is actually spoken
 * first. Configured greeting wins; synthesis is the fallback; an introduction
 * is guaranteed either way.
 */
function resolveOpeningGreeting({
  agent = {},
  organization = null,
  direction = "inbound",
  recipientName = "",
  targetName = "",
  callPurpose = "",
  precomputed = "",
  agentName = "",
  organizationName = "",
} = {}) {
  const outbound = String(direction || "").toLowerCase() === "outbound";

  const resolvedAgentName = cleanAgentNameForSpeech(
    agentName || agent?.name || agent?.agent_name || "",
  );
  const resolvedOrgName = cleanOrganizationNameForSpeech(
    organizationName ||
      agent?.knowledge_base_business_name ||
      agent?.business_name ||
      agent?.knowledge_base_name ||
      organization?.business_name ||
      organization?.company_name ||
      organization?.name ||
      "",
  );

  // Priority order. The dashboard greeting outranks anything synthesised —
  // that is the whole point of the field existing.
  const configured = outbound
    ? firstNonEmptyValue(
        agent?.outbound_greeting,
        agent?.outbound_intro,
        agent?.greeting,
      )
    : firstNonEmptyValue(
        agent?.greeting,
        agent?.welcome_message,
        agent?.inbound_greeting,
      );

  let chosen = String(configured || "")
    .replace(/\s+/g, " ")
    .trim();

  // Pre-call intelligence only gets to speak when nothing is configured. It
  // previously overrode the tenant's own greeting on outbound calls.
  if (!chosen) {
    chosen = String(precomputed || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (!chosen) {
    chosen = outbound
      ? buildOutboundGreeting({
          recipientName: cleanRecipientNameForSpeech(
            recipientName || targetName || "",
          ),
          agentName: resolvedAgentName,
          organizationName: resolvedOrgName,
          callPurpose,
        })
      : buildInboundGreeting({
          agentName: resolvedAgentName,
          organizationName: resolvedOrgName,
        });
  }

  if (outbound) {
    chosen = repairOutboundAssistantText(chosen, {
      direction: "outbound",
      recipientName: cleanRecipientNameForSpeech(
        recipientName || targetName || "",
      ),
      targetName: cleanRecipientNameForSpeech(
        recipientName || targetName || "",
      ),
      agentName: resolvedAgentName,
      organizationName: resolvedOrgName,
      callPurpose,
    });
  }

  return ensureAgentIntroduction(chosen, {
    agentName: resolvedAgentName,
    organizationName: resolvedOrgName,
    direction,
  })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 480);
}

function firstNonEmptyValue(...values) {
  for (const value of values) {
    const clean = String(value == null ? "" : value).trim();
    if (clean) return clean;
  }
  return "";
}

function dynamicAgentIdentityLine({
  agentName = "",
  organizationName = "",
  direction = "",
} = {}) {
  const identity = buildCallerIdentityPhrase({ agentName, organizationName });
  const outbound = String(direction || "").toLowerCase() === "outbound";
  if (identity === "the team") {
    return outbound
      ? "You are the configured outbound phone agent for this tenant. Do not invent a personal name or business name if unavailable."
      : "You are the configured inbound receptionist for this tenant. Do not invent a personal name or business name if unavailable.";
  }
  return outbound
    ? `You are ${identity}, the configured outbound phone agent for this tenant.`
    : `You are ${identity}, the configured inbound receptionist for this tenant.`;
}

function buildOutboundGreeting({
  recipientName = "",
  agentName = "",
  organizationName = "",
  callPurpose = "",
} = {}) {
  const cleanName = cleanRecipientNameForSpeech(recipientName);
  const identity = buildCallerIdentityPhrase({ agentName, organizationName });
  const purpose = interpretOutboundPurposeForSpeech(callPurpose);
  const productIntent = purposeExplicitlyMentionsProducts(callPurpose);
  const webinarIntent = purposeExplicitlyMentionsWebinar(callPurpose);
  const prefix = cleanName ? `Hello ${cleanName},` : "Hello,";
  let reason = "I'm just calling to check in and see how you're doing today";
  if (webinarIntent) {
    reason = `I'm calling about ${purpose || "the webinar or event mentioned for this outreach"}`;
  } else if (purpose) {
    reason = outboundGreetingReasonClause(purpose);
  }
  if (identity === "the team") {
    return `${prefix} ${reason}. Do you have a quick moment to talk?`;
  }
  return `${prefix} this is ${identity}. ${reason}. Do you have a quick moment to talk?`;
}

function hasInboundHelpdeskPhrase(text) {
  const value = normalizeSpaces(text);
  if (!value) return false;
  return (
    /\b(?:how|what)\s+(?:can|may)\s+i\s+help\s+you(?:\s+with)?\s*(?:today|right\s+now|this\s+(?:morning|afternoon|evening))?\??/i.test(
      value,
    ) ||
    /\b(?:thank\s+you\s+for\s+calling|thanks\s+for\s+calling|you(?:'ve| have)\s+reached)\b/i.test(
      value,
    ) ||
    /\b(?:how\s+can\s+i\s+assist\s+you|how\s+may\s+i\s+assist\s+you)\b/i.test(
      value,
    )
  );
}

function callerNameRules({ recipientName = "", direction = "" } = {}) {
  const cleanName = cleanRecipientNameForSpeech(recipientName);
  const outbound = String(direction || "").toLowerCase() === "outbound";
  return [
    "CALLER NAME RULE:",
    cleanName
      ? `- Known ${outbound ? "recipient" : "caller"} name: ${cleanName}. Use this name naturally in the greeting, occasionally during the call, and in the closing line. Do not overuse it. Do not ask for their name unless they correct it.`
      : `- No safe ${outbound ? "recipient" : "caller"} name is available. Do not invent a name. Use a polite neutral greeting, and only ask for a name if it is needed for follow-up or message capture.`,
    "- If asked whether you know their name, answer based only on the provided call context. Never invent a name.",
  ].join("\n");
}

function callEndingRules({ recipientName = "" } = {}) {
  const cleanName = cleanRecipientNameForSpeech(recipientName);
  return [
    "CALL ENDING RULE:",
    "- Do not end the call just because the caller says a soft acknowledgement such as okay, sure, alright, yeah, fine, or hmm during active conversation. Treat those as normal acknowledgements unless the call is already closing.",
    "- If the caller clearly says they are done, not interested, goodbye, that is all, nothing else, or asks to end/hang up, give one short closing notice and stop speaking. The system will handle the final hangup grace window.",
    "- After you have said a final goodbye, do not ask another question. Do not ask whether they want to leave a message. Do not ask 'are you still there?' Do not ask 'is there anything else?' Do not restate the call purpose.",
    cleanName
      ? `- Use the name in the final closing naturally, for example: 'Thank you, ${cleanName}. Goodbye.'`
      : "- Final closing should be short and warm: 'Thank you. Goodbye.'",
    "- If the caller says 'actually', 'wait', 'one more thing', or asks a real new question before hangup, continue helping instead of ending.",
  ].join("\n");
}

function isClosingConfirmation(text) {
  const t = normalizeSpaces(text)
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!t) return false;
  return [
    /^(yes|yeah|yep|sure|ok|okay|alright|all right|fine|correct|please do|go ahead)$/,
    /^(that'?s all|that is all|nothing else|no more questions|no,? that'?s all|no,? nothing else)$/,
    /^(thanks|thank you|thank you very much|appreciate it)$/,
    /^(bye|goodbye|good bye|bye bye|take care)$/,
    /\b(that'?s all|that is all|nothing else|no more questions)\b/,
    /\b(yes|yeah|yep|sure|ok|okay|alright|all right).{0,30}\b(end|finish|close|hang\s*up|disconnect)\b/,
  ].some((pattern) => pattern.test(t));
}

function isFinalAckAfterGoodbye(text) {
  const t = normalizeSpaces(text)
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!t) return false;
  return [
    /^(ok|okay|alright|all right|sure|fine|yes|yeah|yep)$/,
    /^(thanks|thank you|thank you very much|appreciate it|no problem)$/,
    /^(bye|goodbye|good bye|bye bye|take care)$/,
    /^(no|nope|nothing|nothing else|that'?s all|that is all)$/,
    /^hello$/,
  ].some((pattern) => pattern.test(t));
}

function isNewRequestAfterClosing(text) {
  const t = normalizeSpaces(text).toLowerCase();
  if (!t) return false;
  if (isClosingConfirmation(t) || isFinalAckAfterGoodbye(t)) return false;
  return [
    /\b(actually|wait|hold on|one more thing|before you go|don'?t hang up|do not hang up)\b/,
    /\b(i have|i still have|can you|could you|would you|please help|help me|tell me|explain|what about|how about)\b/,
    /\b(question|another question|need to ask|want to ask|also)\b/,
    /\?\s*$/,
  ].some((pattern) => pattern.test(t));
}

function buildFinalClosingMessage({ recipientName = "" } = {}) {
  const cleanName = cleanRecipientNameForSpeech(recipientName);
  return cleanName
    ? `Thank you, ${cleanName}. I'll be ending the call now. Goodbye.`
    : "Thank you. I'll be ending the call now. Goodbye.";
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

function removeUnrequestedSalesLanguage(text, context = {}) {
  let output = asString(text);
  const source = [
    context.callPurpose,
    context.normalizedPurpose,
    context.customInstructions,
    context.operatorInstructions,
  ]
    .filter(Boolean)
    .join(" ");
  const productIntent = purposeExplicitlyMentionsProducts(source);
  const webinarIntent = purposeExplicitlyMentionsWebinar(source);
  if (!productIntent) {
    output = output
      .replace(
        /\b(?:and\s+)?whether any of our products might be useful for you\b/gi,
        "",
      )
      .replace(
        /\b(?:and\s+)?see if any of our products might be helpful for you\b/gi,
        "",
      )
      .replace(
        /\b(?:your\s+)?interest in (?:our )?(?:products|purchasing|buying|ordering)[^.!?]*[.!?]?/gi,
        "",
      )
      .replace(
        /\binterested in (?:purchasing|buying|ordering|our products)[^.!?]*[.!?]?/gi,
        "",
      )
      .replace(
        /\bwe have a variety of (?:products|supplements)[^.!?]*[.!?]?/gi,
        "",
      )
      .replace(
        /\bwould you like to hear about (?:our )?(?:products|supplements)[^.!?]*[.!?]?/gi,
        "",
      );
  }
  if (!webinarIntent) {
    output = output.replace(
      /\b(?:webinar|seminar|training|workshop|book a slot|book your slot)[^.!?]*[.!?]?/gi,
      "",
    );
  }
  return output
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
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
  output = removeUnrequestedSalesLanguage(output, context);
  const recipient = cleanRecipientNameForSpeech(
    firstNonEmpty(context.recipientName, context.targetName),
  );
  if (recipient) {
    output = output.replace(/\bHello\s*,\s*/i, `Hello ${recipient}, `);
  }
  output = collapseDuplicatePhrases(collapseDuplicateWords(output));
  output = output.replace(
    /\bthis\s+is\s+([A-Za-z][A-Za-z .'-]{1,60})\s+from\s+\1\b/gi,
    "this is $1",
  );
  output = output
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
    cleanName
      ? "- Use the recipient name naturally in the closing line and when confirming important details; do not overuse it."
      : "- Since no safe recipient name is available, do not invent one and do not pretend to know it.",
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
  ensureAgentIntroduction,
  resolveOpeningGreeting,
  dynamicAgentIdentityLine,
  buildInboundGreeting,
  buildCallerIdentityPhrase,
  cleanOrganizationNameForSpeech,
  cleanAgentNameForSpeech,
  cleanRecipientNameForSpeech,
  sanitizeOutboundPurposeText,
  humanizeOutboundPurposeForSpeech,
  interpretOutboundPurposeForSpeech,
  purposeExplicitlyMentionsProducts,
  purposeExplicitlyMentionsWebinar,
  outboundGreetingReasonClause,
  buildOutboundGreeting,
  callerNameRules,
  callEndingRules,
  isClosingConfirmation,
  isFinalAckAfterGoodbye,
  isNewRequestAfterClosing,
  buildFinalClosingMessage,
  hasInboundHelpdeskPhrase,
  safeCustomOutboundGreeting,
  repairOutboundPurposePhrasing,
  repairOutboundAssistantText,
  outboundBehaviorRules,
  inboundBehaviorRules,
};
