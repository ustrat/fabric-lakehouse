// One-time (idempotent) creation of the containers the cache and precompute job need.
// Containers are infrastructure: created here, never by the API at runtime.
// Usage (from operational-api/):  node scripts/setup-containers.js
require("./dev-settings");
const { CosmosClient } = require("@azure/cosmos");
const { DefaultAzureCredential } = require("@azure/identity");

const db = new CosmosClient({ endpoint: process.env.RETAIL_COSMOS_ENDPOINT, aadCredentials: new DefaultAzureCredential() })
  .database("retail_cosmos");
const AUTOSCALE = { maxThroughput: 1000 }; // Fabric requires autoscale (set on the container body in the JS SDK)

(async () => {
  await db.containers.createIfNotExists({
    id: "AnswerCache",
    partitionKey: { paths: ["/scope"] },
    defaultTtl: -1, // TTL on, per-item `ttl` decides expiry; the _system version doc never expires
    vectorEmbeddingPolicy: {
      vectorEmbeddings: [{ path: "/questionEmbedding", dataType: "float32", dimensions: 1536, distanceFunction: "cosine" }],
    },
    indexingPolicy: {
      indexingMode: "consistent",
      automatic: true,
      includedPaths: [{ path: "/*" }],
      excludedPaths: [{ path: '/"_etag"/?' }, { path: "/questionEmbedding/*" }, { path: "/answer/*" }],
      vectorIndexes: [{ path: "/questionEmbedding", type: "quantizedFlat" }],
    },
    ...AUTOSCALE,
  });
  console.log("AnswerCache ready (pk /scope, vector /questionEmbedding, TTL on)");

  await db.containers.createIfNotExists({
    id: "ProductInsights",
    partitionKey: { paths: ["/productId"] },
    indexingPolicy: {
      indexingMode: "consistent",
      automatic: true,
      includedPaths: [{ path: "/*" }],
      excludedPaths: [{ path: '/"_etag"/?' }, { path: "/themes/*" }], // served by point read; no need to index quotes
    },
    ...AUTOSCALE,
  });
  console.log("ProductInsights ready (pk /productId)");
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
