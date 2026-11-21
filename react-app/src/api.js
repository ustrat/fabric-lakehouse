import { useCallback } from "react";
import { useMsal } from "@azure/msal-react";
import { InteractionRequiredAuthError } from "@azure/msal-browser";
import { apiRequest, API_BASE_URL } from "./authConfig";
import { mockFetch } from "./mock";

// Demo mode serves canned registry responses so the UI can be shown while the capacity is paused.
// Enable with ?demo in the URL or VITE_DEMO=1.
export const DEMO = new URLSearchParams(window.location.search).has("demo") || import.meta.env.VITE_DEMO === "1";

export function useApiToken() {
  const { instance, accounts } = useMsal();
  return useCallback(async () => {
    const account = accounts[0];
    try {
      return (await instance.acquireTokenSilent({ ...apiRequest, account })).accessToken;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) return (await instance.acquireTokenPopup(apiRequest)).accessToken;
      throw err;
    }
  }, [instance, accounts]);
}

// Every registry response is { ...body, _meta }. Returns { data, meta } or throws with the API's error text.
export function useApi() {
  const getToken = useApiToken();
  return useCallback(
    async (path, { method = "GET", body, signal } = {}) => {
      if (DEMO) return mockFetch(path, { method, body, signal });
      const token = await getToken();
      const resp = await fetch(`${API_BASE_URL}${path}`, {
        method,
        signal,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await resp.json().catch(() => ({}));
      if (resp.ok && Array.isArray(json)) return { data: json, meta: {} }; // older non-registry endpoints
      const { _meta: meta, ...data } = json;
      if (!resp.ok) throw Object.assign(new Error(data.error || `Request failed (${resp.status})`), { status: resp.status, meta });
      return { data, meta: meta || {} };
    },
    [getToken]
  );
}
