// Canned responses shaped exactly like the registry operations (body + _meta). Demo only.
const P = (productId, name, categoryName, currentPrice, priceBand, reviewCount, avgStars, description) => ({
  productId, name, categoryName, currentPrice, priceBand, reviewCount, avgStars, description,
});

const PRODUCTS = [
  P("a1f3c2d4-0001", "Nebula Wireless Headphones", "Headphones", 349.0, "premium", 3, 3.0, "over-ear noise cancelling travel"),
  P("a1f3c2d4-0002", "Drift Earbuds Pro", "Headphones", 179.0, "standard", 6, 4.33, "in-ear noise cancelling earbuds flight"),
  P("a1f3c2d4-0003", "Summit 14 Laptop", "Laptops", 1499.0, "premium", 5, 4.6, "lightweight laptop long battery"),
  P("a1f3c2d4-0004", "Atlas 15 Laptop", "Laptops", 899.0, "standard", 4, 3.75, "budget laptop students"),
  P("a1f3c2d4-0005", "Halo Smart Speaker", "Speakers", 129.0, "standard", 7, 4.14, "voice assistant speaker home"),
  P("a1f3c2d4-0006", "Orbit Travel Pillow", "Travel", 39.0, "standard", 2, 4.5, "neck pillow flight sleep"),
];

const INSIGHTS = {
  "a1f3c2d4-0001": [
    { label: "Price too high", sentiment: "complaint", quotes: [{ text: "Sound is great but not worth this price.", count: 2, stars: "3,3" }, { text: "Too expensive for what you get.", count: 1, stars: "3" }] },
  ],
  "a1f3c2d4-0002": [
    { label: "Noise cancelling works well", sentiment: "praise", quotes: [{ text: "Blocked out the engine noise on a 10 hour flight.", count: 3, stars: "5,5,4" }] },
    { label: "Battery drains quickly", sentiment: "complaint", quotes: [{ text: "Battery barely lasts four hours.", count: 2, stars: "3,4" }] },
    { label: "Comfortable but case is bulky", sentiment: "mixed", quotes: [{ text: "Comfortable fit, but the case is bulky.", count: 1, stars: "4" }] },
  ],
  "a1f3c2d4-0003": [
    { label: "Excellent battery life", sentiment: "praise", quotes: [{ text: "Easily lasts a full workday.", count: 4, stars: "5,5,5,4" }] },
    { label: "Runs warm under load", sentiment: "complaint", quotes: [{ text: "Gets hot when exporting video.", count: 1, stars: "4" }] },
  ],
};

const TRENDS = [
  { categoryName: "Headphones", priceBand: "premium", products: 1, reviews: 3, avgStars: 3.0 },
  { categoryName: "Laptops", priceBand: "standard", products: 1, reviews: 4, avgStars: 3.75 },
  { categoryName: "Speakers", priceBand: "standard", products: 1, reviews: 7, avgStars: 4.14 },
  { categoryName: "Headphones", priceBand: "standard", products: 1, reviews: 6, avgStars: 4.33 },
  { categoryName: "Travel", priceBand: "standard", products: 1, reviews: 2, avgStars: 4.5 },
  { categoryName: "Laptops", priceBand: "premium", products: 1, reviews: 5, avgStars: 4.6 },
];

const askCache = new Map();
const norm = (q) => q.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); });
});
const notFound = (msg) => Object.assign(new Error(msg), { status: 404, meta: {} });

