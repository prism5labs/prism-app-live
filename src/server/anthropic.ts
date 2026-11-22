// Anthropic Messages API client (plain fetch, no SDK). The brain is only
// used when ANTHROPIC_API_KEY is set; without it the app answers honestly
// that the brain is not connected. No provider or model names ever reach
// the visible copy.

import { config } from "./config";

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type ChatResult =
  | { ok: true; reply: string }
  | { ok: false; error: string };

export async function chat(
  systemPrompt: string,
  history: ChatTurn[],
  userMessage: string,
): Promise<ChatResult> {
  if (!config.anthropicApiKey) {
    return { ok: false, error: "brain_not_connected" };
  }
  const messages: ChatTurn[] = [
    ...history.slice(-20),
    { role: "user", content: userMessage },
  ];
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
  const parts = Array.isArray(data.content) ? data.content : [];
  const text = parts
    .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("")
    .trim();
  if (!text) return { ok: false, error: "brain_empty" };
  return { ok: true, reply: text };
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
