// Two front doors over one data access layer:
//   1. REST routes declared in the registry (React app; each screen calls a fixed endpoint)
//   2. /api/retail/tools  (AI; the model picks an operation by its description)
const express = require("express");

function createRetailRouter({ dal, middleware = [] }) {
  const router = express.Router();
  // Scope the gateway/access checks to this router's paths; app.use() runs a router for every request,
  // so an unscoped router.use() would also lock /health and re-run checks on the app's own routes.
  if (middleware.length) router.use("/api/retail", ...middleware);

  // APIM forwards the validated caller token in x-user-token (see docs/semantic-registry.md).
  const reqCtx = (req) => ({ userToken: req.headers["x-user-token"], access: req.access });
  const send = (res, out) => res.status(out.status).json({ ...out.body, _meta: out.meta });

  router.get("/api/retail/tools", (req, res) => res.json({ tools: dal.toolDefinitions() }));

  router.post("/api/retail/tools/:name", async (req, res) => {
    send(res, await dal.invoke(req.params.name, req.body || {}, reqCtx(req)));
  });

  // Register static routes before parameterized ones so /products/search isn't captured by /products/:id.
  const ops = [...dal.operations].sort((a, b) => a.route.includes(":") - b.route.includes(":"));
  for (const op of ops) {
    const [method, path] = op.route.split(" ");
    router[method.toLowerCase()](path, async (req, res) => {
      const args = { ...req.query, ...(req.body || {}), ...req.params };
      send(res, await dal.invoke(op.name, args, reqCtx(req)));
    });
  }
  return router;
}

module.exports = { createRetailRouter };
