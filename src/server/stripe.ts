// Step 10 — automatic unlocks after purchase (Stripe webhook).
// Buy buttons leave the app for Stripe Payment Links, and nothing tells
// the app a purchase happened, so unlocking runs through codes today.
// This module closes that loop: Stripe tells the server when a payment
// lands, through a webhook, and the server unlocks the Launch on the
// buyer's account.
//
// Handler shape matches server.ts: handleStripeWebhook(req) and
// handleStripeStatus(req) return Responses, so the coordinator only has
// to mount them in the route if-chain. Nothing here edits server.ts.
//
// RAW BODY WARNING (see WIRING.md): the webhook handler MUST receive the
// request untouched. server.ts must route POST /api/stripe/webhook
// straight to handleStripeWebhook(req) and must NOT call readBody(req)
// (req.json()) for that path first — parsing the body destroys the exact
// bytes the Stripe signature was computed over, and every signature
// check would then fail.
//
// Verification is HMAC-SHA256 over "<timestamp>.<raw body>" with
// STRIPE_WEBHOOK_SECRET (Bun crypto), timestamp tolerance 5 minutes,
// compared timing-safe. No Stripe SDK, no new dependencies, no restricted
// Stripe key needed: the webhook secret alone proves the event came
// from Stripe.
//
// Mapping rule: unlock ONLY what the event names unambiguously. If the
// purchased product cannot be mapped to a catalog slug, the payment is
// logged in stripe_payments and the webhook still returns 200 — never
// fail the webhook over a missing mapping, and never guess an unlock.

import { timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { db, ownPhoton, ownAtom, ownProduct, setUpkeep, getOrCreateAccount } from "./db";
import { markPerkUsed } from "./auth";
import { PHOTON_NAMES } from "../shared/photons";
import { ATOM_NAMES } from "../shared/atoms";
import { PRODUCTS } from "../shared/catalog";

db.exec(`
CREATE TABLE IF NOT EXISTS stripe_payments (
  session_id TEXT PRIMARY KEY,
  amount_total INTEGER,
  currency TEXT,
  product TEXT,
  account_id TEXT,
  received_at TEXT NOT NULL
);
`);

export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

export function stripeConfigured(): boolean {
  return config.stripeWebhookSecret.length > 0;
}

/**
 * The account-id check for webhook parsing is STRICTER than server.ts on
 * purpose: client_reference_id is a free-form field, and the legacy hint
 * "Photon-Prism" passes the server's loose account regex (letters and a
 * hyphen, 12 chars). A real account id always comes from client/api.ts,
 * which generates "acc_" + 24 hex chars. Requiring the "acc_" prefix is
 * what keeps a product hint from ever being mistaken for an account.
 * Anything without the prefix is treated as a hint (or ignored).
 */
function isWebhookAccountId(id: string): boolean {
  return /^acc_[A-Za-z0-9_-]{8,127}$/.test(id);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// --- Signature verification (Stripe-Signature header) ---

export type SignatureCheck = { ok: true } | { ok: false; error: string };

function hmacHex(secret: string, signedPayload: string): string {
  const hasher = new Bun.CryptoHasher("sha256", secret);
  hasher.update(signedPayload);
  return hasher.digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Verify a Stripe webhook signature. header is the raw Stripe-Signature
 *  value ("t=<unix seconds>,v1=<hex>,v1=<hex>,..."). The timestamp must be
 *  within 5 minutes of now, and at least one v1 must match the HMAC of
 *  "<timestamp>.<rawBody>" under the secret. */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): SignatureCheck {
  if (!secret) return { ok: false, error: "webhook_not_configured" };
  if (!header) return { ok: false, error: "missing_signature" };
  let timestamp = "";
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t" && v) timestamp = v;
    if (k === "v1" && v) candidates.push(v);
  }
  if (!timestamp || candidates.length === 0) {
    return { ok: false, error: "bad_signature" };
  }
  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) return { ok: false, error: "bad_signature" };
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > STRIPE_SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, error: "stale_signature" };
  }
  const expected = hmacHex(secret, `${timestamp}.${rawBody}`);
  if (!candidates.some((c) => safeEqualHex(c, expected))) {
    return { ok: false, error: "bad_signature" };
  }
  return { ok: true };
}

