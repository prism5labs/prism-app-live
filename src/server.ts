// Prism 5 — standalone server (Bun + TypeScript, zero npm dependencies).
// Serves the PWA shell from public/ and the JSON API under /api/.
// No @hatch/space-sdk, no artifact runtime: plain Bun.serve, bun:sqlite,
// and fetch for the brain and Gmail.

import { join, normalize, extname } from "node:path";
import { config, brainConnected, brainProvider, googleConfigured } from "./server/config";
import {
  getOrCreateAccount,
  getOwned,
  ownsPhoton,
  getThread,
  addMessage,
  incrementMeter,
  meterState,
  redeemFreeCode,
  setCustomName,
  isUnlimited,
  getCustomization,
  getCustomizations,
  saveCustomization,
} from "./server/db";
import { chat as brainChat } from "./server/anthropic";
import { chat as geminiChat, chatStream as geminiChatStream } from "./server/gemini";
import { systemPromptFor } from "./server/personas";
import { voiceById } from "./shared/voices";
import {
  PHOTONS,
  photonByName,
  PHOTON_NAMES,
} from "./shared/photons";
import { SUPERNOVA, SATELLITE, UPKEEP, PRODUCTS, CATEGORIES } from "./shared/catalog";
import {
  authUrl,
  handleOAuthCallback,
  listInbox,
  saveDraft,
  connectedLabels,
  GMAIL_LABELS,
  GMAIL_LABEL_TITLES,
  type GmailLabel,
} from "./server/gmail";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bad(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function accountIdFrom(req: Request, body: any): string {
  const fromBody = typeof body?.accountId === "string" ? body.accountId.trim() : "";
  if (fromBody) return fromBody;
  const fromHeader = req.headers.get("x-account-id") || "";
  if (fromHeader.trim()) return fromHeader.trim();
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("accountId") || "";
  return fromQuery.trim();
}

function isValidAccountId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(id);
}

// Plain words for a brain failure, shared by the chat endpoints.
function brainErrorMessage(error: string): string {
  return error === "brain_unreachable" || error === "brain_error"
    ? "Something went wrong on my end. Try that again in a moment."
    : "The brain isn't answering right now. Try that again in a moment.";
}

// Everything both chat endpoints check before the brain is called:
// the account, the Photon, ownership, the monthly meter, and that a brain
// is connected. Returns the error response to send, or the pieces the
// brain call needs.
async function prepareChat(
  req: Request,
  body: any,
): Promise<
  | { error: Response }
  | {
      error?: undefined;
      accountId: string;
      photon: string;
      message: string;
      system: string;
      history: { role: "user" | "assistant"; content: string }[];
    }
> {
  const accountId = accountIdFrom(req, body);
  if (!isValidAccountId(accountId)) return { error: bad("accountId required", 400) };
  const photon = String(body.photon || "");
  const message = String(body.message || "").trim();
  if (!photonByName(photon)) return { error: bad("unknown photon", 400) };
  if (!message) return { error: bad("message required", 400) };
  if (message.length > 4000) return { error: bad("message too long", 400) };

  if (!ownsPhoton(accountId, photon)) {
    return {
      error: json({
        ok: false,
        error: "not_owned",
        message: `You don't own ${photon} yet. You can buy ${photon} in the Store, or redeem a code in Upkeep.`,
      }),
    };
  }
  const a = getOrCreateAccount(accountId);
  if (!isUnlimited(a) && a.meter_used >= 300) {
    return {
      error: json({
        ok: false,
        error: "meter_exhausted",
        message:
          "You've used your 300 chats for this month. Upkeep gives you unlimited chat for $29 a month, or your allowance resets next month.",
      }),
    };
  }
  if (!brainConnected()) {
    return {
      error: json({
        ok: false,
        error: "brain_not_connected",
        message:
          "The brain isn't connected yet, so I can't answer that one. Your message wasn't saved and it didn't use any of your chats.",
      }),
    };
  }
  const history = getThread(accountId, photon).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  // The Photon's saved customization (if any) names the Face and sets how
  // it talks. No customization row means chat behaves exactly as before.
  const c = getCustomization(accountId, photon);
  const system = systemPromptFor(photon, c?.faceName || a.custom_name || photon, c);
  return { accountId, photon, message, system, history };
}

