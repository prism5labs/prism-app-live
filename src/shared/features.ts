// Nova feature sets (Nov 19, 2026) — who gets what, in one place, so the
// server and the client never disagree.
//
// A Nova is the personal helper: it opens the PERSONAL set, the things
// that keep one person's own day in order. The BUSINESS set — a Photon
// working in chat with the business's inbox, calendar and files,
// Switchboard email to approved contacts, proactive checks and
// reminders, more than one account, and a helper who knows the
// business — stays locked unless the account owns a business Launch
// (Supernova or Satellite). The free code opens everything, as it
// always has.
//
// The gate follows the pattern the app already uses everywhere else:
// ownership is a row in the `owned` table (kind 'product' with the
// slug, kind 'photon' or 'atom' with the name), the server reports it
// in /api/state, and the client shows locked things as locked. There is no second gating system: a feature
// set is open when the products that open it are owned. Server
// endpoints that serve a gated feature check the same helpers here
// (via stateFor) before they act.

export type FeatureSet = "personal" | "business";

// The personal set, in plain words — what a Nova opens.
export const PERSONAL_FEATURES: { id: string; label: string }[] = [
  { id: "inbox-triage", label: "One inbox — new mail brought to you, replies drafted in your words" },
  { id: "calendar-reminders", label: "Calendar and reminders, kept where you can see them" },
  { id: "morning-briefing", label: "A morning briefing that walks your day, one item at a time" },
  { id: "check-ins", label: "Gentle check-ins, and nudges to get started" },
];

// The business set, in plain words — what stays locked on Nova alone.
export const BUSINESS_FEATURES: { id: string; label: string }[] = [
  { id: "front-desk", label: "Inbox, calendar and files, worked in chat — read for you, drafted for your tap" },
  { id: "quotes-invoices", label: "Switchboard email to contacts who have approved you" },
  { id: "client-handling", label: "Proactive checks and reminders — what needs a decision, brought to you" },
  { id: "multiple-accounts", label: "More than one email account" },
  { id: "team", label: "A helper who knows your business — your profile and notes, in every chat" },
];

export const BUSINESS_LAUNCH_SLUGS = ["supernova", "satellite"] as const;
export const NOVA_SLUG = "nova";
export const PERSONAL_UPKEEP_SLUG = "personal-upkeep";

export function hasPersonalAccess(
  ownedProducts: string[],
  freeCode: boolean,
  ownedAtoms: string[] = [],
): boolean {
  if (freeCode) return true;
  // Owning any Atom opens the personal set too: an Atom IS a Nova, the
  // same way a Photon is a Supernova, and it is bought on a Nova link.
  if (ownedAtoms.length > 0) return true;
  return (
    ownedProducts.includes(NOVA_SLUG) ||
    BUSINESS_LAUNCH_SLUGS.some((s) => ownedProducts.includes(s))
  );
}

/** Personal access: a Nova, an Atom, a business Launch (which includes the
 *  personal set), or the free code. */
export function featureAccess(
  ownedProducts: string[],
  freeCode: boolean,
  ownedAtoms: string[] = [],
): { personal: boolean; business: boolean } {
  return {
    personal: hasPersonalAccess(ownedProducts, freeCode, ownedAtoms),
    business: hasBusinessAccess(ownedProducts, freeCode),
  };
}

/** Business access: a business Launch only (or the free code). A Nova
 *  on its own never opens the business set. */
export function hasBusinessAccess(ownedProducts: string[], freeCode: boolean): boolean {
  if (freeCode) return true;
  return BUSINESS_LAUNCH_SLUGS.some((s) => ownedProducts.includes(s));
}

// Nova's gentler default (Nov 19, 2026): check-ins and getting-started
// nudges are ON for Nova owners, from the moment Nova is owned. The
// owner can turn either off in the You tab; the saved choice is what
// counts after that. There was no per-product defaults store before
// this — no product set defaults anywhere in the app — so the default
// lives here as the value a Nova owner gets until they save a choice,
// and the saved choice lives in the nova_settings table (db.ts).
export const NOVA_DEFAULTS = {
  checkIns: true,
  gettingStartedNudges: true,
} as const;
