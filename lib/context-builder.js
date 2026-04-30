"use strict";

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function asString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch (_) {
      return [value];
    }
  }
  return [];
}

function truncate(text, max = 1400) {
  const value = asString(text);
  if (value.length <= max) return value;
  return value.slice(0, max - 3) + "...";
}

async function safeQuery(label, fn, fallback = []) {
  try {
    const result = await fn();
    if (result?.error) {
      console.warn(
        `[context-builder] ${label} query warning:`,
        result.error.message,
      );
      return fallback;
    }
    return result?.data ?? fallback;
  } catch (err) {
    console.warn(`[context-builder] ${label} query failed:`, err.message);
    return fallback;
  }
}

function normalizeFaqs(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      question: asString(row?.question),
      answer: asString(row?.answer),
      source: asString(row?.source),
    }))
    .filter((row) => row.question && row.answer);
}

function normalizeChunk(row) {
  return {
    id: row?.id || null,
    content: asString(row?.content),
    sourceUrl: asString(row?.source_url),
    sourceTitle: asString(row?.source_title || row?.source_url),
    chatbotId: row?.chatbot_id || null,
    voiceAgentId: row?.voice_agent_id || null,
    organizationId: row?.organization_id || null,
  };
}

function tokenize(text) {
  return uniq(
    asString(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s:/._-]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2)
      .slice(0, 24),
  );
}

function scoreText(text, keywords) {
  const haystack = asString(text).toLowerCase();
  if (!haystack) return 0;
  let score = 0;
  for (const keyword of keywords) {
    if (!keyword) continue;
    if (haystack.includes(keyword)) score += 2;
    const parts = keyword.split(/[-_/]/).filter(Boolean);
    if (parts.length > 1 && parts.some((part) => haystack.includes(part)))
      score += 1;
  }
  return score;
}

function chooseRelevantChunks(rows, query, max = 5) {
  const chunks = (rows || []).map(normalizeChunk).filter((row) => row.content);
  if (chunks.length === 0) return [];
  const keywords = tokenize(query);
  if (keywords.length === 0) return chunks.slice(0, max);

  const ranked = chunks
    .map((chunk) => ({
      chunk,
      score: scoreText(
        chunk.content + "\n" + chunk.sourceTitle + "\n" + chunk.sourceUrl,
        keywords,
      ),
    }))
    .sort(
      (a, b) =>
        b.score - a.score || a.chunk.content.length - b.chunk.content.length,
    );

  const filtered = ranked
    .filter((entry) => entry.score > 0)
    .slice(0, max)
    .map((entry) => entry.chunk);
  return filtered.length > 0 ? filtered : chunks.slice(0, max);
}

function chooseRelevantLinks(rows, query, max = 6) {
  const keywords = tokenize(query);
  const candidates = [];
  const seen = new Set();
  for (const row of rows || []) {
    const chunk = normalizeChunk(row);
    if (!chunk.sourceUrl) continue;
    if (seen.has(chunk.sourceUrl)) continue;
    seen.add(chunk.sourceUrl);
    const label = chunk.sourceTitle || chunk.sourceUrl;
    const score = scoreText(
      label + "\n" + chunk.content + "\n" + chunk.sourceUrl,
      keywords,
    );
    candidates.push({ label, url: chunk.sourceUrl, score });
  }
  const ranked = candidates.sort(
    (a, b) => b.score - a.score || a.label.length - b.label.length,
  );
  const chosen = ranked.filter((item) => item.score > 0).slice(0, max);
  return chosen.length > 0
    ? chosen
    : ranked.slice(0, Math.min(max, ranked.length));
}

function buildFormattingRules() {
  return [
    "FORMAT RULES:",
    "- Use clear, polished English with proper punctuation.",
    "- Use short paragraphs.",
    "- Use **bold headings** only when headings genuinely help.",
    "- Use bullet lists only for options or steps.",
    "- When sharing a URL, format it as a markdown link like [About page](https://example.com/about).",
  ].join("\n");
}

