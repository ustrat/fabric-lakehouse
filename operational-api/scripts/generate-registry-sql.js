// Generate the gold build from the KPI registry (registry/metrics.json), so Fabric computes exactly
// what the registry defines.
//
// Usage (from operational-api/):
//   node scripts/generate-registry-sql.js            write registry/generated/*
//   node scripts/generate-registry-sql.js --check    exit 1 if the generated files are stale (CI)
//   node scripts/generate-registry-sql.js --upload   also upload to the lakehouse Files/registry/ folder,
//                                                    where the gold notebook reads it (uses `az login`)
const fs = require("fs");
const path = require("path");
const kpi = require("../registry/kpi");

const MODEL = "product_reviews";
const model = kpi.registry.models[MODEL];
const OUT_DIR = path.join(__dirname, "..", "registry", "generated");
const sql = kpi.goldSql(MODEL);
const manifest = {
  $comment: "GENERATED from registry/metrics.json by scripts/generate-registry-sql.js. Do not edit.",
  model: MODEL,
  table: model.table,
  registryVersion: kpi.version,
  registryHash: kpi.definitionHash,
  keys: Object.keys(model.keys),
  businessColumns: kpi.businessColumns(MODEL),
  sql,
};
const files = {
  [`${model.table}.sql`]: sql,
  [`${model.table}.json`]: JSON.stringify(manifest, null, 2) + "\n",
};

if (process.argv.includes("--check")) {
  const stale = Object.entries(files).filter(([name, text]) => {
    const p = path.join(OUT_DIR, name);
    return !fs.existsSync(p) || fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n") !== text;
  });
  if (stale.length) {
    console.error(`Stale generated files: ${stale.map(([n]) => n).join(", ")}. Run: node scripts/generate-registry-sql.js`);
    process.exit(1);
  }
  console.log(`Generated files match registry v${kpi.version} (${kpi.definitionHash}).`);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(OUT_DIR, name), text);
console.log(`Wrote registry/generated/{${Object.keys(files).join(",")}} for registry v${kpi.version} (${kpi.definitionHash}).`);

if (process.argv.includes("--upload")) {
  // OneLake DFS: create, append, flush. Override the folder with ONELAKE_REGISTRY_URL.
  const base = process.env.ONELAKE_REGISTRY_URL
    || "https://onelake.dfs.fabric.microsoft.com/5083af17-1c9d-4f7c-b6a8-d161267194f9/1d08bc2a-e24d-40cd-bffb-acd800035157/Files/registry";
  const { DefaultAzureCredential } = require("@azure/identity");
  (async () => {
    const { token } = await new DefaultAzureCredential().getToken("https://storage.azure.com/.default");
    const headers = { Authorization: `Bearer ${token}`, "x-ms-version": "2023-11-03" };
    for (const [name, text] of Object.entries(files)) {
      const url = `${base}/${name}`;
      const body = Buffer.from(text, "utf8");
      const steps = [
        ["PUT", `${url}?resource=file`, undefined],
        ["PATCH", `${url}?action=append&position=0`, body],
        ["PATCH", `${url}?action=flush&position=${body.length}`, undefined],
      ];
      for (const [method, u, b] of steps) {
        const res = await fetch(u, { method, headers: { ...headers, ...(b ? { "Content-Type": "application/octet-stream" } : {}) }, body: b });
        if (!res.ok) throw new Error(`${method} ${u.split("?")[0]} -> ${res.status} ${await res.text()}`);
      }
      console.log(`Uploaded ${name} (${body.length} bytes) to ${base}`);
    }
  })().catch((err) => { console.error(err.message); process.exit(1); });
}
