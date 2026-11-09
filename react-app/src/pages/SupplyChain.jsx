import { useCallback, useEffect, useState } from "react";
import { useApi } from "../api";

// The original supply-chain indicators view, kept as its own page.
export default function SupplyChain() {
  const api = useApi();
  const [state, setState] = useState({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const { data } = await api("/api/indicators");
      setState({ status: "done", rows: data });
    } catch (err) {
      setState({ status: "error", error: err.message });
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Supply chain</h1>
          <p>Latest value for each tracked indicator.</p>
        </div>
        <button className="btn" onClick={load} disabled={state.status === "loading"}>Refresh</button>
      </div>
      {state.status === "error" && <div className="banner">{state.error}</div>}
      <div className="card" style={{ overflowX: "auto" }}>
        <table className="data">
          <thead><tr><th>Series</th><th>Metric</th><th className="r">Value</th><th>As of</th><th>Source</th></tr></thead>
          <tbody>
            {state.status === "loading" && [0, 1, 2].map((i) => <tr key={i}><td colSpan={5}><div className="skeleton" style={{ height: 18 }} /></td></tr>)}
            {(state.rows || []).map((r) => (
              <tr key={r.series_id}>
                <td style={{ fontFamily: "var(--mono)" }}>{r.series_id}</td>
                <td>{r.metric_name}</td>
                <td className="r num">{r.value}</td>
                <td className="num">{r.observation_date}</td>
                <td className="muted">{r.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