function buildChatPrompt({
  businessName,
  customPrompt,
  faqs,
  chunks,
  links,
  collectLeads,
}) {
  const parts = [];
  parts.push(
    `You are the website assistant for ${businessName || "this business"}.`,
  );
  parts.push(
    "Answer using only the information relevant to the user's request. Do not dump unrelated FAQs or unrelated website text.",
  );
  parts.push(
    "When the user is specific, give the exact answer or direct page link. When the user is broad or there are several plausible matches, present the best options and ask one short clarifying question so the user can choose.",
  );
  parts.push(
    "If the exact requested item or page is not available, say so plainly and then offer the closest valid alternatives.",
  );
  parts.push(
    "If useful links are available, include them directly. Prefer the most relevant links first.",
  );
  if (collectLeads) {
    parts.push(
      "If the user shows strong purchase, booking, pricing, or contact intent and the information is not fully resolved in chat, it is acceptable to ask for contact details so the team can follow up.",
    );
  }
  if (customPrompt) parts.push(`CUSTOM INSTRUCTIONS:\n${customPrompt}`);
  if ((faqs || []).length) {
    parts.push(
      "FAQS:\n" +
        faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n\n"),
    );
  }
  if ((chunks || []).length) {
    parts.push(
      "RELEVANT WEBSITE KNOWLEDGE:\n" +
        chunks
          .map((chunk, index) => `[Source ${index + 1}] ${chunk.content}`)
          .join("\n\n---\n\n"),
    );
  }
  if ((links || []).length) {
    parts.push(
      "RELEVANT PAGES:\n" +
        links.map((link) => `- ${link.label}: ${link.url}`).join("\n"),
    );
  }
  parts.push(buildFormattingRules());
  return parts.join("\n\n");
}

function languageRules(language) {
  const lang = asString(language, "English");
  if (/^en(glish)?$/i.test(lang) || /english/i.test(lang)) {
    return [
      "LANGUAGE CONTROL:",
      "- Speak English only.",
      "- Do not repeat answers in Arabic or any other language.",
      "- Do not translate unless the caller explicitly asks.",
      "- If the caller speaks another language, politely ask whether they want to continue in that language; do not auto-repeat every answer.",
    ].join("\n");
  }
  return [
    "LANGUAGE CONTROL:",
    `- The configured language is ${lang}.`,
    "- Use the configured language consistently.",
    "- Do not repeat every answer in another language unless the caller explicitly asks.",
  ].join("\n");
}

function summarizeBusiness(org = {}) {
  const fields = [];
  if (org.name) fields.push(`Business/organization name: ${org.name}`);
  if (org.industry) fields.push(`Industry: ${org.industry}`);
  if (org.website) fields.push(`Website: ${org.website}`);
  if (org.location) fields.push(`Location: ${org.location}`);
  if (org.phone_number) fields.push(`Business phone: ${org.phone_number}`);
  if (org.timezone) fields.push(`Timezone: ${org.timezone}`);
  return fields.join("\n");
}

