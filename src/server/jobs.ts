// Step 8 — the job plug (Prism 5 app capability design, section 4).
//
// A small worker that wakes on a schedule, fetches job listings from a
// connected feed, filters them by the owner's rules, and FILES what fits
// so the owner can review it. It does NOT apply to any job. There is no
// apply adapter yet, and auto-apply is never turned on silently: the
// standing rule is that nothing goes out without the owner's tap, and the
// job plug is no exception.
//
// The job source is an OPEN QUESTION, stated plainly: Indeed's public API
// is restricted, so the choice is a job-board partnership, a licensed
// feed, or a hosted browser worker. That choice is undecided and unpriced.
// Until it is decided, this module ships one provider-agnostic adapter
// interface plus one concrete adapter that reads a JSON or RSS feed URL
// from JOBS_FEED_URL. When no feed URL is set, runs fail honestly with
// job_source_not_connected instead of pretending to search. This module
// never scrapes Indeed or any job board, and never invents listings.
//
// File ownership: this module owns its own tables (created here, at
// import) and its own routes (exported as handleJobsApi for server.ts to
// mount). It does not edit server.ts, db.ts, config.ts, or any client
// file. It reads JOBS_FEED_URL from process.env directly; the
// coordinator consolidates env handling at merge time.

import { db } from "./db";

// --- Tables (created here, at import, like db.ts does for its own) ---

db.exec(`
CREATE TABLE IF NOT EXISTS job_rules (
  account_id TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  rule_value TEXT NOT NULL,
  PRIMARY KEY (account_id, rule_key)
);
CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  found INTEGER NOT NULL DEFAULT 0,
  kept INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  log TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS job_listings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT NOT NULL,
  url TEXT NOT NULL,
  pay TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_listings_account_url
  ON job_listings (account_id, url);
CREATE INDEX IF NOT EXISTS idx_job_listings_account_status
  ON job_listings (account_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_job_runs_account
  ON job_runs (account_id, started_at);
`);

// --- Types ---

export type NormalizedListing = {
  source: string;
  title: string;
  company: string;
  location: string;
  url: string;
  pay: string;
  description?: string;
};

export type JobListingRow = {
  id: string;
  accountId: string;
  source: string;
  title: string;
  company: string;
  location: string;
  url: string;
  pay: string;
  status: "filed" | "skipped";
  createdAt: string;
};

export type JobRunRow = {
  id: string;
  accountId: string;
  startedAt: string;
  found: number;
  kept: number;
  skipped: number;
  log: JobDecision[];
};

export type JobDecision = {
  title: string;
  company: string;
  url: string;
  decision: "filed" | "skipped";
  reason: string;
  detail: string;
};

export type JobRunSummary =
  | {
      ok: true;
      runId: string;
      accountId: string;
      startedAt: string;
      found: number;
      kept: number;
      skipped: number;
      decisions: JobDecision[];
      autoApplied: false;
      note: string;
    }
  | { ok: false; error: string; message: string };

// --- Rules ---

// Rule keys the owner may set through POST /api/jobs/rules. Anything else
// is rejected, so a typo never silently becomes a rule that does nothing.
export const RULE_KEYS = [
  "prefer_remote",
  "onsite_allowed",
  "onsite_area",
  "pay_floor_monthly",
  "hard_no_outbound_sales",
  "hard_no_cold_calling",
  "hard_no_call_center",
  "hard_no_commission_only",
  "hard_no_fedex",
  "hard_no_drug_test",
  "hard_no_dot_physical",
  "hard_no_thc_testing",
  "allow_background_check",
  "approved_roles",
] as const;

export type RuleKey = (typeof RULE_KEYS)[number];
export type JobRules = Record<string, string>;

const RULE_KEY_SET = new Set<string>(RULE_KEYS);
const BOOLEAN_RULE_KEYS = new Set<string>([
  "prefer_remote",
  "onsite_allowed",
  "hard_no_outbound_sales",
  "hard_no_cold_calling",
  "hard_no_call_center",
  "hard_no_commission_only",
  "hard_no_fedex",
  "hard_no_drug_test",
  "hard_no_dot_physical",
  "hard_no_thc_testing",
  "allow_background_check",
]);

