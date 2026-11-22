// Anthropic Messages API client (plain fetch, no SDK). The brain is only
// used when ANTHROPIC_API_KEY is set; without it the app answers honestly
// that the brain is not connected. No provider or model names ever reach
// the visible copy.
//
// Web research is wired into the brain as a tool: when a Brave Search key
// is set (see research.ts), the brain may call web_search for a current or
// external fact instead of guessing, and the results ride back in as tool
// results with their sources, so the reply can name where the fact came
// from. Without a key the tool is never offered and chat behaves exactly
// as it did before — one request, no tools. The Gemini bridge stays
// text-only: it is the temporary free bridge, and its streaming path
// cannot carry tool calls.

import { config } from "./config";
import {
  searchWeb,
  researchConfigured,
  type SearchProvider,
  type SearchResult,
} from "./research";

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type ChatResult =
  | { ok: true; reply: string }
  | { ok: false; error: string };

export type ChatOptions = {
  /** Override the search provider (tests only; production uses Brave). */
  searchProvider?: SearchProvider;
};

/** The one tool the brain gets: live web search, with sources. */
export const WEB_SEARCH_TOOL = {
  name: "web_search",
  description:
    "Search the live web for a current or external fact. Returns up to five results, each with a title, URL, snippet, and source.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query, phrased as a short question or a few key words.",
      },
    },
    required: ["query"],
  },
} as const;

/** How many tool rounds a single chat call may take before the brain must
 *  answer in words. Two rounds of searching, then a final text-only call. */
export const MAX_RESEARCH_TOOL_ROUNDS = 2;
/** Cap on searches per chat call, so one message cannot burn the quota. */
export const MAX_SEARCHES_PER_CALL = 2;

/** Tacked onto the system prompt only while the tool is offered, so the
 *  brain knows it exists and how to use it. */
export const RESEARCH_SYSTEM_NOTE =
  "You can look things up live with the web_search tool when a question needs a current or external fact you do not already know. Use it instead of guessing: never state a guessed fact as a checked one. When you use search results, name the source in your answer. If a search comes back empty or fails, say so plainly and answer from what you do know.";

type ContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: any;
  tool_use_id?: string;
  content?: string;
};

type ApiMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

type ToolUse = { id: string; name: string; input: any };

type ParsedResponse = {
  text: string;
  stopReason: string;
  toolUses: ToolUse[];
  /** The tool_use blocks exactly as the model sent them, for the replay. */
  toolUseBlocks: ContentBlock[];
};

