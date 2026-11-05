// Fabric Data Agent handler, called over its MCP endpoint AS THE SIGNED-IN EMPLOYEE (On-Behalf-Of),
// so Fabric permissions and RLS apply per user.
const { OnBehalfOfCredential } = require("@azure/identity");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default";

async function userFabricToken(ctx) {
  if (ctx.userToken) {
    const obo = new OnBehalfOfCredential({
      tenantId: ctx.setting("AZURE_TENANT_ID"),
      clientId: ctx.setting("API_CLIENT_ID"),
      clientSecret: ctx.setting("API_CLIENT_SECRET"),
      userAssertionToken: ctx.userToken,
    });
    return (await obo.getToken(FABRIC_SCOPE)).token;
  }
  // Local development only: run as whoever is signed in to `az login`. Never set this in App Service.
  if (process.env.DATA_AGENT_DEV_CREDENTIAL === "1") return (await ctx.credential.getToken(FABRIC_SCOPE)).token;
  const err = new Error("ask_data needs the caller's token (APIM must forward x-user-token)");
  err.status = 401;
  throw err;
}

async function ask(op, store, args, ctx) {
  const question = String(args.question || "").trim();
  if (!question) return { status: 400, body: { error: "question is required" } };

  const token = await userFabricToken(ctx);
  const transport = new StreamableHTTPClientTransport(new URL(ctx.setting(store.mcpUrlSetting)), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "ustrat-operational-api", version: "1.0.0" });
  const t0 = Date.now();
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const tool = tools[0]; // a data agent exposes exactly one tool
    const argName = Object.keys(tool.inputSchema.properties || {})[0];
    const result = await client.callTool({ name: tool.name, arguments: { [argName]: question } });
    const answer = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return {
      status: result.isError ? 502 : 200,
      body: { answer },
      meta: { tool: tool.name, agentMs: Date.now() - t0 },
    };
  } finally {
    await client.close().catch(() => {});
  }
}

module.exports = { ask };