// Neil's standing rules, as the defaults when the owner has set nothing.
// The owner can change any of these through the rules endpoints.
export function defaultRules(): JobRules {
  return {
    prefer_remote: "true",
    onsite_allowed: "true",
    onsite_area: "Green Bay area",
    pay_floor_monthly: "3000",
    hard_no_outbound_sales: "true",
    hard_no_cold_calling: "true",
    hard_no_call_center: "true",
    hard_no_commission_only: "true",
    hard_no_fedex: "true",
    hard_no_drug_test: "true",
    hard_no_dot_physical: "true",
    hard_no_thc_testing: "true",
    // Background-check consent is fine and never blocks a listing. It is
    // a rule key so the owner can see it stated, not a filter.
    allow_background_check: "true",
    // Roles the owner approved by name for a drug test or DOT physical,
    // as a JSON array of listing URLs (exact match) or titles
    // (case-insensitive). Empty means no role is approved. Drug-screen
    // consent is never signed by the plug itself, approved or not: the
    // plug only files the listing, and the owner decides.
    approved_roles: "[]",
  };
}

function isTrue(rules: JobRules, key: string): boolean {
  return rules[key] === "true";
}

function approvedRoles(rules: JobRules): string[] {
  try {
    const parsed: unknown = JSON.parse(rules.approved_roles || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function isApprovedRole(rules: JobRules, listing: NormalizedListing): boolean {
  const approved = approvedRoles(rules);
  if (approved.length === 0) return false;
  const url = listing.url.trim();
  const title = listing.title.trim().toLowerCase();
  return approved.some(
    (a) => a.trim() === url || a.trim().toLowerCase() === title,
  );
}

export function getRules(accountId: string): { rules: JobRules; customized: boolean } {
  const rows = db
    .query(`SELECT rule_key, rule_value FROM job_rules WHERE account_id = ?`)
    .all(accountId) as { rule_key: string; rule_value: string }[];
  const rules = defaultRules();
  for (const row of rows) {
    if (RULE_KEY_SET.has(row.rule_key)) rules[row.rule_key] = row.rule_value;
  }
  return { rules, customized: rows.length > 0 };
}

function validateRuleValue(key: string, value: unknown): string {
  if (BOOLEAN_RULE_KEYS.has(key)) {
    if (value === true || value === "true") return "true";
    if (value === false || value === "false") return "false";
    throw new Error(`rule ${key} must be true or false`);
  }
  if (key === "pay_floor_monthly") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error("rule pay_floor_monthly must be a number of 0 or more");
    }
    return String(Math.floor(n));
  }
  if (key === "approved_roles") {
    // Accept a JSON array of strings, or a comma-separated string.
    if (Array.isArray(value)) {
      if (!value.every((v) => typeof v === "string")) {
        throw new Error("rule approved_roles must be an array of strings");
      }
      return JSON.stringify(value);
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return "[]";
      if (trimmed.startsWith("[")) {
        const parsed: unknown = JSON.parse(trimmed);
        if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
          throw new Error("rule approved_roles must be a JSON array of strings");
        }
        return JSON.stringify(parsed);
      }
      return JSON.stringify(
        trimmed
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
    throw new Error("rule approved_roles must be an array of strings");
  }
  if (key === "onsite_area") {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("rule onsite_area must be a non-empty string");
    }
    return value.trim().slice(0, 120);
  }
  if (typeof value !== "string") throw new Error(`rule ${key} must be a string`);
  return value.slice(0, 500);
}

export function setRules(accountId: string, patch: Record<string, unknown>): JobRules {
  for (const key of Object.keys(patch)) {
    if (!RULE_KEY_SET.has(key)) {
      throw new Error(
        `unknown rule ${key}; valid rules are: ${[...RULE_KEYS].join(", ")}`,
      );
    }
  }
  const { rules } = getRules(accountId);
  for (const [key, value] of Object.entries(patch)) {
    rules[key] = validateRuleValue(key, value);
  }
  for (const [key, value] of Object.entries(patch)) {
    db.query(
      `INSERT INTO job_rules (account_id, rule_key, rule_value) VALUES (?, ?, ?)
       ON CONFLICT(account_id, rule_key) DO UPDATE SET rule_value = excluded.rule_value`,
    ).run(accountId, key, rules[key]);
  }
  return rules;
}

// --- Pay parsing ---

// Turns a pay string into a monthly dollar amount, or null when the pay
// is missing or cannot be parsed. Hourly assumes 160 hours a month
// (40 hours a week, 4 weeks); weekly uses 4.33 weeks a month. A pay range
// is judged on its LOW end, so the floor is never passed on a top number
// the owner may never see. A bare number of 20,000 or more with no unit
// is read as yearly; anything smaller with no unit is read as monthly.
export function parsePayMonthly(pay: string): number | null {
  const raw = (pay || "").trim().toLowerCase().replace(/,/g, "");
  if (!raw) return null;
  const cleaned = raw.replace(/\$/g, "");
  const range = cleaned.match(/(\d+(?:\.\d+)?)\s*(?:k)?\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(k)?/);
  let amount: number | null = null;
  let unit = "";
  if (range) {
    const lowK = /(\d+(?:\.\d+)?)\s*k\s*(?:-|–|to)/.test(cleaned);
    amount = lowK ? Number(range[1]) * 1000 : Number(range[1]);
    unit = cleaned;
  } else {
    const m = cleaned.match(/(\d+(?:\.\d+)?)\s*(k)?/);
    if (!m) return null;
    amount = Number(m[1]) * (m[2] === "k" ? 1000 : 1);
    unit = cleaned;
  }
  if (!Number.isFinite(amount)) return null;
  if (/hour|\/hr|per\s*hour|hourly/.test(unit)) return amount * 160;
  if (/week|\/wk|per\s*week/.test(unit)) return amount * 4.33;
  if (/year|\/yr|per\s*year|annual|salary/i.test(unit)) return amount / 12;
  if (/month|\/mo|per\s*month|monthly/.test(unit)) return amount;
  // No unit: big numbers are yearly salaries, small ones monthly pay.
  if (amount >= 20000) return amount / 12;
  return amount;
}

// --- Location ---

// Towns that count as the Green Bay area for onsite work. A listing whose
// location names one of these is onsite-OK; anything else onsite is
// outside the area. Remote work is not bound by location at all.
const GREEN_BAY_AREA = [
  "green bay",
  "de pere",
  "ashwaubenon",
  "allouez",
  "bellevue",
  "howard",
  "suamico",
  "pulaski",
  "luxemburg",
  "denmark",
  "wrightstown",
];

function isRemoteText(text: string): boolean {
  return /remote|work[\s-]?from[\s-]?home|\bwfh\b/i.test(text);
}

function isGreenBayArea(location: string): boolean {
  const loc = location.toLowerCase();
  return GREEN_BAY_AREA.some((town) => loc.includes(town));
}

// --- Hard-no detection (on title + company + description) ---

function hasDrugTest(text: string): boolean {
  // "No drug test" and "drug test not required" do NOT count.
  if (/no\s+drug\s*(test|screen|screening)/i.test(text)) return false;
  if (/drug\s*(test|screen|screening)[^.]{0,60}not\s+required/i.test(text)) return false;
  return /drug\s*(test|screen|screening)|pre-employment\s+screening/i.test(text);
}

function hasDotPhysical(text: string): boolean {
  if (/no\s+dot\s+physical/i.test(text)) return false;
  if (/dot\s+physical[^.]{0,60}not\s+required/i.test(text)) return false;
  return /dot\s+physical|department of transportation\s+physical/i.test(text);
}

function hasThcTesting(text: string): boolean {
  return /thc\s*(test|screen|screening)|test(s|ing)?\s+for\s+thc|marijuana\s*(test|screen)/i.test(text);
}

// --- Rules engine ---

export function evaluateListing(
  listing: NormalizedListing,
  rules: JobRules,
): { decision: "filed" | "skipped"; reason: string; detail: string; notes: string[] } {
  const text = [listing.title, listing.company, listing.description || ""].join(" ");
  const notes: string[] = [];

  // Hard-no rules first, in a fixed order so the logged reason is
  // deterministic when a listing trips more than one.
  if (isTrue(rules, "hard_no_fedex") && /fedex/i.test(listing.company)) {
    return {
      decision: "skipped",
      reason: "hard_no_fedex",
      detail: "FedEx is a hard no in any role.",
      notes,
    };
  }
  if (isTrue(rules, "hard_no_outbound_sales") && /\boutbound\b/i.test(text)) {
    // "No outbound calls" and "no outbound work" do NOT count: the
    // posting is saying the job has none of it.
    if (!/no\s+outbound/i.test(text)) {
      return {
        decision: "skipped",
        reason: "hard_no_outbound_sales",
        detail: "Outbound sales is a hard no.",
        notes,
      };
    }
  }
  if (isTrue(rules, "hard_no_cold_calling") && /cold[\s-]?call/i.test(text)) {
    if (!/no\s+cold[\s-]?call/i.test(text)) {
      return {
        decision: "skipped",
        reason: "hard_no_cold_calling",
        detail: "Cold calling is a hard no.",
        notes,
      };
    }
  }
  if (isTrue(rules, "hard_no_call_center") && /call[\s-]?cent(re|er)/i.test(text)) {
    return {
      decision: "skipped",
      reason: "hard_no_call_center",
      detail: "Phone-heavy call center work is a hard no.",
      notes,
    };
  }
  if (
    isTrue(rules, "hard_no_commission_only") &&
    (/commission[\s-]?only/i.test(text) || /100%\s*commission/i.test(text))
  ) {
    return {
      decision: "skipped",
      reason: "hard_no_commission_only",
      detail: "Commission-only work is a hard no.",
      notes,
    };
  }
  // THC testing is checked before the general drug-test rule so a
  // posting that names THC gets the more specific reason.
  if (isTrue(rules, "hard_no_thc_testing") && hasThcTesting(text)) {
    return {
      decision: "skipped",
      reason: "hard_no_thc_testing",
      detail: "The employer tests for THC.",
      notes,
    };
  }
  if (isTrue(rules, "hard_no_drug_test") && hasDrugTest(text)) {
    if (isApprovedRole(rules, listing)) {
      notes.push("Drug test required, but this role is on the owner's approved list.");
    } else {
      return {
        decision: "skipped",
        reason: "hard_no_drug_test",
        detail: "The posting requires a drug test and the owner has not approved this role.",
        notes,
      };
    }
  }
  if (isTrue(rules, "hard_no_dot_physical") && hasDotPhysical(text)) {
    if (isApprovedRole(rules, listing)) {
      notes.push("DOT physical required, but this role is on the owner's approved list.");
    } else {
      return {
        decision: "skipped",
        reason: "hard_no_dot_physical",
        detail: "The posting requires a DOT physical and the owner has not approved this role.",
        notes,
      };
    }
  }

  // Soft rules: filed as skipped with the reason, never applied.
  const floor = Number(rules.pay_floor_monthly || "3000");
  const monthly = parsePayMonthly(listing.pay);
  if (monthly === null) {
    notes.push("Pay not listed, so the pay floor could not be checked.");
  } else if (monthly < floor) {
    return {
      decision: "skipped",
      reason: "pay_below_floor",
      detail: `Pay is about $${Math.round(monthly)} a month, below the $${floor} floor.`,
      notes,
    };
  }

  const locationText = [listing.location, listing.title, listing.description || ""].join(" ");
  if (!isRemoteText(locationText)) {
    if (listing.location.trim() && isTrue(rules, "onsite_allowed") && !isGreenBayArea(listing.location)) {
      return {
        decision: "skipped",
        reason: "location_outside_area",
        detail: `Onsite work in ${listing.location} is outside the ${rules.onsite_area || "Green Bay area"}. Remote work is preferred.`,
        notes,
      };
    }
    if (!listing.location.trim()) {
      notes.push("Location not listed, so the onsite area could not be checked.");
    }
  }

  return {
    decision: "filed",
    reason: "fits_rules",
    detail: "Fits the owner's rules. Filed for review; nothing was applied to.",
    notes,
  };
}

// --- Job source: provider-agnostic adapter + one feed adapter ---

export type JobSourceAdapter = {
  name: string;
  fetchListings: () => Promise<NormalizedListing[]>;
};

export function jobsFeedUrl(): string {
  return (process.env.JOBS_FEED_URL || "").trim();
}

export function jobSourceConnected(): boolean {
  return jobsFeedUrl().length > 0;
}

const NOT_CONNECTED_MESSAGE =
  "No job source is connected yet, so the job plug cannot search. " +
  "A job source (a job-board partnership, a licensed feed, or a hosted browser worker) " +
  "still has to be chosen and priced. Once one is connected, the plug files jobs that fit your rules and never applies to one on its own.";

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function tagText(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  let inner = m[1].trim();
  if (inner.startsWith("<![CDATA[")) inner = inner.slice(9).replace(/\]\]>$/, "");
  return stripTags(inner);
}

