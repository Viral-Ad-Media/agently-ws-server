// lib/scraper.service.js - Scraper V2: business-KB scoped website and ecommerce importer
"use strict";

const crypto = require("crypto");
const cheerio = require("cheerio");
const { getSupabase } = require("./supabase");
const { logKnowledgeSyncUsage } = require("./usage-ledger");

const CHUNK_SIZE = Number(process.env.SCRAPER_CHUNK_SIZE || 420);
const CHUNK_OVERLAP = Number(process.env.SCRAPER_CHUNK_OVERLAP || 55);
const MAX_CHUNKS = Number(process.env.SCRAPER_MAX_CHUNKS || 260);
const MAX_PAGES = Number(process.env.SCRAPER_MAX_PAGES || 40);
const MAX_SITEMAP_URLS = Number(process.env.SCRAPER_MAX_SITEMAP_URLS || 250);
const MAX_PRODUCT_PAGES = Number(process.env.SCRAPER_MAX_PRODUCT_PAGES || 120);
const MAX_PRODUCTS = Number(process.env.SCRAPER_MAX_PRODUCTS || 250);
const FETCH_TIMEOUT_MS = Number(process.env.SCRAPER_FETCH_TIMEOUT_MS || 22000);
const USER_AGENT =
  process.env.SCRAPER_USER_AGENT ||
  "Mozilla/5.0 (compatible; AgentlyScraper/2.0; +https://www.agentlycall.com)";

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(url) {
  const raw = cleanText(url).replace(/\/+$/, "");
  if (!raw) return "";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProtocol);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    return u.toString().replace(/\/+$/, "");
  } catch (_) {
    return "";
  }
}

function rootUrl(url) {
  try {
    const u = new URL(normalizeUrl(url));
    return `${u.protocol}//${u.hostname}`;
  } catch (_) {
    return normalizeUrl(url);
  }
}

function domainFromUrl(value) {
  try {
    return new URL(normalizeUrl(value)).hostname.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

function sameHost(a, b) {
  return domainFromUrl(a) && domainFromUrl(a) === domainFromUrl(b);
}

function titleFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(last)
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  } catch (_) {
    return "Website page";
  }
}

function hashText(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function tokenCount(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean).length;
}

function compactSummary(value, maxChars = 420) {
  const text = cleanText(value);
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  return `${cut.slice(0, Math.max(cut.lastIndexOf("."), cut.lastIndexOf(" "), 260)).trim()}...`;
}

function failureReason(error) {
  const message = cleanText(error?.message || error || "Unknown error");
  if (/HTTP\s+401|HTTP\s+403/i.test(message)) {
    return `${message}. The website blocked automated access or requires permission.`;
  }
  if (/too little text/i.test(message)) {
    return "The page returned too little usable text after cleaning.";
  }
  if (/timeout|aborted|AbortError/i.test(message)) {
    return "The page timed out while loading.";
  }
  return message;
}

function buildScrapeReport({
  pages = [],
  pageFailures = [],
  pageWarnings = [],
  attemptedUrls = [],
  discoveredUrls = 0,
  products = [],
  chunksStored = 0,
  productsStored = 0,
  strategy = "scraper-v2",
}) {
  const attempted = Math.max(
    1,
    attemptedUrls.length || pages.length + pageFailures.length,
  );
  const scraped = pages.length;
  const failed = pageFailures.length;
  const coveragePercent = Math.max(
    0,
    Math.min(100, Math.round((scraped / attempted) * 100)),
  );
  const failedPages = pageFailures.slice(0, 30).map((item) => ({
    url: item.url || "",
    reason: failureReason(item.reason || item.error || item.message),
  }));
  const warnings = pageWarnings.slice(0, 30).map((item) => ({
    url: item.url || "",
    reason: cleanText(
      item.reason || "Large page was compacted before storage.",
    ),
  }));
  const suggestedActions = [];
  if (failedPages.length) {
    suggestedActions.push(
      "Retry failed pages individually from the Knowledge Base page.",
    );
    suggestedActions.push(
      "If a page is blocked or still fails, add the key answers manually as FAQs for this Knowledge Base.",
    );
  }
  if (!scraped) {
    suggestedActions.push(
      "Check that the URL is public and does not require login, bot verification, or private access.",
    );
  }
  if (!chunksStored) {
    suggestedActions.push(
      "No compact chunks were stored, so assigned agents do not have usable website knowledge from this source yet.",
    );
  }
  return {
    coveragePercent,
    pagesAttempted: attempted,
    pagesScraped: scraped,
    pagesFailed: failed,
    pagesDiscovered: discoveredUrls,
    chunksStored,
    productsFound: products.length,
    productsStored,
    failedPages,
    warnings,
    suggestedActions,
    usable: chunksStored > 0,
    strategy,
    generatedAt: new Date().toISOString(),
  };
}

