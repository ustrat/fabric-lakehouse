// KPI registry compiler. registry/metrics.json is the only place a metric, dimension or business
// rule is defined; this module turns it into:
//   - goldSql():     the Spark SQL that builds the gold table (executed by the gold notebook)
//   - compileQuery(): parameterized T-SQL for the lakehouse SQL endpoint (query_metric and friends)
//   - list()/describe()/definitionText(): what the AI and the app are told each metric means
// SQL fragments come only from the registry file (reviewed in PRs). Caller input is checked
// against the registry's allowlists and passed as SQL parameters, never spliced in.
const crypto = require("crypto");
const REGISTRY = require("./metrics.json");

const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FILTER_OPS = new Set(["eq", "contains"]);
const MAX_TOP = 500;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// ---------- load-time validation: fail at startup, not on the first request ----------
function validateRegistry(reg) {
  const errors = [];
  const all = new Map();
  for (const kind of ["dimensions", "measures", "metrics", "attributes"]) {
    for (const [id, def] of Object.entries(reg[kind] || {})) {
      if (!ID.test(id)) errors.push(`${kind}.${id}: invalid id`);
      if (all.has(id)) errors.push(`${kind}.${id}: id already used in ${all.get(id)}`);
      all.set(id, kind);
      if (!reg.models[def.model]) errors.push(`${kind}.${id}: unknown model '${def.model}'`);
    }
  }
  for (const [id, m] of Object.entries(reg.measures)) {
    if (!m.build && !m.rollupExpr) errors.push(`measures.${id}: needs 'build' (stored) or 'rollupExpr' (query-time)`);
    if (m.build && m.rollup !== "SUM") errors.push(`measures.${id}: stored measures must be additive (rollup: SUM)`);
  }
  for (const [id, m] of Object.entries(reg.metrics)) {
    for (const part of ["numerator", "denominator"]) {
      const ref = reg.measures[m[part]];
      if (!ref) errors.push(`metrics.${id}: ${part} '${m[part]}' is not a measure`);
      else if (!ref.build) errors.push(`metrics.${id}: ${part} '${m[part]}' must be a stored measure`);
    }
  }
  for (const [id, d] of Object.entries(reg.dimensions)) {
    for (const op of d.filters || []) if (!FILTER_OPS.has(op)) errors.push(`dimensions.${id}: unknown filter op '${op}'`);
  }
  // Every {rule:x} / {col:x} placeholder must resolve.
  const text = JSON.stringify(reg);
  for (const [, name] of text.matchAll(/\{rule:([^}]+)\}/g)) if (!reg.rules[name]) errors.push(`unknown rule '${name}'`);
  for (const [, name] of text.matchAll(/\{col:([^}]+)\}/g)) if (!all.has(name) && !Object.values(reg.models).some((m) => m.keys[name])) errors.push(`unknown column '${name}'`);
  if (errors.length) throw new Error(`KPI registry is invalid:\n  - ${errors.join("\n  - ")}`);
}
validateRegistry(REGISTRY);

const version = REGISTRY.version;
// Hash of only what changes a number (SQL fragments, rules, ratios). Labels, synonyms and descriptions are
// left out, so rewording a description does not rewrite every gold row and Cosmos doc.
const DESCRIPTIVE = new Set(["label", "synonyms", "description", "unit", "owner", "certified", "internal", "groupBy", "filters", "values"]);
const definitionHash = crypto.createHash("sha256")
  .update(JSON.stringify({ rules: REGISTRY.rules, models: REGISTRY.models, dimensions: REGISTRY.dimensions,
    measures: REGISTRY.measures, metrics: REGISTRY.metrics, attributes: REGISTRY.attributes },
  (k, v) => (DESCRIPTIVE.has(k) ? undefined : v)))
  .digest("hex").slice(0, 16);

// Caller-supplied ids are looked up as own properties only ("constructor" is not a metric).
const own = (obj, id) => (typeof id === "string" && Object.prototype.hasOwnProperty.call(obj || {}, id) ? obj[id] : undefined);

