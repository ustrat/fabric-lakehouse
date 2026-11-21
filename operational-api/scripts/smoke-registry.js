// Smoke test: invoke every registry operation directly (no Express, no APIM) as the `az login` user.
// Usage (from operational-api/):  node scripts/smoke-registry.js [--skip-agent]
require("./dev-settings");
const { DefaultAzureCredential } = require("@azure/identity");
const { createDal } = require("../dal");
const { poolFor } = require("../dal/sql");

const credential = new DefaultAzureCredential();
const dal = createDal({ credential });
const skipAgent = process.argv.includes("--skip-agent");
const FULL = { full: true };

async function run(name, args, ctx = { access: FULL }) {
  const out = await dal.invoke(name, args, ctx);
  console.log(`\n=== ${name} ${JSON.stringify(args)} -> ${out.status}`);
  console.log(JSON.stringify(out.body, null, 2).slice(0, 1200));
  console.log("meta:", JSON.stringify(out.meta));
  return out;
}

(async () => {
  console.log("Tools exposed to AI:", dal.toolDefinitions().map((t) => t.name).join(", "));
  const search = await run("search_products", { q: "something to block out noise on a long flight", top: 3 });
  const first = search.body.results?.[0];
  if (first) {
    await run("get_product_rating", { productId: first.productId });
    await run("get_product_insights", { productId: first.productId });
  }
  await run("get_product_rating", { productId: "does-not-exist" });
  const trends = await run("get_rating_trends", { category: "laptops" });

  // KPI registry tools.
  await run("list_metrics", {});
  await run("describe_metric", { metric: "avgStars" });
  await run("query_metric", { metrics: ["avgStars", "reviewCount"], groupBy: ["priceBand"] });
  await run("query_metric", { metrics: ["avgStars"], groupBy: ["currentPrice"] }); // expect 400: not an allowed dimension

  // Drift checks: the same registry metric must give the same number from every store that serves it.
  const drift = [];
  const check = (label, a, b) => {
    const ok = a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;
    console.log(`${ok ? "OK  " : "DRIFT"} ${label}: ${a} vs ${b}`);
    if (!ok) drift.push(label);
  };
  if (first) {
    const rating = await dal.invoke("get_product_rating", { productId: first.productId }, { access: FULL });
    const sqlRow = (await dal.invoke("query_metric", {
      metrics: ["avgStars", "reviewCount"], filters: [{ dimension: "productId", op: "eq", value: first.productId }],
    }, { access: FULL })).body.rows?.[0];
    check(`avgStars for ${rating.body.productName} (Cosmos vs gold)`, rating.body.avgStars, sqlRow?.avgStars);
    check(`reviewCount for ${rating.body.productName} (Cosmos vs gold)`, rating.body.reviewCount, sqlRow?.reviewCount);
    if (rating.meta.registryMismatch) drift.push(`Cosmos ProductSummary: ${rating.meta.registryMismatch}`);
    const insights = await dal.invoke("get_product_insights", { productId: first.productId }, { access: FULL });
    if (insights.status === 200 && insights.meta.registryMismatch) drift.push(`Cosmos ProductInsights: ${insights.meta.registryMismatch}`);
  }
  // Independent recomputation straight from the review rows (not via the gold table or the registry compiler).
  const pool = await poolFor({ serverSetting: "LAKEHOUSE_SQL_SERVER", database: "retail_ai_lh" }, { credential, setting: (n) => process.env[n] });
  const { recordset: raw } = await pool.request().query(`
    SELECT p.categoryName, p.priceBand, CAST(ROUND(CAST(SUM(r.stars) AS float) / COUNT(*), 2) AS decimal(18,2)) AS avgStars
    FROM dbo.vw_reviews r JOIN dbo.vw_products p ON p.productId = r.productId
    GROUP BY p.categoryName, p.priceBand`);
  const rawBy = new Map(raw.map((r) => [`${r.categoryName}|${r.priceBand}`, r.avgStars]));
  for (const row of trends.body.rows || []) {
    check(`avgStars ${row.categoryName}/${row.priceBand} (registry vs raw reviews)`, row.avgStars, rawBy.get(`${row.categoryName}|${row.priceBand}`));
  }
  if (drift.length) { console.error(`\n${drift.length} drift problem(s):\n  ${drift.join("\n  ")}`); process.exitCode = 1; }

  if (!skipAgent) {
    // Cache behaviour: live, exact repeat, paraphrase, different meaning, different access scope.
    await run("ask_data", { question: "What's the average rating of premium products?" });
    await run("ask_data", { question: "What's the average rating of premium products?" });
    await run("ask_data", { question: "what is the average rating for premium products" });
    await run("ask_data", { question: "What's the average rating of standard products?" });
    await run("ask_data", { question: "What's the average rating of premium products?" }, { access: { full: false, groups: ["test-group"] } });
  }
  process.exit(process.exitCode || 0);
})();
