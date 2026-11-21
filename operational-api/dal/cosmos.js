// Cosmos DB handlers: key lookups and semantic search. One client per store, created lazily.
const { CosmosClient } = require("@azure/cosmos");

const clients = new Map();

function containerFor(store, op, ctx) {
  const endpoint = ctx.setting(store.endpointSetting);
  if (!clients.has(endpoint)) {
    clients.set(endpoint, new CosmosClient({ endpoint, aadCredentials: ctx.credential }));
  }
  return clients.get(endpoint).database(store.database).container(op.container);
}

function pick(doc, fields) {
  return Object.fromEntries(fields.filter((f) => f in doc).map((f) => [f, doc[f]]));
}

// id == partition key value by design (see the Part 3 load), so this is a ~1 RU point read.
async function pointRead(op, store, args, ctx) {
  const key = args[op.key];
  const { resource, requestCharge } = await containerFor(store, op, ctx).item(key, key).read();
  if (!resource) return { status: 404, body: { error: `No ${op.container} entry for ${op.key} '${key}'` } };
  return { body: pick(resource, op.fields), meta: { ru: requestCharge } };
}

// Field names are interpolated from the registry only (never from callers); user text goes in parameters.
async function semanticSearch(op, store, args, ctx) {
  const q = String(args.q || "").trim();
  if (!q) return { status: 400, body: { error: "q is required" } };
  const top = Math.min(Math.max(parseInt(args.top, 10) || 5, 1), op.maxTop);
  const mode = args.mode === "hybrid" ? "hybrid" : op.defaultMode;

  const vector = await ctx.embed(op.embeddingStore, q);
  const select = op.fields.map((f) => `c.${f}`).join(", ");
  let query;
  const parameters = [{ name: "@v", value: vector }];
  if (mode === "hybrid") {
    // FullTextScore takes literal terms; keep only safe word characters from the user's text.
    const terms = [...new Set(q.toLowerCase().match(/[a-z0-9]{3,}/g) || [])].slice(0, 8);
    if (!terms.length) return semanticSearch(op, store, { ...args, mode: "vector" }, ctx);
    const termList = terms.map((t) => `"${t}"`).join(", ");
    query = `SELECT TOP ${top} ${select} FROM c ORDER BY RANK RRF(VectorDistance(c.${op.vectorField}, @v), FullTextScore(c.${op.textField}, ${termList}))`;
  } else {
    query = `SELECT TOP ${top} ${select}, VectorDistance(c.${op.vectorField}, @v) AS similarity FROM c ORDER BY VectorDistance(c.${op.vectorField}, @v)`;
  }
  const { resources, requestCharge } = await containerFor(store, op, ctx).items.query({ query, parameters }).fetchAll();
  return { body: { mode, results: resources }, meta: { ru: requestCharge } };
}

module.exports = { pointRead, semanticSearch };
