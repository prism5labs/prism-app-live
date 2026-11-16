// Step 10 — web research (server side).
// A Photon cannot look anything up live on its own. When it needs a live
// fact, the server asks a search provider and the answer comes back with
// its source, so the Photon cites what it found and never states a guessed
// fact as a checked one.
//
// One provider interface, one concrete adapter (Brave Search API, via
// fetch, key from BRAVE_SEARCH_API_KEY). No new dependencies.
//
// This module is NOT wired into the brain yet: anthropic.ts is untouched,
// so the brain cannot call this as a tool. For now the endpoint is for
// the client UI (a "check this" action) and for pasted research. Brain
// tool-use integration is a follow-up — see WIRING.md.
//
// Handler shape matches server.ts: handleResearch(req) reads its own JSON
// body and returns a Response, so the coordinator only has to mount it in
// the route if-chain. Nothing here edits server.ts.

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  /** Where the result came from: the site's hostname, e.g. "example.com". */
  source: string;
};

export interface SearchProvider {
  name: string;
  search(query: string): Promise<SearchResult[]>;
}

export const MAX_QUERY_LENGTH = 500;
export const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_RESULT_COUNT = 5;

// Read at call time, not import time, so the key can land after boot.
export function researchConfigured(): boolean {
  return (process.env.BRAVE_SEARCH_API_KEY || "").length > 0;
}

function sourceFromUrl(url: string): string {
  try {
    return new URL(url).hostname || "web";
  } catch {
    return "web";
  }
}

type BraveWebResult = {
  title?: unknown;
  url?: unknown;
  description?: unknown;
};

function normalizeBraveResults(data: any): SearchResult[] {
  const raw = (data?.web?.results ?? []) as BraveWebResult[];
  const out: SearchResult[] = [];
  for (const r of raw) {
    const url = typeof r.url === "string" ? r.url : "";
    const title = typeof r.title === "string" ? r.title : "";
    if (!url || !title) continue;
    out.push({
      title,
      url,
      snippet: typeof r.description === "string" ? r.description : "",
      source: sourceFromUrl(url),
    });
  }
  return out;
}

/** Brave Search API adapter. Throws on any upstream failure; the handler
 *  turns that into a plain-words research_failed, never the upstream body. */
export async function searchBrave(query: string): Promise<SearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY || "";
  if (!key) throw new Error("research_not_connected");
  const url =
    `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}` +
    `&count=${BRAVE_RESULT_COUNT}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "X-Subscription-Token": key,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`brave_search_${res.status}`);
  const data = (await res.json()) as any;
  return normalizeBraveResults(data);
}

export const braveSearchProvider: SearchProvider = {
  name: "brave",
  search: searchBrave,
};

/** Provider interface entry point. Defaults to Brave; a caller may pass a
 *  different provider that satisfies SearchProvider. */
export async function searchWeb(
  query: string,
  provider: SearchProvider = braveSearchProvider,
): Promise<SearchResult[]> {
  return provider.search(query);
}

// --- HTTP plumbing (same small helpers as server.ts; this module must not
// import server.ts, or the import would be circular). ---

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bad(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

function isValidAccountId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(id);
}

// POST /api/research — body: { accountId, query }.
// Returns { ok: true, query, provider, results: [{ title, url, snippet,
// source }] }, always with sources. Without a Brave key:
// { ok: false, error: "research_not_connected" } with a plain-words message.
export async function handleResearch(req: Request): Promise<Response> {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const accountId = typeof body?.accountId === "string" ? body.accountId.trim() : "";
  if (!isValidAccountId(accountId)) return bad("accountId required", 400);
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query) return bad("query required", 400);
  if (query.length > MAX_QUERY_LENGTH) return bad("query too long", 400);
  if (!researchConfigured()) {
    return json({
      ok: false,
      error: "research_not_connected",
      message:
        "Web search isn't connected on this server yet. It needs a Brave Search key, and until then I can't look things up live — paste the page or the facts here and I'll work from that.",
    });
  }
  try {
    const results = await searchWeb(query);
    return json({ ok: true, query, provider: "brave", results });
  } catch (e) {
    console.error("research failed:", e);
    return json({
      ok: false,
      error: "research_failed",
      message: "The search didn't come back. Try that again in a moment.",
    });
  }
}
