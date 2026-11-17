// Generates src/shared/catalog.ts from the live Stripe links record and the
// product files, so every checkout URL in the app is byte-for-byte exact.
// Run: bun scripts/gen-catalog.ts
// Source of truth: ~/workspace/business/stripe-payment-links.md
// Product descriptions: ~/workspace/business/products/*.txt ("What it does" line)

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const STRIPE_MD = join(ROOT, "..", "stripe-payment-links.md");
const PRODUCTS_DIR = join(ROOT, "..", "products");
const OUT = join(ROOT, "src", "shared", "catalog.ts");

const md = readFileSync(STRIPE_MD, "utf8");

type LinkRow = {
  product: string;
  price: string;
  total: string;
  url: string;
};

function parseTable(section: string): LinkRow[] {
  const rows: LinkRow[] = [];
  for (const line of section.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || t.includes("---") || t.includes("Product |")) continue;
    const cells = t.split("|").map((c) => c.trim()).filter(Boolean);
    // One-time/subscription tables: Product | Price | Fee | Total | Link | Link ID
    if (cells.length >= 5 && cells[4].startsWith("https://buy.stripe.com/")) {
      rows.push({ product: cells[0], price: cells[1], total: cells[3], url: cells[4] });
    }
  }
  return rows;
}

function sectionBetween(md: string, start: string, end?: string): string {
  const i = md.indexOf(start);
  if (i < 0) throw new Error("section not found: " + start);
  const j = end ? md.indexOf(end, i) : md.length;
  return md.slice(i, j < 0 ? md.length : j);
}

// --- Top-level links ---
const oneTime = parseTable(sectionBetween(md, "### One-time", "### Subscriptions"));
const subs = parseTable(sectionBetween(md, "### Subscriptions", "### Named catalog links"));

function find(rows: LinkRow[], product: string): LinkRow {
  const r = rows.find((x) => x.product === product);
  if (!r) throw new Error("link row not found: " + product);
  return r;
}

// --- Named catalog links, grouped by category ---
type NamedRow = LinkRow & { category: string; num: string };
const categories = ["Everyday Life", "Communication", "Business Operations", "Data & Documents"];
const named: NamedRow[] = [];
for (let ci = 0; ci < categories.length; ci++) {
  const cat = categories[ci];
  const next = categories[ci + 1] ? `#### ${categories[ci + 1]}` : "Notes:";
  const sec = sectionBetween(md, `#### ${cat}`, next);
  for (const line of sec.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || t.includes("---") || t.includes("Product |")) continue;
    const cells = t.split("|").map((c) => c.trim()).filter(Boolean);
    // # | Product | Price | Fee | Total | Link | Link ID
    if (cells.length >= 6 && cells[5].startsWith("https://buy.stripe.com/")) {
      named.push({ num: cells[0], product: cells[1], price: cells[2], total: cells[4], url: cells[5], category: cat });
    }
  }
}
if (named.length !== 46) throw new Error(`expected 46 named links, got ${named.length}`);

// --- Product descriptions from the product files ---
const SLUGS: Record<string, string> = {
  "Morning Briefing": "morning-briefing",
  // Start My Day: product file exists, md rows #11-12 exist with prices,
  // but its two Stripe payment links are PENDING (see the md note). The
  // generator picks it up the moment the live URLs are pasted in and the
  // counts below go 46 -> 48 named links and 23 -> 24 products.
  "Start My Day": "start-my-day",
  "Bill Reminder List": "bill-reminder-list",
  "Weekly Planner Check": "weekly-planner-check",
  "Find a Time": "find-a-time",
  "End of Day Wrap": "end-of-day-wrap",
  "Inbox Sorting Drafts": "inbox-sorting-drafts",
  "Check-in Drafts": "check-in-drafts",
  "Meeting Notes Summary": "meeting-notes-summary",
  "Inbox Zero Sprint": "inbox-zero-sprint",
  "Morning Comms Check": "morning-comms-check",
  "Stay in Touch Writer": "stay-in-touch-writer",
  "Who's This?": "whos-this",
  "Missed-Call Catcher": "missed-call-catcher",
  "On Watch": "on-watch",
  "Lead Follow-up Drafts": "lead-follow-up-drafts",
  "Invoice Reminder Drafts": "invoice-reminder-drafts",
  "Review Request Drafts": "review-request-drafts",
  "Invoice Helper": "invoice-helper",
  "Quote Writer": "quote-writer",
  "Job Done Post": "job-done-post",
  "Spreadsheet Report": "spreadsheet-report",
  "File Sorting Plan": "file-sorting-plan",
  "Form Copy Helper": "form-copy-helper",
};

function productDescription(slug: string): string {
  const txt = readFileSync(join(PRODUCTS_DIR, slug + ".txt"), "utf8");
  const m = txt.match(/\*\*What it does:\*\*\s*(.+)/);
  if (!m) throw new Error("no 'What it does' line in " + slug);
  let d = m[1].trim();
  // Strip trailing "Made by Prism 5 Labs." and similar tail.
  d = d.replace(/\s*Made by Prism 5 Labs\.?\s*$/, "");
  return d;
}

// --- Group named rows into products ---
type Variant = { price: string; total: string; url: string };
type Product = {
  slug: string;
  name: string;
  kind: "Spark" | "Plug";
  category: string;
  description: string;
  personal: Variant;
  business: Variant;
};