function atomLink(block: string): string {
  const m = block.match(/<link[^>]*href="([^"]+)"[^>]*>/i);
  if (m) return m[1].trim();
  return tagText(block, "link");
}

function parseFeedText(text: string, source: string): NormalizedListing[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("feed is empty");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("feed JSON could not be parsed");
    }
    const items: unknown[] = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null
        ? ((parsed as Record<string, unknown>).jobs ??
          (parsed as Record<string, unknown>).listings ??
          (parsed as Record<string, unknown>).results ??
          (parsed as Record<string, unknown>).data ??
          []) as unknown[]
        : [];
    if (!Array.isArray(items)) throw new Error("feed JSON is not a list of jobs");
    const out: NormalizedListing[] = [];
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      const title = String(o.title ?? o.job_title ?? o.name ?? "").trim();
      const url = String(o.url ?? o.link ?? o.apply_url ?? o.applyUrl ?? "").trim();
      if (!title || !url) continue;
      out.push({
        source,
        title,
        company: String(o.company ?? o.company_name ?? o.employer ?? "").trim(),
        location: String(o.location ?? o.city ?? "").trim(),
        url,
        pay: String(o.pay ?? o.salary ?? o.compensation ?? "").trim(),
        description: String(o.description ?? o.summary ?? o.snippet ?? "").trim() || undefined,
      });
    }
    return out;
  }
  if (/<rss[\s>]|<feed[\s>]|<rdf/i.test(trimmed)) {
    const blocks = [...trimmed.matchAll(/<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi)].map(
      (m) => m[1],
    );
    const out: NormalizedListing[] = [];
    for (const block of blocks) {
      const title = tagText(block, "title");
      const url = atomLink(block);
      if (!title || !url) continue;
      const description =
        tagText(block, "description") || tagText(block, "summary") || tagText(block, "content") || "";
      // Some feeds put the employer in the author/creator tag.
      const company =
        tagText(block, "author") || tagText(block, "dc:creator") || "";
      out.push({
        source,
        title,
        company,
        location: "",
        url,
        pay: "",
        description: description || undefined,
      });
    }
    return out;
  }
  throw new Error("feed is neither JSON nor RSS/Atom");
}

