// Semantic answer cache for slow operations (ask_data).
// A cached answer is reused only when ALL of these hold:
//   - same access scope (callers with different row-level access never share answers)
//   - same data version (a gold refresh writes a new version, which invalidates everything)
//   - the new question is near-identical in meaning (cosine similarity >= threshold)
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");

const SYSTEM_PK = "_system";
const VERSION_DOC = "dataVersion";
const VERSION_TTL_MS = 5 * 60 * 1000;

function createCache({ store, cacheCfg, ctx }) {
  const container = new CosmosClient({ endpoint: ctx.setting(store.endpointSetting), aadCredentials: ctx.credential })
    .database(store.database)
    .container(cacheCfg.container);
  let version = { value: null, fetchedAt: 0 };

  async function dataVersion() {
    if (version.value && Date.now() - version.fetchedAt < VERSION_TTL_MS) return version.value;
    try {
      const { resource } = await container.item(VERSION_DOC, SYSTEM_PK).read();
      version = { value: resource?.version || "unversioned", fetchedAt: Date.now() };
    } catch (err) {
      if (!version.value) throw err;
    }
    return version.value;
  }

  // Scope = the caller's effective row-level access. Full-access callers share one scope;
  // restricted callers share only with others holding exactly the same restricted groups.
  function scopeFor(access) {
    if (!access || access.full) return "all";
    const groups = [...access.groups].sort().join(",");
    return "g:" + crypto.createHash("sha256").update(groups).digest("hex").slice(0, 16);
  }

  const normalize = (q) => q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

  async function lookup({ operation, question, access }) {
    const scope = scopeFor(access);
    const ver = await dataVersion();
    const vector = await ctx.embed(cacheCfg.embeddingStore, normalize(question));
    const { resources } = await container.items.query({
      query:
        "SELECT TOP 1 c.question, c.answer, c.createdAt, VectorDistance(c.questionEmbedding, @v) AS similarity " +
        "FROM c WHERE c.scope = @scope AND c.operation = @op AND c.dataVersion = @ver " +
        "ORDER BY VectorDistance(c.questionEmbedding, @v)",
      parameters: [
        { name: "@v", value: vector },
        { name: "@scope", value: scope },
        { name: "@op", value: operation },
        { name: "@ver", value: ver },
      ],
    }, { partitionKey: scope }).fetchAll();
    const best = resources[0];
    const hit = best && best.similarity >= cacheCfg.similarityThreshold;
    return { hit, entry: hit ? best : null, nearest: best?.similarity ?? null, vector, scope, ver };
  }

  async function save({ operation, question, answer, lookupResult }) {
    const { vector, scope, ver } = lookupResult;
    await container.items.upsert({
      id: crypto.createHash("sha256").update(`${scope}|${operation}|${normalize(question)}|${ver}`).digest("hex"),
      scope,
      operation,
      question,
      answer,
      dataVersion: ver,
      questionEmbedding: vector,
      createdAt: new Date().toISOString(),
      ttl: cacheCfg.ttlSeconds,
    });
  }

  return { lookup, save };
}

module.exports = { createCache, SYSTEM_PK, VERSION_DOC };
