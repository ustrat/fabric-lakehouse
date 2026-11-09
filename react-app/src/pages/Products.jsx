import { useEffect, useState } from "react";
import { useApi } from "../api";
import Provenance from "../components/Provenance";
import Icon from "../components/Icon";

const EXAMPLES = ["something to block out noise on a long flight", "lightweight laptop for travel", "gift under $50"];
const money = (n) => (n == null ? "—" : n.toLocaleString(undefined, { style: "currency", currency: "USD" }));
const stars = (v) => "★★★★★".slice(0, Math.round(v || 0)) + "☆☆☆☆☆".slice(0, 5 - Math.round(v || 0));

export default function Products({ selected, onSelect, onResults }) {
  const api = useApi();
  const [q, setQ] = useState("");
  const [mode, setMode] = useState("vector");
  const [search, setSearch] = useState({ status: "idle" });

  async function runSearch(e, query = q) {
    e?.preventDefault();
    if (!query.trim()) return;
    setSearch({ status: "loading" });
    try {
      const { data, meta } = await api(`/api/retail/products/search?${new URLSearchParams({ q: query, mode, top: 8 })}`);
      setSearch({ status: "done", results: data.results, meta });
      onResults?.(data.results);
      if (data.results[0]) onSelect({ productId: data.results[0].productId, name: data.results[0].name });
    } catch (err) {
      setSearch({ status: "error", error: err.message });
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <p>Describe what a customer needs. Search matches by meaning, not just keywords.</p>
        </div>
      </div>

      <form className="search-bar" onSubmit={runSearch} role="search">
        <label htmlFor="product-q" className="sr-only">Search products</label>
        <div className="input-wrap">
          <input id="product-q" className="input" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. something to block out noise on a long flight" autoFocus />
          {!q && <kbd className="kbd-hint" aria-hidden="true" title="Press / to search">/</kbd>}
        </div>
        <div className="segmented" role="group" aria-label="Search mode" data-index={mode === "hybrid" ? 1 : 0}>
          <span className="segmented-thumb" aria-hidden="true" />
          <button type="button" aria-pressed={mode === "vector"} onClick={() => setMode("vector")} title="Match by meaning">Meaning</button>
          <button type="button" aria-pressed={mode === "hybrid"} onClick={() => setMode("hybrid")} title="Meaning + keywords; best for brand names and model numbers">Hybrid</button>
        </div>
        <button className="btn btn-primary" disabled={search.status === "loading" || !q.trim()}>Search</button>
      </form>

      {search.status === "error" && <div className="banner">{search.error}</div>}

      {search.status === "idle" && !selected && (
        <Overview onExample={(ex) => { setQ(ex); runSearch(null, ex); }} />
      )}

      {(search.status !== "idle" || selected) && (
        <div className="products-grid">
          <div className="card">
            <ResultList search={search} selectedId={selected?.productId} onSelect={onSelect} />
          </div>
          {selected ? <ProductDetail productId={selected.productId} /> : <div />}
        </div>
      )}
    </>
  );
}

// Catalog snapshot shown before the first search, from the same weighted trends query as Rating trends.
function Overview({ onExample }) {
  const api = useApi();
  const [state, setState] = useState({ status: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    api("/api/retail/analytics/ratings", { signal: ctrl.signal })
      .then(({ data, meta }) => setState({ status: "done", rows: data.rows, meta }))
      .catch((err) => err.name !== "AbortError" && setState({ status: "error" }));
    return () => ctrl.abort();
  }, [api]);

  const rows = state.rows || [];
  const products = rows.reduce((s, r) => s + r.products, 0);
  const reviews = rows.reduce((s, r) => s + r.reviews, 0);
  const avg = reviews ? rows.reduce((s, r) => s + r.avgStars * r.reviews, 0) / reviews : null;
  const lowest = rows[0]; // query orders by avgStars ascending

  return (
    <div className="overview enter">
      {state.status !== "error" && (
        <div className="kpis">
          {state.status === "loading" ? [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 92 }} />) : (
            <>
              <div className="card kpi">
                <div className="kpi-label">Products with reviews</div>
                <div className="kpi-value num">{products}</div>
                <div className="muted" style={{ fontSize: 12 }}>{reviews} reviews in total</div>
              </div>
              <div className="card kpi">
                <div className="kpi-label">Average rating</div>
                <div className="kpi-value num">{avg != null ? avg.toFixed(2) : "—"}<small>/ 5</small></div>
                <div className="stars" aria-hidden="true">{stars(avg)}</div>
              </div>
              <div className="card kpi">
                <div className="kpi-label">Lowest-rated group</div>
                <div className="kpi-value" style={{ fontSize: 18, marginTop: 6 }}>{lowest ? `${lowest.categoryName} · ${lowest.priceBand}` : "—"}</div>
                {lowest && <div className="muted num" style={{ fontSize: 12 }}>{Number(lowest.avgStars).toFixed(2)} stars from {lowest.reviews} reviews</div>}
              </div>
            </>
          )}
        </div>
      )}
      <div className="card card-pad" style={{ display: "grid", gap: 10 }}>
        <h3>Try a search</h3>
        <div className="overview-examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="suggestion" onClick={() => onExample(ex)}><Icon name="search" size={14} />{ex}</button>
          ))}
        </div>
      </div>
      {state.meta && <Provenance meta={state.meta} />}
    </div>
  );
}