const byKey = new Map<string, Product>();
for (const row of named) {
  const m = row.product.match(/^(.+?) — (Spark|Plug)(?: \((Personal|Business)\))?$/);
  if (!m) throw new Error("cannot parse product row: " + row.product);
  const name = m[1];
  const kind = m[2] as "Spark" | "Plug";
  let variant = m[3] as "Personal" | "Business" | undefined;
  if (!variant) {
    // Fixed-price rows: infer variant from price (canon: Spark 19/25, Plug 39/59).
    const p = parseFloat(row.price.replace(/[^0-9.]/g, ""));
    variant = kind === "Spark" ? (p === 19 ? "Personal" : "Business") : p === 39 ? "Personal" : "Business";
  }
  const key = name + "|" + kind;
  let prod = byKey.get(key);
  if (!prod) {
    const slug = SLUGS[name];
    if (!slug) throw new Error("no slug for product: " + name);
    prod = {
      slug,
      name,
      kind,
      category: row.category,
      description: productDescription(slug),
      personal: { price: "", total: "", url: "" },
      business: { price: "", total: "", url: "" },
    };
    byKey.set(key, prod);
  }
  const v: Variant = { price: row.price, total: row.total, url: row.url };
  if (variant === "Personal") prod.personal = v;
  else prod.business = v;
}
const products = [...byKey.values()];
if (products.length !== 23) throw new Error(`expected 23 products, got ${products.length}`);
for (const p of products) {
  if (!p.personal.url || !p.business.url) throw new Error("missing variant for " + p.name);
}

// --- Emit catalog.ts ---
const supernova = find(oneTime, "Supernova");
const satellite = find(oneTime, "Satellite");
const snMonthly = find(subs, "Supernova");
const snTwoYear = find(subs, "Supernova (2-year)");
const snAnnual = find(subs, "Supernova (annual prepay)");
const satMonthly = find(subs, "Satellite");
const satTwoYear = find(subs, "Satellite (2-year)");
const satAnnual = find(subs, "Satellite (annual prepay)");
const upkeep = find(subs, "Upkeep");

const esc = (s: string) => JSON.stringify(s);

const out = `// AUTO-GENERATED by scripts/gen-catalog.ts from
// ~/workspace/business/stripe-payment-links.md and ~/workspace/business/products/*.txt
// Do not hand-edit: re-run the generator. Every checkout URL is byte-for-byte
// the live Stripe Payment Link. Prices include the standard 3% processing fee
// as a separate line at checkout; the totals below are what the buyer pays.

export type Variant = { price: string; total: string; url: string };
export type CatalogProduct = {
  slug: string;
  name: string;
  kind: "Spark" | "Plug";
  category: string;
  description: string;
  personal: Variant;
  business: Variant;
};

export const SUPERNOVA = {
  name: "Supernova",
  price: ${esc(supernova.price)},
  total: ${esc(supernova.total)},
  url: ${esc(supernova.url)},
  monthly: { price: ${esc(snMonthly.price)}, total: ${esc(snMonthly.total)}, url: ${esc(snMonthly.url)} },
  twoYear: { price: ${esc(snTwoYear.price)}, total: ${esc(snTwoYear.total)}, url: ${esc(snTwoYear.url)} },
  annual: { price: ${esc(snAnnual.price)}, total: ${esc(snAnnual.total)}, url: ${esc(snAnnual.url)} },
};

export const SATELLITE = {
  name: "Satellite",
  price: ${esc(satellite.price)},
  total: ${esc(satellite.total)},
  url: ${esc(satellite.url)},
  monthly: { price: ${esc(satMonthly.price)}, total: ${esc(satMonthly.total)}, url: ${esc(satMonthly.url)} },
  twoYear: { price: ${esc(satTwoYear.price)}, total: ${esc(satTwoYear.total)}, url: ${esc(satTwoYear.url)} },
  annual: { price: ${esc(satAnnual.price)}, total: ${esc(satAnnual.total)}, url: ${esc(satAnnual.url)} },
};

export const UPKEEP = {
  name: "Upkeep",
  price: ${esc(upkeep.price)},
  total: ${esc(upkeep.total)},
  url: ${esc(upkeep.url)},
};

// Each Photon is bought individually on the Supernova link, with the Photon
// named in client_reference_id so fulfillment can tell which one it is.
export function photonBuyUrl(name: string): string {
  return SUPERNOVA.url + "?client_reference_id=Photon-" + encodeURIComponent(name);
}

export const CATEGORIES = ${JSON.stringify(categories)};

export const PRODUCTS: CatalogProduct[] = ${JSON.stringify(products, null, 2)};

export const ALL_CHECKOUT_URLS: string[] = [
  SUPERNOVA.url,
  SUPERNOVA.monthly.url,
  SUPERNOVA.twoYear.url,
  SUPERNOVA.annual.url,
  SATELLITE.url,
  SATELLITE.monthly.url,
  SATELLITE.twoYear.url,
  SATELLITE.annual.url,
  UPKEEP.url,
  ...PRODUCTS.flatMap((p) => [p.personal.url, p.business.url]),
];
`;

writeFileSync(OUT, out);
console.log(`wrote ${OUT}`);
console.log(`products: ${products.length}, named links: ${named.length}, total checkout URLs: ${9 + 46}`);
console.log(`supernova ${supernova.url} total ${supernova.total}`);
console.log(`satellite ${satellite.url} total ${satellite.total}`);
console.log(`upkeep ${upkeep.url} total ${upkeep.total}`);
