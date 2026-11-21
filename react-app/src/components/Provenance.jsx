// Shows where an answer came from and how fast. Users trust numbers they can trace.
const STORE_LABEL = {
  retailCosmos: "Cosmos DB",
  lakehouseSql: "Lakehouse SQL",
  retailDataAgent: "Data Agent (live)",
  AnswerCache: "Answer cache",
};

export const fmtMs = (ms) => (ms == null ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

export default function Provenance({ meta }) {
  if (!meta || !meta.operation) return null;
  const parts = [STORE_LABEL[meta.store] || meta.store];
  if (meta.cache === "hit" && meta.similarity != null) parts.push(`${Math.round(meta.similarity * 100)}% match`);
  if (meta.source) parts.push(meta.source.replace(/^dbo\./, ""));
  if (meta.ru != null) parts.push(`${+meta.ru.toFixed(1)} RU`);
  parts.push(fmtMs(meta.ms));
  const speed = meta.ms < 1000 ? "fast" : meta.ms > 5000 ? "slow" : "";
  return (
    <span className={`prov ${speed}`} title={`Operation: ${meta.operation}`}>
      <span className="dot" aria-hidden="true" />
      {parts.join(" · ")}
    </span>
  );
}
