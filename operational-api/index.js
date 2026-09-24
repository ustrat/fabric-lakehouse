const crypto = require("crypto");
const express = require("express");
const { CosmosClient } = require("@azure/cosmos");
const { DefaultAzureCredential, getBearerTokenProvider } = require("@azure/identity");
const { AzureOpenAI } = require("openai");

const PORT = process.env.PORT || 8080;
const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT || "https://bc836f6d-54c1-43a9-b890-87cdb4428a90.zbc.sql.cosmos.fabric.microsoft.com:443/";
const DATABASE_NAME = "operational_db";
const FULL_CONTAINER = "supply_chain_dashboard";
const RESTRICTED_CONTAINER = "supply_chain_dashboard_restricted";
const OPENAI_ENDPOINT = process.env.OPENAI_ENDPOINT || "https://ustrat-ai-foundry.openai.azure.com/";
const OPENAI_DEPLOYMENT = process.env.OPENAI_DEPLOYMENT || "gpt-5-mini";

// Resolved by App Service from a Key Vault reference; APIM injects the same value on every request.
const BACKEND_SHARED_SECRET = process.env.BACKEND_SHARED_SECRET;

// Auth, CORS and the restricted/full decision all happen in APIM. This service only accepts
// traffic proving it came through APIM, and trusts APIM's x-data-scope header for container choice.
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

const credential = new DefaultAzureCredential();
const database = new CosmosClient({ endpoint: COSMOS_ENDPOINT, aadCredentials: credential }).database(DATABASE_NAME);
const containers = {
  full: database.container(FULL_CONTAINER),
  restricted: database.container(RESTRICTED_CONTAINER),
};

// Anything other than an explicit "full" gets the restricted container, so a missing or
// mangled header fails closed rather than exposing everything.
function containerFor(req) {
  return req.headers["x-data-scope"] === "full" ? containers.full : containers.restricted;
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

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/indicators", requireGateway, async (req, res) => {
  try {
    const { resources } = await containerFor(req).items.readAll().fetchAll();
    res.json(resources);
  } catch (err) {
    console.error("Failed to read indicators:", err.message);
    res.status(502).json({ error: "Failed to read indicators", detail: err.message });
  }
});

app.get("/api/indicators/:seriesId", requireGateway, async (req, res) => {
  const { seriesId } = req.params;
  try {
    const { resource } = await containerFor(req).item(seriesId, seriesId).read();
    if (!resource) {
      return res.status(404).json({ error: `No indicator found for series_id '${seriesId}'` });
    }
    res.json(resource);
  } catch (err) {
    if (err.code === 404) {
      return res.status(404).json({ error: `No indicator found for series_id '${seriesId}'` });
    }
    console.error("Failed to read indicator:", err.message);
    res.status(502).json({ error: "Failed to read indicator", detail: err.message });
  }
});

app.post("/api/chat", requireGateway, async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Request body must include a 'message' string" });
  }

  try {
    const { resources } = await containerFor(req).items.readAll().fetchAll();
    const context = resources
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
