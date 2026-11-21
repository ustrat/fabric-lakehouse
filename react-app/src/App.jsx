import { useEffect, useState } from "react";
import { useMsal, AuthenticatedTemplate, UnauthenticatedTemplate } from "@azure/msal-react";
import { apiRequest } from "./authConfig";
import { DEMO } from "./api";
import Products from "./pages/Products";
import Analytics from "./pages/Analytics";
import SupplyChain from "./pages/SupplyChain";
import Assistant from "./components/Assistant";
import Icon from "./components/Icon";
import "./styles.css";

const PAGES = [
  { id: "products", label: "Products", icon: "products" },
  { id: "analytics", label: "Rating trends", icon: "trends" },
  { id: "supply", label: "Supply chain", icon: "supply" },
];

function SignInScreen() {
  const { instance } = useMsal();
  return (
    <div className="signin">
      <div className="card">
        <div className="brand-mark" style={{ margin: "0 auto", width: 40, height: 40, fontSize: 18 }}>U</div>
        <h1>Uprise Strategy Operations</h1>
        <p className="muted" style={{ margin: 0 }}>Sign in with your work account to continue.</p>
        <button className="btn btn-primary" style={{ justifyContent: "center" }} onClick={() => instance.loginPopup(apiRequest)}>
          Sign in with Microsoft
        </button>
      </div>
    </div>
  );
}

function Workspace() {
  const { instance, accounts } = useMsal();
  const [page, setPage] = useState("products");
  const [product, setProduct] = useState(null);
  const [known, setKnown] = useState([]); // products seen in search results; lets AI answers link to them
  const remember = (list) => setKnown((prev) => {
    const byId = new Map(prev.map((p) => [p.productId, p]));
    list.forEach((p) => byId.set(p.productId, { productId: p.productId, name: p.name }));
    return [...byId.values()];
  });
  const openProduct = (p) => { setProduct(p); setPage("products"); };

  // Keyboard: "/" search products, Ctrl/Cmd+K ask the data, Esc closes the assistant.
  useEffect(() => {
    const focusSoon = (id) => setTimeout(() => document.getElementById(id)?.focus(), 0); // after React renders the target
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setAssistantOpen(true);
        focusSoon("ask");
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        setPage("products");
        focusSoon("product-q");
      } else if (e.key === "Escape" && (!typing || e.target.id === "ask")) {
        setAssistantOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [assistantOpen, setAssistantOpen] = useState(window.innerWidth > 1180);
  const name = DEMO ? "Demo user" : accounts[0]?.name || accounts[0]?.username;

  return (
    <div className={`shell ${assistantOpen ? "" : "no-assistant"}`}>
      <nav className="sidebar" aria-label="Main">
        <div className="brand"><span className="brand-mark">U</span><span>Operations</span></div>
        {PAGES.map((p) => (
          <button key={p.id} className="nav-item" aria-current={page === p.id ? "page" : undefined} onClick={() => setPage(p.id)}>
            <Icon name={p.icon} />{p.label}
          </button>
        ))}
        {!assistantOpen && (
          <button className="nav-item" onClick={() => setAssistantOpen(true)}><Icon name="sparkle" />Ask the data</button>
        )}
        <div className="sidebar-foot">
          {DEMO && <span className="chip accent" style={{ justifySelf: "start" }}>Demo data</span>}
          <span>{name}</span>
          {!DEMO && <button className="link" style={{ justifySelf: "start", fontSize: 12 }} onClick={() => instance.logoutPopup()}>Sign out</button>}
        </div>
      </nav>

      <main className="main">
        {page === "products" && <Products selected={product} onSelect={setProduct} onResults={remember} />}
        {page === "analytics" && <Analytics />}
        {page === "supply" && <SupplyChain />}
      </main>

      {assistantOpen && (
        <Assistant context={page === "products" ? product : null} products={known} onOpenProduct={openProduct}
          onClose={() => setAssistantOpen(false)} />
      )}
    </div>
  );
}

export default function App() {
  if (DEMO) return <Workspace />;
  return (
    <>
      <UnauthenticatedTemplate><SignInScreen /></UnauthenticatedTemplate>
      <AuthenticatedTemplate><Workspace /></AuthenticatedTemplate>
    </>
  );
}
