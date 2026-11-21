import { useCallback, useEffect, useState } from "react";
import { useApi } from "../api";
import Provenance from "../components/Provenance";

export default function Analytics() {
  const api = useApi();
  const [category, setCategory] = useState("");
  const [state, setState] = useState({ status: "loading" });

  const load = useCallback(async (cat) => {
    setState((s) => ({ ...s, status: "loading" }));
    try {
      const qs = cat ? `?${new URLSearchParams({ category: cat })}` : "";
      const { data, meta } = await api(`/api/retail/analytics/ratings${qs}`);
      setState({ status: "done", rows: data.rows, meta });
    } catch (err) {
      setState({ status: "error", error: err.message });
    }
  }, [api]);

  useEffect(() => { load(""); }, [load]);

  const rows = state.rows || [];
  const totalReviews = rows.reduce((s, r) => s + r.reviews, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Rating trends</h1>
          <p>Average stars by category and price band, weighted by review count. Lowest first.</p>
        </div>
      </div>

      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); load(category.trim()); }}>
        <label htmlFor="cat" className="sr-only">Filter by category</label>
        <input id="cat" className="input" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Filter category, e.g. laptops" />
        <button className="btn">Apply</button>
        {category && <button type="button" className="btn btn-ghost" onClick={() => { setCategory(""); load(""); }}>Clear</button>}
      </form>

      {state.status === "error" && <div className="banner">{state.error}</div>}

      <div className="card" style={{ overflowX: "auto" }}>
        <table className="data">
          <thead>
            <tr>
              <th>Category</th>
              <th>Price band</th>
              <th className="r">Products</th>
              <th className="r">Reviews</th>
              <th>Average stars</th>
            </tr>
          </thead>
          <tbody>
            {state.status === "loading" && !rows.length && [0, 1, 2, 3].map((i) => (
              <tr key={i}><td colSpan={5}><div className="skeleton" style={{ height: 18 }} /></td></tr>
            ))}
            {rows.map((r) => (
              <tr key={`${r.categoryName}-${r.priceBand}`} style={{ opacity: state.status === "loading" ? 0.5 : 1 }}>
                <td>{r.categoryName}</td>
                <td><span className={`chip ${r.priceBand === "premium" ? "accent" : ""}`}>{r.priceBand}</span></td>
                <td className="r num">{r.products}</td>
                <td className="r num">{r.reviews}</td>
                <td>
                  <div className="bar-cell">
                    <span className="num" style={{ width: 34 }}>{Number(r.avgStars).toFixed(2)}</span>
                    <span className="track" aria-hidden="true"><span className="fill" style={{ display: "block", width: `${(r.avgStars / 5) * 100}%` }} /></span>
                  </div>
                </td>
              </tr>
            ))}
            {state.status === "done" && !rows.length && <tr><td colSpan={5} className="empty">No categories match “{category}”</td></tr>}
          </tbody>
        </table>
        {state.meta && (
          <div className="table-foot">
            <span className="num">{rows.length} groups · {totalReviews} reviews</span>
            <Provenance meta={state.meta} />
          </div>
        )}
      </div>
    </>
  );
}