function ResultList({ search, selectedId, onSelect }) {
  if (search.status === "loading") {
    return <div className="results">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 52, margin: 4 }} />)}</div>;
  }
  if (search.status !== "done") return <div className="empty">No search yet</div>;
  if (!search.results.length) return <div className="empty">No matching products</div>;
  return (
    <>
      <div className="results" role="listbox" aria-label="Search results">
        {search.results.map((r, i) => (
          <button key={r.productId} className="result enter" style={{ "--i": i }} role="option" aria-selected={r.productId === selectedId}
            onClick={() => onSelect({ productId: r.productId, name: r.name })}>
            <span className="result-name">{r.name}</span>
            <span className="num">{money(r.currentPrice)}</span>
            <span className="result-sub">{r.categoryName}</span>
            {r.similarity != null && <span className="result-sub num">{Math.round(r.similarity * 100)}% match</span>}
            {r.similarity != null && <span className="match" aria-hidden="true"><span style={{ width: `${Math.max(0, r.similarity) * 100}%` }} /></span>}
          </button>
        ))}
      </div>
      <div className="results-foot"><Provenance meta={search.meta} /></div>
    </>
  );
}

function ProductDetail({ productId }) {
  const api = useApi();
  const [rating, setRating] = useState({ status: "loading" });
  const [insights, setInsights] = useState({ status: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    // Keep the previous product on screen (dimmed) until the next one arrives: no blank flash between products.
    const load = (path, set) => {
      set((s) => ({ ...s, status: "loading" }));
      return api(path, { signal: ctrl.signal })
        .then(({ data, meta }) => set({ status: "done", data, meta }))
        .catch((err) => err.name !== "AbortError" && set({ status: err.status === 404 ? "missing" : "error", error: err.message }));
    };
    load(`/api/retail/products/${encodeURIComponent(productId)}/rating`, setRating);
    load(`/api/retail/products/${encodeURIComponent(productId)}/insights`, setInsights);
    return () => ctrl.abort();
  }, [api, productId]);

  if (!rating.data && rating.status === "loading") {
    // Same footprint as the loaded layout, so nothing shifts when it arrives.
    return (
      <div className="detail" aria-busy="true">
        <div className="skeleton" style={{ height: 58 }} />
        <div className="kpis">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 106 }} />)}</div>
        <div className="skeleton" style={{ height: 300 }} />
      </div>
    );
  }
  if (rating.status === "missing" || rating.status === "error") return <div className="card empty enter">{rating.error}</div>;
  const p = rating.data;

  return (
    <div className={`detail enter ${rating.status === "loading" ? "is-stale" : ""}`} key={p.productId} aria-busy={rating.status === "loading"}>
      <div className="detail-head">
        <div>
          <h1>{p.productName}</h1>
          <div className="chips">
            <span className="chip">{p.categoryName}</span>
            {p.priceBand && <span className={`chip ${p.priceBand === "premium" ? "accent" : ""}`}>{p.priceBand}</span>}
          </div>
        </div>
        <Provenance meta={rating.meta} />
      </div>

      <div className="kpis">
        <div className="card kpi">
          <div className="kpi-label">Average rating</div>
          <div className="kpi-value num">{p.avgStars != null ? p.avgStars.toFixed(2) : "—"}<small>/ 5</small></div>
          <div className="stars" aria-hidden="true">{stars(p.avgStars)}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Reviews</div>
          <div className="kpi-value num">{p.reviewCount ?? 0}</div>
          {p.reviewCount < 10 && <div className="muted" style={{ fontSize: 12 }}>Small sample, read with care</div>}
        </div>
        <div className="card kpi">
          <div className="kpi-label">Current price</div>
          <div className="kpi-value num">{money(p.currentPrice)}</div>
        </div>
      </div>

      <Insights state={insights} />
    </div>
  );
}

function Insights({ state }) {
  return (
    <div className="card card-pad" style={{ display: "grid", gap: 14 }}>
      <div className="detail-head">
        <h3>What customers say</h3>
        {state.status === "done" && <Provenance meta={state.meta} />}
      </div>
      {state.status === "loading" && !state.data && <div className="skeleton" style={{ height: 220 }} />}
      {state.status === "missing" && <div className="muted enter">No review insights for this product yet. They are refreshed after each data load.</div>}
      {state.status === "error" && <div className="banner enter">{state.error}</div>}
      {state.data && (state.status === "done" || state.status === "loading") && (
        <div className={`themes-wrap ${state.status === "loading" ? "is-stale" : "enter"}`} key={state.data.productId}>
          <InsightBody data={state.data} />
        </div>
      )}
    </div>
  );
}

function InsightBody({ data }) {
  const max = Math.max(...data.themes.map((t) => t.count), 1);
  return (
    <>
      <div className="summary">{data.summary}</div>
      <div className="themes">
        {data.themes.map((t) => (
          <div className="theme-row" key={t.label}>
            <div className="theme-label">{t.label} <span className={`chip ${t.sentiment}`}>{t.sentiment}</span></div>
            <div className="theme-count num">{t.count} of {data.reviewCount}</div>
            <div className="theme-bar" aria-hidden="true"><span className={t.sentiment} style={{ width: `${(t.count / max) * 100}%` }} /></div>
            <ul className="quotes">
              {t.quotes.slice(0, 3).map((q) => (
                <li key={q.text}>“{q.text}”{q.count > 1 && <span className="q-count">×{q.count}</span>}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Counts are exact and quotes are verbatim. A model only groups reviews into themes.
        {data.generatedAt && ` Updated ${new Date(data.generatedAt).toLocaleString()}.`}
      </div>
    </>
  );
}