// Filterable fields: dimensions, plus model keys that declare filters (e.g. productId eq).
function filterField(id) {
  const d = own(REGISTRY.dimensions, id);
  if (d) return d;
  for (const [modelId, m] of Object.entries(REGISTRY.models)) {
    const k = own(m.keys, id);
    if (k) return { model: modelId, filters: k.filters || [] };
  }
  return undefined;
}

function expand(expr) {
  return expr
    .replace(/\{rule:([^}]+)\}/g, (_, n) => String(REGISTRY.rules[n].value))
    .replace(/\{col:([^}]+)\}/g, (_, n) => `[${n}]`);
}

function byModel(kind, model) {
  return Object.entries(REGISTRY[kind] || {}).filter(([, d]) => d.model === model);
}

// ---------- gold build (Spark SQL) ----------
function goldSql(modelId = "product_reviews") {
  const model = REGISTRY.models[modelId];
  if (!model) throw new Error(`Unknown model '${modelId}'`);
  const keys = Object.entries(model.keys);
  const dims = byModel("dimensions", modelId);
  const stored = byModel("measures", modelId).filter(([, m]) => m.build);
  const metrics = byModel("metrics", modelId).filter(([, m]) => m.store);
  const attrs = byModel("attributes", modelId);

  const groupCols = [...keys, ...dims].map(([id, d]) => [id, expand(d.build)]);
  const ratio = (m) => {
    const num = expand(REGISTRY.measures[m.numerator].build);
    const den = expand(REGISTRY.measures[m.denominator].build);
    const value = `${num} / NULLIF(${den}, 0)`;
    return m.round != null ? `ROUND(${value}, ${m.round})` : value;
  };
  const select = [
    ...groupCols.map(([id, e]) => `${e} AS ${id}`),
    ...stored.map(([id, m]) => `${expand(m.build)} AS ${id}`),
    ...metrics.map(([id, m]) => `${ratio(m)} AS ${id}`),
    ...attrs.map(([id, a]) => `${expand(a.build)} AS ${id}`),
    `${version} AS registryVersion`,
    `'${definitionHash}' AS registryHash`,
    "current_timestamp() AS refreshedAt",
  ];
  return [
    `-- GENERATED from operational-api/registry/metrics.json by scripts/generate-registry-sql.js. Do not edit.`,
    `-- registryVersion=${version} registryHash=${definitionHash} model=${modelId} table=${model.table}`,
    `SELECT`,
    `    ${select.join(",\n    ")}`,
    `FROM ${model.from}`,
    `WHERE ${model.where}`,
    `GROUP BY ${groupCols.map(([, e]) => e).join(", ")}`,
    "",
  ].join("\n");
}

// Gold columns whose change should produce a new row version (everything except bookkeeping).
function businessColumns(modelId = "product_reviews") {
  const m = REGISTRY.models[modelId];
  return [
    ...byModel("dimensions", modelId), ...byModel("measures", modelId).filter(([, d]) => d.build),
    ...byModel("metrics", modelId).filter(([, d]) => d.store), ...byModel("attributes", modelId),
  ].map(([id]) => id).concat("registryVersion", "registryHash").filter((id) => !(id in m.keys));
}

// ---------- metric queries (T-SQL on the SQL endpoint) ----------
function queryable(id) {
  const m = own(REGISTRY.measures, id);
  if (m && !m.internal) return { kind: "measure", def: m };
  const metric = own(REGISTRY.metrics, id);
  if (metric) return { kind: "metric", def: metric };
  return null;
}

function selectExpr(id) {
  const { kind, def } = queryable(id);
  if (kind === "metric") {
    const value = `CAST(SUM([${def.numerator}]) AS float) / NULLIF(SUM([${def.denominator}]), 0)`;
    return def.round != null ? `CAST(ROUND(${value}, ${def.round}) AS decimal(18,${def.round}))` : value;
  }
  const sum = def.rollupExpr ? expand(def.rollupExpr) : `SUM([${id}])`;
  return def.type === "int" ? `CAST(${sum} AS int)` : `CAST(${sum} AS float)`;
}

