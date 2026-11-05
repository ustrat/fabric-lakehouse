// Smoke test: invoke every registry operation directly (no Express, no APIM) as the `az login` user.
// Usage (from operational-api/):  node scripts/smoke-registry.js [--skip-agent]
require("./dev-settings");
const { DefaultAzureCredential } = require("@azure/identity");
const { createDal } = require("../dal");

const dal = createDal({ credential: new DefaultAzureCredential() });
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
  await run("get_rating_trends", { category: "laptops" });

  if (!skipAgent) {
    // Cache behaviour: live, exact repeat, paraphrase, different meaning, different access scope.
    await run("ask_data", { question: "What's the average rating of premium products?" });
    await run("ask_data", { question: "What's the average rating of premium products?" });
    await run("ask_data", { question: "what is the average rating for premium products" });
    await run("ask_data", { question: "What's the average rating of standard products?" });
    await run("ask_data", { question: "What's the average rating of premium products?" }, { access: { full: false, groups: ["test-group"] } });
  }
  process.exit(0);
})();
