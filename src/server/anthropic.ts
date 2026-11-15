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