function inferBusinessProfileFromScrape(result = {}, normalizedUrl = "") {
  const pages = Array.isArray(result.pages) ? result.pages : [];
  const allText = pages
    .slice(0, 8)
    .map((page) => `${page.title || ""}\n${page.text || ""}`)
    .join("\n")
    .toLowerCase();
  const sourceDomain = domainFromUrl(normalizedUrl);
  const titles = pages
    .map((page) => cleanText(page.title))
    .filter(Boolean)
    .slice(0, 8);
  const services = [];
  const addService = (value) => {
    const text = cleanText(value);
    if (text && !services.includes(text)) services.push(text);
  };

  let industry = "";
  let description = "";
  let runtimeProfile = "";

  const stopWords = new Set([
    "about",
    "after",
    "again",
    "also",
    "and",
    "are",
    "because",
    "been",
    "before",
    "being",
    "best",
    "but",
    "can",
    "com",
    "contact",
    "copyright",
    "for",
    "from",
    "has",
    "have",
    "home",
    "how",
    "https",
    "into",
    "learn",
    "more",
    "not",
    "our",
    "page",
    "policy",
    "read",
    "services",
    "site",
    "that",
    "the",
    "their",
    "this",
    "with",
    "www",
    "you",
    "your",
  ]);
  const keywordCounts = new Map();
  allText
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stopWords.has(word))
    .slice(0, 2500)
    .forEach((word) =>
      keywordCounts.set(word, (keywordCounts.get(word) || 0) + 1),
    );
  const inferredTopics = Array.from(keywordCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
    .slice(0, 12);
  titles.forEach(addService);
  inferredTopics.slice(0, 10).forEach(addService);

  description = titles.length
    ? `Website knowledge scraped from ${sourceDomain || normalizedUrl}. Main page topics: ${titles.join("; ")}.`
    : `Website knowledge scraped from ${sourceDomain || normalizedUrl}.`;
  runtimeProfile = inferredTopics.length
    ? `${description} High-signal terms from the selected website content: ${inferredTopics.join(", ")}.`
    : description;

  return {
    industry,
    description,
    runtimeProfile,
    services: services.slice(0, 20),
    titles,
    sourceDomain,
  };
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function isLikelyBinaryUrl(url) {
  return /\.(png|jpe?g|gif|webp|svg|pdf|zip|rar|7z|mp4|mov|mp3|wav|css|js|woff2?|ttf|ico)(\?|$)/i.test(
    String(url || ""),
  );
}

function sitemapCandidates(url) {
  const root = rootUrl(url);
  return [
    `${root}/robots.txt`,
    `${root}/sitemap.xml`,
    `${root}/sitemap_index.xml`,
    `${root}/wp-sitemap.xml`,
    `${root}/product-sitemap.xml`,
    `${root}/page-sitemap.xml`,
    `${root}/post-sitemap.xml`,
    `${root}/collections-sitemap.xml`,
    `${root}/products-sitemap.xml`,
  ];
}

async function fetchText(
  url,
  {
    accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    timeoutMs = FETCH_TIMEOUT_MS,
  } = {},
) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: accept,
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const text = await res.text();
  return {
    text,
    status: res.status,
    finalUrl: res.url || url,
    contentType: res.headers.get("content-type") || "",
  };
}

async function fetchJson(url, opts = {}) {
  const { text } = await fetchText(url, {
    accept: "application/json,text/javascript,*/*;q=0.8",
    timeoutMs: opts.timeoutMs || FETCH_TIMEOUT_MS,
  });
  return JSON.parse(text);
}

async function fetchViaJina(url) {
  const target = `https://r.jina.ai/${normalizeUrl(url).replace(/^https?:\/\//, "")}`;
  const { text } = await fetchText(target, {
    accept: "text/plain",
    timeoutMs: 26000,
  });
  const cleaned = cleanText(text);
  if (cleaned.length < 100) throw new Error("Jina returned too little content");
  return {
    text,
    title: titleFromUrl(url),
    links: extractUrls(text).filter((u) => sameHost(u, url)),
  };
}

function extractUrls(text) {
  return Array.from(
    new Set(
      (String(text || "").match(/https?:\/\/[^\s)\]"'<>{}]+/gi) || []).map(
        (u) => normalizeUrl(u.replace(/[.,;:!?]+$/, "")),
      ),
    ),
  ).filter(Boolean);
}

function parseSitemapLocs(xml) {
  const locs = [];
  try {
    const $ = cheerio.load(xml, { xmlMode: true });
    $("loc").each((_i, el) => {
      const loc = normalizeUrl($(el).text());
      if (loc) locs.push(loc);
    });
  } catch (_) {}
  if (!locs.length) {
    const re = /<loc>\s*([^<]+)\s*<\/loc>/gi;
    let m;
    while ((m = re.exec(String(xml || "")))) {
      const loc = normalizeUrl(m[1]);
      if (loc) locs.push(loc);
    }
  }
  return uniqueBy(locs, (x) => x);
}

async function discoverSitemapUrls(baseUrl) {
  const discoveredSitemaps = [];
  const urls = [];

  for (const candidate of sitemapCandidates(baseUrl)) {
    try {
      const { text } = await fetchText(candidate, {
        accept: "text/plain,application/xml,text/xml,*/*;q=0.8",
        timeoutMs: 10000,
      });
      if (candidate.endsWith("/robots.txt")) {
        for (const line of String(text).split(/\r?\n/)) {
          const match = line.match(/^\s*Sitemap:\s*(\S+)/i);
          if (match) discoveredSitemaps.push(normalizeUrl(match[1]));
        }
      } else {
        discoveredSitemaps.push(candidate);
        urls.push(...parseSitemapLocs(text));
      }
    } catch (_) {}
  }

  const sitemapQueue = uniqueBy(discoveredSitemaps, (x) => x).slice(0, 20);
  for (const sm of sitemapQueue) {
    try {
      const { text } = await fetchText(sm, {
        accept: "application/xml,text/xml,*/*;q=0.8",
        timeoutMs: 14000,
      });
      const locs = parseSitemapLocs(text).filter((u) => sameHost(u, baseUrl));
      const nested = locs.filter((u) =>
        /sitemap.*\.xml(\?|$)|\.xml(\?|$)/i.test(u),
      );
      const pages = locs.filter((u) => !/\.xml(\?|$)/i.test(u));
      urls.push(...pages);
      for (const n of nested.slice(0, 20)) {
        if (!sitemapQueue.includes(n)) sitemapQueue.push(n);
      }
    } catch (_) {}
    if (urls.length >= MAX_SITEMAP_URLS) break;
  }

  return uniqueBy(urls, (x) => x)
    .filter((u) => sameHost(u, baseUrl) && !isLikelyBinaryUrl(u))
    .slice(0, MAX_SITEMAP_URLS);
}