const asList = (v) => (v == null || v === "" ? [] : Array.isArray(v) ? v : String(v).split(",").map((s) => s.trim()).filter(Boolean));

// spec: { metrics: [ids], groupBy?: [dims], filters?: [{dimension, op, value}], orderBy?: [{field, dir}], top? }
function compileQuery(spec) {
  const metrics = asList(spec.metrics);
  const groupBy = asList(spec.groupBy);
  if (!metrics.length) throw fail("metrics: name at least one metric (see list_metrics)");

  const models = new Set();
  for (const id of metrics) {
    const q = queryable(id);
    if (!q) throw fail(`Unknown metric '${id}'. Use list_metrics to see what exists.`);
    models.add(q.def.model);
  }
  for (const id of groupBy) {
    const d = own(REGISTRY.dimensions, id);
    if (!d || !d.groupBy) throw fail(`Cannot group by '${id}'. Allowed: ${groupable().join(", ")}`);
    models.add(d.model);
  }

  const params = [];
  const where = [];
  for (const f of spec.filters || []) {
    const d = filterField(f?.dimension);
    if (!d) throw fail(`Cannot filter on '${f?.dimension}'`);
    const op = f.op || "eq";
    if (!(d.filters || []).includes(op)) throw fail(`Filter '${op}' is not allowed on ${f.dimension}. Allowed: ${(d.filters || []).join(", ") || "none"}`);
    const value = String(f.value ?? "").trim();
    if (!value) throw fail(`Filter on ${f.dimension} needs a value`);
    if (d.values && op === "eq" && !d.values.includes(value.toLowerCase())) throw fail(`${f.dimension} must be one of: ${d.values.join(", ")}`);
    const p = `f${params.length}`;
    params.push({ name: p, value: op === "eq" && d.values ? value.toLowerCase() : value });
    where.push(op === "contains"
      ? `LOWER([${f.dimension}]) LIKE '%' + LOWER(REPLACE(REPLACE(REPLACE(@${p}, '[', '[[]'), '%', '[%]'), '_', '[_]')) + '%'`
      : `[${f.dimension}] = @${p}`);
    models.add(d.model);
  }
  if (models.size !== 1) throw fail("These metrics and dimensions come from different models and cannot be combined in one query");
  const model = REGISTRY.models[[...models][0]];

  // A ratio over an empty group is undefined, so those groups are left out rather than shown as null.
  const denominators = [...new Set(metrics.map((id) => REGISTRY.metrics[id]?.denominator).filter(Boolean))];
  const having = denominators.map((d) => `SUM([${d}]) > 0`);

  const selected = new Set([...groupBy, ...metrics]);
  const order = (spec.orderBy || []).map((o) => {
    if (!selected.has(o?.field)) throw fail(`orderBy '${o?.field}' must be one of the selected metrics or groupBy dimensions`);
    return `[${o.field}] ${String(o.dir).toLowerCase() === "desc" ? "DESC" : "ASC"}`;
  });
  if (!order.length) order.push(...groupBy.map((g) => `[${g}] ASC`));
  const top = Math.min(Math.max(parseInt(spec.top, 10) || 100, 1), MAX_TOP);

  const sql = [
    `SELECT TOP (${top}) ${[...groupBy.map((g) => `[${g}]`), ...metrics.map((id) => `${selectExpr(id)} AS [${id}]`)].join(", ")}`,
    `FROM ${model.sqlObject}`,
    where.length ? `WHERE ${where.join(" AND ")}` : "",
    groupBy.length ? `GROUP BY ${groupBy.map((g) => `[${g}]`).join(", ")}` : "",
    having.length ? `HAVING ${having.join(" AND ")}` : "",
    order.length ? `ORDER BY ${order.join(", ")}` : "",
  ].filter(Boolean).join("\n");
  return { sql, params, source: model.sqlObject, metrics, groupBy };
}