export async function mockFetch(path, { method, body, signal }) {
  const url = new URL(path, "http://demo");
  const t0 = performance.now();
  let m;

  if (url.pathname === "/api/retail/products/search") {
    await wait(180, signal);
    const words = norm(url.searchParams.get("q") || "").split(" ").filter((w) => w.length > 2);
    const scored = PRODUCTS.map((p) => {
      const hay = `${p.name} ${p.categoryName} ${p.description}`.toLowerCase();
      const hits = words.filter((w) => hay.includes(w.slice(0, 5))).length;
      return { ...p, similarity: Math.min(0.92, 0.55 + hits * 0.09) };
    }).sort((a, b) => b.similarity - a.similarity);
    const top = parseInt(url.searchParams.get("top"), 10) || 5;
    return {
      data: { mode: url.searchParams.get("mode") || "vector", results: scored.slice(0, top).map(({ productId, name, categoryName, currentPrice, similarity }) => ({ productId, name, categoryName, currentPrice, similarity })) },
      meta: { operation: "search_products", store: "retailCosmos", ms: Math.round(performance.now() - t0), ru: 14.2 },
    };
  }

  if ((m = url.pathname.match(/^\/api\/retail\/products\/([^/]+)\/rating$/))) {
    await wait(40, signal);
    const p = PRODUCTS.find((x) => x.productId === m[1]);
    if (!p) throw notFound(`No ProductSummary entry for productId '${m[1]}'`);
    return {
      data: { productId: p.productId, productName: p.name, categoryName: p.categoryName, priceBand: p.priceBand, currentPrice: p.currentPrice, reviewCount: p.reviewCount, avgStars: p.avgStars, refreshedAt: "2026-11-05T14:00:00Z" },
      meta: { operation: "get_product_rating", store: "retailCosmos", ms: Math.round(performance.now() - t0), ru: 1 },
    };
  }

  if ((m = url.pathname.match(/^\/api\/retail\/products\/([^/]+)\/insights$/))) {
    await wait(45, signal);
    const p = PRODUCTS.find((x) => x.productId === m[1]);
    const themes = INSIGHTS[m[1]];
    if (!p || !themes) throw notFound(`No ProductInsights entry for productId '${m[1]}'`);
    const full = themes.map((t) => ({ ...t, count: t.quotes.reduce((s, q) => s + q.count, 0) })).sort((a, b) => b.count - a.count);
    return {
      data: { productId: p.productId, productName: p.name, reviewCount: p.reviewCount, avgStars: p.avgStars, themes: full, summary: `${full[0].count} of ${p.reviewCount} reviews: "${full[0].label}" (${full[0].sentiment}).`, generatedAt: "2026-11-05T14:05:00Z" },
      meta: { operation: "get_product_insights", store: "retailCosmos", ms: Math.round(performance.now() - t0), ru: 1 },
    };
  }

  if (url.pathname === "/api/retail/analytics/ratings") {
    await wait(420, signal);
    const c = (url.searchParams.get("category") || "").toLowerCase();
    return {
      data: { rows: TRENDS.filter((r) => !c || r.categoryName.toLowerCase().includes(c)) },
      meta: { operation: "get_rating_trends", store: "lakehouseSql", ms: Math.round(performance.now() - t0), sqlMs: 388, source: "dbo.gold_product_review_summary" },
    };
  }

  if (url.pathname === "/api/retail/ask" && method === "POST") {
    const key = norm(body.question);
    const hit = askCache.get(key);
    if (hit) {
      await wait(260, signal);
      return {
        data: { ...hit.answer, cachedFrom: { question: hit.question, at: hit.at } },
        meta: { operation: "ask_data", store: "AnswerCache", ms: Math.round(performance.now() - t0), cache: "hit", similarity: 0.98 },
      };
    }
    await wait(3200, signal); // the real agent takes ~8-30 s
    const about = body.question.match(/productId ([^)]+)\)/)?.[1];
    const p = PRODUCTS.find((x) => x.productId === about);
    const themes = p && INSIGHTS[p.productId];
    const answer = p ? {
      answer: themes
        ? `${p.name} has ${p.reviewCount} reviews averaging ${p.avgStars} stars. ` + themes.map((t) => `${t.quotes.reduce((s, q) => s + q.count, 0)} mention "${t.label.toLowerCase()}" (${t.sentiment})`).join("; ") + "."
        : `${p.name} has ${p.reviewCount} reviews averaging ${p.avgStars} stars. Review themes are not available for this product yet.`,
    } : {
      answer: "Premium products average 3.86 stars across 8 reviews; standard products average 4.15 stars across 19 reviews (weighted by review count). The lowest-rated premium product is Nebula Wireless Headphones (3.0 stars, 3 reviews), where all 3 reviews mention price.",
    };
    askCache.set(key, { answer, question: body.question, at: new Date().toISOString() });
    return {
      data: answer,
      meta: { operation: "ask_data", store: "retailDataAgent", ms: Math.round(performance.now() - t0), agentMs: Math.round(performance.now() - t0) - 120, cache: "miss", nearestSimilarity: 0.84 },
    };
  }

  if (url.pathname === "/api/indicators") {
    await wait(200, signal);
    return {
      data: Object.assign([
        { series_id: "GSCPI", metric_name: "Global Supply Chain Pressure Index", value: 0.31, observation_date: "2026-10-31", source: "NY Fed" },
        { series_id: "PPIACO", metric_name: "Producer Price Index: All Commodities", value: 262.4, observation_date: "2026-09-30", source: "FRED" },
      ]),
      meta: {},
    };
  }

  throw notFound(`Demo mode has no response for ${method} ${url.pathname}`);
}
