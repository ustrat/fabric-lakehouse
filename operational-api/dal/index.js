// Data access layer: loads the registry and dispatches each operation to its store handler.
// The same invoke() backs both the REST routes (React app) and the AI tool endpoints.
const { AzureOpenAI } = require("openai");
const { getBearerTokenProvider } = require("@azure/identity");
const registry = require("../registry/operations.json");
const cosmos = require("./cosmos");
const sql = require("./sql");
const dataAgent = require("./dataAgent");

const HANDLERS = {
  "cosmos.pointRead": cosmos.pointRead,
  "cosmos.semanticSearch": cosmos.semanticSearch,
  "sql.namedQuery": sql.namedQuery,
  "dataAgent.ask": dataAgent.ask,
};

const operations = new Map(registry.operations.map((op) => [op.name, op]));

// Fail at startup, not on the first request, if the registry and the code disagree.
for (const op of operations.values()) {
  if (!HANDLERS[op.handler]) throw new Error(`Registry operation '${op.name}' uses unknown handler '${op.handler}'`);
  if (!registry.stores[op.store]) throw new Error(`Registry operation '${op.name}' uses unknown store '${op.store}'`);
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
      const out = await HANDLERS[op.handler](op, registry.stores[op.store], args, ctx);
      return { status: out.status || 200, body: out.body, meta: { operation: name, store: op.store, ms: Date.now() - t0, ...out.meta } };
    } catch (err) {
      console.error(`Operation ${name} failed:`, err.message);
      return { status: err.status || 502, body: { error: `${name} failed`, detail: err.message } };
    }
  }

  // OpenAI/Foundry function-tool format, generated from the same registry the routes use.
  function toolDefinitions() {
    return [...operations.values()].map((op) => ({
      type: "function",
      name: op.name,
      description: op.definition ? `${op.description} Definition: ${op.definition}` : op.description,
      parameters: op.parameters,
    }));
  }

  return { invoke, toolDefinitions, operations: [...operations.values()] };
}

module.exports = { createDal };
