// API client for the standalone app. The account id is generated once on
// the device and stored locally; the server creates the account on first
// sight. Nothing about the account leaves the device except this id.

export function getAccountId(): string {
  let id = "";
  try {
    id = localStorage.getItem("prism5.accountId") || "";
  } catch {
    id = "";
  }
  if (!id) {
    id = "acc_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    try {
      localStorage.setItem("prism5.accountId", id);
    } catch {
      // Private mode: the id lasts for this session only.
    }
  }
  return id;
}

async function req(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "content-type": "application/json",
      "x-account-id": getAccountId(),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: "bad_response", raw: text.slice(0, 200) };
  }
}

export const api = {
  state: () => req(`/api/state?accountId=${encodeURIComponent(getAccountId())}`),
  store: () => req("/api/store"),
  seed: () => req("/api/seed"),
  redeem: (code: string) =>
    req("/api/redeem", { method: "POST", body: JSON.stringify({ accountId: getAccountId(), code }) }),
  setCustomName: (name: string) =>
    req("/api/custom-name", { method: "POST", body: JSON.stringify({ accountId: getAccountId(), name }) }),
  thread: (photon: string) =>
    req(`/api/threads/${encodeURIComponent(photon)}?accountId=${encodeURIComponent(getAccountId())}`),
  chat: (photon: string, message: string) =>
    req("/api/chat", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), photon, message }),
    }),
  voice: (photon: string) =>
    req("/api/voice", { method: "POST", body: JSON.stringify({ accountId: getAccountId(), photon }) }),
  inboxes: () => req(`/api/inboxes?accountId=${encodeURIComponent(getAccountId())}`),
  saveDraft: (label: string, to: string, subject: string, body: string) =>
    req("/api/inboxes/draft", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), label, to, subject, body }),
    }),
  // Per-Photon customization (name, voice, look). Progress saved per
  // Photon so the owner picks up where they left off.
  customizeGet: (photon: string) =>
    req(
      `/api/customize?accountId=${encodeURIComponent(getAccountId())}&photon=${encodeURIComponent(photon)}`,
    ),
  customizeSave: (photon: string, patch: Record<string, unknown>) =>
    req("/api/customize", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), photon, ...patch }),
    }),
};