function scoreUrl(url) {
  const s = String(url || "").toLowerCase();
  let score = 0;
  if (/\/products?\//.test(s)) score += 80;
  if (/\/collections?\//.test(s)) score += 45;
  if (/\/shop\b|\/store\b|\/catalog\b/.test(s)) score += 40;
  if (/price|pricing|plans|packages/.test(s)) score += 35;
  if (
    /faq|help|support|shipping|delivery|refund|return|terms|privacy|policy/.test(
      s,
    )
  )
    score += 30;
  if (/about|contact|location|news|blog/.test(s)) score += 20;
  if (/\?|#/.test(s)) score -= 10;
  if (/account|cart|checkout|login|register|wishlist|search/.test(s))
    score -= 70;
  return score;
}

function prioritizeUrls(baseUrl, urls) {
  return uniqueBy(
    [normalizeUrl(baseUrl), ...(urls || []).map(normalizeUrl)],
    (x) => x,
  )
    .filter((u) => u && sameHost(u, baseUrl) && !isLikelyBinaryUrl(u))
    .sort((a, b) => scoreUrl(b) - scoreUrl(a))
    .slice(0, MAX_PAGES);
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function flattenJsonLd(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, out);
    return out;
  }
  if (typeof value !== "object") return out;
  out.push(value);
  if (value["@graph"]) flattenJsonLd(value["@graph"], out);
  if (value.mainEntity) flattenJsonLd(value.mainEntity, out);
  if (value.itemListElement) flattenJsonLd(value.itemListElement, out);
  return out;
}

function hasType(obj, type) {
  const raw = obj?.["@type"] || obj?.type;
  if (Array.isArray(raw))
    return raw.some((x) => String(x).toLowerCase() === type);
  return String(raw || "").toLowerCase() === type;
}

function firstValue(value) {
  if (Array.isArray(value)) return firstValue(value[0]);
  if (value && typeof value === "object") {
    if (value["@id"]) return value["@id"];
    if (value.url) return value.url;
    if (value.name) return value.name;
    return "";
  }
  return cleanText(value);
}

function normalizeCurrency(value) {
  return cleanText(value).toUpperCase().slice(0, 8);
}

function parsePriceNumber(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  const match = raw.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

function normalizeAvailability(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  const last = raw.split("/").filter(Boolean).pop() || raw;
  return last.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function offerFromProduct(product) {
  const offers = Array.isArray(product.offers)
    ? product.offers
    : product.offers
      ? [product.offers]
      : [];
  const offer = offers[0] || {};
  return {
    price: offer.price || offer.lowPrice || offer.highPrice || product.price,
    priceCurrency:
      offer.priceCurrency || product.priceCurrency || product.currency,
    availability: offer.availability || product.availability,
  };
}

function productFromJsonLd(item, pageUrl) {
  const offer = offerFromProduct(item);
  const name = cleanText(item.name || item.headline);
  if (!name) return null;
  const brand = firstValue(item.brand);
  const image = firstValue(item.image);
  const url = normalizeUrl(item.url || pageUrl);
  const price = parsePriceNumber(offer.price);
  const currency = normalizeCurrency(offer.priceCurrency);
  const priceText = offer.price
    ? `${currency ? `${currency} ` : ""}${cleanText(offer.price)}`.trim()
    : "";
  return {
    name,
    url,
    description: cleanText(item.description),
    price,
    priceText,
    currency,
    availability: normalizeAvailability(offer.availability),
    brand,
    sku: cleanText(
      item.sku || item.mpn || item.gtin || item.gtin13 || item.gtin14,
    ),
    imageUrl: normalizeUrl(image) || "",
    variants: [],
    rawSource: "json_ld_product",
    metadata: { jsonLdType: item["@type"] || "Product" },
  };
}

function extractJsonLdProducts($, pageUrl) {
  const products = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).contents().text() || $(el).html() || "";
    const parsed = safeParseJson(raw.trim());
    const nodes = flattenJsonLd(parsed);
    for (const node of nodes) {
      if (hasType(node, "product")) {
        const product = productFromJsonLd(node, pageUrl);
        if (product) products.push(product);
      }
    }
  });
  return products;
}

function extractMetaProduct($, pageUrl, title) {
  const name =
    cleanText($('meta[property="og:title"]').attr("content")) ||
    cleanText($("h1").first().text()) ||
    title;
  const price =
    cleanText($('meta[property="product:price:amount"]').attr("content")) ||
    cleanText($('[itemprop="price"]').first().attr("content")) ||
    cleanText($('[itemprop="price"]').first().text());
  if (!name || !price) return [];
  const currency =
    normalizeCurrency(
      $('meta[property="product:price:currency"]').attr("content"),
    ) ||
    normalizeCurrency($('[itemprop="priceCurrency"]').first().attr("content"));
  return [
    {
      name,
      url: pageUrl,
      description:
        cleanText($('meta[property="og:description"]').attr("content")) ||
        cleanText($('meta[name="description"]').attr("content")),
      price: parsePriceNumber(price),
      priceText: `${currency ? `${currency} ` : ""}${price}`.trim(),
      currency,
      availability: normalizeAvailability(
        $('[itemprop="availability"]').first().attr("href"),
      ),
      brand: "",
      sku: cleanText($('[itemprop="sku"]').first().text()),
      imageUrl:
        normalizeUrl($('meta[property="og:image"]').attr("content")) || "",
      variants: [],
      rawSource: "html_meta_product",
      metadata: {},
    },
  ];
}

function extractTextFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const title =
    cleanText($("title").first().text()) ||
    cleanText($("h1").first().text()) ||
    titleFromUrl(pageUrl);
  const products = [
    ...extractJsonLdProducts($, pageUrl),
    ...extractMetaProduct($, pageUrl, title),
  ];
  const links = [];
  $("a[href]").each((_i, el) => {
    const href = cleanText($(el).attr("href"));
    const label = cleanText($(el).text());
    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:")
    )
      return;
    try {
      const abs = normalizeUrl(new URL(href, pageUrl).toString());
      if (abs && sameHost(abs, pageUrl) && !isLikelyBinaryUrl(abs)) {
        links.push({ label: label || titleFromUrl(abs), url: abs });
      }
    } catch (_) {}
  });

  $("script, style, noscript, svg, canvas, iframe, form").remove();
  const pieces = [];
  $("body")
    .find("h1,h2,h3,h4,h5,h6,p,li,dt,dd,th,td,a,button,span,div")
    .each((_i, el) => {
      const content = cleanText($(el).text());
      if (content.length > 18) pieces.push(content);
    });
  let text = uniqueBy(pieces, (x) => x.toLowerCase()).join("\n");
  const linkText = uniqueBy(links, (l) => l.url)
    .slice(0, 120)
    .map((l) => `Link: ${l.label} - ${l.url}`)
    .join("\n");
  if (linkText)
    text += `\n\nWebsite links discovered on this page:\n${linkText}`;
  return {
    title,
    text: text.replace(/\n{3,}/g, "\n\n").trim(),
    links: uniqueBy(links, (l) => l.url).map((l) => l.url),
    products,
    platformSignals: detectPlatformSignals(html, pageUrl),
  };
}

