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
  // Streaming chat: the reply arrives as server-sent events, one
  // {"delta": "..."} per piece, then {"done": true, ...} at the end.
  // onEvent fires for every event. Throws only when the request itself
  // fails to reach the server (the caller falls back to chat() then);
  // a brain error arrives as an { error, message } event instead.
  chatStream: async (
    photon: string,
    message: string,
    onEvent: (ev: {
      delta?: string;
      done?: boolean;
      reply?: string;
      meter?: any;
      error?: string;
      message?: string;
    }) => void,
  ): Promise<void> => {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-account-id": getAccountId(),
      },
      body: JSON.stringify({ accountId: getAccountId(), photon, message }),
    });
    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream")) {
      // Not a stream: a gating error in plain JSON, or a proxy that
      // swallowed the stream. Surface it as one error event.
      const r = await res.json().catch(() => null);
      onEvent({
        error: r?.error || "bad_response",
        message: r?.message || "Something went wrong. Try that again in a moment.",
      });
      return;
    }
    if (!res.body) {
      onEvent({ error: "bad_response", message: "Something went wrong. Try that again in a moment." });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload));
        } catch {
          // A torn line is skipped; the next event still parses.
        }
      }
    }
  },
  voice: (photon: string) =>
    req("/api/voice", { method: "POST", body: JSON.stringify({ accountId: getAccountId(), photon }) }),
  inboxes: () => req(`/api/inboxes?accountId=${encodeURIComponent(getAccountId())}`),
  saveDraft: (label: string, to: string, subject: string, body: string) =>
    req("/api/inboxes/draft", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), label, to, subject, body }),
    }),
  // Switchboard: email sends to approved contacts, and the friend-request
  // flow that approves a new contact first.
  contacts: () => req(`/api/contacts?accountId=${encodeURIComponent(getAccountId())}`),
  requestContact: (photon: string, name: string, address: string) =>
    req("/api/contacts/request", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), photon, name, address }),
    }),
  switchboardSend: (photon: string, to: string, subject: string, body: string, name?: string) =>
    req("/api/switchboard/send", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), photon, to, subject, body, name }),
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
