const express = require("express");
const cors = require("cors");
const { createRemoteJWKSet, jwtVerify } = require("jose");
const { CosmosClient } = require("@azure/cosmos");
const { DefaultAzureCredential, getBearerTokenProvider } = require("@azure/identity");
const { AzureOpenAI } = require("openai");

const PORT = process.env.PORT || 8080;
const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT || "https://bc836f6d-54c1-43a9-b890-87cdb4428a90.zbc.sql.cosmos.fabric.microsoft.com:443/";
const DATABASE_NAME = "operational_db";
const CONTAINER_NAME = "supply_chain_dashboard";
const OPENAI_ENDPOINT = process.env.OPENAI_ENDPOINT || "https://ustrat-ai-foundry.openai.azure.com/";
const OPENAI_DEPLOYMENT = process.env.OPENAI_DEPLOYMENT || "gpt-5-mini";

const TENANT_ID = process.env.TENANT_ID || "b1e769c7-78fc-4eb9-a371-2c14cbcc07af";
const API_APP_ID = process.env.API_APP_ID || "5fcba1ce-8186-4dbb-9b35-e2f07ee74db6";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://blue-cliff-0b313850f.5.azurestaticapps.net";
const RESTRICTED_GROUP_ID = process.env.RESTRICTED_GROUP_ID || "20245927-4db0-4696-8374-35c40a6bdd2a";
const RESTRICTED_SOURCE = "NY_FED";

// True if the caller's token carries the restricted-data-viewers group.
// Mirrors the Fabric Lakehouse's NYFedOnlyReader row-security role - same group, same restriction,
// enforced independently here because Cosmos DB has no native row-level security of its own.
function isRestrictedCaller(req) {
  const groups = req.user?.groups || [];
  return groups.includes(RESTRICTED_GROUP_ID);
}

function filterForCaller(req, items) {
  return isRestrictedCaller(req) ? items.filter((i) => i.source === RESTRICTED_SOURCE) : items;
}

// Verifies Entra ID access tokens issued for this API's own scope (access_as_user).
// Public signing keys are fetched (and cached) from Entra's own JWKS endpoint - no secret needed.
const jwks = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`));

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
      audience: [`api://${API_APP_ID}`, API_APP_ID],
    });
    req.user = payload;
    next();
  } catch (err) {
    console.error("Token validation failed:", err.message);
    res.status(401).json({ error: "Invalid or expired token", detail: err.message });
  }
}

// DefaultAzureCredential automatically uses the App Service's managed identity
// when running in Azure - no keys or connection strings needed.
const credential = new DefaultAzureCredential();
const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, aadCredentials: credential });
const container = client.database(DATABASE_NAME).container(CONTAINER_NAME);

const azureADTokenProvider = getBearerTokenProvider(credential, "https://cognitiveservices.azure.com/.default");
const openaiClient = new AzureOpenAI({
  endpoint: OPENAI_ENDPOINT,
  azureADTokenProvider,
  apiVersion: "2024-10-21",
  deployment: OPENAI_DEPLOYMENT,
});

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/indicators", requireAuth, async (req, res) => {
  try {
    const { resources } = await container.items.readAll().fetchAll();
    res.json(filterForCaller(req, resources));
  } catch (err) {
    console.error("Failed to read indicators:", err.message);
    res.status(502).json({ error: "Failed to read indicators", detail: err.message });
  }
});

app.get("/api/indicators/:seriesId", requireAuth, async (req, res) => {
  const { seriesId } = req.params;
  try {
    const { resource } = await container.item(seriesId, seriesId).read();
    if (!resource || (isRestrictedCaller(req) && resource.source !== RESTRICTED_SOURCE)) {
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

app.post("/api/chat", requireAuth, async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Request body must include a 'message' string" });
  }

  try {
    const { resources } = await container.items.readAll().fetchAll();
    const context = filterForCaller(req, resources)
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
