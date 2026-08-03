"use strict";

const crypto = require("crypto");
const { getSupabase } = require("./supabase");

function nowIso() {
  return new Date().toISOString();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeJson(value) {
  if (!value || typeof value !== "object") return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return {};
  }
}

function stableKey(parts) {
  return crypto
    .createHash("sha256")
    .update(parts.filter(Boolean).map(String).join("|"))
    .digest("hex");
}

async function postWalletChargeForUsageEvent(sb, usageEventId, organizationId) {
  const { data, error } = await sb.rpc(
    "billing_post_wallet_charge_for_usage_event",
    {
      p_usage_event_id: usageEventId,
      p_force: false,
      p_source: "agently-ws-server",
    },
  );
  if (error) {
    const message = String(error.message || error || "");
    if (
      /billing_post_wallet_charge_for_usage_event|function .* does not exist|Could not find the function/i.test(
        message,
      )
    ) {
      const missing = new Error(
        "The required immediate wallet-posting database function is missing. Apply project-docs/Agently-Immediate-Wallet-Posting-Migration.sql before testing billable realtime usage.",
      );
      missing.code = "BILLING_WALLET_POST_FUNCTION_MISSING";
      missing.details = { usageEventId, organizationId, cause: message };
      throw missing;
    }
    throw error;
  }
  const row = Array.isArray(data) ? data[0] || null : data || null;
  return row || null;
}