// --- Mapping a Checkout Session to unlocks ---

export type UnlockAction =
  | { kind: "photon"; ref: string }
  | { kind: "atom"; ref: string }
  | { kind: "product"; ref: string }
  | { kind: "upkeep" };

/**
 * Split a client_reference_id into the buyer's account id and the product
 * hint. The client buy flow sends "<accountId>:<hint>" (see WIRING.md),
 * e.g. "acc_abc123:Photon-Prism" or "acc_abc123:morning-briefing-personal".
 * The account part must start with "acc_" (the format client/api.ts
 * generates); anything else in that slot is treated as a hint, never as
 * an account. Older links carried only the hint ("Photon-Prism",
 * "morning-briefing-personal") and no account id — those parse with
 * accountId null, and no unlock happens for them.
 */
export function parseClientReference(
  ref: unknown,
): { accountId: string | null; hint: string | null } {
  if (typeof ref !== "string" || !ref) return { accountId: null, hint: null };
  const sep = ref.search(/[:|]/);
  if (sep > 0) {
    const first = ref.slice(0, sep);
    const rest = ref.slice(sep + 1);
    if (isWebhookAccountId(first)) {
      return { accountId: first, hint: rest || null };
    }
    return { accountId: null, hint: ref };
  }
  if (isWebhookAccountId(ref)) return { accountId: ref, hint: null };
  return { accountId: null, hint: ref };
}

const PRODUCT_SLUGS = new Set(PRODUCTS.map((p) => p.slug));

/**
 * Turn a product hint into unlocks. Returns null when the hint names
 * nothing this server recognises — the caller logs it and does NOT guess.
 * Hint vocabulary (set by the client buy flow, see WIRING.md):
 *   "Photon-<Name>"            -> that Photon
 *   "Atom-<Name>"              -> that Atom (bought on a Nova link, the
 *                                 same way a Photon is bought on the
 *                                 Supernova link)
 *   "<catalog slug>"           -> that Spark/Plug (personal/business suffix
 *                                 stripped: "<slug>-personal" / "-business")
 *   "supernova" (+ -monthly, -two-year, -annual) -> product "supernova"
 *   "satellite" (+ -monthly, -two-year, -annual) -> product "satellite"
 *   "nova" (+ -monthly)        -> product "nova" (one-time or monthly:
 *                                 both unlock the same personal set)
 *   "personal-upkeep"          -> product "personal-upkeep"
 *   "upkeep"                   -> Upkeep on
 */
export function unlocksForHint(hint: string | null): UnlockAction[] | null {
  if (!hint) return null;
  const photonMatch = hint.match(/^Photon-(.+)$/);
  if (photonMatch && PHOTON_NAMES.includes(photonMatch[1])) {
    return [{ kind: "photon", ref: photonMatch[1] }];
  }
  const atomMatch = hint.match(/^Atom-(.+)$/);
  if (atomMatch && ATOM_NAMES.includes(atomMatch[1])) {
    return [{ kind: "atom", ref: atomMatch[1] }];
  }
  const slug = hint.replace(/-(personal|business)$/, "");
  if (PRODUCT_SLUGS.has(slug)) return [{ kind: "product", ref: slug }];
  if (slug === "supernova" || slug.startsWith("supernova-")) {
    return [{ kind: "product", ref: "supernova" }];
  }
  if (slug === "satellite" || slug.startsWith("satellite-")) {
    return [{ kind: "product", ref: "satellite" }];
  }
  if (slug === "nova" || slug.startsWith("nova-")) {
    return [{ kind: "product", ref: "nova" }];
  }
  if (slug === "personal-upkeep") {
    return [{ kind: "product", ref: "personal-upkeep" }];
  }
  if (slug === "upkeep") return [{ kind: "upkeep" }];
  return null;
}

