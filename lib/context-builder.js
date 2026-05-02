"use strict";

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function uniqueBy(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of arr || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
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

function sameId(a, b) {
  return asString(a) !== "" && asString(a) === asString(b);
}

function truncate(text, max = 1400) {
  const value = asString(text);
  if (value.length <= max) return value;
  return value.slice(0, max - 3) + "...";
}

async function safeQuery(label, fn, fallback = [], diagnostics = null) {
  try {
    const result = await fn();
    if (result?.error) {
      const message = result.error.message || String(result.error);
      console.warn(`[context-builder] ${label} query warning:`, message);
      if (diagnostics) diagnostics[label] = `query error: ${message}`;
      return fallback;
    }
    const data = result?.data ?? fallback;
    if (diagnostics && Array.isArray(data) && data.length === 0) {
      diagnostics[label] = "no rows returned";
    }
    if (diagnostics && (data === null || data === undefined)) {
      diagnostics[label] = "no row returned";
    }
    return data;
  } catch (err) {
    const message = err?.message || String(err);
    console.warn(`[context-builder] ${label} query failed:`, message);
    if (diagnostics) diagnostics[label] = `query failed: ${message}`;
    return fallback;
  }
}

function normalizeFaq(row) {
  const question = asString(row?.question);
  const answer = asString(row?.answer);
  if (!question || !answer) return null;
  return {
    question,
    answer,
    source: asString(row?.source),
    voiceAgentId: row?.voice_agent_id || null,
    organizationId: row?.organization_id || null,
  };
}

function normalizeFaqs(rows) {
  return (rows || []).map(normalizeFaq).filter(Boolean);
}

function normalizeChunk(row) {
  return {
    id: row?.id || null,
    content: asString(row?.content),
    sourceUrl: asString(row?.source_url),
    sourceTitle: asString(row?.source_title || row?.source_url),
    chunkIndex: Number.isFinite(Number(row?.chunk_index))
      ? Number(row.chunk_index)
      : 0,
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

function chooseRelevantChunks(rows, query, max = 18) {
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
      (a, b) => b.score - a.score || a.chunk.chunkIndex - b.chunk.chunkIndex,
    );

  const filtered = ranked
    .filter((entry) => entry.score > 0)
    .slice(0, max)
    .map((entry) => entry.chunk);
  return filtered.length > 0 ? filtered : chunks.slice(0, max);
}

function chooseRelevantLinks(rows, query, max = 8) {
  const keywords = tokenize(query);
  const candidates = [];
  const seen = new Set();
  for (const row of rows || []) {
    const chunk = normalizeChunk(row);
    if (!chunk.sourceUrl || seen.has(chunk.sourceUrl)) continue;
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

function sourceLooksUploaded(chunk) {
  const src =
    `${chunk.sourceUrl || ""} ${chunk.sourceTitle || ""}`.toLowerCase();
  if (!chunk.sourceUrl) return true;
  return (
    /upload|uploaded|document|file|pdf|docx|storage|supabase|bucket/.test(
      src,
    ) && !/^https?:\/\//i.test(chunk.sourceUrl)
  );
}

function sourceLooksScraped(chunk) {
  return /^https?:\/\//i.test(chunk.sourceUrl || "");
}

function looksProductService(text) {
  return /product|service|sell|buy|price|pricing|package|plan|order|shop|store|supplement|gumm|wellness|delivery|shipping|booking/i.test(
    asString(text),
  );
}

function buildFormattingRules() {
  return [
    "PHONE STYLE RULES:",
    "- Speak naturally in short sentences.",
    "- Do not read long URLs aloud unless the caller asks for a link.",
    "- Ask one question at a time.",
    "- Keep answers concise unless the caller asks for detail.",
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
  if (collectLeads)
    parts.push(
      "If the request cannot be fully resolved, ask for contact details so the team can follow up.",
    );
  if (customPrompt) parts.push(`CUSTOM INSTRUCTIONS:\n${customPrompt}`);
  if ((faqs || []).length)
    parts.push(
      "FAQS:\n" +
        faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n\n"),
    );
  if ((chunks || []).length)
    parts.push(
      "RELEVANT WEBSITE KNOWLEDGE:\n" +
        chunks
          .map((chunk, index) => `[Source ${index + 1}] ${chunk.content}`)
          .join("\n\n---\n\n"),
    );
  if ((links || []).length)
    parts.push(
      "RELEVANT PAGES:\n" +
        links.map((link) => `- ${link.label}: ${link.url}`).join("\n"),
    );
  parts.push(buildFormattingRules());
  return parts.join("\n\n");
}

function languageRules(language) {
  const lang = asString(language, "English");
  if (/^en(glish)?$/i.test(lang) || /english/i.test(lang)) {
    return [
      "LANGUAGE CONTROL:",
      "- The configured language is English.",
      "- Speak English only from the first word of the call.",
      "- Do not speak Arabic.",
      "- Do not repeat answers in Arabic or any other language.",
      "- Do not translate unless the caller explicitly asks.",
      "- If the caller speaks another language, ask once in English whether they want to continue in that language. Do not automatically repeat every answer in that language.",
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
  callPurpose = "",
  customInstructions = "",
  lead = null,
  recipientPhone = "",
  callerPhone = "",
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
  const isOutbound = callDirection.toLowerCase() === "outbound";
  const purposeText = asString(callPurpose);
  const customInstructionText = asString(customInstructions);
  const leadText = lead
    ? [
        lead.name ? `Lead name: ${lead.name}` : "",
        lead.phone ? `Lead phone: ${lead.phone}` : "",
        lead.email ? `Lead email: ${lead.email}` : "",
        lead.reason ? `Lead reason: ${lead.reason}` : "",
        lead.status ? `Lead status: ${lead.status}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  const captureFields = asArray(agentRow?.data_capture_fields).length
    ? asArray(agentRow.data_capture_fields)
        .map((item) => asString(item))
        .filter(Boolean)
        .join(", ")
    : "name, phone, email, reason";
  const callPurposes = asArray(agentRow?.call_purposes)
    .map((item) => asString(item))
    .filter(Boolean);
  const rules =
    agentRow?.rules && typeof agentRow.rules === "object"
      ? JSON.stringify(agentRow.rules)
      : asString(agentRow?.rules);
  const links = chooseRelevantLinks(
    relevantChunks || [],
    "business pages products services support contact shop",
    10,
  );
  const faqText = (faqs || [])
    .slice(0, 60)
    .map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`)
    .join("\n\n");
  const knowledgeText = (relevantChunks || [])
    .slice(0, 24)
    .map((chunk, index) => {
      const title =
        chunk.sourceTitle || chunk.sourceUrl || `Knowledge ${index + 1}`;
      const url = chunk.sourceUrl ? `\nURL: ${chunk.sourceUrl}` : "";
      return `[Knowledge ${index + 1}] ${title}${url}\n${truncate(chunk.content, 1500)}`;
    })
    .join("\n\n---\n\n");

  const parts = [
    "IDENTITY:",
    `- You are ${agentName}, the phone assistant for ${businessName}.`,
    "- You are not the developer.",
    "- You are not a generic AI assistant.",
    `- You answer as ${businessName}'s business receptionist/assistant.`,
    `- Call direction: ${callDirection}.`,
    `- Configured voice profile from dashboard: ${voiceProfile || "not provided"}.`,
    `- Configured greeting to use on call start: ${greeting}`,
    `- Tone: ${tone}.`,
    `- Business hours: ${businessHours}.`,
    rules ? `- Agent behavior rules: ${rules}` : "",
    languageRules(language),
    isOutbound ? "OUTBOUND CALL RULES:" : "GREETING RULES:",
    isOutbound
      ? "- This is an outbound call. Do not use the inbound greeting. Start by briefly introducing yourself, the business, and the reason for the call, then ask if now is a good time."
      : `- Use this configured greeting exactly or near-exactly at call start: ${greeting}`,
    isOutbound && purposeText
      ? `- Primary outbound call purpose: ${purposeText}`
      : "",
    isOutbound && customInstructionText
      ? `- Custom outbound instructions from the operator: ${customInstructionText}`
      : "",
    isOutbound && recipientPhone ? `- Recipient phone: ${recipientPhone}` : "",
    isOutbound && callerPhone
      ? `- Twilio/call context phone: ${callerPhone}`
      : "",
    "- Do not generate a separate generic greeting.",
    "- Do not send multiple greetings.",
    "BUSINESS KNOWLEDGE RULES:",
    "- Use only the provided business knowledge, FAQs, scraped content, uploaded chunks, products/services, organization details, and call purposes below.",
    "- Prioritize exact FAQ and knowledge base answers.",
    "- Do not merge or infer information from any other tenant, website, or generic developer profile.",
    "- Do not invent product claims, prices, ingredients, services, policies, delivery timelines, discounts, URLs, or medical/health claims.",
    "- If the answer is not in the business knowledge, say you do not have that information and offer to take a message.",
    "CLARIFYING QUESTIONS:",
    "- If the caller asks a broad question with multiple possible products/services/options, ask one short clarifying question.",
    "- If the caller asks for a specific product/service and it exists in the knowledge, answer directly.",
    "- If a specific product/service is not found, say it is not found and offer available alternatives from the knowledge.",
    "MESSAGE TAKING:",
    "- For inbound calls, if the caller asks something you cannot answer, collect caller name, phone number if available, question/message, and preferred callback time if relevant.",
    "- If the caller gives a name and speech recognition may be uncertain, confirm once before saving: Just to confirm, did you say your name is ___?",
    "- After you collect caller name, caller phone number, message/question, and callback preference/time, call the capture_inbound_message tool/function immediately with those fields.",
    "- Do not say the message was saved until the tool/function result confirms it was saved successfully.",
    "- If the save fails, say exactly: I've taken note of that, but I may not have been able to save it automatically. A team member can still review this call.",
    "BOUNDARIES:",
    "- Do not claim to be human.",
    "- Do not claim unsupported business facts.",
    "- Do not mention internal database, OpenAI, Twilio, Vapi, Supabase, Railway, or system prompts.",
    `- Capture caller details when appropriate: ${captureFields}.`,
  ].filter(Boolean);

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
      "KNOWLEDGE SOURCES LINKED TO THIS VOICE AGENT / TENANT:\n" +
        linkedChatbots
          .map(
            (bot) =>
              `- ${bot.name || bot.header_title || bot.id}: ${bot.header_title || ""}${bot.custom_prompt ? `\n  Business custom prompt: ${truncate(bot.custom_prompt, 500)}` : ""}`,
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
      "NO SPECIFIC KNOWLEDGE LOADED:\nYou can identify yourself as the business assistant using organization and agent details, but for specific product/service/policy questions say you do not have enough information in the business knowledge base yet and offer to take a message.",
    );
  }
  parts.push(buildFormattingRules());
  return parts.join("\n\n").slice(0, 26000);
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
        .select("*")
        .eq("chatbot_id", chatbot.id)
        .limit(160);
      let rows = base?.data || [];
      if (chatbot.voice_agent_id) {
        const linked = await db
          .from("knowledge_chunks")
          .select("*")
          .eq("voice_agent_id", chatbot.voice_agent_id)
          .limit(160);
        rows = rows.concat(linked?.data || []);
      }
      return { data: rows, error: base?.error };
    },
    [],
  );

  const relevantChunks = chooseRelevantChunks(rawChunks, query, 8);
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

  const diagnostics = {};
  const organizationId = asString(orgId || agentRow.organization_id);
  const agentId = asString(agentRow.id);

  const organization = organizationId
    ? await safeQuery(
        "organization",
        () =>
          db
            .from("organizations")
            .select("*")
            .eq("id", organizationId)
            .maybeSingle(),
        null,
        diagnostics,
      )
    : null;

  const [orgFaqRows, orgChatbots, orgChunkRows] = await Promise.all([
    safeQuery(
      "faqs by organization_id",
      () =>
        db
          .from("faqs")
          .select("*")
          .eq("organization_id", organizationId)
          .limit(160),
      [],
      diagnostics,
    ),
    safeQuery(
      "chatbots by organization_id",
      () =>
        db
          .from("chatbots")
          .select("*")
          .eq("organization_id", organizationId)
          .limit(50),
      [],
      diagnostics,
    ),
    safeQuery(
      "knowledge_chunks by organization_id",
      () =>
        db
          .from("knowledge_chunks")
          .select("*")
          .eq("organization_id", organizationId)
          .limit(400),
      [],
      diagnostics,
    ),
  ]);

  const linkedChatbots = (orgChatbots || []).filter(
    (bot) =>
      sameId(bot.voice_agent_id, agentId) ||
      sameId(bot.id, organization?.active_chatbot_id) ||
      bot.is_active === true,
  );
  if (linkedChatbots.length === 0) {
    diagnostics["linked chatbots selected"] = (orgChatbots || []).length
      ? "no rows matched voice_agent_id, active_chatbot_id, or is_active=true"
      : "no chatbot rows for organization_id";
  }
  const linkedChatbotIds = new Set(
    linkedChatbots.map((bot) => asString(bot.id)).filter(Boolean),
  );

  let lead = null;
  const leadId = asString(extra.leadId);
  if (leadId) {
    lead = await safeQuery(
      "lead by id",
      () =>
        db
          .from("leads")
          .select("*")
          .eq("id", leadId)
          .eq("organization_id", organizationId)
          .maybeSingle(),
      null,
      diagnostics,
    );
  }

  const agentFaqs = normalizeFaqs(
    (orgFaqRows || []).filter(
      (row) => !row.voice_agent_id || sameId(row.voice_agent_id, agentId),
    ),
  );
  const chatbotFaqs = [];
  for (const bot of linkedChatbots)
    chatbotFaqs.push(...normalizeFaqs(asArray(bot.faqs)));
  const faqs = uniqueBy(
    [...agentFaqs, ...chatbotFaqs],
    (f) => `${f.question}|${f.answer}`,
  ).slice(0, 80);
  if (faqs.length === 0) {
    diagnostics.faqs = (orgFaqRows || []).length
      ? "FAQ rows exist for organization_id, but none matched voice_agent_id/null and linked chatbot faqs were empty"
      : diagnostics["faqs by organization_id"] || "no rows for organization_id";
  }

  const normalizedOrgChunks = (orgChunkRows || [])
    .map(normalizeChunk)
    .filter(
      (chunk) => chunk.content && sameId(chunk.organizationId, organizationId),
    );
  const exactAgentChunks = normalizedOrgChunks.filter((chunk) =>
    sameId(chunk.voiceAgentId, agentId),
  );
  const chatbotChunks = normalizedOrgChunks.filter((chunk) =>
    linkedChatbotIds.has(asString(chunk.chatbotId)),
  );
  const orgFallbackChunks = normalizedOrgChunks.filter(
    (chunk) => !chunk.voiceAgentId && !chunk.chatbotId,
  );
  let selectedChunks = uniqueBy(
    [...exactAgentChunks, ...chatbotChunks, ...orgFallbackChunks],
    (chunk) => `${chunk.sourceUrl}|${chunk.content.slice(0, 180)}`,
  );

  if (selectedChunks.length === 0 && normalizedOrgChunks.length > 0) {
    selectedChunks = uniqueBy(
      normalizedOrgChunks,
      (chunk) => `${chunk.sourceUrl}|${chunk.content.slice(0, 180)}`,
    );
    diagnostics["knowledge selection"] =
      "no exact voice_agent_id/linked chatbot/null chunks; used all organization_id chunks as tenant-safe fallback";
  } else if (selectedChunks.length === 0) {
    diagnostics["knowledge selection"] =
      diagnostics["knowledge_chunks by organization_id"] ||
      "no rows for organization_id";
  }

  const relevantChunks = chooseRelevantChunks(selectedChunks, query, 24);
  const relevantKnowledge = relevantChunks
    .map((chunk) => chunk.content)
    .join("\n\n---\n\n");
  const callPurposes = asArray(agentRow.call_purposes)
    .map((item) => asString(item))
    .filter(Boolean);
  const assignmentContext = asString(extra.assignmentContext);
  const direction = asString(extra.direction || agentRow.direction, "inbound");
  const callPurpose = asString(extra.callPurpose);
  const customInstructions = asString(extra.customInstructions);
  const recipientPhone = asString(extra.recipientPhone);
  const callerPhone = asString(extra.callerPhone);
  const systemPrompt = buildTwilioVoicePrompt({
    agentRow,
    organization,
    faqs,
    relevantChunks,
    linkedChatbots,
    direction,
    assignmentContext,
    callPurpose,
    customInstructions,
    lead,
    recipientPhone,
    callerPhone,
  });

  const uploadedDocumentChunks =
    relevantChunks.filter(sourceLooksUploaded).length;
  const scrapedContent = relevantChunks.filter(sourceLooksScraped).length;
  const productsServices = relevantChunks.filter((chunk) =>
    looksProductService(`${chunk.sourceTitle}\n${chunk.content}`),
  ).length;
  const stats = {
    faqs: faqs.length,
    knowledgeChunks: relevantChunks.length,
    uploadedDocumentChunks,
    scrapedContent,
    productsServices,
    callPurposes: callPurposes.length,
    linkedChatbots: linkedChatbots.length,
    finalPromptChars: systemPrompt.length,
  };

  if (stats.knowledgeChunks === 0)
    diagnostics.knowledgeChunks =
      diagnostics["knowledge selection"] || "no tenant knowledge rows loaded";
  if (stats.uploadedDocumentChunks === 0)
    diagnostics.uploadedDocumentChunks = stats.knowledgeChunks
      ? "loaded chunks did not look like uploaded document chunks"
      : diagnostics.knowledgeChunks;
  if (stats.scrapedContent === 0)
    diagnostics.scrapedContent = stats.knowledgeChunks
      ? "loaded chunks did not have http/https source_url"
      : diagnostics.knowledgeChunks;
  if (stats.productsServices === 0)
    diagnostics.productsServices = stats.knowledgeChunks
      ? "no loaded chunk matched product/service keywords"
      : diagnostics.knowledgeChunks;
  if (stats.callPurposes === 0)
    diagnostics.callPurposes = "voice_agents.call_purposes is empty";

  console.log(
    "[context-builder] loaded faqs count",
    stats.faqs,
    stats.faqs === 0 ? diagnostics.faqs : "",
  );
  console.log(
    "[context-builder] loaded knowledge chunks count",
    stats.knowledgeChunks,
    stats.knowledgeChunks === 0 ? diagnostics.knowledgeChunks : "",
  );
  console.log(
    "[context-builder] loaded scraped pages count",
    stats.scrapedContent,
    stats.scrapedContent === 0 ? diagnostics.scrapedContent : "",
  );
  console.log(
    "[context-builder] loaded uploaded chunks count",
    stats.uploadedDocumentChunks,
    stats.uploadedDocumentChunks === 0
      ? diagnostics.uploadedDocumentChunks
      : "",
  );
  console.log(
    "[context-builder] loaded products/services count",
    stats.productsServices,
    stats.productsServices === 0 ? diagnostics.productsServices : "",
  );
  console.log("[context-builder] final prompt chars", stats.finalPromptChars);

  const firstFaq = faqs[0]
    ? `Q: ${faqs[0].question}\nA: ${faqs[0].answer}`
    : "";
  const firstKnowledgeChunk = relevantChunks[0]
    ? truncate(relevantChunks[0].content, 500)
    : "";
  const firstProductServiceChunk = relevantChunks.find((chunk) =>
    looksProductService(`${chunk.sourceTitle}\n${chunk.content}`),
  );

  return {
    organization,
    faqs,
    relevantChunks,
    relevantKnowledge,
    callPurposes,
    linkedChatbots,
    systemPrompt,
    stats,
    diagnostics,
    samples: {
      firstFaq,
      firstKnowledgeChunk,
      firstProductService: firstProductServiceChunk
        ? truncate(firstProductServiceChunk.content, 500)
        : "",
    },
    debug: {
      agent: {
        id: agentRow.id || "",
        name: agentRow.name || "",
        language: agentRow.language || "",
        voiceProfile: agentRow.voice || "",
        greeting: agentRow.greeting || "",
        direction: agentRow.direction || "",
      },
      organization: {
        id: organization?.id || organizationId || "",
        name: organization?.name || "",
      },
      currentCall: {
        direction,
        callPurpose,
        customInstructions,
        recipientPhone,
        callerPhone,
        leadId,
        leadName: lead?.name || "",
      },
      counts: stats,
      samples: {
        firstFaq,
        firstKnowledgeChunk,
        firstProductService: firstProductServiceChunk
          ? truncate(firstProductServiceChunk.content, 500)
          : "",
      },
      diagnostics,
      finalPromptPreview: systemPrompt.slice(0, 1500),
      finalPromptChars: systemPrompt.length,
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