function roundMoney(value, places = 8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

async function getWalletRow(sb, organizationId) {
  const { data, error } = await sb
    .from("billing_wallets")
    .select(
      "id,organization_id,currency,balance_usd,minimum_recharge_usd,status,updated_at",
    )
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data || null;
}

async function requireWalletCharge(sb, usageEventId, organizationId, billable) {
  if (!billable) return { skipped: true, reason: "non_billable" };
  if (!usageEventId || !organizationId) {
    const error = new Error(
      "Billable realtime usage is missing a usage-event or organization identifier.",
    );
    error.code = "BILLING_WALLET_POST_FAILED";
    throw error;
  }

  // Ensures a charge row exists (no-op if the DB trigger already created one).
  const { error: chargeRpcError } = await sb.rpc(
    "billing_admin_charge_usage_event",
    {
      p_usage_event_id: usageEventId,
      p_apply_wallet: false,
      p_force: false,
    },
  );
  if (chargeRpcError) throw chargeRpcError;

  const { data: charge, error: chargeError } = await sb
    .from("billing_customer_usage_charges")
    .select("id,customer_charge_usd")
    .eq("usage_event_id", usageEventId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (chargeError) throw chargeError;
  if (!charge) {
    const error = new Error(
      "Realtime usage was recorded without a customer charge row.",
    );
    error.code = "BILLING_CHARGE_ROW_MISSING";
    throw error;
  }

  // Single, org-locked posting path — same function used by every other
  // billing surface in this codebase. No bespoke insert logic here anymore.
  const posted = await postWalletChargeForUsageEvent(
    sb,
    usageEventId,
    organizationId,
  );

  return {
    chargeId: charge.id,
    customerChargeUsd: roundMoney(charge.customer_charge_usd, 8),
    walletTransactionId: posted?.wallet_transaction_id || null,
    walletBalanceUsd: safeNumber(posted?.balance_after_usd, 0),
    walletUpdatedAt: nowIso(),
  };
}

function normalizeUsage(usage = {}) {
  return {
    input_tokens: safeNumber(usage.input_tokens ?? usage.prompt_tokens),
    output_tokens: safeNumber(usage.output_tokens ?? usage.completion_tokens),
    cached_input_tokens: safeNumber(usage.input_token_details?.cached_tokens),
    audio_input_tokens: safeNumber(usage.input_token_details?.audio_tokens),
    audio_output_tokens: safeNumber(usage.output_token_details?.audio_tokens),
  };
}

async function insertUsageEvent(event) {
  const sb = getSupabase();
  const occurredAt = event.occurredAt || event.occurred_at || nowIso();
  const payload = {
    organization_id: event.organizationId || event.organization_id || null,
    user_id: event.userId || event.user_id || null,
    provider: event.provider,
    service: event.service,
    event_type: event.eventType || event.event_type || "usage",
    source: event.source || "agently_ws_server",
    external_id: event.externalId || event.external_id || null,
    idempotency_key:
      event.idempotencyKey ||
      event.idempotency_key ||
      stableKey([
        event.provider,
        event.service,
        event.eventType || event.event_type,
        event.externalId || event.external_id,
        event.callId || event.call_id,
        event.organizationId || event.organization_id,
        occurredAt,
      ]),
    call_id: event.callId || event.call_id || null,
    chatbot_id: event.chatbotId || event.chatbot_id || null,
    voice_agent_id: event.voiceAgentId || event.voice_agent_id || null,
    knowledge_base_id: event.knowledgeBaseId || event.knowledge_base_id || null,
    lead_id: event.leadId || event.lead_id || null,
    unit: event.unit || null,
    quantity: event.quantity == null ? null : safeNumber(event.quantity),
    unit_cost_usd: event.unitCostUsd ?? event.unit_cost_usd ?? null,
    estimated_cost_usd:
      event.estimatedCostUsd ?? event.estimated_cost_usd ?? null,
    billable: event.billable !== false,
    occurred_at: occurredAt,
    metadata: safeJson(event.metadata),
  };

  try {
    const { data, error } = await sb.rpc("record_billing_usage_event", {
      p_organization_id: payload.organization_id,
      p_provider: payload.provider,
      p_service: payload.service,
      p_unit: payload.unit,
      p_quantity: payload.quantity,
      p_occurred_at: payload.occurred_at,
      p_event_type: payload.event_type,
      p_source: payload.source,
      p_external_id: payload.external_id,
      p_idempotency_key: payload.idempotency_key,
      p_user_id: payload.user_id,
      p_call_id: payload.call_id,
      p_chatbot_id: payload.chatbot_id,
      p_voice_agent_id: payload.voice_agent_id,
      p_knowledge_base_id: payload.knowledge_base_id,
      p_lead_id: payload.lead_id,
      p_unit_cost_usd: payload.unit_cost_usd,
      p_estimated_cost_usd: payload.estimated_cost_usd,
      p_billable: payload.billable,
      p_metadata: payload.metadata,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] || null : data || null;
    const billing = await requireWalletCharge(
      sb,
      row?.id || row?.usage_event_id || null,
      payload.organization_id,
      payload.billable,
    );
    return { ...(row || {}), billing };
  } catch (rpcError) {
    const message = rpcError?.message || String(rpcError);
    if (
      !/record_billing_usage_event|function .* does not exist|Could not find the function/i.test(
        message,
      )
    ) {
      throw rpcError;
    }
  }

  const { data, error } = await sb
    .from("billing_usage_events")
    .upsert(payload, { onConflict: "idempotency_key" })
    .select("id")
    .maybeSingle();
  if (error) throw error;
  const billing = await requireWalletCharge(
    sb,
    data?.id || null,
    payload.organization_id,
    payload.billable,
  );
  return { ...(data || {}), billing };
}

function hasExactOpenAIUsage(usage, normalized, total) {
  if (!usage || typeof usage !== "object") return false;
  if (safeNumber(total) > 0) return true;
  return [
    normalized.input_tokens,
    normalized.output_tokens,
    normalized.cached_input_tokens,
    normalized.audio_input_tokens,
    normalized.audio_output_tokens,
  ].some((value) => safeNumber(value) > 0);
}

function openAIComponentRows(normalized) {
  return [
    {
      key: "input",
      eventSuffix: "input_tokens",
      quantity: normalized.input_tokens,
      unitDetail: "input_tokens",
    },
    {
      key: "output",
      eventSuffix: "output_tokens",
      quantity: normalized.output_tokens,
      unitDetail: "output_tokens",
    },
    {
      key: "cached_input",
      eventSuffix: "cached_input_tokens",
      quantity: normalized.cached_input_tokens,
      unitDetail: "cached_input_tokens",
    },
    {
      key: "audio_input",
      eventSuffix: "audio_input_tokens",
      quantity: normalized.audio_input_tokens,
      unitDetail: "audio_input_tokens",
    },
    {
      key: "audio_output",
      eventSuffix: "audio_output_tokens",
      quantity: normalized.audio_output_tokens,
      unitDetail: "audio_output_tokens",
    },
  ].filter((item) => safeNumber(item.quantity) > 0);
}

async function logOpenAIUsage({
  organizationId,
  userId,
  service = "chat_completion",
  eventType = "openai_text_tokens",
  model,
  usage,
  inputTokens,
  outputTokens,
  cachedInputTokens,
  audioInputTokens,
  audioOutputTokens,
  estimatedCostUsd,
  callId,
  chatbotId,
  voiceAgentId,
  knowledgeBaseId,
  leadId,
  externalId,
  metadata,
}) {
  const normalized = normalizeUsage(usage || {});
  if (inputTokens != null) normalized.input_tokens = safeNumber(inputTokens);
  if (outputTokens != null) normalized.output_tokens = safeNumber(outputTokens);
  if (cachedInputTokens != null)
    normalized.cached_input_tokens = safeNumber(cachedInputTokens);
  if (audioInputTokens != null)
    normalized.audio_input_tokens = safeNumber(audioInputTokens);
  if (audioOutputTokens != null)
    normalized.audio_output_tokens = safeNumber(audioOutputTokens);
  const total =
    normalized.input_tokens +
    normalized.output_tokens +
    normalized.cached_input_tokens +
    normalized.audio_input_tokens +
    normalized.audio_output_tokens;

  const exactUsage = hasExactOpenAIUsage(usage, normalized, total);
  const baseExternalId =
    externalId ||
    metadata?.response_id ||
    metadata?.request_id ||
    metadata?.session_id ||
    stableKey([
      "openai",
      service,
      eventType,
      organizationId,
      callId,
      chatbotId,
      voiceAgentId,
      knowledgeBaseId,
      leadId,
      nowIso(),
    ]);

  const common = {
    organizationId,
    userId,
    provider: "openai",
    service,
    callId,
    chatbotId,
    voiceAgentId,
    knowledgeBaseId,
    leadId,
  };

  if (!exactUsage) {
    return insertUsageEvent({
      ...common,
      eventType: String(eventType || "openai_text_tokens").includes(
        "usage_missing",
      )
        ? eventType
        : `${eventType}_usage_missing`,
      externalId: `${baseExternalId}:usage_missing`,
      idempotencyKey: stableKey([
        "openai",
        service,
        eventType,
        baseExternalId,
        "usage_missing",
        organizationId,
        callId,
        chatbotId,
      ]),
      unit: "tokens",
      quantity: 0,
      estimatedCostUsd: null,
      billable: false,
      metadata: {
        model,
        usage: safeJson(usage),
        ...normalized,
        total_tokens: 0,
        exact_usage: false,
        usage_missing: true,
        note: "OpenAI did not return usage details for this request. This row is not billable and must not be treated as token cost.",
        ...(metadata || {}),
      },
    });
  }

  const rows = [];
  for (const component of openAIComponentRows(normalized)) {
    rows.push(
      await insertUsageEvent({
        ...common,
        eventType: `${eventType}_${component.eventSuffix}`,
        externalId: `${baseExternalId}:${component.key}`,
        idempotencyKey: stableKey([
          "openai",
          service,
          eventType,
          baseExternalId,
          component.key,
          organizationId,
          callId,
          chatbotId,
          voiceAgentId,
          knowledgeBaseId,
        ]),
        unit: "tokens",
        quantity: safeNumber(component.quantity),
        estimatedCostUsd: null,
        billable: Boolean(organizationId),
        metadata: {
          model,
          usage: safeJson(usage),
          ...normalized,
          total_tokens: total,
          token_component: component.unitDetail,
          exact_usage: true,
          cost_basis: "openai_exact_usage_component",
          original_event_type: eventType,
          ...(metadata || {}),
        },
      }),
    );
  }

  return rows;
}

async function logKnowledgeSyncUsage({
  organizationId,
  userId,
  knowledgeBaseId,
  knowledgeSourceId,
  pagesAttempted,
  pagesScraped,
  pagesFailed,
  chunksStored,
  productsStored,
  faqsStored,
  storageBytes,
  durationMs,
  externalId,
  metadata,
}) {
  const groupId = externalId || knowledgeSourceId || knowledgeBaseId || null;
  const common = {
    organizationId,
    userId,
    knowledgeBaseId,
    provider: "knowledge_base",
    service: "scrape_sync",
    source: "knowledge_sync_meter",
    externalId: groupId,
  };
  const sharedMetadata = {
    knowledge_source_id: knowledgeSourceId || null,
    duration_ms: durationMs || null,
    ...(metadata || {}),
  };
  const definitions = [
    ["sync_attempt", "sync", 1],
    ["pages_attempted", "pages", pagesAttempted],
    ["pages_scraped", "pages", pagesScraped],
    ["pages_failed", "pages", pagesFailed],
    ["chunks_stored", "chunks", chunksStored],
    ["products_stored", "products", productsStored],
    ["faqs_stored", "faqs", faqsStored],
    ["knowledge_sync_storage_bytes", "bytes", storageBytes],
  ];
  const rows = [];
  for (const [eventType, unit, quantity] of definitions) {
    const qty = safeNumber(quantity);
    if (qty <= 0) continue;
    rows.push(
      await insertUsageEvent({
        ...common,
        eventType,
        unit,
        quantity: qty,
        metadata: sharedMetadata,
      }),
    );
  }
  return rows;
}

async function logRailwayRuntimeUsage({
  organizationId,
  userId,
  seconds,
  callId,
  voiceAgentId,
  chatbotId,
  externalId,
  eventType = "websocket_runtime",
  source = "agently_ws_runtime_meter",
  metadata,
}) {
  return insertUsageEvent({
    organizationId,
    userId,
    provider: "railway",
    service: "runtime",
    eventType,
    source,
    externalId,
    callId,
    voiceAgentId,
    chatbotId,
    unit: "seconds",
    quantity: safeNumber(seconds),
    billable: Boolean(organizationId) && safeNumber(seconds) > 0,
    metadata: metadata || {},
  });
}

async function logElevenLabsUsage({
  organizationId,
  userId,
  voiceId,
  modelId,
  characters,
  credits,
  callId,
  voiceAgentId,
  externalId,
  metadata,
}) {
  return insertUsageEvent({
    organizationId,
    userId,
    provider: "elevenlabs",
    service: "tts",
    eventType: "elevenlabs_synthesis",
    source: "agently_ws_voice_meter",
    externalId,
    callId,
    voiceAgentId,
    unit: credits != null ? "credits" : "characters",
    quantity: safeNumber(credits ?? characters),
    billable: Boolean(organizationId),
    metadata: {
      voice_id: voiceId || null,
      model_id: modelId || null,
      characters: characters ?? null,
      credits: credits ?? null,
      ...(metadata || {}),
    },
  });
}

module.exports = {
  insertUsageEvent,
  logOpenAIUsage,
  logKnowledgeSyncUsage,
  logRailwayRuntimeUsage,
  logElevenLabsUsage,
};