// --- State ---
function stateFor(accountId: string) {
  const a = getOrCreateAccount(accountId);
  const owned = getOwned(accountId);
  const displayName = a.custom_name || "Prism 5";
  return {
    accountId,
    displayName,
    customName: a.custom_name,
    ownedPhotons: owned.photons,
    ownedProducts: owned.products,
    meter: meterState(a),
    upkeep: a.upkeep,
    freeCode: a.free_code,
    brain: brainConnected(),
    googleConfigured: googleConfigured(),
    customizations: getCustomizations(accountId),
    photons: PHOTONS.map((p) => ({
      name: p.name,
      pronoun: p.pronoun,
      tagline: p.tagline,
      focus: p.focus,
      owned: owned.photons.includes(p.name),
    })),
  };
}

async function handleApi(req: Request, path: string): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  // GET /api/state
  if (path === "/api/state" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return json({ ok: true, ...stateFor(accountId) });
  }

  // GET /api/store — the full catalog (the client also bundles it).
  if (path === "/api/store" && method === "GET") {
    return json({
      ok: true,
      supernova: SUPERNOVA,
      satellite: SATELLITE,
      upkeep: UPKEEP,
      categories: CATEGORIES,
      products: PRODUCTS,
      photonNames: PHOTON_NAMES,
    });
  }

  // GET /api/seed — the deployed Prism starts with her persona, not the
  // Original's private memory. The full seed is never copied into this repo.
  if (path === "/api/seed" && method === "GET") {
    return json({
      ok: true,
      seeded: false,
      persona: "distilled",
      note: "Prism starts with her persona, not the Original's private memory. The full seed is never copied into this repo.",
    });
  }

  // POST /api/redeem — friends-and-family code, checked server-side only.
  if (path === "/api/redeem" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const code = String(body.code || "").replace(/\s+/g, "");
    if (!code) return bad("code required", 400);
    if (code === config.freeCode.replace(/\s+/g, "")) {
      redeemFreeCode(accountId);
      return json({
        ok: true,
        message: "That's the one. Everything's yours now.",
        ...stateFor(accountId),
      });
    }
    return json({ ok: false, message: "That code doesn't match" });
  }

  // GET /api/customize?photon= — the saved customization for one Photon.
  // POST /api/customize — save one step (or the whole flow) for one Photon.
  // Progress is per Photon, so the owner picks up where they left off.
  if (path === "/api/customize" && method === "GET") {
    const url = new URL(req.url);
    const photon = String(url.searchParams.get("photon") || "");
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    if (!photonByName(photon)) return bad("unknown photon", 400);
    if (!ownsPhoton(accountId, photon)) return bad("not_owned", 403);
    const c = getCustomization(accountId, photon);
    return json({
      ok: true,
      customization: c || {
        photon,
        faceName: null,
        voice: "house",
        tuning: null,
        lookSet: null,
        portrait: null,
        step: 0,
        done: false,
      },
    });
  }
  if (path === "/api/customize" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const photon = String(body.photon || "");
    if (!photonByName(photon)) return bad("unknown photon", 400);
    if (!ownsPhoton(accountId, photon)) return bad("not_owned", 403);
    const c = saveCustomization(accountId, photon, {
      faceName: body.faceName !== undefined ? body.faceName : undefined,
      voice: typeof body.voice === "string" ? body.voice : undefined,
      tuning:
        body.tuning && typeof body.tuning === "object" && !Array.isArray(body.tuning)
          ? body.tuning
          : undefined,
      lookSet: typeof body.lookSet === "string" || body.lookSet === null ? body.lookSet : undefined,
      portrait:
        typeof body.portrait === "string" || body.portrait === null ? body.portrait : undefined,
      step: typeof body.step === "number" ? body.step : undefined,
      done: typeof body.done === "boolean" ? body.done : undefined,
    });
    return json({ ok: true, customization: c });
  }

  // POST /api/custom-name — "Make it yours". Empty clears it.
  if (path === "/api/custom-name" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const name = String(body.name || "").trim().slice(0, 40);
    setCustomName(accountId, name ? name : null);
    return json({ ok: true, displayName: name || "Prism 5", customName: name || null });
  }

  // GET /api/threads/:photon
  const threadMatch = path.match(/^\/api\/threads\/([A-Za-z]+)$/);
  if (threadMatch && method === "GET") {
    const photon = threadMatch[1];
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    if (!photonByName(photon)) return bad("unknown photon", 400);
    return json({
      ok: true,
      photon,
      owned: ownsPhoton(accountId, photon),
      messages: getThread(accountId, photon),
    });
  }

  // POST /api/chat — server-side gating, meter, then the brain.
  if (path === "/api/chat" && method === "POST") {
    const body = await readBody(req);
    const prep = await prepareChat(req, body);
    if (prep.error) return prep.error;
    const { accountId, photon, message, system, history } = prep;
    // Anthropic takes precedence; Gemini is only the free bridge when no
    // Anthropic key is set. Gating and the meter already ran above and wrap
    // this call either way.
    const result =
      brainProvider() === "anthropic"
        ? await brainChat(system, history, message)
        : await geminiChat(system, history, message);
    if (!result.ok) {
      return json({ ok: false, error: result.error, message: brainErrorMessage(result.error) });
    }
    addMessage(accountId, photon, "user", message);
    addMessage(accountId, photon, "assistant", result.reply);
    incrementMeter(accountId);
    const after = getOrCreateAccount(accountId);
    return json({ ok: true, reply: result.reply, meter: meterState(after) });
  }

  // POST /api/chat/stream — the same chat, streamed. The reply arrives as
  // server-sent events, {"delta": "..."} as each piece lands, then
  // {"done": true, "reply": "...", "meter": {...}}. The thread and the
  // meter are only touched once the whole reply is in, exactly like
  // /api/chat, so a failed stream saves nothing and charges nothing.
  // Anthropic has no streaming client here, so it answers in one delta.
  if (path === "/api/chat/stream" && method === "POST") {
    const body = await readBody(req);
    const prep = await prepareChat(req, body);
    if (prep.error) return prep.error;
    const { accountId, photon, message, system, history } = prep;
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const sendRaw = (text: string) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(text));
          } catch {
            closed = true;
          }
        };
        const send = (obj: unknown) => sendRaw(`data: ${JSON.stringify(obj)}\n\n`);
        // Heartbeat: the free Gemini bridge can sit silent for minutes
        // before its first token, and an idle SSE connection is closed
        // after ~10s (Bun's default idleTimeout, and proxies in front).
        // A comment line every 5s keeps the stream alive while the brain
        // thinks. SSE comments are ignored by the client parser.
        sendRaw(": connected\n\n");
        const heartbeat = setInterval(() => sendRaw(": ping\n\n"), 5000);
        let full = "";
        try {
          if (brainProvider() === "anthropic") {
            const result = await brainChat(system, history, message);
            if (!result.ok) {
              send({ error: result.error, message: brainErrorMessage(result.error) });
              return;
            }
            full = result.reply;
            send({ delta: full });
          } else {
            const result = await geminiChatStream(system, history, message, (d) => {
              full += d;
              send({ delta: d });
            });
            if (!result.ok) {
              send({ error: result.error, message: brainErrorMessage(result.error) });
              return;
            }
            full = result.reply;
          }
          addMessage(accountId, photon, "user", message);
          addMessage(accountId, photon, "assistant", full);
          incrementMeter(accountId);
          const after = getOrCreateAccount(accountId);
          send({ done: true, reply: full, meter: meterState(after) });
        } catch (e) {
          console.error("chat stream failed:", e);
          send({ error: "brain_unreachable", message: brainErrorMessage("brain_unreachable") });
        } finally {
          clearInterval(heartbeat);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // Already closed; nothing left to do.
            }
          }
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  // POST /api/voice — the gate only. Live audio is not wired (no ElevenLabs).
  if (path === "/api/voice" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const photon = String(body.photon || "");
    if (!photonByName(photon)) return bad("unknown photon", 400);
    if (!ownsPhoton(accountId, photon)) {
      return json({
        ok: false,
        error: "not_owned",
        message: `You don't own ${photon} yet. You can buy ${photon} in the Store, or redeem a code in Upkeep.`,
      });
    }
    const a = getOrCreateAccount(accountId);
    if (!a.upkeep) {
      return json({
        ok: false,
        error: "needs_upkeep",
        message:
          "Live voice calls come with Upkeep, $29 a month. Upkeep also brings unlimited chat, Launch updates, and priority support.",
      });
    }
    // The saved voice pick rides with the call gate, so the call UI can show
    // the Photon's voice. The audio line itself is not wired yet.
    const c = getCustomization(accountId, photon);
    const voiceId = c?.voice || "house";
    return json({
      ok: true,
      status: "voice_pending",
      voice: voiceId,
      voiceName: voiceById(voiceId).name,
      message:
        "Live voice isn't wired up yet. The call button is here and the gate is on, but the voice line itself lands with the next build.",
    });
  }

  // GET /api/inboxes — all three Gmail accounts side by side.
  if (path === "/api/inboxes" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const connected = connectedLabels(accountId);
    const connectedSet = new Set(connected.map((c) => c.label));
    const results = await Promise.all(
      GMAIL_LABELS.map(async (label) => {
        const c = connected.find((x) => x.label === label);
        if (!c) {
          return {
            label,
            title: GMAIL_LABEL_TITLES[label],
            connected: false,
            email: null as string | null,
            messages: [],
          };
        }
        const r = await listInbox(accountId, label, 8);
        return {
          label,
          title: GMAIL_LABEL_TITLES[label],
          connected: r.connected,
          email: r.email || c.email,
          messages: r.messages,
          error: r.error || null,
        };
      }),
    );
    return json({
      ok: true,
      googleConfigured: googleConfigured(),
      accounts: results,
      _connectedLabels: [...connectedSet],
    });
  }

  // GET /api/oauth/google/start?accountId&label — begin a Gmail sign-in.
  if (path === "/api/oauth/google/start" && method === "GET") {
    const accountId = url.searchParams.get("accountId") || "";
    const label = url.searchParams.get("label") || "";
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    if (!(GMAIL_LABELS as readonly string[]).includes(label)) return bad("bad label", 400);
    const u = authUrl(accountId, label as GmailLabel);
    if (!u) {
      return json({
        ok: false,
        error: "google_not_configured",
        message:
          "Gmail sign-in isn't set up on this server yet. It needs a Google OAuth client (client ID, secret, and redirect).",
      });
    }
    return Response.redirect(u, 302);
  }

  // GET /api/oauth/google/callback?code&state — finish a Gmail sign-in.
  if (path === "/api/oauth/google/callback" && method === "GET") {
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const r = await handleOAuthCallback(code, state);
    const base = config.appUrl || "";
    const dest = r.ok
      ? `${base}/?tab=inboxes&gmail=connected`
      : `${base}/?tab=inboxes&gmail=error`;
    return Response.redirect(dest, 302);
  }

  // POST /api/inboxes/draft — save a real draft into a Gmail account.
  if (path === "/api/inboxes/draft" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const label = String(body.label || "");
    if (!(GMAIL_LABELS as readonly string[]).includes(label)) return bad("bad label", 400);
    const to = String(body.to || "").trim();
    const subject = String(body.subject || "").trim();
    const draftBody = String(body.body || "");
    if (!to || !draftBody) return bad("to and body required", 400);
    const r = await saveDraft(accountId, label as GmailLabel, to, subject, draftBody);
    if (!r.ok) return json({ ok: false, error: r.error || "draft_failed" });
    return json({ ok: true, draftId: r.draftId });
  }

  return bad("not found", 404);
}

