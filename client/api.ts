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
  // Messenger, Facebook Pages only (Step 9). Personal Messenger has no
  // supported API, so there is no route for it.
  messengerStatus: () =>
    req(`/api/messenger/status?accountId=${encodeURIComponent(getAccountId())}`),
  messengerThreads: () =>
    req(`/api/messenger/threads?accountId=${encodeURIComponent(getAccountId())}`),
  messengerMessages: (conversationId: string) =>
    req(
      `/api/messenger/messages?accountId=${encodeURIComponent(getAccountId())}&conversationId=${encodeURIComponent(conversationId)}`,
    ),
  messengerSend: (conversationId: string, text: string) =>
    req("/api/messenger/send", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), conversationId, text }),
    }),
  // Live web research with sources (Step 10), and the Stripe webhook
  // status that decides whether purchases unlock automatically.
  research: (query: string) =>
    req("/api/research", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), query }),
    }),
  stripeStatus: () => req("/api/stripe/status"),
  inboxes: () => req(`/api/inboxes?accountId=${encodeURIComponent(getAccountId())}`),
  saveDraft: (label: string, to: string, subject: string, body: string) =>
    req("/api/inboxes/draft", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), label, to, subject, body }),
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