function buildTwilioVoicePrompt({
  agentRow,
  organization,
  faqs,
  relevantChunks,
  linkedChatbots,
  direction = "inbound",
  assignmentContext = "",
}) {
  const agentName = asString(agentRow?.name, "the AI assistant");
  const businessName = asString(organization?.name, "this business");
  const language = asString(agentRow?.language, "English");
  const greeting = asString(
    agentRow?.greeting,
    "Hello, thank you for calling. How can I help you today?",
  );
  const voiceProfile = asString(agentRow?.voice, "");
  const tone = asString(agentRow?.tone, "Professional");
  const businessHours = asString(agentRow?.business_hours, "not provided");
  const callDirection = asString(direction || agentRow?.direction, "inbound");
  const captureFields = asArray(agentRow?.data_capture_fields).length
    ? asArray(agentRow.data_capture_fields)
        .map((item) => asString(item))
        .filter(Boolean)
        .join(", ")
    : "name, phone, email, reason";
  const callPurposes = asArray(agentRow?.call_purposes)
    .map((item) => asString(item))
    .filter(Boolean);
  const links = chooseRelevantLinks(
    relevantChunks || [],
    "business pages products services support",
    10,
  );
  const faqText = (faqs || [])
    .slice(0, 50)
    .map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`)
    .join("\n\n");
  const knowledgeText = (relevantChunks || [])
    .slice(0, 18)
    .map((chunk, index) => {
      const title =
        chunk.sourceTitle || chunk.sourceUrl || `Knowledge ${index + 1}`;
      const url = chunk.sourceUrl ? `\nURL: ${chunk.sourceUrl}` : "";
      return `[Knowledge ${index + 1}] ${title}${url}\n${truncate(chunk.content, 1300)}`;
    })
    .join("\n\n---\n\n");

  const parts = [
    `You are ${agentName}, the AI phone assistant for ${businessName}.`,
    `You must answer as ${businessName}'s business assistant, not as the software developer, platform owner, or website creator.`,
    `Call direction: ${callDirection}.`,
    `Configured language: ${language}.`,
    `Configured voice profile from dashboard: ${voiceProfile || "not provided"}.`,
    `Configured greeting: ${greeting}`,
    `Tone: ${tone}. Keep every reply natural, concise, and phone-friendly.`,
    `Business hours: ${businessHours}.`,
    `Capture caller details when appropriate: ${captureFields}.`,
    languageRules(language),
    "KNOWLEDGE AND SCOPE RULES:",
    "- Use only the tenant-specific business knowledge, FAQs, scraped website content, linked chatbot knowledge, organization details, and call purposes below.",
    "- Do not merge or infer information from any other tenant, website, or generic developer profile.",
    "- Do not invent products, prices, ingredients, services, policies, locations, discounts, URLs, or medical claims.",
    "- If the answer is not in the business knowledge, say you do not have that information in the business knowledge base and offer to take a message or ask the caller to clarify.",
    "- If the caller request covers multiple products, services, links, pages, or options, ask one short clarifying question and offer the known options.",
    "- Provide links/options only when they are present in the knowledge base or source URLs below.",
    "- If asked about the developer, platform, app creator, or implementation, do not pretend to be the developer. Redirect as the business assistant unless the business knowledge explicitly includes that information.",
    "- If the caller asks for a human, escalation, refund, medical/legal/financial advice, or anything sensitive, collect details and say the team can follow up unless a specific approved process is in the knowledge base.",
  ];

  const orgSummary = summarizeBusiness(organization || {});
  if (orgSummary) parts.push(`ORGANIZATION DETAILS:\n${orgSummary}`);
  if (callPurposes.length)
    parts.push(
      "CALL PURPOSES:\n" + callPurposes.map((item) => `- ${item}`).join("\n"),
    );
  if (assignmentContext)
    parts.push(`CALL/ASSIGNMENT CONTEXT:\n${assignmentContext}`);
  if ((linkedChatbots || []).length) {
    parts.push(
      "LINKED CHATBOT CONTEXT:\n" +
        linkedChatbots
          .map(
            (bot) =>
              `- ${bot.name || bot.header_title || bot.id}: ${bot.header_title || ""} ${bot.custom_prompt ? `\n  Custom prompt: ${truncate(bot.custom_prompt, 500)}` : ""}`,
          )
          .join("\n"),
    );
  }
  if (faqText) parts.push(`TENANT FAQS:\n${faqText}`);
  if (knowledgeText)
    parts.push(
      `TENANT KNOWLEDGE BASE / SCRAPED OR UPLOADED CONTENT:\n${knowledgeText}`,
    );
  if (links.length)
    parts.push(
      "KNOWN LINKS FROM KNOWLEDGE BASE:\n" +
        links.map((link) => `- ${link.label}: ${link.url}`).join("\n"),
    );
  if (!faqText && !knowledgeText) {
    parts.push(
      "NO SPECIFIC KNOWLEDGE LOADED:\nYou can identify yourself as the business assistant using the organization and agent details, but for specific product/service/policy questions say you do not have enough information in the business knowledge base yet and offer to take a message.",
    );
  }
  parts.push(
    'CALL ENDING DATA CAPTURE:\nWhen the conversation is clearly ending and you have captured details, output a final JSON line exactly like {"captured": {"name": "...", "phone": "...", "email": "...", "reason": "..."}}.',
  );
  return parts.join("\n\n");
}

async function loadChatbotContext(db, chatbotId, query) {
  const chatbot = await safeQuery(
    "chatbot",
    () =>
      db
        .from("chatbots")
        .select(
          "id, organization_id, voice_agent_id, header_title, custom_prompt, faqs, collect_leads",
        )
        .eq("id", chatbotId)
        .single(),
    null,
  );
  if (!chatbot) return null;

  const faqJson = normalizeFaqs(
    Array.isArray(chatbot.faqs) ? chatbot.faqs : [],
  );
  const rawChunks = await safeQuery(
    "chatbot knowledge chunks",
    async () => {
      const base = await db
        .from("knowledge_chunks")
        .select(
          "id, organization_id, content, source_url, source_title, chatbot_id, voice_agent_id",
        )
        .eq("chatbot_id", chatbot.id)
        .limit(120);
      let rows = base?.data || [];
      if (chatbot.voice_agent_id) {
        const linked = await db
          .from("knowledge_chunks")
          .select(
            "id, organization_id, content, source_url, source_title, chatbot_id, voice_agent_id",
          )
          .eq("voice_agent_id", chatbot.voice_agent_id)
          .limit(120);
        rows = rows.concat(linked?.data || []);
      }
      return { data: rows, error: base?.error };
    },
    [],
  );

  const relevantChunks = chooseRelevantChunks(rawChunks, query, 5);
  const links = chooseRelevantLinks(rawChunks, query, 6);

  return {
    chatbot,
    faqs: faqJson,
    chunks: relevantChunks,
    links,
    systemPrompt: buildChatPrompt({
      businessName: chatbot.header_title,
      customPrompt: chatbot.custom_prompt,
      faqs: faqJson,
      chunks: relevantChunks,
      links,
      collectLeads: chatbot.collect_leads,
    }),
  };
}

