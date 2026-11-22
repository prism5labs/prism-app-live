// Prism 5 — standalone server (Bun + TypeScript, zero npm dependencies).
// Serves the PWA shell from public/ and the JSON API under /api/.
// No @hatch/space-sdk, no artifact runtime: plain Bun.serve, bun:sqlite,
// and fetch for the brain and Gmail.

import { join, normalize, extname } from "node:path";
import { config, brainConnected, brainProvider, googleConfigured, microsoftConfigured } from "./server/config";
import {
  getOrCreateAccount,
  getOwned,
  ownsPhoton,
  ownsAtom,
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
  listContacts,
  getContactByAddress,
  createContact,
  setContactPhone,
  getContactByToken,
  setContactStatus,
  markRequestSent,
  getProfile,
  saveProfile,
  getNovaSettings,
  saveNovaSettings,
  listImportedMemory,
  addImportedMemory,
  deleteImportedMemory,
  memoryDigest,
  identityBlock,
  personaSeed,
  type Contact,
} from "./server/db";
import { chatWithTools } from "./server/anthropic";
import { TOOL_DEFINITIONS, executeTool, getToolConnectionState } from "./server/tools";
import { chat as geminiChat, chatStream as geminiChatStream } from "./server/gemini";
import { systemPromptFor, type OwnerContext } from "./server/personas";
import { voiceById } from "./shared/voices";
import {
  PHOTONS,
  photonByName,
  PHOTON_NAMES,
} from "./shared/photons";
import { SUPERNOVA, SATELLITE, UPKEEP, NOVA, PERSONAL_UPKEEP, PRODUCTS, CATEGORIES } from "./shared/catalog";
import { featureAccess, hasPersonalAccess } from "./shared/features";
import { ATOMS, atomByName } from "./shared/atoms";
import {
  authUrl,
  handleOAuthCallback,
  listInbox,
  getMessage as gmailGetMessage,
  saveDraft,
  sendFromAny,
  connectedLabels,
  isValidGmailLabel,
  gmailLabelTitle,
  type GmailLabel,
} from "./server/gmail";
// Outlook mail (Microsoft Graph): the same shape as Gmail, so an Outlook
// mailbox shows as its own card in Inboxes and can save real drafts.
import {
  authUrl as outlookAuthUrl,
  handleOAuthCallback as outlookHandleOAuthCallback,
  listInbox as outlookListInbox,
  getMessage as outlookGetMessage,
  saveDraft as outlookSaveDraft,
  connectedLabels as outlookConnectedLabels,
  isValidOutlookLabel,
  outlookLabelTitle,
  type OutlookLabel,
} from "./server/outlook";
// Capability steps (design doc): each module owns its own routes and
// tables and reads its env vars directly; server.ts only mounts them.
import {
  authUrlExtra,
  handleExtraOAuthCallback,
  calendarStatus,
  listCalendarEvents,
  bookCalendarEvent,
  cancelCalendarEvent,
  freeBusy,
  driveStatus,
  searchDrive,
  readDriveFile,
} from "./server/google";
import { voiceStatus, voiceSay, voiceTranscribe } from "./server/voice";
import { handleMessenger } from "./server/messenger";
import {
  getTextsStatus,
  listTexts,
  sendText,
  incomingText,
  listCalls,
  dialCall,
  voiceWebhook,
  voicemailCallback,
} from "./server/telephony";
import { handleProactiveApi, startProactiveScheduler } from "./server/proactive";
import { handleDayApi } from "./server/startmyday";
import { handleResearch } from "./server/research";
import { handleStripeWebhook, handleStripeStatus } from "./server/stripe";
// Google sign-in for the app itself: a person, not a device. Same OAuth
// client as Gmail; the account follows the owner across devices.
import {
  authUrlSignin,
  handleSigninCallback,
  exchangeSigninSession,
  recoverSignin,
  recordSigninStart,
  takeSigninStart,
  authStatus,
  getPerk,
  getBackstories,
} from "./server/auth";

// Switchboard is email. Reports to Prism 5 go to the Labs test inbox.
export const PRISM_REPORT_ADDRESS = "prism5labstest@gmail.com";
export const PRISM_REPORT_NAME = "Prism 5";

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// The connection request email: the friend request. The recipient taps
// Approve or Decline, and the link flips this account's contact row.
function contactRequestEmail(
  origin: string,
  accountId: string,
  contact: Contact,
): { subject: string; body: string } {
  const approve = `${origin}/api/contacts/approve?accountId=${encodeURIComponent(accountId)}&contact=${encodeURIComponent(contact.id)}&token=${encodeURIComponent(contact.token)}`;
  const decline = `${origin}/api/contacts/decline?accountId=${encodeURIComponent(accountId)}&contact=${encodeURIComponent(contact.id)}&token=${encodeURIComponent(contact.token)}`;
  return {
    subject: `Switchboard connection request: ${contact.photon} would like to send you reports`,
    body: [
      `Hi,`,
      ``,
      `${contact.photon}, a Launch from Prism 5 Labs running on its owner's phone, would like to connect with you on Switchboard so it can send you reports and messages by email.`,
      ``,
      `Approve this contact:`,
      approve,
      ``,
      `Decline:`,
      decline,
      ``,
      `Once you approve, ${contact.photon} can send to this inbox. If you decline, or just ignore this email, nothing is sent.`,
      ``,
      `— Prism 5 Labs Switchboard`,
    ].join("\n"),
  };
}