// The one concrete adapter: reads a JSON or RSS/Atom feed URL from
// JOBS_FEED_URL with fetch, nothing else. No scraping, no invented
// listings: what the feed returns is what gets filtered.
export async function fetchListingsFromFeed(): Promise<NormalizedListing[]> {
  const url = jobsFeedUrl();
  if (!url) throw new Error("job_source_not_connected");
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error("could not reach the job feed");
  }
  if (!res.ok) throw new Error(`job feed answered ${res.status}`);
  const text = await res.text();
  return parseFeedText(text, "feed");
}

export const feedAdapter: JobSourceAdapter = {
  name: "feed",
  fetchListings: fetchListingsFromFeed,
};

// The active adapter. The feed adapter is the default; the coordinator
// (or a later step, once the source decision is made) can swap in a
// partnership or licensed-feed adapter through setJobSourceAdapter.
let activeAdapter: JobSourceAdapter = feedAdapter;

export function setJobSourceAdapter(adapter: JobSourceAdapter | null): void {
  activeAdapter = adapter ?? feedAdapter;
}

export function getJobSourceAdapter(): JobSourceAdapter {
  return activeAdapter;
}

// --- Storage helpers ---

function rowToListing(row: any): JobListingRow {
  return {
    id: row.id,
    accountId: row.account_id,
    source: row.source,
    title: row.title,
    company: row.company,
    location: row.location,
    url: row.url,
    pay: row.pay,
    status: row.status === "filed" ? "filed" : "skipped",
    createdAt: row.created_at,
  };
}

