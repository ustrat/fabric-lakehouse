// Smoke test: invoke every registry operation directly (no Express, no APIM) as the `az login` user.
// Usage (from operational-api/):  node scripts/smoke-registry.js
const { DefaultAzureCredential } = require("@azure/identity");

const DEFAULTS = {
  RETAIL_COSMOS_ENDPOINT: "https://ae268e38-3ca9-4db0-815c-2c9c808d346b.zae.sql.cosmos.fabric.microsoft.com",
  LAKEHOUSE_SQL_SERVER: "y5u6pmp4pc4u5i3rfqkmxtahv4-c6xygue5dr6e7nvi2fqsm4mu7e.datawarehouse.fabric.microsoft.com",
  RETAIL_DATA_AGENT_MCP_URL:
    "https://api.fabric.microsoft.com/v1/mcp/workspaces/5083af17-1c9d-4f7c-b6a8-d161267194f9/dataagents/3848e9c0-b9bb-456c-b2f2-81887323da94/agent",
  OPENAI_ENDPOINT: "https://ustrat-ai-foundry.openai.azure.com/",
  EMBEDDING_DEPLOYMENT: "text-embedding-3-small",
  DATA_AGENT_DEV_CREDENTIAL: "1",
};
for (const [k, v] of Object.entries(DEFAULTS)) process.env[k] ??= v;

const { createDal } = require("../dal");
const dal = createDal({ credential: new DefaultAzureCredential() });
const skipAgent = process.argv.includes("--skip-agent");

async function run(name, args) {
  const out = await dal.invoke(name, args);
  console.log(`\n=== ${name} ${JSON.stringify(args)} -> ${out.status}`);
  console.log(JSON.stringify(out.body, null, 2).slice(0, 1500));
  console.log("meta:", JSON.stringify(out.meta));
  return out;
}

(async () => {
  console.log("Tools exposed to AI:", dal.toolDefinitions().map((t) => t.name).join(", "));
  const search = await run("search_products", { q: "something to block out noise on a long flight", top: 3 });
  const first = search.body.results?.[0];
  if (first) await run("get_product_rating", { productId: first.productId });
  await run("get_product_rating", { productId: "does-not-exist" });
  await run("get_rating_trends", { category: "laptops" });
  if (!skipAgent) await run("ask_data", { question: "What's the average rating of premium products?" });
  process.exit(0);
})();
