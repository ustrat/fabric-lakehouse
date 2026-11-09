import { useEffect, useRef, useState } from "react";
import { useApi } from "../api";
import Provenance, { fmtMs } from "./Provenance";
import Icon from "./Icon";

const SUGGESTIONS = {
  general: [
    "How do premium products compare with standard on average rating?",
    "Which category has the lowest average rating?",
    "What do customers complain about most?",
  ],
  product: [
    "What do customers complain about?",
    "How does this compare with other products in its category?",
  ],
};

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const escapeRe =(s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NUMBER = String.raw`\$?\d[\d,]*(?:\.\d+)?%?`;

// Bold the numbers and turn known product names into links that open the product.
function RichAnswer({ text, products, onOpenProduct }) {
  const names = [...products].sort((a, b) => b.name.length - a.name.length);
  const byName = new Map(names.map((p) => [p.name.toLowerCase(), p]));
  const pattern = new RegExp([...names.map((p) => escapeRe(p.name)), NUMBER].join("|"), "gi");
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const p = byName.get(m[0].toLowerCase());
    parts.push(p
      ? <button key={m.index} className="entity" onClick={() => onOpenProduct(p)} title="Open product">{m[0]}</button>
      : <strong key={m.index}>{m[0]}</strong>);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <div className="bubble">{parts}</div>;
}

// Embedded AI panel. Same data as the screens, plus the screen's context (the selected product).
export default function Assistant({ context, products = [], onOpenProduct, onClose }) {
  const api = useApi();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [useContext, setUseContext] = useState(true);
  const [pending, setPending] = useState(null); // { started, ctrl }
  const [now, setNow] = useState(Date.now());
  const bodyRef = useRef(null);

  useEffect(() => { setUseContext(true); }, [context?.productId]);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [pending]);
  useEffect(() => {
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, [messages, pending]);

  const ctx = useContext ? context : null;

  async function ask(raw) {
    const q = raw.trim();
    if (!q || pending) return;
    setText("");
    // Context goes into the question so the agent (and the cache key) see it.
    const question = ctx ? `About the product "${ctx.name}" (productId ${ctx.productId}): ${q}` : q;
    setMessages((m) => [...m, { role: "user", text: q, context: ctx?.name }]);
    const ctrl = new AbortController();
    setPending({ started: Date.now(), ctrl });
    try {
      const { data, meta } = await api("/api/retail/ask", { method: "POST", body: { question }, signal: ctrl.signal });
      setMessages((m) => [...m, { role: "ai", text: data.answer, meta, cachedFrom: data.cachedFrom }]);
    } catch (err) {
      setMessages((m) => [...m, { role: "ai", error: err.name === "AbortError" ? "Stopped." : err.message }]);
    } finally {
      setPending(null);
    }
  }

  const elapsed = pending ? now - pending.started : 0;
  const suggestions = ctx ? SUGGESTIONS.product : SUGGESTIONS.general;

  return (
    <aside className="assistant" aria-label="Ask the data">
      <div className="assistant-head">
        <div>
          <h2>Ask the data</h2>
          <div className="muted" style={{ fontSize: 12 }}>Answers come from the retail data agent</div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {messages.length > 0 && <button className="btn btn-ghost" onClick={() => setMessages([])} disabled={!!pending}>Clear</button>}
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close assistant"><Icon name="close" /></button>
        </div>
      </div>

      <div className="assistant-body" ref={bodyRef} aria-live="polite">
        {!messages.length && !pending && (
          <div className="suggestions">
            <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>Try asking</div>
            {suggestions.map((s) => <button key={s} className="suggestion" onClick={() => ask(s)}>{s}</button>)}
          </div>
        )}

        {messages.map((m, i) => m.role === "user" ? (
          <div key={i} className="msg-user">
            {m.text}
            {m.context && <div style={{ fontSize: 11, opacity: 0.8, marginTop: 3 }}>about {m.context}</div>}
          </div>
        ) : (
          <div key={i} className="msg-ai">
            {m.error ? <div className="banner">{m.error}</div> : <RichAnswer text={m.text} products={products} onOpenProduct={onOpenProduct} />}
            {m.cachedFrom && <div className="cached-from">Reused a verified answer to “{m.cachedFrom.question}”</div>}
            <Provenance meta={m.meta} />
          </div>
        ))}

        {pending && (
          <div className="thinking-box msg-ai" role="status">
            <div className="progress" aria-hidden="true" />
            <div className="status-line">
              {/* key swaps the text with a fade, in place; the line height never changes */}
              <span className="status-text" key={elapsed < 1500 ? "cache" : "agent"}>
                {elapsed < 1500 ? "Checking recent answers…" : "Querying the data agent, usually 10–30 s"}
              </span>
              <span className="num muted">{fmtMs(elapsed)}</span>
              <button className="link" style={{ marginLeft: "auto", fontSize: 13 }} onClick={() => pending.ctrl.abort()}>Stop</button>
            </div>
          </div>
        )}
      </div>

      <div className="assistant-foot">
        <div className="context-row">
          {context ? (
            useContext
              ? <><span className="chip accent">Context: {context.name}</span><button className="link" style={{ fontSize: 12 }} onClick={() => setUseContext(false)}>remove</button></>
              : <button className="link" style={{ fontSize: 12 }} onClick={() => setUseContext(true)}>Ask about {context.name}</button>
          ) : <span>Asking about all products</span>}
        </div>
        <form className="ask-form" onSubmit={(e) => { e.preventDefault(); ask(text); }}>
          <label htmlFor="ask" className="sr-only">Your question</label>
          <input id="ask" className="input" value={text} onChange={(e) => setText(e.target.value)}
            placeholder={`Ask a question about the data (${IS_MAC ? "⌘" : "Ctrl+"}K)`} disabled={!!pending} />
          <button className="btn btn-primary" disabled={!!pending || !text.trim()}>Ask</button>
        </form>
      </div>
    </aside>
  );
}