async function loadVoiceContext(db, orgId, agentRow, query, extra = {}) {
  if (!agentRow) return null;

  const organizationId = asString(orgId || agentRow.organization_id);
  const [organization, faqRows, linkedChatbots, directChunks] =
    await Promise.all([
      organizationId
        ? safeQuery(
            "organization",
            () =>
              db
                .from("organizations")
                .select(
                  "id, name, industry, website, location, timezone, phone_number",
                )
                .eq("id", organizationId)
                .maybeSingle(),
            null,
          )
        : Promise.resolve(null),
      safeQuery("voice faqs", () =>
        db
          .from("faqs")
          .select(
            "id, organization_id, voice_agent_id, question, answer, source",
          )
          .eq("organization_id", organizationId)
          .eq("voice_agent_id", agentRow.id)
          .limit(80),
      ),
      safeQuery("linked chatbots", () =>
        db
          .from("chatbots")
          .select(
            "id, organization_id, voice_agent_id, name, header_title, welcome_message, custom_prompt, faqs, collect_leads",
          )
          .eq("organization_id", organizationId)
          .eq("voice_agent_id", agentRow.id)
          .limit(10),
      ),
      safeQuery("direct voice knowledge chunks", () =>
        db
          .from("knowledge_chunks")
          .select(
            "id, organization_id, content, source_url, source_title, chatbot_id, voice_agent_id",
          )
          .eq("organization_id", organizationId)
          .eq("voice_agent_id", agentRow.id)
          .limit(180),
      ),
    ]);

  let linkedChunks = [];
  const linkedChatbotIds = (linkedChatbots || [])
    .map((row) => row.id)
    .filter(Boolean);
  if (linkedChatbotIds.length > 0) {
    linkedChunks = await safeQuery("linked chatbot knowledge chunks", () =>
      db
        .from("knowledge_chunks")
        .select(
          "id, organization_id, content, source_url, source_title, chatbot_id, voice_agent_id",
        )
        .eq("organization_id", organizationId)
        .in("chatbot_id", linkedChatbotIds)
        .limit(180),
    );
  }

  const chatbotFaqs = [];
  for (const bot of linkedChatbots || []) {
    chatbotFaqs.push(...normalizeFaqs(asArray(bot.faqs)));
  }

  const faqs = normalizeFaqs([...(faqRows || []), ...chatbotFaqs]);
  const allChunks = [...(directChunks || []), ...linkedChunks]
    .map(normalizeChunk)
    .filter(
      (chunk) => !organizationId || chunk.organizationId === organizationId,
    );
  const relevantChunks = chooseRelevantChunks(allChunks, query, 18);
  const relevantKnowledge = relevantChunks
    .map((chunk) => chunk.content)
    .join("\n\n---\n\n");
  const callPurposes = asArray(agentRow.call_purposes)
    .map((item) => asString(item))
    .filter(Boolean);
  const assignmentContext = asString(extra.assignmentContext);
  const direction = asString(extra.direction || agentRow.direction, "inbound");
  const systemPrompt = buildTwilioVoicePrompt({
    agentRow,
    organization,
    faqs,
    relevantChunks,
    linkedChatbots,
    direction,
    assignmentContext,
  });

  const stats = {
    faqs: faqs.length,
    knowledgeChunks: relevantChunks.length,
    scrapedPages: uniq(relevantChunks.map((chunk) => chunk.sourceUrl)).length,
    linkedChatbots: (linkedChatbots || []).length,
    finalPromptChars: systemPrompt.length,
  };

  console.log("[context-builder] loaded faqs count", stats.faqs);
  console.log(
    "[context-builder] loaded knowledge chunks count",
    stats.knowledgeChunks,
  );
  console.log(
    "[context-builder] loaded scraped pages count",
    stats.scrapedPages,
  );
  console.log("[context-builder] final prompt chars", stats.finalPromptChars);

  return {
    organization,
    faqs,
    relevantChunks,
    relevantKnowledge,
    callPurposes,
    linkedChatbots,
    systemPrompt,
    stats,
    debug: {
      agentName: agentRow.name || "",
      organizationName: organization?.name || "",
      language: agentRow.language || "",
      voiceProfile: agentRow.voice || "",
      greeting: agentRow.greeting || "",
      counts: stats,
      promptPreview: systemPrompt.slice(0, 500),
    },
  };
}

module.exports = {
  tokenize,
  chooseRelevantChunks,
  chooseRelevantLinks,
  loadChatbotContext,
  loadVoiceContext,
  buildChatPrompt,
  buildTwilioVoicePrompt,
};