// ---------- what the AI and the app are told ----------
function groupable() {
  return Object.entries(REGISTRY.dimensions).filter(([, d]) => d.groupBy).map(([id]) => id);
}

function formulaText(id) {
  const m = REGISTRY.metrics[id];
  if (m) return `${m.numerator} / ${m.denominator}${m.round != null ? `, rounded to ${m.round} decimals` : ""}`;
  const ms = REGISTRY.measures[id];
  return ms?.rollupExpr ? expand(ms.rollupExpr).replace(/\[|\]/g, "") : ms ? `${ms.build} per product, summed across products` : null;
}

function describe(id) {
  const q = queryable(id);
  if (!q) return null;
  const d = q.def;
  return {
    id, kind: q.kind, label: d.label, description: d.description, synonyms: d.synonyms || [], unit: d.unit,
    formula: formulaText(id), owner: d.owner, certified: !!d.certified,
    dimensions: groupable().filter((g) => REGISTRY.dimensions[g].model === d.model).map((g) => ({
      id: g, label: REGISTRY.dimensions[g].label, values: REGISTRY.dimensions[g].values, filters: REGISTRY.dimensions[g].filters,
    })),
    rules: Object.fromEntries(Object.entries(REGISTRY.rules).filter(([r]) => JSON.stringify(REGISTRY.dimensions).includes(`{rule:${r}}`))),
    registryVersion: version,
  };
}

function list() {
  return [...Object.keys(REGISTRY.metrics), ...Object.keys(REGISTRY.measures)]
    .filter((id) => queryable(id))
    .map((id) => { const d = describe(id); return { id, label: d.label, description: d.description, synonyms: d.synonyms, unit: d.unit }; });
}

// One-line definitions for tool descriptions and response provenance.
function definitionText(ids) {
  return ids.filter((id) => queryable(id)).map((id) => `${id} = ${REGISTRY.metrics[id]?.description || REGISTRY.measures[id].description}`).join(" ");
}

function definitions(ids) {
  return Object.fromEntries(ids.filter((id) => queryable(id)).map((id) => {
    const d = describe(id);
    return [id, { label: d.label, formula: d.formula, unit: d.unit, certified: d.certified }];
  }));
}

// JSON Schema for the general query_metric tool, with enums taken from the registry.
function querySchema() {
  const metricIds = list().map((m) => m.id);
  const keyIds = Object.values(REGISTRY.models).flatMap((m) => Object.keys(m.keys));
  const filterable = [...Object.keys(REGISTRY.dimensions), ...keyIds].filter((id) => (filterField(id).filters || []).length);
  return {
    type: "object",
    properties: {
      metrics: { type: "array", items: { type: "string", enum: metricIds }, minItems: 1, description: "Metric ids from list_metrics." },
      groupBy: { type: "array", items: { type: "string", enum: groupable() }, description: "Dimensions to break the metrics down by. Omit for a single total." },
      filters: {
        type: "array",
        description: "Optional filters. op 'eq' = exact match, 'contains' = case-insensitive partial match. describe_metric lists which ops each dimension allows.",
        items: {
          type: "object",
          properties: { dimension: { type: "string", enum: filterable }, op: { type: "string", enum: [...FILTER_OPS] }, value: { type: "string" } },
          required: ["dimension", "value"],
        },
      },
      orderBy: {
        type: "array",
        items: { type: "object", properties: { field: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } }, required: ["field"] },
      },
      top: { type: "integer", minimum: 1, maximum: MAX_TOP, description: "Maximum rows (default 100)." },
    },
    required: ["metrics"],
  };
}

module.exports = {
  version, definitionHash, goldSql, businessColumns, compileQuery, list, describe, definitions, definitionText, querySchema,
  validateRegistry, registry: REGISTRY,
};