function detectPlatformSignals(html, pageUrl) {
  const text = String(html || "").toLowerCase();
  const signals = [];
  if (
    text.includes("shopify") ||
    text.includes("/cdn/shop/") ||
    text.includes("shopify-section")
  )
    signals.push("shopify");
  if (
    text.includes("woocommerce") ||
    text.includes("wc-block") ||
    text.includes("/wp-content/plugins/woocommerce")
  )
    signals.push("woocommerce");
  if (text.includes("wp-content") || text.includes("wp-json"))
    signals.push("wordpress");
  if (/\/products?\//i.test(pageUrl)) signals.push("product-page");
  return uniqueBy(signals, (x) => x);
}

async function fetchPage(url) {
  const normalized = normalizeUrl(url);
  try {
    const { text: html } = await fetchText(normalized);
    const parsed = extractTextFromHtml(html, normalized);
    if (cleanText(parsed.text).length < 100)
      throw new Error("Page returned too little text content");
    return parsed;
  } catch (rawErr) {
    if (process.env.SCRAPER_VERBOSE_LOGS === "true") {
      console.warn(
        "[scraper-v2] raw fetch failed, trying Jina:",
        normalized,
        rawErr.message,
      );
    }
    const viaJina = await fetchViaJina(normalized);
    return {
      title: viaJina.title || titleFromUrl(normalized),
      text: viaJina.text,
      links: viaJina.links || [],
      products: [],
      platformSignals: ["jina_fallback"],
    };
  }
}

function extractShopifyHandle(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("products");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1].replace(/\.js$/i, "");
  } catch (_) {}
  return "";
}

function productFromShopify(raw, sourceUrl) {
  if (!raw || !raw.title) return null;
  const variants = Array.isArray(raw.variants)
    ? raw.variants.map((v) => {
        const price = parsePriceNumber(v.price);
        return {
          id: v.id ? String(v.id) : "",
          title: cleanText(v.title),
          sku: cleanText(v.sku),
          available: v.available === true,
          price,
          priceText: cleanText(v.price),
          option1: cleanText(v.option1),
          option2: cleanText(v.option2),
          option3: cleanText(v.option3),
        };
      })
    : [];
  const firstVariant = variants.find((v) => v.priceText) || variants[0] || {};
  const priceText = firstVariant.priceText || cleanText(raw.price);
  const handle = cleanText(raw.handle) || extractShopifyHandle(sourceUrl);
  const url =
    sourceUrl || (handle ? `${rootUrl(sourceUrl)}/products/${handle}` : "");
  return {
    name: cleanText(raw.title),
    url: normalizeUrl(url),
    description: cleanText(raw.description || raw.body_html),
    price: parsePriceNumber(priceText),
    priceText,
    currency: "",
    availability: variants.some((v) => v.available) ? "In stock" : "",
    brand: cleanText(raw.vendor),
    sku: cleanText(firstVariant.sku),
    imageUrl: normalizeUrl(raw.featured_image || raw.images?.[0]) || "",
    variants,
    rawSource: "shopify_ajax_product",
    metadata: { handle, productType: raw.type || raw.product_type || "" },
  };
}

async function fetchShopifyProducts(baseUrl, knownUrls = []) {
  const products = [];
  const handles = uniqueBy(
    (knownUrls || []).map(extractShopifyHandle).filter(Boolean),
    (x) => x,
  ).slice(0, MAX_PRODUCT_PAGES);
  for (const handle of handles) {
    try {
      const url = `${rootUrl(baseUrl)}/products/${handle}.js`;
      const raw = await fetchJson(url, { timeoutMs: 12000 });
      const product = productFromShopify(
        raw,
        `${rootUrl(baseUrl)}/products/${handle}`,
      );
      if (product) products.push(product);
    } catch (_) {}
  }

  // Many Shopify themes also expose a public collection JSON feed. This is opportunistic;
  // product.js by handle remains the primary Shopify Ajax extraction path.
  try {
    const feed = await fetchJson(
      `${rootUrl(baseUrl)}/products.json?limit=250`,
      { timeoutMs: 15000 },
    );
    const rawProducts = Array.isArray(feed?.products) ? feed.products : [];
    for (const raw of rawProducts.slice(0, MAX_PRODUCTS)) {
      const handle = cleanText(raw.handle);
      const product = productFromShopify(
        raw,
        handle ? `${rootUrl(baseUrl)}/products/${handle}` : baseUrl,
      );
      if (product)
        products.push({ ...product, rawSource: "shopify_products_json" });
    }
  } catch (_) {}

  return uniqueProducts(products).slice(0, MAX_PRODUCTS);
}

function productFromWoo(raw, baseUrl) {
  if (!raw || !raw.name) return null;
  const priceHtml = cleanText(
    String(raw.price_html || "").replace(/<[^>]+>/g, " "),
  );
  const prices = raw.prices || {};
  const minorUnit = Number(prices.currency_minor_unit || 2);
  const rawPrice = prices.price || prices.regular_price || prices.sale_price;
  const price = rawPrice
    ? Number(rawPrice) /
      Math.pow(10, Number.isFinite(minorUnit) ? minorUnit : 2)
    : parsePriceNumber(priceHtml);
  const currency = normalizeCurrency(prices.currency_code || "");
  const priceText = price
    ? `${currency ? `${currency} ` : ""}${price.toFixed(Math.max(0, Math.min(minorUnit || 2, 4)))}`
    : priceHtml;
  const images = Array.isArray(raw.images) ? raw.images : [];
  return {
    name: cleanText(raw.name),
    url: normalizeUrl(
      raw.permalink || raw.url || `${rootUrl(baseUrl)}/?p=${raw.id}`,
    ),
    description: cleanText(
      String(raw.short_description || raw.description || "").replace(
        /<[^>]+>/g,
        " ",
      ),
    ),
    price: Number.isFinite(price) ? price : null,
    priceText,
    currency,
    availability:
      raw.is_in_stock === false
        ? "Out of stock"
        : raw.is_in_stock === true
          ? "In stock"
          : "",
    brand: cleanText(raw.brands?.[0]?.name || ""),
    sku: cleanText(raw.sku),
    imageUrl: normalizeUrl(images[0]?.src || ""),
    variants: [],
    rawSource: "woocommerce_store_api",
    metadata: {
      id: raw.id || null,
      categories: Array.isArray(raw.categories)
        ? raw.categories.map((c) => c.name).filter(Boolean)
        : [],
      averageRating: raw.average_rating || "",
    },
  };
}

