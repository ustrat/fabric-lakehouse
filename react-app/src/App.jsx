import { useState, useCallback } from "react";
import { useMsal, useIsAuthenticated, AuthenticatedTemplate, UnauthenticatedTemplate } from "@azure/msal-react";
import { InteractionRequiredAuthError } from "@azure/msal-browser";
import { apiRequest, API_BASE_URL } from "./authConfig";

function SignInScreen() {
  const { instance } = useMsal();
  return (
    <div style={styles.centered}>
      <h1>Uprise Strategy Operational Dashboard</h1>
      <p>Sign in with your organizational account to continue.</p>
      <button style={styles.button} onClick={() => instance.loginPopup(apiRequest)}>
        Sign in with Microsoft
      </button>
    </div>
  );
}

function useApiToken() {
  const { instance, accounts } = useMsal();

  return useCallback(async () => {
    const account = accounts[0];
    try {
      const result = await instance.acquireTokenSilent({ ...apiRequest, account });
      return result.accessToken;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        const result = await instance.acquireTokenPopup(apiRequest);
        return result.accessToken;
      }
      throw err;
    }
  }, [instance, accounts]);
}

function Dashboard() {
  const getToken = useApiToken();
  const [indicators, setIndicators] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadIndicators = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const resp = await fetch(`${API_BASE_URL}/api/indicators`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`API returned ${resp.status}`);
      setIndicators(await resp.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  return (
    <div style={styles.panel}>
      <h2>Supply Chain Dashboard</h2>
      <button style={styles.button} onClick={loadIndicators} disabled={loading}>
        {loading ? "Loading..." : "Refresh indicators"}
      </button>
      {error && <p style={styles.error}>{error}</p>}
      {indicators && (
        <table style={styles.table}>
          <thead>
            <tr>
              <th>Series</th>
              <th>Metric</th>
              <th>Value</th>
              <th>As of</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {indicators.map((row) => (
              <tr key={row.series_id}>
                <td>{row.series_id}</td>
                <td>{row.metric_name}</td>
                <td>{row.value}</td>
                <td>{row.observation_date}</td>
                <td>{row.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Chat() {
  const getToken = useApiToken();
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const sendMessage = useCallback(
    async (e) => {
      e.preventDefault();
      if (!message.trim()) return;
      setLoading(true);
      setError(null);
      setReply(null);
      try {
        const token = await getToken();
        const resp = await fetch(`${API_BASE_URL}/api/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ message }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `API returned ${resp.status}`);
        setReply(data.reply);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [message, getToken]
  );

  return (
    <div style={styles.panel}>
      <h2>Ask about the data</h2>
      <form onSubmit={sendMessage} style={styles.chatForm}>
        <input
          style={styles.input}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="e.g. What is the current GSCPI value?"
        />
        <button style={styles.button} type="submit" disabled={loading}>
          {loading ? "Asking..." : "Ask"}
        </button>
      </form>
      {error && <p style={styles.error}>{error}</p>}
      {reply && <p style={styles.reply}>{reply}</p>}
    </div>
  );
}

function UserBadge() {
  const { instance, accounts } = useMsal();
  const name = accounts[0]?.name || accounts[0]?.username || "signed in user";
  return (
    <div style={styles.userBar}>
      <span>Signed in as {name}</span>
      <button style={styles.linkButton} onClick={() => instance.logoutPopup()}>
        Sign out
      </button>
    </div>
  );
}

export default function App() {
  const isAuthenticated = useIsAuthenticated();

  return (
    <div style={styles.app}>
      <UnauthenticatedTemplate>
        <SignInScreen />
      </UnauthenticatedTemplate>
      <AuthenticatedTemplate>
        <UserBadge />
        <Dashboard />
        <Chat />
      </AuthenticatedTemplate>
    </div>
  );
}

const styles = {
  app: { fontFamily: "system-ui, sans-serif", maxWidth: 900, margin: "0 auto", padding: 24 },
  centered: { textAlign: "center", marginTop: 80 },
  panel: { border: "1px solid #ddd", borderRadius: 8, padding: 20, marginTop: 20 },
  button: { padding: "8px 16px", borderRadius: 6, border: "1px solid #444", background: "#222", color: "#fff", cursor: "pointer" },
  linkButton: { background: "none", border: "none", color: "#0066cc", cursor: "pointer", textDecoration: "underline" },
  userBar: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #eee" },
  table: { width: "100%", borderCollapse: "collapse", marginTop: 16 },
  error: { color: "#c0392b" },
  reply: { marginTop: 12, padding: 12, background: "#f5f5f5", borderRadius: 6, whiteSpace: "pre-wrap" },
  chatForm: { display: "flex", gap: 8 },
  input: { flex: 1, padding: 8, borderRadius: 6, border: "1px solid #ccc" },
};
