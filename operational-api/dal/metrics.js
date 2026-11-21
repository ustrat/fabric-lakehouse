// KPI handlers. Every number is computed by SQL that registry/kpi.js generates from registry/metrics.json.
const sql = require("mssql");
const kpi = require("../registry/kpi");
const { poolFor } = require("./sql");

function provenance(ids) {
  return { registryVersion: kpi.version, registryHash: kpi.definitionHash, definitions: kpi.definitions(ids) };
}

// Two ways in:
//   - fixed operations (e.g. get_rating_trends): op.query holds the spec, op.filterParams maps simple
//     REST/tool parameters to registry filters, op.aliases renames output columns for the app.
//   - query_metric: the caller (usually the AI) sends the spec itself; kpi.compileQuery validates it.
async function query(op, store, args, ctx) {
  let spec;
  if (op.query) {
    const filters = Object.entries(op.filterParams || {})
      .filter(([param]) => args[param] !== undefined && args[param] !== "")
      .map(([param, f]) => ({ dimension: f.dimension, op: f.op, value: args[param] }));
    spec = { ...op.query, filters: [...(op.query.filters || []), ...filters] };
  } else {
    spec = { metrics: args.metrics, groupBy: args.groupBy, filters: parseJson(args.filters), orderBy: parseJson(args.orderBy), top: args.top };
  }

  let compiled;
  try {
    compiled = kpi.compileQuery(spec);
  } catch (err) {
    if (err.status === 400) return { status: 400, body: { error: err.message } };
    throw err;
  }

  const request = (await poolFor(store, ctx)).request();
  for (const p of compiled.params) request.input(p.name, sql.NVarChar, p.value);
  const t0 = Date.now();
  const result = await request.query(compiled.sql);
  const aliases = op.aliases || {};
  const rows = Object.keys(aliases).length
    ? result.recordset.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [aliases[k] || k, v])))
    : result.recordset;

  return {
    body: { rows, ...provenance(compiled.metrics) },
    meta: { sqlMs: Date.now() - t0, source: compiled.source, registryVersion: kpi.version },
  };
}

// REST query strings arrive as text; tool calls arrive as JSON.
function parseJson(v) {
  if (v == null || v === "") return undefined;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return undefined; }
}

async function listMetrics() {
  return { body: { metrics: kpi.list(), registryVersion: kpi.version } };
}

async function describeMetric(op, store, args) {
  const d = kpi.describe(String(args.metric || ""));
  if (!d) return { status: 404, body: { error: `Unknown metric '${args.metric}'. Use list_metrics.` } };
  return { body: d };
}

module.exports = { query, listMetrics, describeMetric, provenance };