export function listListings(
  accountId: string,
  opts: { status?: "filed" | "skipped"; limit?: number } = {},
): JobListingRow[] {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const rows =
    opts.status === "filed" || opts.status === "skipped"
      ? (db
          .query(
            `SELECT * FROM job_listings WHERE account_id = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(accountId, opts.status, limit) as any[])
      : (db
          .query(
            `SELECT * FROM job_listings WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(accountId, limit) as any[]);
  return rows.map(rowToListing);
}

export function getLastRun(accountId: string): JobRunRow | null {
  const row = db
    .query(`SELECT * FROM job_runs WHERE account_id = ? ORDER BY started_at DESC LIMIT 1`)
    .get(accountId) as any;
  if (!row) return null;
  let log: JobDecision[] = [];
  try {
    log = JSON.parse(row.log || "[]");
  } catch {
    log = [];
  }
  return {
    id: row.id,
    accountId: row.account_id,
    startedAt: row.started_at,
    found: row.found,
    kept: row.kept,
    skipped: row.skipped,
    log,
  };
}

export function getJobStatus(accountId: string): {
  sourceConnected: boolean;
  source: string | null;
  rulesSet: boolean;
  rules: JobRules;
  autoApply: false;
  lastRun: JobRunRow | null;
  message: string;
} {
  const { rules, customized } = getRules(accountId);
  const connected = jobSourceConnected();
  return {
    sourceConnected: connected,
    source: connected ? activeAdapter.name : null,
    rulesSet: customized,
    rules,
    autoApply: false,
    lastRun: getLastRun(accountId),
    message: connected
      ? "The job plug files jobs that fit your rules so you can review them. It never applies to a job on its own."
      : NOT_CONNECTED_MESSAGE,
  };
}

// --- Worker ---

export async function runJobPlug(accountId: string): Promise<JobRunSummary> {
  const startedAt = new Date().toISOString();
  if (!jobSourceConnected()) {
    return { ok: false, error: "job_source_not_connected", message: NOT_CONNECTED_MESSAGE };
  }
  const { rules } = getRules(accountId);
  let fetched: NormalizedListing[];
  try {
    fetched = await activeAdapter.fetchListings();
  } catch (e) {
    const message = e instanceof Error ? e.message : "job feed failed";
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    db.query(
      `INSERT INTO job_runs (id, account_id, started_at, found, kept, skipped, log) VALUES (?, ?, ?, 0, 0, 0, ?)`,
    ).run(runId, accountId, startedAt, JSON.stringify([{ error: message }]));
    return {
      ok: false,
      error: "job_source_error",
      message: `The job feed could not be read (${message}). Nothing was filed and nothing was applied to.`,
    };
  }

  const decisions: JobDecision[] = [];
  const seenUrls = new Set<string>();
  let kept = 0;
  let skipped = 0;
  for (const listing of fetched) {
    const urlKey = listing.url.trim().toLowerCase();
    if (!urlKey) continue;
    if (seenUrls.has(urlKey)) continue;
    seenUrls.add(urlKey);
    const existing = db
      .query(`SELECT status FROM job_listings WHERE account_id = ? AND url = ?`)
      .get(accountId, listing.url.trim()) as any;
    if (existing) {
      skipped += 1;
      decisions.push({
        title: listing.title,
        company: listing.company,
        url: listing.url,
        decision: "skipped",
        reason: "already_filed",
        detail: "This job was already filed on an earlier run.",
      });
      continue;
    }
    const result = evaluateListing(listing, rules);
    const id = `job_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    db.query(
      `INSERT INTO job_listings (id, account_id, source, title, company, location, url, pay, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      accountId,
      listing.source || activeAdapter.name,
      listing.title,
      listing.company,
      listing.location,
      listing.url,
      listing.pay,
      result.decision,
      startedAt,
    );
    if (result.decision === "filed") kept += 1;
    else skipped += 1;
    decisions.push({
      title: listing.title,
      company: listing.company,
      url: listing.url,
      decision: result.decision,
      reason: result.reason,
      detail: result.notes.length
        ? `${result.detail} (${result.notes.join(" ")})`
        : result.detail,
    });
  }

  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  db.query(
    `INSERT INTO job_runs (id, account_id, started_at, found, kept, skipped, log) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, accountId, startedAt, seenUrls.size, kept, skipped, JSON.stringify(decisions));
  return {
    ok: true,
    runId,
    accountId,
    startedAt,
    found: seenUrls.size,
    kept,
    skipped,
    decisions,
    autoApplied: false,
    note: "Filed what fits for review. Nothing was applied to; there is no apply step yet.",
  };
}

// --- Scheduler (daily; NOT auto-started on import) ---

export const JOB_PLUG_INTERVAL_MS = 24 * 60 * 60 * 1000;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startJobPlugScheduler(): () => void {
  if (schedulerTimer) return stopJobPlugScheduler;
  const runAllAccounts = async () => {
    const rows = db.query(`SELECT id FROM accounts`).all() as { id: string }[];
    for (const row of rows) {
      try {
        await runJobPlug(row.id);
      } catch (e) {
        console.error("job plug scheduled run failed for account", row.id, e);
      }
    }
  };
  schedulerTimer = setInterval(() => {
    void runAllAccounts();
  }, JOB_PLUG_INTERVAL_MS);
  return stopJobPlugScheduler;
}

export function stopJobPlugScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

// --- Persona truth lines (for personas.ts at merge time) ---

export const JOB_TRUTH_LINES = [
  "The job plug files jobs that fit your rules so you can review them. It does not apply to any job on its own.",
  "It only works once a job source is connected, and right now no job source is connected, so it cannot search yet.",
  "It never signs a drug-test consent or a background-check consent, and it skips anything from FedEx, anything outbound or cold-calling, any phone-heavy call center, and any posting that needs a drug test or a DOT physical unless you approved that exact role.",
];

// --- Routes (mounted by server.ts; this module returns null for other paths) ---

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

export async function handleJobsApi(req: Request, path: string): Promise<Response | null> {
  if (!path.startsWith("/api/jobs")) return null;
  const url = new URL(req.url);
  const method = req.method;

  // GET /api/jobs/status — source connected? rules set? last run?
  if (path === "/api/jobs/status" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return json({ ok: true, ...getJobStatus(accountId) });
  }

  // GET /api/jobs/rules — the merged rules (defaults + owner changes).
  if (path === "/api/jobs/rules" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const { rules, customized } = getRules(accountId);
    return json({ ok: true, rules, customized, defaults: defaultRules() });
  }

  // POST /api/jobs/rules — the owner sets their rules. Unknown keys are
  // rejected; bad values are rejected. Body: { rules: { key: value } }
  // or the rules flat in the body.
  if (path === "/api/jobs/rules" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const patch =
      body.rules && typeof body.rules === "object" && !Array.isArray(body.rules)
        ? (body.rules as Record<string, unknown>)
        : (Object.fromEntries(
            Object.entries(body).filter(([k]) => k !== "accountId"),
          ) as Record<string, unknown>);
    if (Object.keys(patch).length === 0) return bad("no rules given", 400);
    try {
      const rules = setRules(accountId, patch);
      return json({ ok: true, rules });
    } catch (e) {
      return bad(e instanceof Error ? e.message : "invalid rules", 400);
    }
  }

  // GET /api/jobs/listings — stored listings, newest first.
  // ?status=filed|skipped&limit=50
  if (path === "/api/jobs/listings" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const status = url.searchParams.get("status") || "";
    if (status && status !== "filed" && status !== "skipped") {
      return bad("status must be filed or skipped", 400);
    }
    const limit = Number(url.searchParams.get("limit") || "50");
    const listings = listListings(accountId, {
      status: status === "filed" || status === "skipped" ? status : undefined,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return json({ ok: true, listings });
  }

  // POST /api/jobs/run — one manual run for the caller's account. Files
  // what fits; never applies to anything.
  if (path === "/api/jobs/run" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const summary = await runJobPlug(accountId);
    if (!summary.ok) {
      return json({ ok: false, error: summary.error, message: summary.message }, 503);
    }
    return json({ ...summary });
  }

  return bad("not found", 404);
}
