"use strict";

const DEFAULT_LIMIT = Math.max(
  1,
  Number(process.env.KNOWLEDGE_RETRIEVAL_LIMIT || 12),
);
const DEFAULT_MAX_CHARS = Math.max(
  300,
  Number(process.env.KNOWLEDGE_RETRIEVAL_MAX_CHARS || 1100),
);
const FALLBACK_SCAN_LIMIT = Math.max(
  DEFAULT_LIMIT * 4,
  Number(process.env.KNOWLEDGE_RETRIEVAL_SCAN_LIMIT || 60),
);

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "could",
  "do",
  "for",
  "from",
  "get",
  "give",
  "go",
  "has",
  "have",
  "help",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "need",
  "of",
  "on",
  "or",
  "our",
  "please",
  "show",
  "tell",
  "that",
  "the",
  "their",
  "them",
  "there",
  "this",
  "to",
  "want",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "with",
  "you",
  "your",
]);

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function asIdArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function tokenize(value) {
  return [
    ...new Set(
      cleanText(value)
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[^a-z0-9+#/._-]+/g, " ")
        .split(/\s+/)
        .filter((token) => token.length > 2 && !STOPWORDS.has(token))
        .slice(0, 32),
    ),
  ];
}

// --- Fuzzy (typo-tolerant) matching -----------------------------------------
// This is a general, tenant-agnostic safety net that runs in addition to the
// Postgres-side trigram/full-text ranking (search_knowledge_chunks/search_faqs).
// It matters for the code paths here that never reach Postgres at all: the
// fallback scan when the RPC is unavailable, and re-scoring already-fetched
// rows. Bounded/short-circuited so a correctly-spelled query (the common case)
// never pays the extra cost.
function levenshteinWithinBound(a, b, maxDist) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  let prevRow = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prevRow[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const currRow = new Array(b.length + 1);
    currRow[0] = i;
    let rowMin = currRow[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1,
        currRow[j - 1] + 1,
        prevRow[j - 1] + cost,
      );
      if (currRow[j] < rowMin) rowMin = currRow[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    prevRow = currRow;
  }
  return prevRow[b.length];
}

function fuzzyMaxDistFor(len) {
  if (len >= 9) return 2;
  if (len >= 5) return 1;
  return 0; // too short to fuzzy-match reliably (too many false positives)
}

// haystackWords: pre-split, deduped array of lowercase words from the haystack.
function fuzzyTokenMatches(token, haystackWords) {
  const maxDist = fuzzyMaxDistFor(token.length);
  if (maxDist === 0 || !haystackWords || !haystackWords.length) return false;
  let checked = 0;
  for (const word of haystackWords) {
    if (Math.abs(word.length - token.length) > maxDist) continue;
    if (++checked > 200) break; // bound worst-case cost per token
    if (levenshteinWithinBound(token, word, maxDist) <= maxDist) return true;
  }
  return false;
}

function haystackWordSet(haystack) {
  return [
    ...new Set(
      String(haystack || "")
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    ),
  ];
}

function truncate(value, maxChars = DEFAULT_MAX_CHARS) {
  const text = cleanText(value);
  return text.length > maxChars
    ? `${text.slice(0, Math.max(0, maxChars - 1))}…`
    : text;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function contentKind(row) {
  const metadata = normalizeMetadata(row?.metadata);
  return cleanText(
    row?.content_kind ||
      metadata.contentKind ||
      metadata.kind ||
      metadata.type ||
      "page",
  ).toLowerCase();
}

function scoreRow(row, query) {
  const tokens = tokenize(query);
  if (!tokens.length) return 0;
  const haystack = [
    row?.source_title,
    row?.source_url,
    row?.compact_summary,
    row?.content,
    JSON.stringify(normalizeMetadata(row?.metadata)),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  let score = 0;
  let haystackWords = null; // lazily computed only if an exact match misses
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token.length >= 6 ? 4 : 2;
      continue;
    }
    const parts = token.split(/[-_./]/).filter((p) => p.length > 2);
    if (parts.length > 1 && parts.some((part) => haystack.includes(part))) {
      score += 1;
      continue;
    }
    // Typo-tolerant fallback: catches things like "vutamins" -> "vitamin",
    // "Probotics" -> "probiotic". Applies to every tenant equally; this is a
    // general property of the ranking function, not a per-business patch.
    if (!haystackWords) haystackWords = haystackWordSet(haystack);
    if (fuzzyTokenMatches(token, haystackWords)) {
      score += token.length >= 6 ? 2 : 1;
    }
  }
  const kind = contentKind(row);
  if (kind === "product" || kind === "product_fact") score += 2;
  return score;
}

function normalizeChunk(row, maxChars = DEFAULT_MAX_CHARS) {
  if (!row) return null;
  const content = truncate(row.compact_summary || row.content || "", maxChars);
  if (!content) return null;
  const metadata = normalizeMetadata(row.metadata);
  return {
    id: row.id || null,
    source_url: cleanText(row.source_url || row.url || ""),
    source_title: cleanText(row.source_title || row.title || ""),
    content,
    compact_summary: cleanText(row.compact_summary || ""),
    token_count: Number(row.token_count || 0),
    knowledge_base_id: row.knowledge_base_id || null,
    knowledge_source_id: row.knowledge_source_id || null,
    voice_agent_id: row.voice_agent_id || null,
    metadata,
    content_kind: contentKind(row),
    searchScore: Number(row.search_score || row.rank || row.score || 0),
  };
}

function rankLocally(
  rows,
  query,
  limit = DEFAULT_LIMIT,
  maxChars = DEFAULT_MAX_CHARS,
) {
  const normalized = (rows || []).map((row) => ({
    row,
    score: scoreRow(row, query),
  }));
  const hasQuery = tokenize(query).length > 0;
  const ranked = normalized.sort(
    (a, b) =>
      b.score - a.score ||
      String(a.row?.content || "").length - String(b.row?.content || "").length,
  );
  const filtered = hasQuery
    ? ranked.filter((entry) => entry.score > 0)
    : ranked;
  const chosen = (filtered.length ? filtered : ranked).slice(0, limit);
  return chosen
    .map((entry) =>
      normalizeChunk({ ...entry.row, search_score: entry.score }, maxChars),
    )
    .filter(Boolean);
}

function buildFallbackSelect() {
  return "id,organization_id,knowledge_base_id,knowledge_source_id,chatbot_id,voice_agent_id,source_url,source_title,content,compact_summary,token_count,metadata,chunk_index,updated_at,created_at";
}

async function rpcSearchChunks(
  db,
  { organizationId, knowledgeBaseIds, query, limit, maxChars },
) {
  const ids = asIdArray(knowledgeBaseIds);
  const { data, error } = await db.rpc("search_knowledge_chunks", {
    p_organization_id: organizationId,
    p_knowledge_base_ids: ids.length ? ids : null,
    p_query: cleanText(query),
    p_limit: limit,
    p_max_chars: maxChars,
  });
  if (error) throw error;
  return (data || [])
    .map((row) => normalizeChunk(row, maxChars))
    .filter(Boolean);
}

async function rpcSearchFaqs(
  db,
  { organizationId, knowledgeBaseIds, query, limit },
) {
  const ids = asIdArray(knowledgeBaseIds);
  const { data, error } = await db.rpc("search_faqs", {
    p_organization_id: organizationId,
    p_knowledge_base_ids: ids.length ? ids : null,
    p_query: cleanText(query),
    p_limit: limit,
  });
  if (error) throw error;
  return (data || [])
    .map((row) => ({
      id: row.id || null,
      question: cleanText(row.question),
      answer: cleanText(row.answer),
      knowledge_base_id: row.knowledge_base_id || null,
      knowledge_source_id: row.knowledge_source_id || null,
      relevance: Number(row.search_score || 0),
    }))
    .filter((row) => row.question && row.answer);
}

async function fallbackSearchChunks(
  db,
  {
    organizationId,
    knowledgeBaseIds = [],
    query = "",
    limit = DEFAULT_LIMIT,
    maxChars = DEFAULT_MAX_CHARS,
    chatbotId = null,
    voiceAgentId = null,
    linkedChatbotIds = [],
  },
) {
  const ids = asIdArray(knowledgeBaseIds);
  let builder = db
    .from("knowledge_chunks")
    .select(buildFallbackSelect())
    .eq("organization_id", organizationId)
    .limit(Math.max(limit * 4, FALLBACK_SCAN_LIMIT));

  if (ids.length) {
    builder = builder.in("knowledge_base_id", ids);
  } else if (chatbotId) {
    builder = builder.eq("chatbot_id", chatbotId);
  } else if (voiceAgentId) {
    builder = builder.eq("voice_agent_id", voiceAgentId);
  } else if (linkedChatbotIds.length) {
    builder = builder.in("chatbot_id", linkedChatbotIds);
  }

  builder = builder.order("updated_at", {
    ascending: false,
    nullsFirst: false,
  });
  const { data, error } = await builder;
  if (error) {
    console.warn(
      "[knowledge-retrieval] fallback chunks:",
      error.message || error,
    );
    return [];
  }
  return rankLocally(data || [], query, limit, maxChars);
}

async function searchScopedKnowledgeChunks(db, options = {}) {
  const organizationId = options.organizationId;
  if (!organizationId) return [];
  const limit = Math.min(
    Math.max(Number(options.limit || DEFAULT_LIMIT), 1),
    30,
  );
  const maxChars = Math.min(
    Math.max(Number(options.maxChars || DEFAULT_MAX_CHARS), 300),
    2200,
  );
  const query = cleanText(options.query || "");
  const knowledgeBaseIds = asIdArray(options.knowledgeBaseIds);

  if (knowledgeBaseIds.length) {
    try {
      const rows = await rpcSearchChunks(db, {
        organizationId,
        knowledgeBaseIds,
        query,
        limit,
        maxChars,
      });
      if (rows.length) return rows;
    } catch (error) {
      const message = String(error?.message || error || "").toLowerCase();
      if (
        !message.includes("search_knowledge_chunks") &&
        !message.includes("schema cache") &&
        !message.includes("function")
      ) {
        console.warn(
          "[knowledge-retrieval] rpc search:",
          error.message || error,
        );
      }
    }
  }

  if (!knowledgeBaseIds.length) {
    // Strict KB isolation: never search organization-wide or linked legacy chunks
    // without an explicit assigned Knowledge Base.
    return [];
  }

  return fallbackSearchChunks(db, {
    organizationId,
    knowledgeBaseIds,
    query,
    limit,
    maxChars,
    chatbotId: null,
    voiceAgentId: null,
    linkedChatbotIds: [],
  });
}

async function searchScopedFaqs(db, options = {}) {
  const organizationId = options.organizationId;
  if (!organizationId) return [];
  const knowledgeBaseIds = asIdArray(options.knowledgeBaseIds);
  const query = cleanText(options.query || "");
  const limit = Math.min(Math.max(Number(options.limit || 12), 1), 50);

  if (!knowledgeBaseIds.length) {
    // Strict KB runtime isolation: FAQ rows without a selected knowledge_base_id
    // are legacy/unscoped and must not be loaded into voice/chat runtime.
    return [];
  }

  // Primary path: DB-side full-text + trigram ranking (typo-tolerant, shared by
  // every tenant/business since it's one Postgres function keyed only by
  // organization_id/knowledge_base_id).
  try {
    const rows = await rpcSearchFaqs(db, {
      organizationId,
      knowledgeBaseIds,
      query,
      limit,
    });
    if (rows.length) return rows;
  } catch (error) {
    const message = String(error?.message || error || "").toLowerCase();
    if (
      !message.includes("search_faqs") &&
      !message.includes("schema cache") &&
      !message.includes("function")
    ) {
      console.warn("[knowledge-retrieval] rpc faqs:", error.message || error);
    }
  }

  // Fallback path (RPC unavailable/deploy-order edge case): fetch raw rows and
  // rank locally with the same fuzzy-tolerant scoreRow() used for chunks.
  let builder = db
    .from("faqs")
    .select(
      "id,question,answer,voice_agent_id,knowledge_base_id,knowledge_source_id,metadata,updated_at,created_at",
    )
    .eq("organization_id", organizationId)
    .in("knowledge_base_id", knowledgeBaseIds)
    .limit(Math.max(limit * 3, 30));

  builder = builder.order("updated_at", {
    ascending: false,
    nullsFirst: false,
  });
  const { data, error } = await builder;
  if (error) {
    console.warn("[knowledge-retrieval] faqs:", error.message || error);
    return [];
  }
  const rows = (data || [])
    .map((row) => ({
      id: row.id || null,
      question: cleanText(row.question),
      answer: cleanText(row.answer),
      knowledge_base_id: row.knowledge_base_id || null,
      knowledge_source_id: row.knowledge_source_id || null,
      score: scoreRow(
        { ...row, content: `${row.question || ""}\n${row.answer || ""}` },
        query,
      ),
    }))
    .filter((row) => row.question && row.answer);
  const hasQuery = tokenize(query).length > 0;
  const ranked = rows.sort((a, b) => b.score - a.score);
  const filtered = hasQuery ? ranked.filter((row) => row.score > 0) : ranked;
  return (filtered.length ? filtered : ranked)
    .slice(0, limit)
    .map(({ score, ...row }) => ({ ...row, relevance: score }));
}

module.exports = {
  cleanText,
  tokenize,
  normalizeChunk,
  rankLocally,
  searchScopedKnowledgeChunks,
  searchScopedFaqs,
};

// (Not exported at module boundary today, but keeping names stable/discoverable
// for anyone extending this file: fuzzyTokenMatches, levenshteinWithinBound.)
