const crypto = require("crypto");
const express = require("express");
const { CosmosClient } = require("@azure/cosmos");
const { DefaultAzureCredential, getBearerTokenProvider } = require("@azure/identity");
const { AzureOpenAI } = require("openai");
const { createDal } = require("./dal");
const { createRetailRouter } = require("./retail/router");

const PORT = process.env.PORT || 8080;
const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT || "https://bc836f6d-54c1-43a9-b890-87cdb4428a90.zbc.sql.cosmos.fabric.microsoft.com:443/";
const DATABASE_NAME = "operational_db";
const DATA_CONTAINER = "supply_chain_dashboard";
const CONFIG_CONTAINER = "access_config";
const RESTRICTED_GROUPS_DOC = "restricted_groups";
const RESTRICTED_GROUPS_TTL_MS = 5 * 60 * 1000;
const OPENAI_ENDPOINT = process.env.OPENAI_ENDPOINT || "https://ustrat-ai-foundry.openai.azure.com/";
const OPENAI_DEPLOYMENT = process.env.OPENAI_DEPLOYMENT || "gpt-5-mini";

// Resolved by App Service from a Key Vault reference; APIM injects the same value on every request.
const BACKEND_SHARED_SECRET = process.env.BACKEND_SHARED_SECRET;

const credential = new DefaultAzureCredential();
const database = new CosmosClient({ endpoint: COSMOS_ENDPOINT, aadCredentials: credential }).database(DATABASE_NAME);
const dataContainer = database.container(DATA_CONTAINER);
const configContainer = database.container(CONFIG_CONTAINER);

// Row-level security is defined once, as OneLake data access roles on the Lakehouse. The sync
// notebook reads those roles, tags each row with the restricted groups allowed to see it
// (visible_to_groups), and writes the set of restricted groups here. Nothing is hardcoded in this service.
let restrictedGroupsCache = { groups: null, fetchedAt: 0 };

async function getRestrictedGroups() {
  if (restrictedGroupsCache.groups && Date.now() - restrictedGroupsCache.fetchedAt < RESTRICTED_GROUPS_TTL_MS) {
    return restrictedGroupsCache.groups;
  }
  try {
    const { resource } = await configContainer.item(RESTRICTED_GROUPS_DOC, RESTRICTED_GROUPS_DOC).read();
    if (!resource || !Array.isArray(resource.groups)) throw new Error("restricted_groups document missing or malformed");
    restrictedGroupsCache = { groups: new Set(resource.groups), fetchedAt: Date.now() };
  } catch (err) {
    // A stale list is still a restriction; only fail when there is nothing to enforce with.
    if (!restrictedGroupsCache.groups) throw err;
    console.error("Using stale restricted-group list:", err.message);
  }
  return restrictedGroupsCache.groups;
}

function requireGateway(req, res, next) {
  if (!BACKEND_SHARED_SECRET) {
    console.error("BACKEND_SHARED_SECRET is not configured - refusing all requests");
    return res.status(503).json({ error: "Service misconfigured" });
  }
  const provided = Buffer.from(req.headers["x-apim-secret"] || "");
  const expected = Buffer.from(BACKEND_SHARED_SECRET);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(403).json({ error: "Requests must come through the API gateway" });
  }
  next();
}

// APIM always sends x-caller-groups: "none", "overage", or a comma-separated list of group IDs.
// Resolves to req.access = { full: true } or { full: false, groups: [...] }.
async function resolveAccess(req, res, next) {
  const header = req.headers["x-caller-groups"];
  if (!header) {
    // Missing means the gateway policy isn't doing its job; refuse rather than default to full access.
    return res.status(403).json({ error: "Caller group information missing" });
  }
  if (header === "overage") {
    return res.status(403).json({ error: "Group membership too large to evaluate; contact an administrator" });
  }

  let restricted;
  try {
    restricted = await getRestrictedGroups();
  } catch (err) {
    console.error("Cannot load restricted groups:", err.message);
    return res.status(503).json({ error: "Access rules unavailable" });
  }

  const callerGroups = header === "none" ? [] : header.split(",").map((g) => g.trim()).filter(Boolean);
  const callerRestrictedGroups = callerGroups.filter((g) => restricted.has(g));
  req.access = callerRestrictedGroups.length ? { full: false, groups: callerRestrictedGroups } : { full: true };
  next();
}

const VISIBLE_TO_CALLER = "EXISTS(SELECT VALUE g FROM g IN c.visible_to_groups WHERE ARRAY_CONTAINS(@groups, g))";

async function queryIndicators(access, seriesId) {
  const conditions = [];
  const parameters = [];
  if (!access.full) {
    conditions.push(VISIBLE_TO_CALLER);
    parameters.push({ name: "@groups", value: access.groups });
  }
  if (seriesId) {
    conditions.push("c.id = @id");
    parameters.push({ name: "@id", value: seriesId });
  }
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const { resources } = await dataContainer.items.query({ query: `SELECT * FROM c${where}`, parameters }).fetchAll();
  return resources;
}

const azureADTokenProvider = getBearerTokenProvider(credential, "https://cognitiveservices.azure.com/.default");
const openaiClient = new AzureOpenAI({
  endpoint: OPENAI_ENDPOINT,
  azureADTokenProvider,
  apiVersion: "2024-10-21",
  deployment: OPENAI_DEPLOYMENT,
});

const app = express();
app.use(express.json());

// Retail operations routed by registry/operations.json (REST for the app + /api/retail/tools for AI).
app.use(createRetailRouter({ dal: createDal({ credential }), middleware: [requireGateway, resolveAccess] }));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/indicators", requireGateway, resolveAccess, async (req, res) => {
  try {
    res.json(await queryIndicators(req.access));
  } catch (err) {
    console.error("Failed to read indicators:", err.message);
    res.status(502).json({ error: "Failed to read indicators", detail: err.message });
  }
});

app.get("/api/indicators/:seriesId", requireGateway, resolveAccess, async (req, res) => {
  const { seriesId } = req.params;
  try {
    const [resource] = await queryIndicators(req.access, seriesId);
    if (!resource) {
      return res.status(404).json({ error: `No indicator found for series_id '${seriesId}'` });
    }
    res.json(resource);
  } catch (err) {
    console.error("Failed to read indicator:", err.message);
    res.status(502).json({ error: "Failed to read indicator", detail: err.message });
  }
});

app.post("/api/chat", requireGateway, resolveAccess, async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Request body must include a 'message' string" });
  }

  try {
    const context = (await queryIndicators(req.access))
      .map((r) => `- ${r.metric_name} (${r.series_id}): ${r.value} as of ${r.observation_date}, source ${r.source}`)
      .join("\n");

    const completion = await openaiClient.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "You are a supply chain analyst assistant. Answer using ONLY the current indicator data below - " +
            "do not use general knowledge for these figures, and say so plainly if the data doesn't cover the question.\n\n" +
            `Current indicator data:\n${context}`,
        },
        { role: "user", content: message },
      ],
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error("Chat request failed:", err.message);
    res.status(502).json({ error: "Chat request failed", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Operational API listening on port ${PORT}`);
});
