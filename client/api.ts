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

// Signing in swaps the anonymous device id for the Google-linked
// account id, and signing out swaps back to a fresh device id. The
// server is the source of truth either way; this only changes what the
// browser sends.
export function setAccountId(id: string): void {
  try {
    localStorage.setItem("prism5.accountId", id);
  } catch {
    // Private mode: the id lasts for this session only.
  }
}

export function clearAccountId(): void {
  try {
    localStorage.removeItem("prism5.accountId");
  } catch {
    // Nothing stored, nothing to clear.
  }
}

// Every API call answers instead of hanging: a stalled request used
// to leave the app on a loading line with no error and no state — the
// "connecting forever" the owner reported. Calls answer
// { ok: false, error: "timeout" } after `ms` (30s by default) or
// { ok: false, error: "network" } when the fetch itself fails, so boot
// and every tab load always reach render. Chat replies can legitimately
// take longer than 30s, so chat() passes a longer budget.
async function req(path: string, opts: RequestInit = {}, ms = 30000): Promise<any> {
  try {
    const res = await fetch(path, {
      ...opts,
      signal: AbortSignal.timeout(ms),
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
  } catch (e: any) {
    return { ok: false, error: e?.name === "TimeoutError" ? "timeout" : "network" };
  }
}

// Boot-critical calls (state, session exchange) must never hang the
// app: a stalled /api/state used to leave the app an unrendered shell
// with no sign-in button anywhere — it read as a frozen sign-in page.
// They answer { ok: false, error: "timeout" } after 10s instead of
// hanging, so boot always reaches render.
async function reqTimeout(path: string, opts: RequestInit = {}, ms = 10000): Promise<any> {
  try {
    const res = await fetch(path, {
      ...opts,
      signal: AbortSignal.timeout(ms),
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
  } catch (e: any) {
    return { ok: false, error: e?.name === "TimeoutError" ? "timeout" : "network" };
  }
}

export const api = {
  state: () => reqTimeout(`/api/state?accountId=${encodeURIComponent(getAccountId())}`),
  store: () => req("/api/store"),
  seed: () => req("/api/seed"),
  redeem: (code: string) =>
    req("/api/redeem", { method: "POST", body: JSON.stringify({ accountId: getAccountId(), code }) }),
  setCustomName: (name: string) =>
    req("/api/custom-name", { method: "POST", body: JSON.stringify({ accountId: getAccountId(), name }) }),
  // Nova settings (Nov 19, 2026): the gentler default — check-ins and
  // getting-started nudges, on for Nova owners until they switch one off.
  novaSettings: (patch: { checkIns?: boolean; gettingStartedNudges?: boolean }) =>
    req("/api/nova-settings", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), ...patch }),
    }),
  thread: (photon: string) =>
    req(`/api/threads/${encodeURIComponent(photon)}?accountId=${encodeURIComponent(getAccountId())}`),
  // Conversation export: a direct download URL (not a req() call — the
  // answer is a Markdown file, not JSON), carrying the current account id
  // exactly as the thread read does.
  threadExportUrl: (photon: string) =>
    `/api/threads/${encodeURIComponent(photon)}/export?accountId=${encodeURIComponent(getAccountId())}`,
  pinned: () => req(`/api/pinned?accountId=${encodeURIComponent(getAccountId())}`),
  pin: (photon: string) =>
    req(`/api/threads/${encodeURIComponent(photon)}/pin`, {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId() }),
    }),
  unpin: (photon: string) =>
    req(`/api/threads/${encodeURIComponent(photon)}/unpin`, {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId() }),
    }),
  chat: (photon: string, message: string) =>
    req(
      "/api/chat",
      {
        method: "POST",
        body: JSON.stringify({ accountId: getAccountId(), photon, message }),
      },
      120000,
    ),
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
  // Live voice (Step 5): turn-based only. Status first, then transcribe a
  // recorded turn, then say a reply out loud. say returns audio/mpeg, not
  // JSON, so it goes through fetch directly, not req().
  voiceStatus: () => req(`/api/voice/status?accountId=${encodeURIComponent(getAccountId())}`),
  voiceSay: async (
    photon: string,
    text: string,
  ): Promise<{ ok: boolean; blob?: Blob; fallback?: boolean; error?: string; message?: string }> => {
    const res = await fetch("/api/voice/say", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-account-id": getAccountId(),
      },
      body: JSON.stringify({ accountId: getAccountId(), photon, text }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      return { ok: false, error: j?.error, message: j?.message || "I couldn't say that one out loud." };
    }
    return { ok: true, blob: await res.blob(), fallback: res.headers.get("x-voice-fallback") === "true" };
  },
  voiceTranscribe: async (
    photon: string,
    blob: Blob,
  ): Promise<{ ok: boolean; text?: string; error?: string; message?: string }> => {
    const form = new FormData();
    form.append("accountId", getAccountId());
    form.append("photon", photon);
    form.append("file", blob, "voice-note.webm");
    const res = await fetch("/api/voice/transcribe", {
      method: "POST",
      headers: { "x-account-id": getAccountId() },
      body: form,
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) {
      return { ok: false, error: j?.error, message: j?.message || "I couldn't hear that one — try again." };
    }
    return { ok: true, text: j.text || "" };
  },
  // Proactive checks, reminders, push (Step 3).
  proactiveStatus: () =>
    req(`/api/proactive/status?accountId=${encodeURIComponent(getAccountId())}`),
  proactiveCheck: () =>
    req("/api/proactive/check", { method: "POST", body: JSON.stringify({ accountId: getAccountId() }) }),
  reminders: () => req(`/api/reminders?accountId=${encodeURIComponent(getAccountId())}`),
  reminderCreate: (text: string, remindAt: string) =>
    req("/api/reminders", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), text, remind_at: remindAt }),
    }),
  reminderDone: (id: string) =>
    req(`/api/reminders/${encodeURIComponent(id)}/done`, {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId() }),
    }),
  // Start My Day — the morning briefing Plug. The briefing is read-only;
  // dayConfirm is the only call that edits anything, and the client only
  // calls it after the owner's tap on that item.
  dayBriefing: (timeMin: string, timeMax: string, date: string) => {
    const q = new URLSearchParams({ accountId: getAccountId(), timeMin, timeMax, date });
    return req(`/api/day/briefing?${q.toString()}`);
  },
  dayItems: () => req(`/api/day/items?accountId=${encodeURIComponent(getAccountId())}`),
  dayAddItem: (title: string, detail?: string, due?: string) =>
    req("/api/day/items", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), title, detail: detail || undefined, due: due || undefined }),
    }),
  dayConfirm: (kind: string, id: string, action: string, extra?: Record<string, unknown>) =>
    req("/api/day/confirm", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), kind, id, action, ...(extra || {}) }),
    }),
  pushStatus: () => req(`/api/push/status?accountId=${encodeURIComponent(getAccountId())}`),
  pushSubscribe: (subscription: unknown) =>
    req("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), subscription }),
    }),
  pushUnsubscribe: (endpoint?: string) =>
    req("/api/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({
        accountId: getAccountId(),
        ...(endpoint ? { endpoint } : {}),
      }),
    }),
  // Messenger, Facebook Pages only (Step 9). Personal Messenger has no
  // supported API, so there is no route for it. A Page can be connected
  // from the app with a Page access token (connect), and the threads,
  // messages, and send calls take an optional pageId to use that Page
  // instead of the server's Page.
  messengerStatus: () =>
    req(`/api/messenger/status?accountId=${encodeURIComponent(getAccountId())}`),
  messengerPages: () =>
    req(`/api/messenger/pages?accountId=${encodeURIComponent(getAccountId())}`),
  messengerConnect: (token: string) =>
    req("/api/messenger/connect", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), token }),
    }),
  messengerDisconnect: (pageId: string) =>
    req("/api/messenger/disconnect", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), pageId }),
    }),
  messengerThreads: (pageId?: string) => {
    const q = new URLSearchParams({ accountId: getAccountId() });
    if (pageId) q.set("pageId", pageId);
    return req(`/api/messenger/threads?${q.toString()}`);
  },
  messengerMessages: (conversationId: string, pageId?: string) => {
    const q = new URLSearchParams({
      accountId: getAccountId(),
      conversationId,
    });
    if (pageId) q.set("pageId", pageId);
    return req(`/api/messenger/messages?${q.toString()}`);
  },
  messengerSend: (conversationId: string, text: string, pageId?: string) =>
    req("/api/messenger/send", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), conversationId, text, pageId: pageId || "" }),
    }),
  // Live web research with sources (Step 10), and the Stripe webhook
  // status that decides whether purchases unlock automatically.
  research: (query: string) =>
    req("/api/research", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), query }),
    }),
  stripeStatus: () => req("/api/stripe/status"),
  // Google sign-in for the app itself. authSession spends the one-time
  // token the OAuth callback hands back; the account id it returns is
  // the one the browser uses from then on.
  authStatus: () => req(`/api/auth/status?accountId=${encodeURIComponent(getAccountId())}`),
  authSession: (token: string) =>
    reqTimeout("/api/auth/session", { method: "POST", body: JSON.stringify({ token }) }),
  // Sign-in recovery: ask the server which account this device id was
  // linked to, if it ever signed in. The OAuth callback records the
  // link at sign-in time; when the callback was completed in another
  // browsing context (Android diverts the installed app's sign-in to a
  // browser tab, and the one-time token is spent there), this is how
  // the installed app learns its account in its own context instead of
  // asking the owner to sign in again.
  authRecover: () =>
    reqTimeout("/api/auth/recover", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId() }),
    }),
  inboxes: () => req(`/api/inboxes?accountId=${encodeURIComponent(getAccountId())}`),
  gmailMessage: (label: string, id: string) =>
    req(
      `/api/gmail/message?accountId=${encodeURIComponent(getAccountId())}&label=${encodeURIComponent(label)}&id=${encodeURIComponent(id)}`,
    ),
  saveDraft: (label: string, to: string, subject: string, body: string) =>
    req("/api/inboxes/draft", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), label, to, subject, body }),
    }),
  // Outlook mail (Microsoft Graph): the same shape as Gmail, so an
  // Outlook mailbox shows as its own card and can save real drafts.
  outlookInboxes: () => req(`/api/outlook/inboxes?accountId=${encodeURIComponent(getAccountId())}`),
  outlookMessage: (label: string, id: string) =>
    req(
      `/api/outlook/message?accountId=${encodeURIComponent(getAccountId())}&label=${encodeURIComponent(label)}&id=${encodeURIComponent(id)}`,
    ),
  outlookDraft: (label: string, to: string, subject: string, body: string) =>
    req("/api/outlook/draft", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), label, to, subject, body }),
    }),
  // IMAP mail (Yahoo, Apple Mail, any other IMAP mailbox): the same
  // shape as Gmail and Outlook, so an IMAP mailbox shows as its own
  // card and can save real drafts. The sign-in is an app-specific
  // password, tested by the server before it is stored.
  imapProviders: () => req("/api/imap/providers"),
  imapInboxes: () => req(`/api/imap/inboxes?accountId=${encodeURIComponent(getAccountId())}`),
  imapConnect: (provider: string, email: string, password: string, host?: string) =>
    req("/api/imap/connect", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), provider, email, password, host: host || "" }),
    }),
  imapMessage: (label: string, id: string) =>
    req(
      `/api/imap/message?accountId=${encodeURIComponent(getAccountId())}&label=${encodeURIComponent(label)}&id=${encodeURIComponent(id)}`,
    ),
  imapDraft: (label: string, to: string, subject: string, body: string) =>
    req("/api/imap/draft", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), label, to, subject, body }),
    }),
  imapDisconnect: (label: string) =>
    req("/api/imap/disconnect", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), label }),
    }),
  // About you: what the owner tells Prism about themselves, so the
  // Photons know them instead of starting cold.
  profileGet: () => req(`/api/profile?accountId=${encodeURIComponent(getAccountId())}`),
  profileSave: (patch: Record<string, unknown>) =>
    req("/api/profile", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), ...patch }),
    }),
  // Memory imported from another AI: what the owner already told an
  // assistant, so they keep continuity and do not start over.
  memoryList: () => req(`/api/memory?accountId=${encodeURIComponent(getAccountId())}`),
  memoryImport: (source: string, title: string, content: string) =>
    req("/api/memory", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), source, title, content }),
    }),
  memoryDelete: (id: number) =>
    req(`/api/memory/${encodeURIComponent(id)}?accountId=${encodeURIComponent(getAccountId())}`, {
      method: "DELETE",
    }),
  // Switchboard: email sends to approved contacts, and the friend-request
  // flow that approves a new contact first.
  contacts: () => req(`/api/contacts?accountId=${encodeURIComponent(getAccountId())}`),
  requestContact: (photon: string, name: string, address: string, phone?: string) =>
    req("/api/contacts/request", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), photon, name, address, phone: phone || "" }),
    }),
  switchboardSend: (photon: string, to: string, subject: string, body: string, name?: string) =>
    req("/api/switchboard/send", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), photon, to, subject, body, name }),
    }),
  // Texts & calls (Twilio). Status first: nothing is claimed to work
  // until the server says the number is connected.
  textsStatus: () => req(`/api/texts/status?accountId=${encodeURIComponent(getAccountId())}`),
  texts: (limit = 50) =>
    req(`/api/texts?accountId=${encodeURIComponent(getAccountId())}&limit=${limit}`),
  sendText: (to: string, body: string) =>
    req("/api/texts/send", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), to, body }),
    }),
  calls: (limit = 50) =>
    req(`/api/calls?accountId=${encodeURIComponent(getAccountId())}&limit=${limit}`),
  // Calendar (Google). Events default to now through 7 days out on the
  // server when no window is given.
  calendarStatus: () => req(`/api/calendar/status?accountId=${encodeURIComponent(getAccountId())}`),
  calendarEvents: (timeMin?: string, timeMax?: string) => {
    const q = new URLSearchParams({ accountId: getAccountId() });
    if (timeMin) q.set("timeMin", timeMin);
    if (timeMax) q.set("timeMax", timeMax);
    return req(`/api/calendar/events?${q.toString()}`);
  },
  calendarFreeBusy: (timeMin?: string, timeMax?: string) => {
    const q = new URLSearchParams({ accountId: getAccountId() });
    if (timeMin) q.set("timeMin", timeMin);
    if (timeMax) q.set("timeMax", timeMax);
    return req(`/api/calendar/freebusy?${q.toString()}`);
  },
  bookCalendar: (title: string, start: string, end: string, description?: string, attendees?: string[]) =>
    req("/api/calendar/book", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), title, start, end, description, attendees }),
    }),
  cancelCalendar: (eventId: string) =>
    req("/api/calendar/cancel", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), eventId }),
    }),
  // Drive (Google). Search lists files; file reads one as text (Docs as
  // text, Sheets as CSV). Some types cannot be read — the server says so.
  driveStatus: () => req(`/api/drive/status?accountId=${encodeURIComponent(getAccountId())}`),
  driveSearch: (q?: string) => {
    const p = new URLSearchParams({ accountId: getAccountId() });
    if (q) p.set("q", q);
    return req(`/api/drive/search?${p.toString()}`);
  },
  driveFile: (id: string) =>
    req(`/api/drive/file?accountId=${encodeURIComponent(getAccountId())}&id=${encodeURIComponent(id)}`),
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
