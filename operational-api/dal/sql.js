// Fabric SQL analytics endpoint handler. Runs only the named, parameterized queries defined in the registry.
const sql = require("mssql");

const pools = new Map(); // server/db -> { pool, expiresOn }

async function poolFor(store, ctx) {
  const server = ctx.setting(store.serverSetting);
  const id = `${server}/${store.database}`;
  const cached = pools.get(id);
  if (cached && cached.expiresOn - Date.now() > 5 * 60 * 1000) return cached.pool;
  if (cached) cached.pool.close().catch(() => {});

  const token = await ctx.credential.getToken("https://database.windows.net/.default");
  const pool = await new sql.ConnectionPool({
    server,
    database: store.database,
    port: 1433,
    options: { encrypt: true },
    authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
  }).connect();
  pools.set(id, { pool, expiresOn: token.expiresOnTimestamp });
  return pool;
}

const TYPES = { nvarchar: sql.NVarChar, int: sql.Int, decimal: sql.Decimal, date: sql.Date };

async function namedQuery(op, store, args, ctx) {
  const request = (await poolFor(store, ctx)).request();
  for (const [name, type] of Object.entries(op.sqlParams || {})) {
    const value = args[name] === undefined || args[name] === "" ? null : args[name];
    request.input(name, TYPES[type], value);
  }
  const t0 = Date.now();
  const result = await request.query(op.sql);
  return { body: { rows: result.recordset }, meta: { sqlMs: Date.now() - t0, source: op.object } };
}

module.exports = { namedQuery, poolFor };