/**
 * Amount fallback, used ONLY when the session carries no usable hint.
 * Only totals that name exactly one thing are mapped; shared totals are
 * left unknown rather than guessed:
 *   $514.00 Supernova one-time, $101.97 Satellite one-time,
 *   $29.87 Upkeep, $50.47 Supernova monthly, $555.17 Supernova annual,
 *   $33.99 Satellite monthly, $26.78 Satellite 2-year, $373.89 Satellite annual,
 *   $10.30 Nova monthly, $9.27 Personal Upkeep.
 * NOT mapped: $40.17 (Supernova 2-year AND Plug personal), $19.57 / $25.75
 * (every Spark), $60.77 (every Plug business) — the slug is unknowable
 * from the amount alone. And $101.97 is deliberately NOT mapped to Nova
 * one-time: it is the same total as Satellite one-time, so the amount
 * alone cannot tell them apart — Nova one-time unlocks only through its
 * hint (nova-personal), never through the amount.
 */
const AMOUNT_TO_UNLOCKS: Record<number, UnlockAction[]> = {
  51400: [{ kind: "product", ref: "supernova" }],
  10197: [{ kind: "product", ref: "satellite" }],
  2987: [{ kind: "upkeep" }],
  5047: [{ kind: "product", ref: "supernova" }],
  55517: [{ kind: "product", ref: "supernova" }],
  3399: [{ kind: "product", ref: "satellite" }],
  2678: [{ kind: "product", ref: "satellite" }],
  37389: [{ kind: "product", ref: "satellite" }],
  1030: [{ kind: "product", ref: "nova" }],
  927: [{ kind: "product", ref: "personal-upkeep" }],
};

export type SessionMapping = {
  accountId: string | null;
  product: string | null;
  unlocks: UnlockAction[] | null;
};

export function mapCheckoutSession(session: any): SessionMapping {
  const metadata = (session?.metadata ?? {}) as Record<string, unknown>;
  const clientRef = parseClientReference(session?.client_reference_id);
  // metadata.account_id wins when present and valid; otherwise the
  // account id rides inside client_reference_id.
  const metaAccount =
    typeof metadata.account_id === "string" && isWebhookAccountId(metadata.account_id)
      ? metadata.account_id
      : null;
  const accountId = metaAccount ?? clientRef.accountId;
  const hint =
    (typeof metadata.product_slug === "string" && metadata.product_slug) ||
    (typeof metadata.product === "string" && metadata.product) ||
    (typeof metadata.photon === "string" && `Photon-${metadata.photon}`) ||
    clientRef.hint;
  const fromHint = unlocksForHint(hint || null);
  if (fromHint) return { accountId, product: hint || null, unlocks: fromHint };
  const amount = typeof session?.amount_total === "number" ? session.amount_total : null;
  if (amount !== null && AMOUNT_TO_UNLOCKS[amount]) {
    return { accountId, product: `amount:${amount}`, unlocks: AMOUNT_TO_UNLOCKS[amount] };
  }
  return {
    accountId,
    product: hint || (amount !== null ? `amount:${amount}` : null),
    unlocks: null,
  };
}

export function applyUnlocks(accountId: string, unlocks: UnlockAction[]): void {
  getOrCreateAccount(accountId);
  for (const u of unlocks) {
    if (u.kind === "photon") ownPhoton(accountId, u.ref);
    else if (u.kind === "atom") ownAtom(accountId, u.ref);
    else if (u.kind === "product") ownProduct(accountId, u.ref);
    else setUpkeep(accountId, true);
  }
}

export type StripePaymentRow = {
  session_id: string;
  amount_total: number | null;
  currency: string | null;
  product: string | null;
  account_id: string | null;
  received_at: string;
};

export function recordStripePayment(
  sessionId: string,
  amountTotal: number | null,
  currency: string | null,
  product: string | null,
  accountId: string | null,
): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT OR IGNORE INTO stripe_payments
       (session_id, amount_total, currency, product, account_id, received_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, amountTotal, currency, product, accountId, now);
}

