// Local-development defaults for scripts and jobs. Real deployments use App Service settings.
const DEFAULTS = {
  RETAIL_COSMOS_ENDPOINT: "https://ae268e38-3ca9-4db0-815c-2c9c808d346b.zae.sql.cosmos.fabric.microsoft.com",
  LAKEHOUSE_SQL_SERVER: "y5u6pmp4pc4u5i3rfqkmxtahv4-c6xygue5dr6e7nvi2fqsm4mu7e.datawarehouse.fabric.microsoft.com",
  RETAIL_DATA_AGENT_MCP_URL:
    "https://api.fabric.microsoft.com/v1/mcp/workspaces/5083af17-1c9d-4f7c-b6a8-d161267194f9/dataagents/3848e9c0-b9bb-456c-b2f2-81887323da94/agent",
  OPENAI_ENDPOINT: "https://ustrat-ai-foundry.openai.azure.com/",
  EMBEDDING_DEPLOYMENT: "text-embedding-3-small",
  CHAT_DEPLOYMENT: "gpt-5-mini",
  DATA_AGENT_DEV_CREDENTIAL: "1",
};
for (const [k, v] of Object.entries(DEFAULTS)) process.env[k] ??= v;
