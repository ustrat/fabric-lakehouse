# Semantic registry and data access layer

How the app and the AI decide which store answers a question.

- **Fabric owns what the numbers mean.** The gold notebook (`gold_product_review_summary`) computes the metrics, and the views and the Data Agent read the same definitions.
- **`operational-api/registry/operations.json` owns where each answer is fetched from.** It maps business operations to stores and is reviewed in PRs.
- **App Service settings own environment values.** The registry holds setting *names*, never endpoints or secrets.

```
React screen ──REST──┐                       ┌─ get_product_rating ─▶ Cosmos ProductSummary (point read, 1 RU)
                     ├─▶ APIM ─▶ dal.invoke() ├─ search_products    ─▶ Cosmos ProductSearch (embed + vector/hybrid)
AI agent ─tools──────┘                       ├─ get_rating_trends  ─▶ Lakehouse SQL endpoint (gold table)
                                             └─ ask_data           ─▶ Fabric Data Agent (MCP, as the user)
```

## Layout

| Path | Purpose |
|---|---|
| `operational-api/registry/operations.json` | Each operation's route, store, handler, AI tool description and parameter schema |
| `operational-api/dal/index.js` | Loads the registry and checks it at startup. `invoke(name, args)`, `toolDefinitions()` |
| `operational-api/dal/cosmos.js` | `pointRead`, `semanticSearch` (vector or hybrid RRF) |
| `operational-api/dal/sql.js` | `namedQuery`: runs only the parameterized SQL in the registry |
| `operational-api/dal/dataAgent.js` | `ask`: calls the Fabric Data Agent MCP endpoint on behalf of the caller |
| `operational-api/retail/router.js` | The registry's REST routes, plus `GET /api/retail/tools` and `POST /api/retail/tools/:name` |
| `operational-api/scripts/smoke-registry.js` | Calls every operation directly, signed in as your `az login` account |

## Adding a use case

1. Make sure the metric exists in Fabric (the gold table or a view). Don't calculate it in Node.
2. Add an entry to `operations.json`: `name`, `route`, `description` (the AI reads this), `store`, `handler`, store-specific fields and `parameters`.
3. If the store type is new, add a handler in `dal/` and register it in `HANDLERS`.
4. Run `node scripts/smoke-registry.js`.

## App Service settings

| Setting | Example / source |
|---|---|
| `RETAIL_COSMOS_ENDPOINT` | `https://ae268e38-3ca9-4db0-815c-2c9c808d346b.zae.sql.cosmos.fabric.microsoft.com` |
| `LAKEHOUSE_SQL_SERVER` | `y5u6pmp4pc4u5i3rfqkmxtahv4-c6xygue5dr6e7nvi2fqsm4mu7e.datawarehouse.fabric.microsoft.com` |
| `RETAIL_DATA_AGENT_MCP_URL` | `https://api.fabric.microsoft.com/v1/mcp/workspaces/{ws}/dataagents/{agentId}/agent` |
| `EMBEDDING_DEPLOYMENT` | `text-embedding-3-small` (must match the model that built `ProductSearch`) |
| `OPENAI_ENDPOINT` | Already set for `/api/chat` |
| `AZURE_TENANT_ID`, `API_CLIENT_ID` | Tenant ID and the API app registration (`5fcba1ce-…`) |
| `API_CLIENT_SECRET` | **Key Vault reference.** Used only for the On-Behalf-Of exchange in `ask_data`. |

Never set `DATA_AGENT_DEV_CREDENTIAL` in Azure. It makes `ask_data` run as the developer's own identity, for local runs only.

## Permissions

- **App Service managed identity:** read access to the `cosmos db` workspace items `retail_cosmos` and `retail_ai_lh` (it reads Cosmos and the SQL endpoint as itself), plus `Cognitive Services OpenAI User` on `ustrat-ai-foundry`.
- **API app registration:** a client secret or certificate, and the **delegated** Fabric (Power BI Service) permission needed for Data Agent calls, with admin consent.
- **Employees:** read access to the Data Agent and its data, granted through an Entra group, because `ask_data` runs as the user.

## APIM change needed for `ask_data`

Today the policy deletes `Authorization` after validating it. To let `ask_data` act as the caller, forward the validated token before deleting it. The backend only accepts it together with `x-apim-secret`.

```xml
<set-header name="x-user-token" exists-action="override">
    <value>@(context.Request.Headers.GetValueOrDefault("Authorization","").Replace("Bearer ",""))</value>
</set-header>
<set-header name="Authorization" exists-action="delete" />
```

Long agent calls can take 8 to 30 seconds. Check that the APIM `forward-request` timeout and the App Service timeout allow at least 60 seconds.

## Smoke test results (2026-11-05, local, cold start)

| Operation | Store | Result |
|---|---|---|
| `search_products` "block out noise on a long flight" | Cosmos ProductSearch | 3 noise-cancelling headphones, 11 RU |
| `get_product_rating` | Cosmos ProductSummary | 1 RU, about 100 ms cold |
| `get_product_rating` with an unknown ID | Cosmos | 404 |
| `get_rating_trends` "laptops" | Lakehouse SQL endpoint | Premium laptops: 10 products, 35 reviews, 2.77 average (weighted) |
| `ask_data` "average rating of premium products" | Fabric Data Agent | 2.87 from 145 reviews, about 12 s |

Cold-start times include getting tokens and opening connections. Warm calls skip both, because the clients and SQL pools are cached.

## Known gaps

- The retail data has no row-level restrictions yet. The routes still require `requireGateway` and `resolveAccess`, but nothing filters by group.
- `ask_data` opens a new MCP session on every call. If latency matters, add session reuse and MCP *tasks* for long questions.
- Hybrid search pulls keywords from the question with a simple regex. Have a model extract the key terms, or weight the vector side more heavily, if hybrid becomes the default.
