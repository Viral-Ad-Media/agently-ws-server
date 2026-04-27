"use strict";

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function normalizeFaqs(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      question: String(row?.question || "").trim(),
      answer: String(row?.answer || "").trim(),
    }))
    .filter((row) => row.question && row.answer);
}

function normalizeChunk(row) {
  return {
    id: row?.id || null,
    content: String(row?.content || "").trim(),
    sourceUrl: String(row?.source_url || "").trim(),
    sourceTitle: String(row?.source_title || row?.source_url || "").trim(),
    chatbotId: row?.chatbot_id || null,
    voiceAgentId: row?.voice_agent_id || null,
  };
}

function tokenize(text) {
  return uniq(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s:/._-]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2)
      .slice(0, 24),
  );
}

function scoreText(text, keywords) {
  const haystack = String(text || "").toLowerCase();
  if (!haystack) return 0;
  let score = 0;
  for (const keyword of keywords) {
    if (!keyword) continue;
    if (haystack.includes(keyword)) score += 2;
    const parts = keyword.split(/[-_/]/).filter(Boolean);
    if (parts.length > 1 && parts.some((part) => haystack.includes(part))) score += 1;
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
      score: scoreText(chunk.content + "\n" + chunk.sourceTitle + "\n" + chunk.sourceUrl, keywords),
    }))
    .sort((a, b) => b.score - a.score || a.chunk.content.length - b.chunk.content.length);

  const filtered = ranked.filter((entry) => entry.score > 0).slice(0, max).map((entry) => entry.chunk);
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
    const score = scoreText(label + "\n" + chunk.content + "\n" + chunk.sourceUrl, keywords);
    candidates.push({ label, url: chunk.sourceUrl, score });
  }
  const ranked = candidates.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
  const chosen = (ranked.filter((item) => item.score > 0).slice(0, max));
  return chosen.length > 0 ? chosen : ranked.slice(0, Math.min(max, ranked.length));
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