async function fetchWooCommerceProducts(baseUrl) {
  const products = [];
  for (let page = 1; page <= 3; page += 1) {
    try {
      const endpoint = `${rootUrl(baseUrl)}/wp-json/wc/store/v1/products?per_page=100&page=${page}`;
      const raw = await fetchJson(endpoint, { timeoutMs: 14000 });
      if (!Array.isArray(raw) || !raw.length) break;
      for (const item of raw) {
        const product = productFromWoo(item, baseUrl);
        if (product) products.push(product);
      }
      if (raw.length < 100) break;
    } catch (_) {
      break;
    }
  }
  return uniqueProducts(products).slice(0, MAX_PRODUCTS);
}

function uniqueProducts(products) {
  return uniqueBy(
    (products || []).filter((p) => cleanText(p.name)),
    (p) =>
      `${normalizeUrl(p.url) || p.name.toLowerCase()}|${cleanText(p.sku).toLowerCase()}|${cleanText(p.priceText)}`,
  );
}

function productToFactText(product) {
  const lines = [`Product: ${product.name}`];
  if (product.priceText || product.price)
    lines.push(`Price: ${product.priceText || product.price}`);
  if (
    product.currency &&
    !String(product.priceText || "").includes(product.currency)
  )
    lines.push(`Currency: ${product.currency}`);
  if (product.availability) lines.push(`Availability: ${product.availability}`);
  if (product.sku) lines.push(`SKU: ${product.sku}`);
  if (product.brand) lines.push(`Brand: ${product.brand}`);
  if (product.url) lines.push(`Product URL: ${product.url}`);
  if (product.description)
    lines.push(`Description: ${compactSummary(product.description, 900)}`);
  const variants = Array.isArray(product.variants)
    ? product.variants
        .filter((v) => v.title || v.priceText || v.sku)
        .slice(0, 18)
    : [];
  if (variants.length) {
    lines.push("Variants:");
    for (const v of variants) {
      const bits = [
        v.title,
        v.sku ? `SKU ${v.sku}` : "",
        v.priceText ? `Price ${v.priceText}` : "",
        v.available === false ? "Unavailable" : "",
      ].filter(Boolean);
      lines.push(`- ${bits.join("; ")}`);
    }
  }
  return lines.join("\n");
}

function chunkText(text, sourceUrl, sourceTitle, kind = "page") {
  const words = String(text || "")
    .split(/\s+/)
    .filter(Boolean);
  const chunks = [];
  let i = 0;
  let idx = 0;
  while (i < words.length && chunks.length < MAX_CHUNKS) {
    const slice = words
      .slice(i, i + CHUNK_SIZE)
      .join(" ")
      .trim();
    if (slice.length > 40) {
      chunks.push({
        content: slice,
        chunkIndex: idx,
        sourceUrl,
        sourceTitle,
        kind,
      });
    }
    idx += 1;
    i += Math.max(60, CHUNK_SIZE - CHUNK_OVERLAP);
  }
  return chunks;
}

// --- Page content_kind classification ---------------------------------------
// General (all-tenant, ingestion-time) heuristic for pages that describe a
// specific product/service in plain prose rather than structured JSON-LD/
// Shopify/WooCommerce data (which already get kind="product" via
// productChunks()). Those plain pages previously always fell back to the
// generic "page" kind, which meant search_knowledge_chunks' product-content
// tie-break bonus never applied to them even though they were exactly the
// kind of content customers ask about (e.g. a blog-style "Vitamin K2 + D3
// Supplement" page). Runs once per page at scrape time; cheap regex checks,
// no extra network/LLM calls.
const PRODUCT_URL_PATTERN = /\/(products?|shop|store|item|sku)(\/|-|$)/i;
const COMMERCE_KEYWORD_PATTERN =
  /\b(add to cart|add to bag|buy now|in stock|out of stock|checkout|free shipping|subscribe\s*&?\s*save|sku)\b/i;
const PRICE_PATTERN = /[$£€]\s?\d+(?:[.,]\d{2})?/;
const FAQ_URL_PATTERN = /\/(faq|faqs|help-center|help|support)(\/|-|$)/i;
const CONTACT_URL_PATTERN =
  /\/(contact|contact-us|reach-us|get-in-touch)(\/|-|$)/i;
const POLICY_URL_PATTERN =
  /\/(privacy|terms|tos|shipping-policy|return-policy|refund-policy|policies|returns?|refunds?)(\/|-|$)/i;
const ABOUT_URL_PATTERN =
  /\/(about|about-us|our-story|team|who-we-are)(\/|-|$)/i;

function classifyPageKind(text = "", url = "", title = "") {
  const haystack = `${title || ""} ${String(text || "").slice(0, 4000)}`;
  const lowerUrl = String(url || "").toLowerCase();
  const hasProductUrl = PRODUCT_URL_PATTERN.test(lowerUrl);
  const hasCommerceKeyword = COMMERCE_KEYWORD_PATTERN.test(haystack);
  const hasPrice = PRICE_PATTERN.test(haystack);

  if (hasProductUrl && (hasCommerceKeyword || hasPrice)) return "product";
  if (hasProductUrl || hasCommerceKeyword || hasPrice) return "product_fact";
  if (FAQ_URL_PATTERN.test(lowerUrl)) return "faq_page";
  if (CONTACT_URL_PATTERN.test(lowerUrl)) return "contact";
  if (POLICY_URL_PATTERN.test(lowerUrl)) return "policy";
  if (ABOUT_URL_PATTERN.test(lowerUrl)) return "about";
  return "page";
}

function productChunks(products) {
  return (products || []).map((p, idx) => ({
    content: productToFactText(p),
    chunkIndex: idx,
    sourceUrl: p.url || "",
    sourceTitle: p.name,
    kind: "product",
  }));
}

