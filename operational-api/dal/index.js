// Data access layer: loads the registry and dispatches each operation to its store handler.
// The same invoke() backs both the REST routes (React app) and the AI tool endpoints.
const { AzureOpenAI } = require("openai");
const { getBearerTokenProvider } = require("@azure/identity");
const registry = require("../registry/operations.json");
const cosmos = require("./cosmos");
const sql = require("./sql");
const dataAgent = require("./dataAgent");
const metrics = require("./metrics");
const kpi = require("../registry/kpi");
const { createCache } = require("./cache");

const HANDLERS = {
  "cosmos.pointRead": cosmos.pointRead,
  "cosmos.semanticSearch": cosmos.semanticSearch,
  "sql.namedQuery": sql.namedQuery,
  "dataAgent.ask": dataAgent.ask,
  "metrics.query": metrics.query,
  "metrics.list": metrics.listMetrics,
  "metrics.describe": metrics.describeMetric,
};

// Parameter schemas that are generated from the KPI registry instead of written by hand.
const GENERATED_SCHEMAS = { "kpi.querySchema": kpi.querySchema };

const operations = new Map(registry.operations.map((op) => [op.name, op]));

// Fail at startup, not on the first request, if the registry and the code disagree.
for (const op of operations.values()) {
  if (!HANDLERS[op.handler]) throw new Error(`Registry operation '${op.name}' uses unknown handler '${op.handler}'`);
  if (!registry.stores[op.store]) throw new Error(`Registry operation '${op.name}' uses unknown store '${op.store}'`);
  if (typeof op.parameters === "string") {
    if (!GENERATED_SCHEMAS[op.parameters]) throw new Error(`Registry operation '${op.name}' uses unknown schema '${op.parameters}'`);
    op.parameters = GENERATED_SCHEMAS[op.parameters]();
  }
  for (const id of op.metrics || []) {
    if (!kpi.describe(id)) throw new Error(`Registry operation '${op.name}' references unknown metric '${id}'`);
  }
  if (op.query) kpi.compileQuery(op.query); // a fixed query must compile against the KPI registry
}

function setting(name) {
  const value = process.env[name];
  if (!value) throw Object.assign(new Error(`App setting ${name} is not configured`), { status: 503 });
  return value;
}

function createDal({ credential }) {
  const embedClients = new Map();
  async function embed(storeName, text) {
    const store = registry.stores[storeName];
    if (!embedClients.has(storeName)) {
      embedClients.set(storeName, new AzureOpenAI({
        endpoint: setting(store.endpointSetting),
        deployment: setting(store.deploymentSetting),
        apiVersion: "2024-10-21",
        azureADTokenProvider: getBearerTokenProvider(credential, "https://cognitiveservices.azure.com/.default"),
      }));
    }
    const res = await embedClients.get(storeName).embeddings.create({ model: setting(store.deploymentSetting), input: text });
    return res.data[0].embedding;
  }

  const caches = new Map();
  function cacheFor(op, ctx) {
    if (!caches.has(op.name)) {
      caches.set(op.name, createCache({ store: registry.stores[op.cache.store], cacheCfg: op.cache, ctx }));
    }
    return caches.get(op.name);
  }

  function validate(op, args) {
    const missing = (op.parameters.required || []).filter((p) => args[p] === undefined || args[p] === "");
    return missing.length ? `Missing required parameter(s): ${missing.join(", ")}` : null;
  }

  // ctx: { userToken?, access? } from the request. Returns { status, body, meta }.
  async function invoke(name, args = {}, reqCtx = {}) {
    const op = operations.get(name);
    if (!op) return { status: 404, body: { error: `Unknown operation '${name}'` } };
    const problem = validate(op, args);
    if (problem) return { status: 400, body: { error: problem } };

    const ctx = { ...reqCtx, credential, setting, embed };
    const t0 = Date.now();
    try {
      // Semantic cache (registry: op.cache). Any cache failure falls through to a live call.
      let cached = null;
      const question = op.cache && String(args[op.cache.questionParam] || "");
      if (op.cache) {
        try {
          cached = await cacheFor(op, ctx).lookup({ operation: name, question, access: reqCtx.access });
          if (cached.hit) {
            return {
              status: 200,
              body: { ...cached.entry.answer, cachedFrom: { question: cached.entry.question, at: cached.entry.createdAt } },
              meta: { operation: name, store: op.cache.container, ms: Date.now() - t0, cache: "hit", similarity: cached.entry.similarity },
            };
          }
        } catch (err) {
          console.error(`Cache lookup for ${name} failed (serving live):`, err.message);
          cached = null;
        }
      }

      const out = await HANDLERS[op.handler](op, registry.stores[op.store], args, ctx);
      const status = out.status || 200;
      const meta = { operation: name, store: op.store, ms: Date.now() - t0, ...out.meta };
      // Every answer that carries a KPI says which registry definitions produced it. Precomputed docs
      // (Cosmos) report their own stamp; a stamp that differs from the API's registry is flagged, not hidden.
      if (op.metrics || op.query) {
        const stamped = out.body && "registryHash" in out.body;
        meta.registryVersion = stamped ? out.body.registryVersion : kpi.version;
        meta.registryHash = stamped ? out.body.registryHash : kpi.definitionHash;
        if (op.metrics && (!stamped || out.body.registryHash !== kpi.definitionHash)) {
          meta.registryMismatch = stamped ? `built from registry ${out.body.registryHash}, API uses ${kpi.definitionHash}` : "document has no registry stamp";
        }
      }
      if (op.cache) {
        meta.cache = cached ? "miss" : "bypass";
        if (cached) meta.nearestSimilarity = cached.nearest;
        if (cached && status === 200) {
          cacheFor(op, ctx).save({ operation: name, question, answer: out.body, lookupResult: cached })
            .catch((err) => console.error(`Cache save for ${name} failed:`, err.message));
        }
      }
      return { status, body: out.body, meta };
    } catch (err) {
      console.error(`Operation ${name} failed:`, err.message);
      return { status: err.status || 502, body: { error: `${name} failed`, detail: err.message } };
    }
  }

  // OpenAI/Foundry function-tool format, generated from the same registry the routes use.
  function toolDefinitions() {
    // Metric meanings come from the KPI registry, never from free text in operations.json.
    return [...operations.values()].map((op) => {
      const ids = op.metrics || op.query?.metrics || [];
      const parts = [op.description, ids.length && `Definitions: ${kpi.definitionText(ids)}`, op.note];
      return { type: "function", name: op.name, description: parts.filter(Boolean).join(" "), parameters: op.parameters };
    });
  }

  return { invoke, toolDefinitions, operations: [...operations.values()], registryVersion: kpi.version };
}

module.exports = { createDal };