function parseResponse(data: any): ParsedResponse {
  const parts = Array.isArray(data.content) ? data.content : [];
  const text = parts
    .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("")
    .trim();
  const toolUseBlocks = parts.filter(
    (p: any) => p && p.type === "tool_use" && typeof p.id === "string",
  ) as ContentBlock[];
  const toolUses: ToolUse[] = toolUseBlocks.map((b) => ({
    id: b.id as string,
    name: typeof b.name === "string" ? b.name : "",
    input: b.input ?? {},
  }));
  return {
    text,
    stopReason: typeof data.stop_reason === "string" ? data.stop_reason : "",
    toolUses,
    toolUseBlocks,
  };
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No results came back for "${query}".`;
  return results
    .map((r) => `- ${r.title} (${r.source}): ${r.snippet} ${r.url}`)
    .join("\n");
}

async function callAnthropic(
  system: string,
  messages: ApiMessage[],
  tools?: unknown,
): Promise<{ ok: true; parsed: ParsedResponse } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${config.anthropicBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: 1024,
        system,
        messages,
        ...(tools ? { tools } : {}),
      }),
    });
  } catch (e) {
    console.error("Anthropic request failed:", e);
    return { ok: false, error: "brain_unreachable" };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("Anthropic API error:", res.status, text.slice(0, 500));
    return { ok: false, error: "brain_error" };
  }
  const data = (await res.json()) as any;
  return { ok: true, parsed: parseResponse(data) };
}

export async function chat(
  systemPrompt: string,
  history: ChatTurn[],
  userMessage: string,
  opts: ChatOptions = {},
): Promise<ChatResult> {
  if (!config.anthropicApiKey) {
    return { ok: false, error: "brain_not_connected" };
  }
  // The tool is offered only when a search provider exists: an injected
  // one (tests) or a configured Brave key (production). Otherwise this is
  // exactly the old single-request chat, with no tools field at all.
  const toolsOn = !!opts.searchProvider || researchConfigured();
  const system = toolsOn
    ? `${systemPrompt}\n\n${RESEARCH_SYSTEM_NOTE}`
    : systemPrompt;
  const messages: ApiMessage[] = [
    ...history.slice(-20),
    { role: "user", content: userMessage },
  ];
  let searchesUsed = 0;
  for (let round = 0; round <= MAX_RESEARCH_TOOL_ROUNDS; round++) {
    const attachTools = toolsOn && round < MAX_RESEARCH_TOOL_ROUNDS;
    const result = await callAnthropic(
      system,
      messages,
      attachTools ? [WEB_SEARCH_TOOL] : undefined,
    );
    if (!result.ok) return result;
    const { text, stopReason, toolUses, toolUseBlocks } = result.parsed;
    // A plain answer, or the final text-only round: the reply is the text.
    if (!attachTools || stopReason !== "tool_use" || toolUses.length === 0) {
      if (!text) return { ok: false, error: "brain_empty" };
      return { ok: true, reply: text };
    }
    // The brain asked to search. Run each call (capped), and hand the
    // results back as tool results so the next round can answer from them.
    const toolResults: ContentBlock[] = [];
    for (const use of toolUses) {
      if (use.name !== WEB_SEARCH_TOOL.name) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: "Unknown tool.",
        });
        continue;
      }
      if (searchesUsed >= MAX_SEARCHES_PER_CALL) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: "The search limit for this message was reached.",
        });
        continue;
      }
      searchesUsed++;
      const query =
        typeof use.input?.query === "string" ? use.input.query.trim() : "";
      let content: string;
      try {
        const results = await searchWeb(query, opts.searchProvider);
        content = formatSearchResults(query, results);
      } catch (e) {
        console.error("Brain web search failed:", e);
        content = `The search for "${query}" did not come back.`;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content,
      });
    }
    messages.push({ role: "assistant", content: toolUseBlocks });
    messages.push({ role: "user", content: toolResults });
  }
  return { ok: false, error: "brain_empty" };
}

// --- Tool-capable chat ---------------------------------------------------
// Same Messages API call as `chat`, plus tool definitions. When the
// model answers with stop_reason "tool_use", each tool_use block is run
// through the injected executor, the assistant turn and a user turn of
// tool_result blocks are appended, and the model is asked again. The
// loop ends on a normal reply or after MAX_TOOL_ROUNDS tool rounds.
// History handling is unchanged: the saved thread is capped at the
// last 20 turns; tool turns within one request are extra and are not
// part of the saved history.

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ToolExecutor = (name: string, input: any) => Promise<string>;

export const MAX_TOOL_ROUNDS = 5;

function extractText(data: any): string {
  const parts = Array.isArray(data.content) ? data.content : [];
  return parts
    .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("")
    .trim();
}

export async function chatWithTools(
  systemPrompt: string,
  history: ChatTurn[],
  userMessage: string,
  tools: ToolDefinition[],
  execute: ToolExecutor,
): Promise<ChatResult> {
  if (!config.anthropicApiKey) {
    return { ok: false, error: "brain_not_connected" };
  }
  const messages: any[] = [
    ...history.slice(-20),
    { role: "user", content: userMessage },
  ];
  for (let round = 0; ; round++) {
    let res: Response;
    try {
      res = await fetch(`${config.anthropicBaseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": config.anthropicApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.anthropicModel,
          max_tokens: 1024,
          system: systemPrompt,
          messages,
          tools,
        }),
      });
    } catch (e) {
      console.error("Anthropic request failed:", e);
      return { ok: false, error: "brain_unreachable" };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("Anthropic API error:", res.status, text.slice(0, 500));
      return { ok: false, error: "brain_error" };
    }
    const data = (await res.json()) as any;
    const content = Array.isArray(data.content) ? data.content : [];
    const toolUses = content.filter(
      (p: any) => p && p.type === "tool_use" && typeof p.name === "string",
    );
    if (data.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = extractText(data);
      if (!text) return { ok: false, error: "brain_empty" };
      return { ok: true, reply: text };
    }
    if (round >= MAX_TOOL_ROUNDS) {
      return { ok: false, error: "brain_error" };
    }
    const toolResults: any[] = [];
    for (const use of toolUses) {
      let out: string;
      try {
        out = await execute(use.name, use.input ?? {});
      } catch (e) {
        console.error(`tool executor failed (${use.name}):`, e);
        out = JSON.stringify({ ok: false, error: "tool_failed" });
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: typeof out === "string" ? out : JSON.stringify(out),
      });
    }
    messages.push({ role: "assistant", content });
    messages.push({ role: "user", content: toolResults });
  }
}
