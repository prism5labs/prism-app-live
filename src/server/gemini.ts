// Google Gemini API client (plain fetch, no SDK). A temporary free bridge
// brain: only used when no ANTHROPIC_API_KEY is set, so the app switches
// to Anthropic automatically once the credits land. The key comes from the
// GEMINI_API_KEY env var (Google AI Studio, free tier, no card); the model
// from GEMINI_MODEL (default gemini-3.8-flash). No provider or model names
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

// The free bridge is flaky: a call can fail fast with a 429 or 5xx while
// the next one sails through. One retry, after a short pause, turns a dead
// reply into a live one. Only fast failures retry: a slow success is never
// repeated, and a stream that already delivered words is never restarted
// (the retry happens before any response body is read).
const RETRY_DELAY_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postGemini(url: string, body: unknown): Promise<Response> {
  const init: RequestInit = {
    method: "POST",
    headers: {
      "x-goog-api-key": config.geminiApiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
  const first = await fetch(url, init);
  if (!first.ok && (first.status === 429 || first.status >= 500)) {
    await first.body?.cancel().catch(() => {});
    await sleep(RETRY_DELAY_MS);
    return fetch(url, init);
  }
  return first;
}

// Pull the text out of one GenerateContent response (streaming or not).
function responseText(data: any): string {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  const parts =
    candidates[0] && candidates[0].content && Array.isArray(candidates[0].content.parts)
      ? candidates[0].content.parts
      : [];
  return parts
    .filter((p: any) => p && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("");
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
    res = await postGemini(url, {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: toGeminiContents(history, userMessage),
      generationConfig: { maxOutputTokens: 1024 },
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
  const text = responseText(data).trim();
  if (!text) return { ok: false, error: "brain_empty" };
  return { ok: true, reply: text };
}

// Streaming twin of chat: same request, but the reply arrives as server-sent
// events from :streamGenerateContent and each text chunk is handed to
// onDelta as it lands, so the app can show words the moment they exist
// instead of waiting for the whole reply. The free Gemini bridge is slow
// to answer (a full reply can take over two minutes), so streaming is what
// makes chat feel alive: the first words show in seconds, not minutes.
export async function chatStream(
  systemPrompt: string,
  history: ChatTurn[],
  userMessage: string,
  onDelta: (text: string) => void,
): Promise<ChatResult> {
  if (!config.geminiApiKey) {
    return { ok: false, error: "brain_not_connected" };
  }
  const url = `${config.geminiBaseUrl}/v1beta/models/${encodeURIComponent(config.geminiModel)}:streamGenerateContent?alt=sse`;
  let res: Response;
  try {
    res = await postGemini(url, {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: toGeminiContents(history, userMessage),
      generationConfig: { maxOutputTokens: 1024 },
    });
  } catch (e) {
    console.error("Gemini stream request failed:", e);
    return { ok: false, error: "brain_unreachable" };
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    console.error("Gemini stream error:", res.status, text.slice(0, 500));
    return { ok: false, error: "brain_error" };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let data: any;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }
        const text = responseText(data);
        if (text) {
          full += text;
          onDelta(text);
        }
      }
    }
  } catch (e) {
    console.error("Gemini stream read failed:", e);
    return { ok: false, error: "brain_unreachable" };
  }
  full = full.trim();
  if (!full) return { ok: false, error: "brain_empty" };
  return { ok: true, reply: full };
}