// --- Static files ---
async function serveStatic(req: Request, path: string): Promise<Response> {
  let rel = path === "/" ? "index.html" : path.slice(1);
  rel = normalize(rel).replace(/^(\.\.[\/\\])+/, "");
  const filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return new Response("Not found", { status: 404 });
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    // SPA fallback: extensionless paths load the app shell. Missing assets
    // (a path with an extension) get a real 404 so an <img> can fall back
    // and the service worker never caches HTML under an asset URL.
    const ext = extname(filePath);
    if (!path.startsWith("/api/") && !ext) {
      const index = Bun.file(join(PUBLIC_DIR, "index.html"));
      return new Response(index, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  }
  const ext = extname(filePath);
  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPES[ext] || "application/octet-stream",
  };
  if (rel === "sw.js") {
    headers["service-worker-allowed"] = "/";
    headers["cache-control"] = "no-cache";
  }
  return new Response(file, { headers });
}

const server = Bun.serve({
  port: config.port,
  // Chat replies can take minutes on the free bridge, and the stream
  // endpoint holds its connection open that whole time. Bun's default
  // 10s idle timeout would cut an SSE stream that sits quiet waiting
  // for the first token, so raise it to the 255s maximum; the 5s
  // heartbeat in the stream handler keeps it alive past that.
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/healthz") {
        return json({ ok: true, brain: brainConnected(), provider: brainProvider() });
      }
      if (path.startsWith("/api/")) {
        return await handleApi(req, path);
      }
      return await serveStatic(req, path);
    } catch (e) {
      console.error("request failed:", req.method, path, e);
      return json({ ok: false, error: "server_error" }, 500);
    }
  },
});

console.log(`Prism 5 standalone listening on http://localhost:${server.port}`);
console.log(`Brain: ${brainProvider()} (set ANTHROPIC_API_KEY for Claude, GEMINI_API_KEY for the free Gemini bridge)`);
console.log(`Google OAuth configured: ${googleConfigured()}`);
console.log(`Data dir: ${config.dataDir}`);
