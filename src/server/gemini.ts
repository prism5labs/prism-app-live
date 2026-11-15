// Google Gemini API client (plain fetch, no SDK). A temporary free bridge
// brain: only used when no ANTHROPIC_API_KEY is set, so the app switches
// to Anthropic automatically once the credits land. The key comes from the
// GEMINI_API_KEY env var (Google AI Studio, free tier, no card); the model
// from GEMINI_MODEL (default gemini-2.5-flash). No provider or model names
// ever reach the visible copy.
//
// Free-tier note: Google may use free-tier data to improve its models, so
// this is a demo bridge for the first installs, not the production brain.

import { config } from "./config";
import type { ChatTurn, ChatResult } from "./anthropic";

// Gemini contents must alternate user/model and start with user. The saved
// thread always alternates starting with user, but normalize defensively:
// drop a leading model turn and merge consecutive same-role turns.
function toGeminiContents(history: ChatTurn[], userMessage: string) {
  const turns: ChatTurn[] = [...history.slice(-20), { role: "user", content: userMessage }];
  const contents: { role: "user" | "model"; parts: { text: string }[] }[] = [];
  for (const t of turns) {
    const role = t.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts[0].text += `\n${t.content}`;
    } else {
      contents.push({ role, parts: [{ text: t.content }] });
    }
  }
  // Drop a leading model turn (Gemini requires the first content to be user).
  if (contents.length > 0 && contents[0].role === "model") contents.shift();
  return contents;
}

export async function chat(
  systemPrompt: string,
  history: ChatTurn[],
  userMessage: string,
): Promise<ChatResult> {
  if (!config.geminiApiKey) {
    return { ok: false, error: "brain_not_connected" };
  }
  const url = `${config.geminiBaseUrl}/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": config.geminiApiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: toGeminiContents(history, userMessage),
        generationConfig: { maxOutputTokens: 1024 },
      }),
    });
  } catch (e) {
    console.error("Gemini request failed:", e);
    return { ok: false, error: "brain_unreachable" };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("Gemini API error:", res.status, text.slice(0, 500));
    return { ok: false, error: "brain_error" };
  }
  const data = (await res.json()) as any;
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const parts =
    candidates[0] && candidates[0].content && Array.isArray(candidates[0].content.parts)
      ? candidates[0].content.parts
      : [];
  const text = parts
    .filter((p: any) => p && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("")
    .trim();
  if (!text) return { ok: false, error: "brain_empty" };
  return { ok: true, reply: text };
}