async function scrapeWebsiteV2(
  normalizedUrl,
  onProgress = null,
  { singlePage = false } = {},
) {
  const pageFailures = [];
  const pageWarnings = [];
  let home;
  try {
    home = await fetchPage(normalizedUrl);
  } catch (error) {
    pageFailures.push({ url: normalizedUrl, reason: error });
    throw error;
  }

  const sitemapUrls = singlePage
    ? []
    : await discoverSitemapUrls(normalizedUrl);
  const homeLinks = singlePage
    ? []
    : uniqueBy(
        [...(home.links || []), ...extractUrls(home.text)],
        (x) => x,
      ).filter((u) => sameHost(u, normalizedUrl));
  const productLikeUrls = singlePage
    ? []
    : uniqueBy([...sitemapUrls, ...homeLinks], (x) => x)
        .filter((u) => /\/products?\/|\/product\//i.test(u))
        .slice(0, MAX_PRODUCT_PAGES);

  const pageUrls = singlePage
    ? []
    : prioritizeUrls(normalizedUrl, [
        ...homeLinks,
        ...sitemapUrls,
        ...productLikeUrls,
      ]);
  const attemptedUrls = uniqueBy(
    [normalizedUrl, ...pageUrls.filter((u) => u !== normalizedUrl)].slice(
      0,
      MAX_PAGES,
    ),
    (x) => x,
  );
  const progressPages = attemptedUrls.map((pageUrl, index) => ({
    url: pageUrl,
    title:
      index === 0 ? home.title || titleFromUrl(pageUrl) : titleFromUrl(pageUrl),
    status: index === 0 ? "completed" : "queued",
    percent: index === 0 ? 100 : 0,
    error: "",
  }));
  const emitProgress = async (phase, currentUrl = null) => {
    if (typeof onProgress !== "function") return;
    const completed = progressPages.filter(
      (item) => item.status === "completed",
    ).length;
    const failed = progressPages.filter(
      (item) => item.status === "failed",
    ).length;
    const processed = completed + failed;
    const overallPercent = progressPages.length
      ? Math.round((processed / progressPages.length) * 100)
      : 0;
    await onProgress({
      phase,
      currentUrl,
      pagesDetected: progressPages.length,
      pagesCompleted: completed,
      pagesFailed: failed,
      overallPercent,
      pages: progressPages.map((item) => ({ ...item })),
      updatedAt: new Date().toISOString(),
    });
  };
  await emitProgress("discovered", normalizedUrl);

  const pages = [
    {
      url: normalizedUrl,
      title: home.title || titleFromUrl(normalizedUrl),
      text: home.text,
      products: home.products || [],
      platformSignals: home.platformSignals || [],
    },
  ];
  if (String(home.text || "").length > 45000) {
    pageWarnings.push({
      url: normalizedUrl,
      reason: "Large page was compacted before storage.",
    });
  }

  for (const pageUrl of pageUrls.filter((u) => u !== normalizedUrl)) {
    const progressItem = progressPages.find((item) => item.url === pageUrl);
    if (progressItem) {
      progressItem.status = "fetching";
      progressItem.percent = 35;
      progressItem.error = "";
    }
    await emitProgress("fetching", pageUrl);
    try {
      const p = await fetchPage(pageUrl);
      if (progressItem) {
        progressItem.status = "processing";
        progressItem.percent = 75;
        progressItem.title = p.title || progressItem.title;
      }
      await emitProgress("processing", pageUrl);
      pages.push({
        url: pageUrl,
        title: p.title || titleFromUrl(pageUrl),
        text: p.text,
        products: p.products || [],
        platformSignals: p.platformSignals || [],
      });
      if (String(p.text || "").length > 45000) {
        pageWarnings.push({
          url: pageUrl,
          reason: "Large page was compacted before storage.",
        });
      }
      if (progressItem) {
        progressItem.status = "completed";
        progressItem.percent = 100;
      }
    } catch (e) {
      pageFailures.push({ url: pageUrl, reason: e });
      if (progressItem) {
        progressItem.status = "failed";
        progressItem.percent = 100;
        progressItem.error = e?.message || String(e);
      }
      if (process.env.SCRAPER_VERBOSE_LOGS === "true") {
        console.warn("[scraper-v2] skipped linked page:", pageUrl, e.message);
      }
    }
    await emitProgress("page_complete", pageUrl);
    if (pages.length >= MAX_PAGES) break;
  }

  const signals = uniqueBy(
    pages.flatMap((p) => p.platformSignals || []),
    (x) => x,
  );
  const [shopifyProducts, wooProducts] = singlePage
    ? [[], []]
    : await Promise.all([
        fetchShopifyProducts(normalizedUrl, [
          ...pageUrls,
          ...productLikeUrls,
        ]).catch(() => []),
        fetchWooCommerceProducts(normalizedUrl).catch(() => []),
      ]);

  const products = uniqueProducts([
    ...pages.flatMap((p) => p.products || []),
    ...shopifyProducts,
    ...wooProducts,
  ]).slice(0, MAX_PRODUCTS);

  const strategyParts = ["scraper-v2"];
  if (sitemapUrls.length) strategyParts.push("sitemap");
  if (signals.includes("shopify") || shopifyProducts.length)
    strategyParts.push("shopify");
  if (signals.includes("woocommerce") || wooProducts.length)
    strategyParts.push("woocommerce");
  if (products.length) strategyParts.push("structured-products");
  if (signals.includes("jina_fallback")) strategyParts.push("jina-fallback");

  return {
    pages,
    products,
    pageFailures,
    pageWarnings,
    attemptedUrls,
    discoveredUrls: pageUrls.length,
    sitemapUrls: sitemapUrls.length,
    strategy: strategyParts.join("+"),
    platformSignals: signals,
    progressPages,
  };
}

function isMissingTableError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  return (
    error?.code === "42P01" ||
    msg.includes("does not exist") ||
    msg.includes("schema cache") ||
    msg.includes("could not find the table")
  );
}

