// Precompute "what customers say" per product, so the app and AI read it in ~ms instead of
// having an agent summarize review text live (~30 s).
//
// Accuracy design - the model never counts and never writes quotes:
//   1. SQL groups identical review texts and counts them (reviewsWithThisText).
//   2. The model only assigns each distinct text (by index) to a short theme label.
//   3. Code validates every index is used exactly once, then builds counts and verbatim quotes itself.
//   4. A new dataVersion is written last, which invalidates the semantic answer cache.
//
// Run after the gold refresh (schedule alongside the gold notebook).
// Usage (from operational-api/):  node jobs/precompute-insights.js [--limit N] [--stale]
//   --stale  only redo products with no doc, a different registry hash, or changed KPI values (e.g. after 429s).
require("../scripts/dev-settings");
const { CosmosClient } = require("@azure/cosmos");
const { DefaultAzureCredential, getBearerTokenProvider } = require("@azure/identity");
const { AzureOpenAI } = require("openai");
const { poolFor } = require("../dal/sql");

const credential = new DefaultAzureCredential();
const setting = (n) => process.env[n] || (() => { throw new Error(`Missing setting ${n}`); })();
const db = new CosmosClient({ endpoint: setting("RETAIL_COSMOS_ENDPOINT"), aadCredentials: credential }).database("retail_cosmos");
const insights = db.container("ProductInsights");
const answerCache = db.container("AnswerCache");
const chat = new AzureOpenAI({
  endpoint: setting("OPENAI_ENDPOINT"),
  apiVersion: "2025-04-01-preview",
  maxRetries: 8, // backs off on 429 using the Retry-After header
  azureADTokenProvider: getBearerTokenProvider(credential, "https://cognitiveservices.azure.com/.default"),
});
const MODEL = setting("CHAT_DEPLOYMENT");
const SENTIMENTS = new Set(["complaint", "praise", "mixed"]);
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > 0 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;
const STALE_ONLY = process.argv.includes("--stale");

const SYSTEM = `You group customer reviews of ONE product into themes.
Return JSON only: {"themes":[{"label":"<max 6 words>","sentiment":"complaint|praise|mixed","reviews":[<indices>]}]}
Rules:
- Every review index appears in exactly one theme.
- Labels describe only what the review text literally says. Do not infer issues that are not written.
- "mixed" = the same text both criticizes and praises.
- Use as few themes as the text supports.`;

async function labelThemes(product) {
  const lines = product.texts.map((t, i) => `[${i}] (x${t.n}) ${t.text}`).join("\n");
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await chat.chat.completions.create({
      model: MODEL,
      reasoning_effort: "minimal",
      response_format: { type: "json_object" },
      max_completion_tokens: 1200,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `Product: ${product.productName}\n${lines}` }],
    });
    try {
      const themes = JSON.parse(res.choices[0].message.content).themes;
      const seen = themes.flatMap((t) => t.reviews);
      const valid = Array.isArray(themes) && themes.every((t) => t.label && SENTIMENTS.has(t.sentiment) && Array.isArray(t.reviews))
        && seen.length === product.texts.length && new Set(seen).size === seen.length
        && seen.every((i) => Number.isInteger(i) && i >= 0 && i < product.texts.length);
      if (valid) return { themes, validated: true };
      console.warn(`  ${product.productName}: invalid theme assignment (attempt ${attempt})`);
    } catch {
      console.warn(`  ${product.productName}: unparseable model output (attempt ${attempt})`);
    }
  }
  // Fallback keeps the data correct: one unlabeled theme containing every verbatim text.
  return { themes: [{ label: "Unclassified reviews", sentiment: "mixed", reviews: product.texts.map((_, i) => i) }], validated: false };
}