/** Recent webhook receipts, newest first — for checking a payment landed. */
export function listStripePayments(limit = 20): StripePaymentRow[] {
  const rows = db
    .query(
      `SELECT session_id, amount_total, currency, product, account_id, received_at
       FROM stripe_payments ORDER BY received_at DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, Math.floor(limit)))) as StripePaymentRow[];
  return rows;
}

// --- HTTP handlers ---

// POST /api/stripe/webhook — Stripe posts events here. Reads the RAW body
// (req.text()); never parse it as JSON first. Returns 200 for every
// verified event, including ones with no account mapping and event types
// this server ignores. Returns 400 only when the signature cannot be
// verified, the secret is not configured, or the payload is not JSON.
export async function handleStripeWebhook(req: Request): Promise<Response> {
  const secret = config.stripeWebhookSecret;
  if (!secret) {
    return json({
      ok: false,
      error: "webhook_not_configured",
      message:
        "The Stripe webhook secret isn't set on this server, so payments can't be verified yet. Buying still works, but unlocks still run through codes.",
    }, 400);
  }
  const rawBody = await req.text();
  const sig = verifyStripeSignature(rawBody, req.headers.get("Stripe-Signature"), secret);
  if (!sig.ok) {
    return json({ ok: false, error: sig.error }, 400);
  }
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: "bad_payload" }, 400);
  }
  const type = typeof event?.type === "string" ? event.type : "";
  // Everything except a completed checkout is acknowledged and ignored.
  if (type !== "checkout.session.completed") {
    return json({ ok: true, received: true, ignored: true, type });
  }
  const session = event?.data?.object ?? {};
  const sessionId = typeof session?.id === "string" ? session.id : "";
  if (!sessionId) return json({ ok: false, error: "bad_payload" }, 400);
  const mapping = mapCheckoutSession(session);
  const amountTotal =
    typeof session?.amount_total === "number" ? session.amount_total : null;
  const currency = typeof session?.currency === "string" ? session.currency : null;
  // Record first (INSERT OR IGNORE makes redelivery safe), then unlock.
  recordStripePayment(sessionId, amountTotal, currency, mapping.product, mapping.accountId);
  if (!mapping.accountId) {
    console.log(
      `[stripe] checkout ${sessionId}: no account id in client_reference_id or metadata; payment recorded, nothing unlocked (product: ${mapping.product ?? "unknown"})`,
    );
    return json({
      ok: true,
      received: true,
      session: sessionId,
      accountId: null,
      unlocked: [],
      unmapped: true,
      product: mapping.product,
    });
  }
  if (!mapping.unlocks) {
    console.log(
      `[stripe] checkout ${sessionId}: account ${mapping.accountId} paid but the product could not be mapped (product: ${mapping.product ?? "unknown"}); payment recorded, nothing unlocked — do not guess`,
    );
    return json({
      ok: true,
      received: true,
      session: sessionId,
      accountId: mapping.accountId,
      unlocked: [],
      unmapped: true,
      product: mapping.product,
    });
  }
  applyUnlocks(mapping.accountId, mapping.unlocks);
  const unlocked = mapping.unlocks.map((u) =>
    u.kind === "upkeep" ? "upkeep" : `${u.kind}:${u.ref}`,
  );
  // A discounted checkout spends the account's welcome offer, when it
  // has one. total_details.amount_discount is Stripe's own number for
  // the discount on this session, so no promotion-code name is guessed.
  const amountDiscount =
    typeof session?.total_details?.amount_discount === "number"
      ? session.total_details.amount_discount
      : 0;
  if (amountDiscount > 0 && markPerkUsed(mapping.accountId, sessionId)) {
    console.log(`[stripe] checkout ${sessionId}: welcome offer used for ${mapping.accountId}`);
  }
  console.log(`[stripe] checkout ${sessionId}: unlocked ${unlocked.join(", ")} for ${mapping.accountId}`);
  return json({
    ok: true,
    received: true,
    session: sessionId,
    accountId: mapping.accountId,
    unlocked,
    unmapped: false,
    product: mapping.product,
  });
}

// GET /api/stripe/status — whether the webhook secret is configured.
// No secret value is ever returned.
export async function handleStripeStatus(_req: Request): Promise<Response> {
  return json({
    ok: true,
    configured: stripeConfigured(),
    webhook: "/api/stripe/webhook",
  });
}
