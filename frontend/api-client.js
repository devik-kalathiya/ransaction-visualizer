/**
 * TxnApi - thin wrapper around the TXN Studio backend REST API.
 *
 * Every method resolves to `null` (rather than throwing) when the
 * backend is unreachable, so the frontend simulator keeps working
 * fully offline (per the "backend-ready" design note in the help
 * modal) - the backend just adds persistence, AI explanations and
 * PDF/JSON export on top.
 *
 * Override window.TXN_API_BASE before this script loads to point at
 * a different backend host, e.g.:
 *   <script>window.TXN_API_BASE = "https://your-api.example.com/api";</script>
 */
const TxnApi = (() => {
  const BASE = window.TXN_API_BASE || "/api";

  async function safeFetch(path, options) {
    try {
      const res = await fetch(BASE + path, {
        headers: { "Content-Type": "application/json" },
        ...options,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        return { ok: false, status: res.status, error: (data && data.error) || res.statusText, body: data };
      }
      return { ok: true, status: res.status, body: data };
    } catch (err) {
      return { ok: false, status: 0, error: "Backend unreachable", networkError: true };
    }
  }

  return {
    health: () => safeFetch("/health"),

    createTransaction: (payload) =>
      safeFetch("/transactions", { method: "POST", body: JSON.stringify(payload) }),

    transition: (id, to, note) =>
      safeFetch(`/transactions/${id}/transition`, {
        method: "POST",
        body: JSON.stringify({ to, note }),
      }),

    fail: (id) => safeFetch(`/transactions/${id}/fail`, { method: "POST" }),

    reset: (id) => safeFetch(`/transactions/${id}/reset`, { method: "POST" }),

    explain: (id, fresh) => safeFetch(`/transactions/${id}/explain${fresh ? "?fresh=true" : ""}`),
    ask: (id, question) =>safeFetch(`/transactions/${id}/ask`, {method: "POST",body: JSON.stringify({ question }),}),

    history: (limit = 20) => safeFetch(`/transactions?limit=${limit}`),

    get: (id) => safeFetch(`/transactions/${id}`),
    exportUrl: (id, format = "pdf") => `${BASE}/transactions/${id}/export?format=${format}&t=${Date.now()}`,
  };
})();