function buildDoc(product, labeled, version) {
  const themes = labeled.themes.map((t) => {
    const quotes = t.reviews.map((i) => product.texts[i]).sort((a, b) => b.n - a.n)
      .map((q) => ({ text: q.text, count: q.n, stars: q.stars }));
    return { label: t.label, sentiment: t.sentiment, count: quotes.reduce((s, q) => s + q.count, 0), quotes };
  }).sort((a, b) => b.count - a.count);
  const total = themes.reduce((s, t) => s + t.count, 0);
  if (total !== product.reviewCount) throw new Error(`count mismatch for ${product.productId}: ${total} vs ${product.reviewCount}`);
  const top = themes[0];
  return {
    id: product.productId,
    productId: product.productId,
    productName: product.productName,
    reviewCount: product.reviewCount,
    avgStars: product.avgStars,
    // KPI values are copied from gold, so the doc carries gold's registry stamp.
    registryVersion: product.registryVersion,
    registryHash: product.registryHash,
    themes,
    // Deterministic summary (no model text): built from the counted themes.
    summary: `${top.count} of ${total} reviews: "${top.label}" (${top.sentiment}).`,
    themesValidated: labeled.validated,
    model: MODEL,
    generatedAt: new Date().toISOString(),
    dataVersion: version,
  };
}

async function mapLimit(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

(async () => {
  const t0 = Date.now();
  const version = new Date().toISOString();
  const pool = await poolFor({ serverSetting: "LAKEHOUSE_SQL_SERVER", database: "retail_ai_lh" }, { credential, setting });

  const { recordset: rows } = await pool.request().query(`
    SELECT r.productId, r.reviewText, COUNT(*) AS n, STRING_AGG(CAST(r.stars AS varchar(10)), ',') AS stars
    FROM dbo.vw_reviews r
    GROUP BY r.productId, r.reviewText`);
  const { recordset: gold } = await pool.request().query(`
    SELECT productId, productName, reviewCount, avgStars, registryVersion, registryHash
    FROM dbo.gold_product_review_summary WHERE reviewCount > 0`);

  // SQL COUNT/bigint arrive as strings from the mssql driver; normalize before any arithmetic.
  const byProduct = new Map(gold.map((g) => [g.productId, {
    ...g, reviewCount: Number(g.reviewCount), avgStars: g.avgStars === null ? null : Number(g.avgStars), texts: [],
  }]));
  for (const r of rows) byProduct.get(r.productId)?.texts.push({ text: r.reviewText, n: Number(r.n), stars: r.stars });
  let products = [...byProduct.values()].filter((p) => p.texts.length);
  if (STALE_ONLY) {
    // Skip products whose doc already matches gold: same registry hash and the same KPI values.
    const { resources: docs } = await insights.items
      .query("SELECT c.productId, c.registryHash, c.reviewCount, c.avgStars FROM c").fetchAll();
    const current = new Map(docs.map((d) => [d.productId, d]));
    products = products.filter((p) => {
      const d = current.get(p.productId);
      return !d || d.registryHash !== p.registryHash || d.reviewCount !== p.reviewCount || d.avgStars !== p.avgStars;
    });
  }
  products = products.slice(0, LIMIT);
  console.log(`Products with reviews: ${products.length} (from ${rows.length} distinct review texts)`);

  let ok = 0, fallback = 0, failed = 0, ru = 0;
  await mapLimit(products, 3, async (p) => {
    try {
      const labeled = await labelThemes(p);
      const { requestCharge } = await insights.items.upsert(buildDoc(p, labeled, version));
      ru += requestCharge; labeled.validated ? ok++ : fallback++;
    } catch (err) {
      failed++; console.error(`  FAILED ${p.productName}: ${err.message}`);
    }
  });

  // Written last, and only if something changed: bumping the version invalidates every cached ask_data answer.
  if (ok + fallback > 0) {
    await answerCache.items.upsert({ id: "dataVersion", scope: "_system", version, updatedAt: version });
  }
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${ok} validated, ${fallback} fallback, ${failed} failed, ${ru.toFixed(0)} RU. dataVersion=${version}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