function buildChatPrompt({ businessName, customPrompt, faqs, chunks, links, collectLeads }) {
  const parts = [];
  parts.push(`You are the website assistant for ${businessName || "this business"}.`);
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
        chunks.map((chunk, index) => `[Source ${index + 1}] ${chunk.content}`).join("\n\n---\n\n"),
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

function buildInboundVoicePrompt({ agentRow, faqs, relevantKnowledge }) {
  const captureFields = Array.isArray(agentRow?.data_capture_fields)
    ? agentRow.data_capture_fields.join(", ")
    : "name, phone, email, reason";
  const parts = [
    `You are ${agentRow?.name || "the AI receptionist"}, an AI ${agentRow?.tone || "Professional"} receptionist for this business.`,
  ];
  parts.push(
    "This is an inbound voice conversation. Be concise, natural, helpful, and speak in short phone-friendly sentences.",
  );
  parts.push(`Business hours: ${agentRow?.business_hours || "9am-5pm Monday-Friday"}.`);
  parts.push(`Capture the caller's ${captureFields} when appropriate.`);
  parts.push(
    "If you can answer the caller accurately from the available information, do so. If you cannot, do not invent an answer. Offer to take a message and say someone can follow up.",
  );
  parts.push(
    "If the caller asks for a human or transfer, you may offer transfer when escalation is configured. End the transfer response with {\"action\":\"transfer\"}.",
  );
  if ((faqs || []).length) {
    parts.push(
      "VOICE FAQS:\n" +
        faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n\n"),
    );
  }
  if (relevantKnowledge) parts.push(`Relevant business knowledge:\n${relevantKnowledge}`);
  parts.push(
    "On the final line of your final reply when the conversation is ending, output captured details as JSON exactly like {\"captured\": {\"name\": \"...\", \"phone\": \"...\", \"email\": \"...\", \"reason\": \"...\"}}.",
  );
  return parts.join("\n\n");
}

function buildOutboundVoicePrompt({ agentRow, faqs, relevantKnowledge, callPurposes, assignmentContext }) {
  const parts = [
    `You are ${agentRow?.name || "the AI agent"}, an AI ${agentRow?.tone || "Professional"} outbound caller for this business.`,
  ];
  parts.push(
    "This is an outbound voice conversation. Open clearly, explain why you are calling, and keep the conversation concise and respectful.",
  );
  if ((callPurposes || []).length) {
    parts.push("CALL PURPOSES:\n" + callPurposes.map((item) => `- ${item}`).join("\n"));
  }
  if (assignmentContext) parts.push(`LEAD-SPECIFIC CONTEXT:\n${assignmentContext}`);
  if ((faqs || []).length) {
    parts.push(
      "SUPPORTING FAQS:\n" +
        faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n\n"),
    );
  }
  if (relevantKnowledge) parts.push(`Relevant business knowledge:\n${relevantKnowledge}`);
  parts.push(
    "Do not read large blocks of information. Use only the parts that help this call objective.",
  );
  parts.push(
    "On the final line of your final reply when the conversation is ending, output captured details as JSON exactly like {\"captured\": {\"name\": \"...\", \"phone\": \"...\", \"email\": \"...\", \"reason\": \"...\"}}.",
  );
  return parts.join("\n\n");
}

async function loadChatbotContext(db, chatbotId, query) {
  const { data: chatbot } = await db
    .from("chatbots")
    .select("id, organization_id, voice_agent_id, header_title, custom_prompt, faqs, collect_leads")
    .eq("id", chatbotId)
    .single();
  if (!chatbot) return null;

  const faqJson = normalizeFaqs(Array.isArray(chatbot.faqs) ? chatbot.faqs : []);
  const chunkQueries = [
    db.from("knowledge_chunks").select("id, content, source_url, source_title, chatbot_id, voice_agent_id").eq("chatbot_id", chatbot.id).limit(120),
  ];
  if (chatbot.voice_agent_id) {
    chunkQueries.push(
      db.from("knowledge_chunks").select("id, content, source_url, source_title, chatbot_id, voice_agent_id").eq("voice_agent_id", chatbot.voice_agent_id).limit(120),
    );
  }
  const results = await Promise.all(chunkQueries);
  const rawChunks = results.flatMap((result) => result.data || []);
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
  const [faqResult, linkedChatbotResult, directChunksResult] = await Promise.all([
    db.from("faqs").select("question,answer").eq("voice_agent_id", agentRow.id).limit(50),
    db.from("chatbots").select("id").eq("organization_id", orgId).eq("voice_agent_id", agentRow.id).limit(5),
    db.from("knowledge_chunks").select("id, content, source_url, source_title, chatbot_id, voice_agent_id").eq("voice_agent_id", agentRow.id).limit(120),
  ]);
  const linkedChatbotIds = (linkedChatbotResult.data || []).map((row) => row.id).filter(Boolean);
  let linkedChunks = [];
  if (linkedChatbotIds.length > 0) {
    const { data } = await db
      .from("knowledge_chunks")
      .select("id, content, source_url, source_title, chatbot_id, voice_agent_id")
      .in("chatbot_id", linkedChatbotIds)
      .limit(120);
    linkedChunks = data || [];
  }
  const faqs = normalizeFaqs(faqResult.data || []);
  const allChunks = [...(directChunksResult.data || []), ...linkedChunks];
  const relevantChunks = chooseRelevantChunks(allChunks, query, 4);
  const relevantKnowledge = relevantChunks.map((chunk) => chunk.content).join("\n\n---\n\n");
  const callPurposes = Array.isArray(agentRow.call_purposes) ? agentRow.call_purposes.map((item) => String(item || "").trim()).filter(Boolean) : [];
  const assignmentContext = String(extra.assignmentContext || "").trim();
  const systemPrompt = agentRow.direction === "outbound"
    ? buildOutboundVoicePrompt({ agentRow, faqs, relevantKnowledge, callPurposes, assignmentContext })
    : buildInboundVoicePrompt({ agentRow, faqs, relevantKnowledge });

  return { faqs, relevantChunks, relevantKnowledge, callPurposes, systemPrompt };
}

module.exports = {
  tokenize,
  chooseRelevantChunks,
  chooseRelevantLinks,
  loadChatbotContext,
  loadVoiceContext,
  buildChatPrompt,
};