async function safeUpdateSource(db, organizationId, sourceId, updates) {
  if (!sourceId) return;
  const finalUpdates = { ...(updates || {}) };
  if (finalUpdates.metadata && typeof finalUpdates.metadata === "object") {
    try {
      const { data: existing } = await db
        .from("knowledge_sources")
        .select("metadata")
        .eq("id", sourceId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      finalUpdates.metadata = {
        ...(existing?.metadata && typeof existing.metadata === "object"
          ? existing.metadata
          : {}),
        ...finalUpdates.metadata,
      };
    } catch (_) {}
  }
  const { error } = await db
    .from("knowledge_sources")
    .update({ ...finalUpdates, updated_at: new Date().toISOString() })
    .eq("id", sourceId)
    .eq("organization_id", organizationId);
  if (error)
    console.warn("[scraper-v2] failed to update source:", error.message);
}

async function safeUpdateBase(db, organizationId, knowledgeBaseId, updates) {
  if (!knowledgeBaseId) return;
  const finalUpdates = { ...(updates || {}) };
  if (finalUpdates.metadata && typeof finalUpdates.metadata === "object") {
    try {
      const { data: existing } = await db
        .from("knowledge_bases")
        .select("metadata")
        .eq("id", knowledgeBaseId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      finalUpdates.metadata = {
        ...(existing?.metadata && typeof existing.metadata === "object"
          ? existing.metadata
          : {}),
        ...finalUpdates.metadata,
      };
    } catch (_) {}
  }
  const { error } = await db
    .from("knowledge_bases")
    .update({ ...finalUpdates, updated_at: new Date().toISOString() })
    .eq("id", knowledgeBaseId)
    .eq("organization_id", organizationId);
  if (error)
    console.warn(
      "[scraper-v2] failed to update knowledge base:",
      error.message,
    );
}

async function saveProducts(
  db,
  {
    organizationId,
    knowledgeBaseId,
    knowledgeSourceId,
    products,
    replaceExisting = true,
  },
) {
  if (!knowledgeBaseId) return 0;
  try {
    let deleteQuery = db
      .from("scraped_products")
      .delete()
      .eq("organization_id", organizationId)
      .eq("knowledge_base_id", knowledgeBaseId);
    if (knowledgeSourceId) {
      deleteQuery = deleteQuery.eq("knowledge_source_id", knowledgeSourceId);
    } else {
      deleteQuery = deleteQuery.is("knowledge_source_id", null);
    }
    if (!replaceExisting) {
      const urls = [
        ...new Set(products.map((product) => product.url).filter(Boolean)),
      ];
      if (urls.length) deleteQuery = deleteQuery.in("url", urls);
      else deleteQuery = null;
    }
    if (deleteQuery) await deleteQuery;
    if (!products.length) return 0;

    const rows = products.map((p) => ({
      organization_id: organizationId,
      knowledge_base_id: knowledgeBaseId,
      knowledge_source_id: knowledgeSourceId || null,
      name: p.name,
      slug: (() => {
        try {
          return (
            new URL(p.url).pathname.split("/").filter(Boolean).pop() || null
          );
        } catch (_) {
          return null;
        }
      })(),
      url: p.url || null,
      description: p.description || "",
      price: p.price,
      price_text: p.priceText || "",
      currency: p.currency || "",
      availability: p.availability || "",
      brand: p.brand || "",
      sku: p.sku || "",
      image_url: p.imageUrl || "",
      variants: Array.isArray(p.variants) ? p.variants : [],
      raw_source: p.rawSource || "scraper_v2",
      content_hash: hashText(
        `${p.name}|${p.url}|${p.priceText}|${p.description}`,
      ),
      metadata: p.metadata || {},
    }));

    const BATCH = 50;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await db
        .from("scraped_products")
        .insert(rows.slice(i, i + BATCH));
      if (error) throw error;
      inserted += rows.slice(i, i + BATCH).length;
    }
    return inserted;
  } catch (e) {
    if (isMissingTableError(e)) {
      console.warn(
        "[scraper-v2] scraped_products table missing; product facts were still saved as chunks.",
      );
      return 0;
    }
    throw e;
  }
}

async function scrapeAndStore({
  url,
  chatbotId = null,
  organizationId,
  voiceAgentId = null,
  knowledgeBaseId = null,
  knowledgeSourceId = null,
  singlePage = false,
  replaceExisting = true,
  deferFinalStatus = false,
  usageGroupId = null,
  usageMetadata = null,
}) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) throw new Error("A valid website URL is required.");
  if (!organizationId)
    throw new Error("organizationId is required for scraping.");

  const db = getSupabase();
  await safeUpdateSource(db, organizationId, knowledgeSourceId, {
    scrape_status: "scraping",
    last_error: null,
  });
  await safeUpdateBase(db, organizationId, knowledgeBaseId, {
    sync_status: "scraping",
  });

  const syncStartedAt = Date.now();

  try {
    const result = await scrapeWebsiteV2(
      normalizedUrl,
      async (progress) => {
        await safeUpdateSource(db, organizationId, knowledgeSourceId, {
          scrape_status: "scraping",
          metadata: {
            scraperVersion: "scraper-v2",
            scrapeProgress: progress,
          },
        });
      },
      { singlePage },
    );
    const pageChunks = [];
    for (const p of result.pages) {
      const kind = classifyPageKind(p.text, p.url, p.title);
      pageChunks.push(...chunkText(p.text, p.url, p.title, kind));
    }
    const facts = productChunks(result.products);
    const chunks = uniqueBy([...facts, ...pageChunks], (c) =>
      hashText(`${c.sourceUrl}|${c.content}`),
    ).slice(0, MAX_CHUNKS);

    if (!chunks.length) throw new Error("No usable content found at that URL.");

    let deleteQuery = db
      .from("knowledge_chunks")
      .delete()
      .eq("organization_id", organizationId);
    if (knowledgeBaseId)
      deleteQuery = deleteQuery.eq("knowledge_base_id", knowledgeBaseId);
    if (knowledgeSourceId)
      deleteQuery = deleteQuery.eq("knowledge_source_id", knowledgeSourceId);
    if (chatbotId) deleteQuery = deleteQuery.eq("chatbot_id", chatbotId);
    if (!chatbotId && voiceAgentId)
      deleteQuery = deleteQuery.eq("voice_agent_id", voiceAgentId);
    if (!replaceExisting) {
      // Selective worker jobs append one chosen page at a time. Replace only
      // this page's prior chunks instead of erasing the whole Knowledge Base.
      deleteQuery = deleteQuery.eq("source_url", normalizedUrl);
    }
    const { error: deleteError } = await deleteQuery;
    if (deleteError)
      console.warn(
        "[scraper-v2] failed to delete old chunks:",
        deleteError.message,
      );

    const rows = chunks.map((c, index) => {
      const content = c.content.slice(0, 8000);
      const row = {
        organization_id: organizationId,
        chatbot_id: chatbotId || null,
        voice_agent_id: voiceAgentId || null,
        source_url: c.sourceUrl || normalizedUrl,
        source_title:
          c.sourceTitle || titleFromUrl(c.sourceUrl || normalizedUrl),
        content,
        chunk_index: index,
        content_hash: hashText(content),
        token_count: tokenCount(content),
        compact_summary: compactSummary(content),
        metadata: {
          scraperVersion: "scraper-v2",
          contentKind: c.kind || "page",
          strategy: result.strategy,
        },
      };
      if (knowledgeBaseId) row.knowledge_base_id = knowledgeBaseId;
      if (knowledgeSourceId) row.knowledge_source_id = knowledgeSourceId;
      return row;
    });

    const BATCH = 25;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await db
        .from("knowledge_chunks")
        .insert(rows.slice(i, i + BATCH));
      if (error) throw new Error(`Failed to save chunks: ${error.message}`);
    }

    const productsStored = await saveProducts(db, {
      organizationId,
      knowledgeBaseId,
      knowledgeSourceId,
      products: result.products,
      replaceExisting,
    });

    const contentHash = hashText(rows.map((r) => r.content_hash).join("|"));
    const now = new Date().toISOString();
    const scrapeReport = buildScrapeReport({
      pages: result.pages,
      pageFailures: result.pageFailures,
      pageWarnings: result.pageWarnings,
      attemptedUrls: result.attemptedUrls,
      discoveredUrls: result.discoveredUrls,
      products: result.products,
      chunksStored: rows.length,
      productsStored,
      strategy: result.strategy,
    });
    if (!deferFinalStatus) {
      await safeUpdateSource(db, organizationId, knowledgeSourceId, {
        scrape_status: rows.length ? "completed" : "failed",
        scrape_strategy: result.strategy,
        last_scraped_at: now,
        page_count: result.pages.length,
        chunk_count: rows.length,
        product_count: result.products.length,
        content_hash: contentHash,
        last_error: scrapeReport.pagesFailed
          ? `${scrapeReport.pagesFailed} page(s) could not be scraped. Review sync details.`
          : null,
        metadata: {
          scraperVersion: "scraper-v2",
          discoveredUrls: result.discoveredUrls,
          sitemapUrls: result.sitemapUrls,
          platformSignals: result.platformSignals,
          productsStored,
          scrapeReport,
          scrapeProgress: {
            phase: "completed",
            currentUrl: null,
            pagesDetected: result.attemptedUrls.length,
            pagesCompleted: result.pages.length,
            pagesFailed: scrapeReport.pagesFailed || 0,
            overallPercent: 100,
            pages: result.progressPages || [],
            updatedAt: now,
          },
        },
      });
      const inferredProfile = inferBusinessProfileFromScrape(
        result,
        normalizedUrl,
      );
      const baseUpdates = {
        sync_status: "completed",
        last_synced_at: now,
        metadata: {
          scraperVersion: "scraper-v2",
          runtimeProfile: inferredProfile.runtimeProfile,
          services: inferredProfile.services,
          keyTopics: inferredProfile.titles,
          inferredFromScrapeAt: now,
        },
      };
      if (inferredProfile.description)
        baseUpdates.description = inferredProfile.description;
      if (inferredProfile.industry)
        baseUpdates.industry = inferredProfile.industry;
      await safeUpdateBase(db, organizationId, knowledgeBaseId, baseUpdates);
    }

    const storageBytes = Buffer.byteLength(
      JSON.stringify({ chunks: rows, products: result.products, scrapeReport }),
      "utf8",
    );
    try {
      await logKnowledgeSyncUsage({
        organizationId,
        knowledgeBaseId,
        knowledgeSourceId,
        pagesAttempted:
          scrapeReport.pagesAttempted ||
          result.attemptedUrls.length ||
          result.pages.length,
        pagesScraped: result.pages.length,
        pagesFailed: scrapeReport.pagesFailed || 0,
        chunksStored: rows.length,
        productsStored,
        faqsStored: 0,
        storageBytes,
        durationMs: Date.now() - syncStartedAt,
        externalId:
          usageGroupId ||
          `${knowledgeSourceId || knowledgeBaseId || normalizedUrl}:sync:${contentHash}`,
        metadata: {
          url: normalizedUrl,
          strategy: result.strategy,
          scraperVersion: "scraper-v2",
          content_hash: contentHash,
          ...(usageMetadata && typeof usageMetadata === "object"
            ? usageMetadata
            : {}),
        },
      });
    } catch (billingErr) {
      console.warn(
        "[scraper-v2] billing meter skipped:",
        billingErr.message || String(billingErr),
      );
    }

    return {
      success: true,
      text: result.pages.map((page) => page.text || "").join("\n\n"),
      chunksStored: rows.length,
      pagesScraped: result.pages.length,
      pagesDiscovered: result.discoveredUrls,
      productsFound: result.products.length,
      productsStored,
      scrapeReport,
      knowledgeBaseId: knowledgeBaseId || null,
      knowledgeSourceId: knowledgeSourceId || null,
      strategy: result.strategy,
    };
  } catch (e) {
    const failureReport = buildScrapeReport({
      pages: [],
      pageFailures: [{ url: normalizedUrl, reason: e }],
      attemptedUrls: [normalizedUrl],
      chunksStored: 0,
      productsStored: 0,
      strategy: "scraper-v2",
    });
    if (!deferFinalStatus)
      await safeUpdateSource(db, organizationId, knowledgeSourceId, {
        scrape_status: "failed",
        last_error: e.message || String(e),
        metadata: {
          scraperVersion: "scraper-v2",
          scrapeReport: failureReport,
          scrapeProgress: {
            phase: "failed",
            currentUrl: normalizedUrl,
            pagesDetected: 1,
            pagesCompleted: 0,
            pagesFailed: 1,
            overallPercent: 100,
            pages: [
              {
                url: normalizedUrl,
                title: titleFromUrl(normalizedUrl),
                status: "failed",
                percent: 100,
                error: e.message || String(e),
              },
            ],
            updatedAt: new Date().toISOString(),
          },
        },
      });
    if (!deferFinalStatus) {
      await safeUpdateBase(db, organizationId, knowledgeBaseId, {
        sync_status: "failed",
      });
    }
    throw e;
  }
}

module.exports = { scrapeAndStore };