function decisionPage(title: string, line: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:Georgia,serif;background:#0f3d3e;color:#fdf6e3;text-align:center;padding:48px 20px}h1{font-size:28px}p{font-size:17px;line-height:1.5}</style></head><body><h1>${title}</h1><p>${line}</p></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

// The sign-in return page: the tap that gets the owner back into the
// installed app. After Google, the owner is sitting in a browser tab
// (a Custom Tab, with its bar and X). A redirect from here to the app
// would stay in that tab, so this page does not redirect: it shows one
// big button, a plain link to the app on this origin, carrying the
// one-time session token exactly as the old redirect did. Tapping a
// link to an in-scope URL is a user gesture, so Android's intent
// filters route it to the installed app window, which spends the token
// on arrival as before. If the page already loaded inside the
// installed app (display-mode standalone), it continues on its own
// with no tap. The page is self-contained on purpose: it must work in
// a bare tab with no app code loaded.
function oauthReturnPage(url: URL): Response {
  const session = url.searchParams.get("session") || "";
  const ok = url.searchParams.get("status") === "ok" && session.length > 0;
  const target = ok
    ? `/?tab=you&signin=ok&session=${encodeURIComponent(session)}`
    : "/?tab=you";
  const title = ok ? "You're signed in" : "Sign-in didn't finish";
  const line = ok
    ? "Tap below to open Prism 5. If the app doesn't open, tap the Prism 5 icon on your home screen — you're signed in."
    : "Tap below to try again.";
  const button = ok ? "Open Prism 5" : "Try again";
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:Georgia,serif;background:#FFF3DC;color:#0F5257;text-align:center;padding:48px 20px}h1{font-size:28px}p{font-size:17px;line-height:1.5;max-width:420px;margin:0 auto}a.btn{display:inline-block;margin-top:28px;padding:16px 36px;background:#D62828;color:#FFF3DC;font-size:20px;text-decoration:none;border-radius:12px}</style></head><body><h1>${title}</h1><p>${line}</p><a class="btn" href="${esc(target)}">${button}</a><script>if(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches){window.location.replace(${JSON.stringify(target)});}</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
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
  if (fromQuery.trim()) return fromQuery.trim();
  // The shared session cookie (prism5_account) is the LAST resort,
  // after body, header, and query — never the first source. It lets
  // the website, which cannot read the app's localStorage, present the
  // account the app already minted a cookie for.
  return cookieValue(req, ACCOUNT_COOKIE).trim();
}

// --- Cross-origin website leg (Nov 19, 2026) ---
// The website (prism5labs.com) reads the account's side from GET
// /api/state and writes it with POST /api/profile, but it lives on a
// different origin than the app and cannot read the app's localStorage
// (prism5.accountId). CORS is opened ONLY on /api/state and /api/profile,
// only for the two prism5labs.com origins and loopback dev origins, and
// only ever echoes the exact request origin — never * — with
// credentials. No other endpoint gets CORS. The shared session cookie
// (prism5_account) is minted only on a successful GET /api/state or
// POST /api/profile for a caller who already presented a valid
// accountId; it is never minted for an unauthenticated caller and never
// hands an account id to anyone who does not already have it.
const CORS_ALLOWED_ORIGINS = ["https://prism5labs.com", "https://www.prism5labs.com"];
const CORS_ALLOWED_PATHS = ["/api/state", "/api/profile"];
const CORS_LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const ACCOUNT_COOKIE = "prism5_account";

// The exact origin to echo, or null when the origin is not allowed.
function corsOriginFor(req: Request): string | null {
  const origin = req.headers.get("origin") || "";
  if (!origin) return null;
  if (CORS_ALLOWED_ORIGINS.includes(origin)) return origin;
  if (CORS_LOOPBACK_ORIGIN.test(origin)) return origin;
  return null;
}

function corsHeaders(req: Request): Record<string, string> | null {
  const origin = corsOriginFor(req);
  if (!origin) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

// Apply the CORS headers to a response on /api/state or /api/profile.
// When accountId is given and the response succeeded, also mint the
// shared session cookie — only for a caller who already presented a
// valid accountId.
function corsResponse(req: Request, res: Response, accountId?: string): Response {
  const headers = new Headers(res.headers);
  const cors = corsHeaders(req);
  if (cors) for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  if (accountId && isValidAccountId(accountId) && res.status >= 200 && res.status < 300) {
    headers.append("Set-Cookie", accountCookieValue(req, accountId));
  }
  return new Response(res.body, { status: res.status, headers });
}

function accountCookieValue(req: Request, accountId: string): string {
  const url = new URL(req.url);
  // Secure only when the client-facing request is https. Behind Render
  // the request to Bun is plain http, so the proxy's X-Forwarded-Proto
  // is how that is known; local http dev stays without Secure.
  const isHttps = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const parts = [
    `${ACCOUNT_COOKIE}=${accountId}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=31536000",
  ];
  if (isHttps) parts.push("Secure");
  if (url.hostname.endsWith(".prism5labs.com")) parts.push("Domain=.prism5labs.com");
  return parts.join("; ");
}

function cookieValue(req: Request, name: string): string {
  const cookie = req.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
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

// Chat serves both rosters: the Photons (business) and the Atoms
// (personal). A name is a chat name when it is on either roster. The
// thread store keys on the name either way, so an Atom's thread lives
// beside a Photon's with no second store.
function isChatName(name: string): boolean {
  return !!photonByName(name) || !!atomByName(name);
}

// Ownership for one chat name. A Photon: its own owned row (or the free
// code, which ownsPhoton already honors). An Atom: its own owned row
// (kind 'atom'; ownsAtom likewise honors the free code, and redeeming
// the free code writes every Atom row besides) OR the Nova product row
// (kind 'product', ref 'nova' — the generic Nova purchase in stripe.ts
// grants no single Atom, so it opens every Atom's chat). This is
// per-Atom on purpose: hasPersonalAccess in shared/features.ts opens
// the personal FEATURE SET (any Atom, a Nova, or a business Launch),
// which is a wider gate than "may chat with this Atom" and is not
// reused here.
function ownsChatName(accountId: string, name: string): boolean {
  if (photonByName(name)) return ownsPhoton(accountId, name);
  if (atomByName(name)) {
    if (ownsAtom(accountId, name)) return true;
    return getOwned(accountId).products.includes("nova");
  }
  return false;
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
  if (!isChatName(photon)) return { error: bad("unknown photon", 400) };
  if (!message) return { error: bad("message required", 400) };
  if (message.length > 4000) return { error: bad("message too long", 400) };

  if (!ownsChatName(accountId, photon)) {
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
  // What the owner told Prism about themselves, and what they brought
  // from another AI. Both ride in the system prompt so the Photons know
  // the owner instead of starting cold. The profile is the owner's own
  // words; the identity block is the always-on core of their import
  // (who they are, so Prism knows them on sight); the digest is the
  // sections that answer this message, framed as background, never as
  // instructions; and the persona seed is who Prism is to them, from
  // their own export. The owner's name falls back to the name on their
  // signed-in Google identity when they never filled in a display name,
  // so a signed-in owner is never a stranger.
  const profile = getProfile(accountId);
  const auth = authStatus(accountId);
  const ownerContext: OwnerContext = {
    name: profile.displayName || auth.name || null,
    about: profile.about,
    preferences: profile.preferences,
    notes: profile.notes,
    title: profile.title,
    pronouns: profile.pronouns,
    memoryDigest: memoryDigest(accountId, message),
    personaSeed: personaSeed(accountId),
    identityBlock: identityBlock(accountId),
  };
  // An Atom has no customization Face and no account custom name of its
  // own: the account's custom_name belongs to Prism, so an Atom is
  // addressed by its own name unless a customization row renames it.
  const displayName = atomByName(photon)
    ? c?.faceName || photon
    : c?.faceName || a.custom_name || photon;
  // Tools ride only on the Anthropic path: when it is active, the
  // prompt carries the account's live connection state and the tools
  // block, and the chat handlers below call chatWithTools. On the
  // Gemini / no-brain paths toolContext stays null and the prompt and
  // the chat call are exactly as before (plain chat, no tools).
  const toolContext =
    brainProvider() === "anthropic" ? getToolConnectionState(accountId) : null;
  const system = systemPromptFor(photon, displayName, c, ownerContext, toolContext);
  return { accountId, photon, message, system, history };
}

// --- State ---
function stateFor(accountId: string) {
  const a = getOrCreateAccount(accountId);
  const owned = getOwned(accountId);
  const displayName = a.custom_name || "Prism 5";
  // Sign-in: who this account belongs to, the welcome offer, and the
  // Photons' backstories. All empty for an account that never signed
  // in — the perks belong to account creation, not to a device.
  const auth = authStatus(accountId);
  const profile = getProfile(accountId);
  const ownerName = profile.displayName || auth.name || "neighbor";
  return {
    accountId,
    displayName,
    customName: a.custom_name,
    ownedPhotons: owned.photons,
    ownedProducts: owned.products,
    ownedAtoms: owned.atoms,
    // Nova feature sets (Nov 19, 2026): personal open with a Nova (or a
    // business Launch, or the free code); business open only with a
    // business Launch (or the free code). The client shows locked sets
    // as locked from this, and never invents its own gate.
    features: featureAccess(owned.products, a.free_code, owned.atoms),
    // Nova's gentler default: check-ins and getting-started nudges on
    // for Nova owners until the owner saves a choice in the You tab.
    novaSettings: getNovaSettings(accountId),
    // The Business-or-Personal side, from the account profile (Nov 19,
    // 2026) — the chooser's choice, remembered on the account, not the
    // device. Null when never chosen: the chooser shows until a door is
    // picked. THE WEBSITE LEG READS THIS: GET /api/state returns
    // `side` ("business" | "personal" | null) for the account, so a
    // signed-in visitor lands on their chosen door; the side is saved
    // with POST /api/profile { side }. The device copy (prism.side.v1)
    // is a cache — this field is the truth.
    side: profile.side,
    meter: meterState(a),
    upkeep: a.upkeep,
    freeCode: a.free_code,
    brain: brainConnected(),
    googleConfigured: googleConfigured(),
    microsoftConfigured: microsoftConfigured(),
    auth,
    perk: getPerk(accountId),
    backstories: getBackstories(accountId, ownerName, a.created_at),
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

  // CORS preflight, ONLY on /api/state and /api/profile, no auth
  // needed. An allowed origin gets the full preflight answer; any
  // other origin gets a bare 204 with no Access-Control-Allow-Origin,
  // so the browser refuses the call.
  if (method === "OPTIONS" && CORS_ALLOWED_PATHS.includes(path)) {
    const origin = corsOriginFor(req);
    const headers: Record<string, string> = { Vary: "Origin" };
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
      headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "content-type, x-account-id";
      headers["Access-Control-Max-Age"] = "86400";
    }
    return new Response(null, { status: 204, headers });
  }

  // Step 10 — Stripe webhook. Mounted FIRST and routed straight to the
  // handler: it reads the raw body itself (req.text()) for the HMAC
  // signature, so nothing here may call readBody(req) for this path.
  if (path === "/api/stripe/webhook" && method === "POST") {
    return await handleStripeWebhook(req);
  }

  // GET /api/stripe/status — is the webhook secret set?
  if (path === "/api/stripe/status" && method === "GET") {
    return await handleStripeStatus(req);
  }

  // Step 10 — POST /api/research — live web search with sources.
  if (path === "/api/research" && method === "POST") {
    return await handleResearch(req);
  }

  // Step 9 — Messenger (Facebook Pages only). The module returns null
  // for paths it does not own, so this never swallows another route.
  if (path.startsWith("/api/messenger")) {
    const r = await handleMessenger(req, path);
    if (r) return r;
  }

  // GET /api/state
  if (path === "/api/state" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return corsResponse(req, bad("accountId required", 400));
    return corsResponse(req, json({ ok: true, ...stateFor(accountId) }), accountId);
  }

  // GET /api/store — the full catalog (the client also bundles it).
  if (path === "/api/store" && method === "GET") {
    return json({
      ok: true,
      supernova: SUPERNOVA,
      satellite: SATELLITE,
      upkeep: UPKEEP,
      nova: NOVA,
      personalUpkeep: PERSONAL_UPKEEP,
      atoms: ATOMS.map((a) => ({
        name: a.name,
        pronoun: a.pronoun,
        tagline: a.tagline,
        focus: a.focus,
      })),
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

  // GET /api/threads/:name — a Photon or an Atom name; the thread store
  // keys on the name either way.
  const threadMatch = path.match(/^\/api\/threads\/([A-Za-z]+)$/);
  if (threadMatch && method === "GET") {
    const photon = threadMatch[1];
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    if (!isChatName(photon)) return bad("unknown photon", 400);
    return json({
      ok: true,
      photon,
      owned: ownsChatName(accountId, photon),
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
        ? await chatWithTools(system, history, message, TOOL_DEFINITIONS, (name, input) =>
            executeTool(accountId, name, input),
          )
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
            // Anthropic has no streaming client here, so the tool loop
            // runs to completion and the whole reply goes out as one
            // delta, exactly the shape this handler already used.
            const result = await chatWithTools(
              system,
              history,
              message,
              TOOL_DEFINITIONS,
              (name, input) => executeTool(accountId, name, input),
            );
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
    // The free code is Upkeep-equivalent: redeeming it unlocks live
    // voice just like a paid Upkeep subscription, so the free code's
    // "everything's yours now" is literally true.
    if (!isUnlimited(a)) {
      return json({
        ok: false,
        error: "needs_upkeep",
        message:
          "Live voice calls come with Upkeep, $29 a month. Upkeep also brings unlimited chat, Launch updates, and priority support.",
      });
    }
    // The saved voice pick rides with the call gate, so the call UI can show
    // the Photon's voice. The audio line itself is live at /api/voice/say
    // and /api/voice/transcribe (turn-based, ElevenLabs, Upkeep only).
    const c = getCustomization(accountId, photon);
    const voiceId = c?.voice || "house";
    return json({
      ok: true,
      status: "voice_pending",
      voice: voiceId,
      voiceName: voiceById(voiceId).name,
      message:
        "Live voice is turn-based: tap the mic, talk, and the reply comes back out loud. It needs Upkeep and the server's ElevenLabs key.",
    });
  }

  // Step 5 — GET /api/voice/status — is voice configured, and does this
  // account have Upkeep? No Photon needed.
  if (path === "/api/voice/status" && method === "GET") {
    return await voiceStatus(req);
  }

  // Step 5 — POST /api/voice/say — body { accountId, photon, text }.
  // Returns audio/mpeg in the Photon's saved voice.
  if (path === "/api/voice/say" && method === "POST") {
    return await voiceSay(req);
  }

  // Step 5 — POST /api/voice/transcribe — multipart body, audio file in
  // the "file" field (also accepts "audio"). Returns { ok: true, text }.
  if (path === "/api/voice/transcribe" && method === "POST") {
    return await voiceTranscribe(req);
  }

  // GET /api/inboxes — every Gmail account actually connected, as many
  // as there are, each with its messages. There are no fixed slots any
  // more: accounts are added through the generic connect button, and a
  // card appears here once its sign-in finishes.
  if (path === "/api/inboxes" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const connected = connectedLabels(accountId);
    const results = await Promise.all(
      connected.map(async (c) => {
        const r = await listInbox(accountId, c.label, 10);
        return {
          label: c.label,
          title: gmailLabelTitle(c.label, c.email),
          connected: r.connected,
          email: r.email || c.email,
          messages: r.messages,
          unreadCount: typeof r.unreadCount === "number" ? r.unreadCount : null,
          error: r.error || null,
        };
      }),
    );
    return json({
      ok: true,
      googleConfigured: googleConfigured(),
      accounts: results,
      _connectedLabels: connected.map((c) => c.label),
    });
  }

  // GET /api/oauth/google/start?accountId&label — begin a Gmail sign-in.
  if (path === "/api/oauth/google/start" && method === "GET") {
    const accountId = url.searchParams.get("accountId") || "";
    const label = url.searchParams.get("label") || "";
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    if (!isValidGmailLabel(label)) return bad("bad label", 400);
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

  // GET /api/oauth/google/callback?code&state — finish a Gmail sign-in,
  // an app sign-in, or a Calendar + Drive sign-in. All three ride this
  // same registered redirect URI (no new URI in the Google console);
  // the state tells them apart: "<deviceAccountId>:signin" is an app
  // sign-in, "<deviceAccountId>:calendar-drive" is Calendar + Drive
  // (authUrlExtra asks Google to return here, not to /callback-extra,
  // because it reuses the single registered redirect URI), anything
  // else is a Gmail label. A finished app sign-in mints a one-time
  // session token and hands the browser back to You to spend it.
  if (path === "/api/oauth/google/callback" && method === "GET") {
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const base = config.appUrl || "";
    if (state.endsWith(":signin")) {
      const r = await handleSigninCallback(code, state);
      // The sign-in started from the installed app's origin; the
      // callback itself always lands on the registered redirect URI
      // (the Render origin), inside a browser tab. A bare redirect
      // back to the app stays in that tab — a redirect is not a user
      // gesture, so Android never hands it to the installed app. Route
      // the owner through the return page on the origin the sign-in
      // started from instead: its button is the tap that opens the
      // app window. No start recorded (an old link, a direct hit):
      // keep the previous direct redirect.
      const deviceAccountId = state.split(":")[0] || "";
      const startOrigin = takeSigninStart(deviceAccountId);
      if (startOrigin) {
        const dest = r.ok
          ? `${startOrigin}/oauth-return?status=ok&session=${encodeURIComponent(r.sessionToken)}`
          : `${startOrigin}/oauth-return?status=error`;
        return Response.redirect(dest, 302);
      }
      const dest = r.ok
        ? `${base}/?tab=you&signin=ok&session=${encodeURIComponent(r.sessionToken)}`
        : `${base}/?tab=you&signin=error`;
      return Response.redirect(dest, 302);
    }
    if (state.endsWith(":calendar-drive")) {
      // The Calendar + Drive consent returns here, not to
      // /callback-extra, because authUrlExtra reuses the Gmail
      // redirect URI. Before this branch the state fell through to
      // handleOAuthCallback, which rejected it as bad_state and the
      // owner saw "Gmail sign-in didn't finish. Try again."
      const r = await handleExtraOAuthCallback(code, state);
      const dest = r.ok
        ? `${base}/?tab=inboxes&google=connected`
        : `${base}/?tab=inboxes&google=error`;
      return Response.redirect(dest, 302);
    }
    const r = await handleOAuthCallback(code, state);
    const dest = r.ok
      ? `${base}/?tab=connected&gmail=connected`
      : `${base}/?tab=connected&gmail=error`;
    return Response.redirect(dest, 302);
  }

  // GET /api/oauth/google/start-signin?accountId — begin an app
  // sign-in with Google. Same OAuth client as Gmail; scopes are only
  // openid, email, profile (identity, nothing else). The origin this
  // request arrived on is the installed app's origin: record it so the
  // callback can route the return back there (see /oauth-return).
  if (path === "/api/oauth/google/start-signin" && method === "GET") {
    const accountId = url.searchParams.get("accountId") || "";
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    recordSigninStart(accountId, url.origin);
    const u = authUrlSignin(accountId);
    if (!u) {
      return json({
        ok: false,
        error: "google_not_configured",
        message:
          "Google sign-in isn't set up on this server yet. It needs a Google OAuth client (client ID, secret, and redirect).",
      });
    }
    return Response.redirect(u, 302);
  }

  // POST /api/auth/session — spend a one-time sign-in token for the
  // account id. The token is spent on first use and expires after 10
  // minutes, so a stray URL cannot sign anyone in later.
  if (path === "/api/auth/session" && method === "POST") {
    const body = await readBody(req);
    const token = String(body.token || "").trim();
    if (!token) return bad("token required", 400);
    const exchanged = exchangeSigninSession(token);
    if (!exchanged) return json({ ok: false, error: "bad_session" });
    return json({ ok: true, isNew: exchanged.isNew, ...stateFor(exchanged.accountId) });
  }

  // GET /api/auth/status — is this account signed in, and as whom?
  if (path === "/api/auth/status" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return json({ ok: true, ...authStatus(accountId) });
  }

  // POST /api/auth/recover — find the account this device id was
  // linked to, if it ever signed in. The OAuth callback records the
  // link at sign-in time; a device whose sign-in was completed in
  // another browsing context (the installed PWA's flow is diverted to
  // a browser tab on Android, and the one-time token is spent there)
  // asks here on boot and adopts the linked account id in its own
  // context, instead of signing in again. When the device id is not
  // the account id, any rows that landed under the orphaned device id
  // (Calendar/Drive tokens connected while the app was orphaned) move
  // into the linked account as part of the recovery, so the services
  // work under the adopted id. The device id is already the whole
  // credential for the account, so this reveals nothing new.
  if (path === "/api/auth/recover" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const linked = recoverSignin(accountId);
    return json({ ok: true, linked: linked !== null, accountId: linked });
  }

  // Steps 4 + 6 — GET /api/oauth/google/start-extra — begin a Calendar +
  // Drive sign-in (same Google client as Gmail, calendar and Drive scopes
  // added). Owners already connected for Gmail sign in once more.
  if (path === "/api/oauth/google/start-extra" && method === "GET") {
    const accountId = url.searchParams.get("accountId") || "";
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const u = authUrlExtra(accountId);
    if (!u) {
      return json({
        ok: false,
        error: "google_not_configured",
        message:
          "Calendar and Drive sign-in isn't set up on this server yet. It needs a Google OAuth client (client ID, secret, and redirect).",
      });
    }
    return Response.redirect(u, 302);
  }

  // Steps 4 + 6 — GET /api/oauth/google/callback-extra — finish a
  // Calendar + Drive sign-in. A different path from Gmail's callback on
  // purpose; the redirect URI must be registered in the Google console.
  if (path === "/api/oauth/google/callback-extra" && method === "GET") {
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const r = await handleExtraOAuthCallback(code, state);
    const base = config.appUrl || "";
    const dest = r.ok
      ? `${base}/?tab=connected&google=connected`
      : `${base}/?tab=connected&google=error`;
    return Response.redirect(dest, 302);
  }

  // Step 4 — GET /api/calendar/status — is Calendar connected?
  if (path === "/api/calendar/status" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return json(calendarStatus(accountId));
  }

  // Step 4 — GET /api/calendar/events — events in a window (defaults to
  // now through 7 days out). Query: timeMin, timeMax (ISO dates).
  if (path === "/api/calendar/events" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const timeMin = url.searchParams.get("timeMin") || undefined;
    const timeMax = url.searchParams.get("timeMax") || undefined;
    return json(await listCalendarEvents(accountId, timeMin, timeMax));
  }

  // Step 4 — POST /api/calendar/book — create an event. Only when called;
  // the Photon drafts, the owner taps.
  if (path === "/api/calendar/book" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return json(await bookCalendarEvent(accountId, body));
  }

  // Step 4 — POST /api/calendar/cancel — body { accountId, eventId }.
  if (path === "/api/calendar/cancel" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return json(await cancelCalendarEvent(accountId, String(body.eventId || "")));
  }

  // Step 4 — GET /api/calendar/freebusy — busy times in a window.
  if (path === "/api/calendar/freebusy" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const timeMin = url.searchParams.get("timeMin") || undefined;
    const timeMax = url.searchParams.get("timeMax") || undefined;
    return json(await freeBusy(accountId, timeMin, timeMax));
  }

  // Step 6 — GET /api/drive/status — is Drive connected?
  if (path === "/api/drive/status" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return json(driveStatus(accountId));
  }

  // Step 6 — GET /api/drive/search — search Drive, or list the most
  // recently modified files when no q is given.
  if (path === "/api/drive/search" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const q = url.searchParams.get("q") || undefined;
    return json(await searchDrive(accountId, q));
  }

  // Step 6 — GET /api/drive/file — read a file as text (Docs as text,
  // Sheets as CSV). Some types cannot be read as text; the endpoint
  // says so plainly instead of inventing content.
  if (path === "/api/drive/file" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const id = url.searchParams.get("id") || "";
    return json(await readDriveFile(accountId, id));
  }

  // POST /api/inboxes/draft — save a real draft into a Gmail account.
  if (path === "/api/inboxes/draft" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const label = String(body.label || "");
    if (!isValidGmailLabel(label)) return bad("bad label", 400);
    const to = String(body.to || "").trim();
    const subject = String(body.subject || "").trim();
    const draftBody = String(body.body || "");
    if (!to || !draftBody) return bad("to and body required", 400);
    const r = await saveDraft(accountId, label as GmailLabel, to, subject, draftBody);
    if (!r.ok) return json({ ok: false, error: r.error || "draft_failed" });
    return json({ ok: true, draftId: r.draftId });
  }

  // GET /api/gmail/message?accountId&label&id — read one Gmail message
  // in full. The summary view opens the real message through here, one
  // tap, instead of rendering the whole inbox.
  if (path === "/api/gmail/message" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const label = url.searchParams.get("label") || "";
    if (!isValidGmailLabel(label)) return bad("bad label", 400);
    const id = url.searchParams.get("id") || "";
    if (!id) return bad("id required", 400);
    const r = await gmailGetMessage(accountId, label as GmailLabel, id);
    if (!r.ok) return json({ ok: false, error: r.error || "message_failed" });
    return json({ ok: true, id: r.id, from: r.from, subject: r.subject, date: r.date, body: r.body });
  }

  // GET /api/outlook/message?accountId&label&id — the same, for Outlook.
  if (path === "/api/outlook/message" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const label = url.searchParams.get("label") || "";
    if (!isValidOutlookLabel(label)) return bad("bad label", 400);
    const id = url.searchParams.get("id") || "";
    if (!id) return bad("id required", 400);
    const r = await outlookGetMessage(accountId, label as OutlookLabel, id);
    if (!r.ok) return json({ ok: false, error: r.error || "message_failed" });
    return json({ ok: true, id: r.id, from: r.from, subject: r.subject, date: r.date, body: r.body });
  }

  // Outlook mail (Microsoft Graph): the same shape as Gmail, so an
  // Outlook mailbox shows as its own card in Inboxes and can save real
  // drafts. Without a Microsoft OAuth client the start route answers
  // honestly that Outlook sign-in is not set up on this server yet.
  if (path === "/api/outlook/inboxes" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const connected = outlookConnectedLabels(accountId);
    const results = await Promise.all(
      connected.map(async (c) => {
        const r = await outlookListInbox(accountId, c.label, 10);
        return {
          label: c.label,
          title: outlookLabelTitle(c.label, c.email),
          connected: r.connected,
          email: r.email || c.email,
          messages: r.messages,
          unreadCount: typeof r.unreadCount === "number" ? r.unreadCount : null,
          error: r.error || null,
        };
      }),
    );
    return json({
      ok: true,
      microsoftConfigured: microsoftConfigured(),
      accounts: results,
      _connectedLabels: connected.map((c) => c.label),
    });
  }

  // GET /api/oauth/microsoft/start?accountId&label — begin an Outlook
  // sign-in.
  if (path === "/api/oauth/microsoft/start" && method === "GET") {
    const accountId = url.searchParams.get("accountId") || "";
    const label = url.searchParams.get("label") || "";
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    if (!isValidOutlookLabel(label)) return bad("bad label", 400);
    const u = outlookAuthUrl(accountId, label as OutlookLabel);
    if (!u) {
      return json({
        ok: false,
        error: "microsoft_not_configured",
        message:
          "Outlook sign-in isn't set up on this server yet. It needs a Microsoft OAuth client (client ID, secret, and redirect).",
      });
    }
    return Response.redirect(u, 302);
  }

  // GET /api/oauth/microsoft/callback?code&state — finish an Outlook
  // sign-in.
  if (path === "/api/oauth/microsoft/callback" && method === "GET") {
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const r = await outlookHandleOAuthCallback(code, state);
    const base = config.appUrl || "";
    const dest = r.ok
      ? `${base}/?tab=connected&outlook=connected`
      : `${base}/?tab=connected&outlook=error`;
    return Response.redirect(dest, 302);
  }

  // POST /api/outlook/draft — save a real draft into an Outlook mailbox.
  if (path === "/api/outlook/draft" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const label = String(body.label || "");
    if (!isValidOutlookLabel(label)) return bad("bad label", 400);
    const to = String(body.to || "").trim();
    const subject = String(body.subject || "").trim();
    const draftBody = String(body.body || "");
    if (!to || !draftBody) return bad("to and body required", 400);
    const r = await outlookSaveDraft(accountId, label as OutlookLabel, to, subject, draftBody);
    if (!r.ok) return json({ ok: false, error: r.error || "draft_failed" });
    return json({ ok: true, draftId: r.draftId });
  }

  // About you: what the owner tells Prism about themselves. GET reads
  // it; POST saves it (plain text, capped). It is stored on the server
  // for this account only and is never shared with anyone else. The
  // Photons read it in the chat system prompt, so they know the owner
  // instead of starting cold.
  if (path === "/api/profile" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return corsResponse(req, bad("accountId required", 400));
    return corsResponse(req, json({ ok: true, profile: getProfile(accountId) }));
  }
  if (path === "/api/profile" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return corsResponse(req, bad("accountId required", 400));
    const profile = saveProfile(accountId, {
      displayName: typeof body.displayName === "string" || body.displayName === null ? body.displayName : undefined,
      about: typeof body.about === "string" || body.about === null ? body.about : undefined,
      preferences: typeof body.preferences === "string" || body.preferences === null ? body.preferences : undefined,
      notes: typeof body.notes === "string" || body.notes === null ? body.notes : undefined,
      title: typeof body.title === "string" || body.title === null ? body.title : undefined,
      pronouns: typeof body.pronouns === "string" || body.pronouns === null ? body.pronouns : undefined,
      side: typeof body.side === "string" || body.side === null ? body.side : undefined,
    });
    return corsResponse(req, json({ ok: true, profile }), accountId);
  }

  // Nova settings (Nov 19, 2026): the gentler default — check-ins and
  // getting-started nudges, on for Nova owners until they say otherwise.
  // POST saves one or both switches. The gate is the same ownership
  // check the rest of the app uses: personal access (a Nova, a business
  // Launch, or the free code) or the save is refused, so an account that
  // never bought Nova cannot switch on nudges it does not own.
  if (path === "/api/nova-settings" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const owned = getOwned(accountId);
    const a = getOrCreateAccount(accountId);
    if (!hasPersonalAccess(owned.products, a.free_code, owned.atoms)) {
      return json({ ok: false, error: "not_owned" }, 403);
    }
    const settings = saveNovaSettings(accountId, {
      checkIns: typeof body.checkIns === "boolean" ? body.checkIns : undefined,
      gettingStartedNudges:
        typeof body.gettingStartedNudges === "boolean" ? body.gettingStartedNudges : undefined,
    });
    return json({ ok: true, novaSettings: settings });
  }

  // Memory imported from another AI. GET lists what is stored (title,
  // source, size, date — not the full text). POST stores one import: the
  // client parses the file on the device and sends the text. DELETE
  // removes one import. Content is capped at 1,000,000 characters when
  // it is stored; a self-export is split into its sections, and a short
  // identity block plus the sections that answer the message are read
  // into the chat system prompt as background, never as instructions.
  if (path === "/api/memory" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return json({ ok: true, imports: listImportedMemory(accountId) });
  }
  if (path === "/api/memory" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const source = String(body.source || "file").trim().slice(0, 80);
    const title = String(body.title || "Imported memory").trim().slice(0, 200);
    const content = String(body.content || "");
    if (!content.trim()) return bad("content required", 400);
    if (content.length > 1_000_000) return bad("content too long", 400);
    const row = addImportedMemory(accountId, source, title, content);
    return json({ ok: true, imported: row });
  }
  const memoryDeleteMatch = path.match(/^\/api\/memory\/(\d+)$/);
  if (memoryDeleteMatch && method === "DELETE") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    deleteImportedMemory(accountId, parseInt(memoryDeleteMatch[1], 10));
    return json({ ok: true, deleted: true });
  }

  // GET /api/contacts — the Switchboard contact list for this account.
  if (path === "/api/contacts" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const contacts = listContacts(accountId).map((c) => ({
      id: c.id,
      photon: c.photon,
      name: c.name,
      address: c.address,
      phone: c.phone,
      status: c.status,
      createdAt: c.created_at,
    }));
    return json({
      ok: true,
      contacts,
      prismReport: { name: PRISM_REPORT_NAME, address: PRISM_REPORT_ADDRESS },
    });
  }

  // POST /api/contacts/request — ask a new contact to connect. Creates the
  // pending contact and sends the friend-request email from the owner's
  // connected Gmail. The recipient approves or declines by tapping a link.
  if (path === "/api/contacts/request" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const photon = String(body.photon || "");
    if (!photonByName(photon)) return bad("unknown photon", 400);
    if (!ownsPhoton(accountId, photon)) return bad("not_owned", 403);
    const address = String(body.address || "").trim().toLowerCase();
    const name = String(body.name || "").trim().slice(0, 80) || address;
    if (!isEmail(address)) return bad("a real email address is required", 400);
    const existing = getContactByAddress(accountId, address);
    if (existing && existing.status === "approved") {
      return json({ ok: true, status: "approved", contactId: existing.id });
    }
    if (existing && existing.status === "declined") {
      return json({ ok: false, error: "contact_declined" });
    }
    const contact = existing || createContact(accountId, photon, name, address);
    // Optional phone number for texts and caller ID (step 1). Stored
    // with the contact; texts and calls still need the email approval.
    const phone = String(body.phone || "").trim().slice(0, 40);
    if (phone) setContactPhone(accountId, contact.id, phone);
    if (contact.requestSentAt) {
      return json({ ok: false, error: "already_requested", contactId: contact.id });
    }
    const origin = config.appUrl || new URL(req.url).origin;
    const email = contactRequestEmail(origin, accountId, contact);
    const sent = await sendFromAny(accountId, address, email.subject, email.body);
    if (!sent.ok) {
      return json({
        ok: false,
        error: sent.error === "not_connected" ? "gmail_not_connected" : "request_failed",
      });
    }
    markRequestSent(accountId, contact.id);
    return json({ ok: true, status: "pending", contactId: contact.id });
  }

  // GET /api/contacts/approve — the Approve link in a request email.
  if (path === "/api/contacts/approve" && method === "GET") {
    const accountId = url.searchParams.get("accountId") || "";
    const contactId = url.searchParams.get("contact") || "";
    const token = url.searchParams.get("token") || "";
    const contact = getContactByToken(accountId, contactId, token);
    if (!contact) {
      return decisionPage(
        "That link doesn't match.",
        "This connection request may already have been decided, or the link is wrong. Nothing was changed.",
      );
    }
    if (contact.status !== "pending") {
      return decisionPage(
        contact.status === "approved" ? "Already approved." : "Already declined.",
        `${contact.photon} can ${contact.status === "approved" ? "send to this inbox" : "not send to this inbox"}.`,
      );
    }
    setContactStatus(accountId, contactId, "approved");
    return decisionPage(
      "Connected.",
      `${contact.photon} can now send you reports and messages on Switchboard.`,
    );
  }

  // GET /api/contacts/decline — the Decline link in a request email.
  if (path === "/api/contacts/decline" && method === "GET") {
    const accountId = url.searchParams.get("accountId") || "";
    const contactId = url.searchParams.get("contact") || "";
    const token = url.searchParams.get("token") || "";
    const contact = getContactByToken(accountId, contactId, token);
    if (!contact) {
      return decisionPage(
        "That link doesn't match.",
        "This connection request may already have been decided, or the link is wrong. Nothing was changed.",
      );
    }
    if (contact.status !== "pending") {
      return decisionPage(
        contact.status === "approved" ? "Already approved." : "Already declined.",
        `${contact.photon} can ${contact.status === "approved" ? "send to this inbox" : "not send to this inbox"}.`,
      );
    }
    setContactStatus(accountId, contactId, "declined");
    return decisionPage(
      "Declined.",
      `${contact.photon} cannot send to this inbox. Nothing was sent.`,
    );
  }

  // POST /api/switchboard/send — send a report or message by email to a
  // Switchboard contact. Only an approved contact receives anything. If
  // there is no contact yet, the call files the connection request instead
  // and says so; nothing is sent until the recipient approves.
  if (path === "/api/switchboard/send" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const photon = String(body.photon || "");
    if (!photonByName(photon)) return bad("unknown photon", 400);
    if (!ownsPhoton(accountId, photon)) return bad("not_owned", 403);
    const to = String(body.to || "").trim().toLowerCase();
    const subject = String(body.subject || "").trim().slice(0, 200);
    const messageBody = String(body.body || "");
    if (!isEmail(to)) return bad("a real email address is required", 400);
    if (!messageBody.trim()) return bad("body required", 400);
    if (messageBody.length > 20000) return bad("body too long", 400);
    const name = String(body.name || "").trim().slice(0, 80) || to;
    const contact = getContactByAddress(accountId, to);
    if (contact && contact.status === "declined") {
      return json({ ok: false, error: "contact_declined" });
    }
    if (contact && contact.status === "pending") {
      if (!contact.requestSentAt) {
        const origin = config.appUrl || new URL(req.url).origin;
        const email = contactRequestEmail(origin, accountId, contact);
        const sent = await sendFromAny(accountId, to, email.subject, email.body);
        if (!sent.ok) {
          return json({
            ok: false,
            error: sent.error === "not_connected" ? "gmail_not_connected" : "request_failed",
          });
        }
        markRequestSent(accountId, contact.id);
        return json({ ok: false, error: "connection_requested", contactId: contact.id });
      }
      return json({ ok: false, error: "awaiting_approval", contactId: contact.id });
    }
    if (!contact) {
      const fresh = createContact(accountId, photon, name, to);
      const origin = config.appUrl || new URL(req.url).origin;
      const email = contactRequestEmail(origin, accountId, fresh);
      const sent = await sendFromAny(accountId, to, email.subject, email.body);
      if (!sent.ok) {
        return json({
          ok: false,
          error: sent.error === "not_connected" ? "gmail_not_connected" : "request_failed",
        });
      }
      markRequestSent(accountId, fresh.id);
      return json({ ok: false, error: "connection_requested", contactId: fresh.id });
    }
    const sent = await sendFromAny(
      accountId,
      to,
      subject || `Report from ${photon}`,
      messageBody,
    );
    if (!sent.ok) {
      return json({
        ok: false,
        error: sent.error === "not_connected" ? "gmail_not_connected" : "send_failed",
      });
    }
    return json({ ok: true, sent: true, messageId: sent.messageId, fromLabel: sent.label });
  }

  // Steps 1 + 7 — GET /api/texts/status — Twilio configured or not,
  // number masked.
  if (path === "/api/texts/status" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return getTextsStatus(req, accountId);
  }

  // Steps 1 + 7 — GET /api/texts — stored inbound/outbound texts
  // (?limit=, default 50, max 100).
  if (path === "/api/texts" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return listTexts(req, accountId);
  }

  // Steps 1 + 7 — POST /api/texts/send — owner-tap send. Body:
  // { accountId, to, body }. `to` is a phone number, or an email address
  // (the contact's phone column is used). Only approved contacts.
  if (path === "/api/texts/send" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return sendText(req, accountId, body);
  }

  // Steps 1 + 7 — POST /api/texts/incoming — Twilio webhook
  // (form-encoded). No accountId check here: the handler reads
  // ?accountId= from the URL and validates the Twilio signature itself.
  if (path === "/api/texts/incoming" && method === "POST") {
    return incomingText(req);
  }

  // Steps 1 + 7 — GET /api/calls — the call log (?limit=, default 50,
  // max 100).
  if (path === "/api/calls" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return listCalls(req, accountId);
  }

  // Steps 1 + 7 — POST /api/calls/dial — owner-tap outbound call. Body:
  // { accountId, to }. Only approved contacts. Needs APP_URL set (Twilio
  // fetches the call instructions from it).
  if (path === "/api/calls/dial" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return dialCall(req, accountId, body);
  }

  // Steps 1 + 7 — POST /api/calls/voice — TwiML webhook for inbound
  // calls (and the Url Twilio fetches for outbound dials). Greets,
  // records a voicemail with transcription on.
  if (path === "/api/calls/voice" && method === "POST") {
    return voiceWebhook(req);
  }

  // Steps 1 + 7 — POST /api/calls/voicemail — Twilio transcription
  // callback. Signature validated; transcript stored on the call row
  // and as a message the Photon can read.
  if (path === "/api/calls/voicemail" && method === "POST") {
    return voicemailCallback(req);
  }

  // Step 3 — proactive checks, reminders, push. The module returns null
  // for paths it does not own.
  {
    const proactive = await handleProactiveApi(req, path);
    if (proactive) return proactive;
  }

  // Start My Day — the morning briefing Plug. The module returns null
  // for paths it does not own.
  {
    const day = await handleDayApi(req, path);
    if (day) return day;
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
      // GET /oauth-return — the sign-in return page (see oauthReturnPage).
      // Not under /api/, and it must not fall through to the SPA shell.
      if (path === "/oauth-return") {
        return oauthReturnPage(url);
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

// Schedulers (capability step 3). It does not auto-start on import; it
// runs only while the server is awake, so on the free tier it runs
// while the app is in use and stops when it sleeps.
startProactiveScheduler();
