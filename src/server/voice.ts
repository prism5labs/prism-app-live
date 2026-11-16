// Prism 5 — live voice (Step 5 of the capability design).
// Turn-based voice through ElevenLabs: the server speaks text out loud
// (text-to-speech) and turns the owner's recorded audio back into text
// (speech-to-text), so a spoken turn goes: owner talks, server transcribes,
// the text goes through chat as usual, the reply comes back as audio.
//
// This module is self-contained on purpose: the coordinator mounts its
// three handlers in server.ts (see WIRING.md). It imports only db helpers
// and the shared voice/photon lists. It reads ELEVENLABS_API_KEY from
// process.env at call time, so the server still starts with no key set —
// every endpoint then answers honestly that voice is not connected.
//
// What this is NOT: full-duplex realtime conversation. There is no live
// two-way audio stream here, no interruption, no barge-in. The owner
// speaks, then listens. Realtime is a later step; this module says so in
// its answers rather than pretending otherwise.
//
// ElevenLabs endpoints used (verified against ElevenLabs docs, Nov 15 2026):
//   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
//     xi-api-key header, JSON { text, model_id }, returns audio/mpeg.
//   POST https://api.elevenlabs.io/v1/speech-to-text
//     xi-api-key header, multipart form { model_id: "scribe_v2", file },
//     returns JSON { text, ... }.
// Per-minute voice charges apply; the exact rate is set by ElevenLabs and
// must be confirmed at build time — this module states no price.

import { getOrCreateAccount, ownsPhoton, getCustomization } from "./db";
import { config } from "./config";
import { photonByName } from "../shared/photons";
import { voiceById } from "../shared/voices";

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

// The TTS model: the stable multilingual model. Eleven v3 is more
// expressive but costs more per character; the coordinator can switch
// this constant at merge time once the rate is confirmed.
const TTS_MODEL = "eleven_multilingual_v2";
// The transcription model. scribe_v1 has been retired by ElevenLabs;
// scribe_v2 is the current file-transcription model.
const STT_MODEL = "scribe_v2";

export const VOICE_MAX_TEXT = 2000;
export const VOICE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// Audio types the transcribe endpoint accepts. These are the formats a
// phone browser's MediaRecorder produces (webm on Android/Chrome, mp4 on
// iOS/Safari) plus the plain file formats.
const ACCEPTED_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav", // same as wav; curl and some recorders send this MIME type
]);

// --- Voice picks -> ElevenLabs voice IDs ---------------------------------
//
// The app's voice picks are ways of speaking in chat (see
// src/shared/voices.ts), not ElevenLabs voices. This table maps each pick
// to one of ElevenLabs' documented default voices, chosen by tone only.
// The music faces are style homages, never the artist: the mapping picks
// a tone that fits the style, and the Photon never claims to BE that
// person.
//
// Default voices verified against ElevenLabs' published default list:
//   Rachel 21m00Tcm4TlvDq8ikWAM — warm, friendly
//   Adam   pNInz6obpgDQGcFmaJgB — deep, steady
//   Antoni ErXwobaYiN019PkySvjV — upbeat, professional
//   Elli   MF3mGyEYCl7XYWbV9V6O — emotional, expressive
//   Josh   TxGEqnHWrfWFTfGW9XjX — casual, friendly
//
// CAUTION (third-party reports, not yet confirmed with ElevenLabs): the
// legacy default voices are reported to be retired at the end of 2026.
// Before going live, Neil should confirm these IDs still work in his
// ElevenLabs account and, if not, replace them with voices from his own
// ElevenLabs library. Any pick with no mapping here falls back to the
// house voice and says so — a voice pick never fails a call.

export const HOUSE_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel

const VOICE_MAP: Record<string, { elevenLabsId: string; elevenLabsName: string }> = {
  house: { elevenLabsId: "21m00Tcm4TlvDq8ikWAM", elevenLabsName: "Rachel" },
  steady: { elevenLabsId: "pNInz6obpgDQGcFmaJgB", elevenLabsName: "Adam" },
  lakeshore: { elevenLabsId: "TxGEqnHWrfWFTfGW9XjX", elevenLabsName: "Josh" },
  boardroom: { elevenLabsId: "ErXwobaYiN019PkySvjV", elevenLabsName: "Antoni" },
  elvis: { elevenLabsId: "ErXwobaYiN019PkySvjV", elevenLabsName: "Antoni" },
  cash: { elevenLabsId: "pNInz6obpgDQGcFmaJgB", elevenLabsName: "Adam" },
  aretha: { elevenLabsId: "MF3mGyEYCl7XYWbV9V6O", elevenLabsName: "Elli" },
  bowie: { elevenLabsId: "ErXwobaYiN019PkySvjV", elevenLabsName: "Antoni" },
  dolly: { elevenLabsId: "MF3mGyEYCl7XYWbV9V6O", elevenLabsName: "Elli" },
  cobain: { elevenLabsId: "TxGEqnHWrfWFTfGW9XjX", elevenLabsName: "Josh" },
  // "custom" (design your own) has no single tone to map, so it falls
  // back to the house voice like any unmapped pick.
};

export function resolveElevenLabsVoice(pick: string): {
  elevenLabsId: string;
  elevenLabsName: string;
  fellBack: boolean;
} {
  const mapped = VOICE_MAP[pick];
  if (mapped) return { ...mapped, fellBack: false };
  return {
    elevenLabsId: HOUSE_ELEVENLABS_VOICE_ID,
    elevenLabsName: "Rachel",
    fellBack: true,
  };
}

// --- Small local helpers (mirrors server.ts; this module stays standalone) ---

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

function accountIdFrom(req: Request, body: any): string {
  const fromBody = typeof body?.accountId === "string" ? body.accountId.trim() : "";
  if (fromBody) return fromBody;
  const fromHeader = req.headers.get("x-account-id") || "";
  if (fromHeader.trim()) return fromHeader.trim();
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("accountId") || "";
  return fromQuery.trim();
}

function elevenLabsKey(): string {
  return config.elevenLabsApiKey.trim();
}

export function voiceConfigured(): boolean {
  return elevenLabsKey().length > 0;
}

// The honest not-connected answer every endpoint gives with no key.
function notConnected(): Response {
  return json({
    ok: false,
    error: "voice_not_connected",
    message:
      "Live voice isn't set up yet. The server needs an ElevenLabs key before I can talk out loud — that's a setup step, not something wrong with your phone.",
  });
}

// The shared gate for the two audio endpoints: a real account, a real
// Photon the account owns, and Upkeep (the same gate as the existing
// POST /api/voice route). Returns the error response to send, or the
// account and Photon the handler needs.
async function gateVoice(
  req: Request,
  body: any,
): Promise<{ error: Response } | { error?: undefined; accountId: string; photon: string }> {
  const accountId = accountIdFrom(req, body);
  if (!isValidAccountId(accountId)) return { error: bad("accountId required", 400) };
  const photon = String(body?.photon || "");
  if (!photonByName(photon)) return { error: bad("unknown photon", 400) };
  if (!ownsPhoton(accountId, photon)) {
    return {
      error: json({
        ok: false,
        error: "not_owned",
        message: `You don't own ${photon} yet. You can buy ${photon} in the Store, or redeem a code in Upkeep.`,
      }),
    };
  }
  const a = getOrCreateAccount(accountId);
  if (!a.upkeep) {
    return {
      error: json({
        ok: false,
        error: "needs_upkeep",
        message:
          "Live voice calls come with Upkeep, $29 a month. Upkeep also brings unlimited chat, Launch updates, and priority support.",
      }),
    };
  }
  return { accountId, photon };
}

// The Photon's saved voice pick, resolved to an ElevenLabs voice. An
// unmapped pick falls back to the house voice and says so in `fellBack`.
function voiceFor(accountId: string, photon: string): {
  pick: string;
  pickName: string;
  elevenLabsId: string;
  elevenLabsName: string;
  fellBack: boolean;
} {
  const c = getCustomization(accountId, photon);
  const pick = c?.voice || "house";
  const resolved = resolveElevenLabsVoice(pick);
  return {
    pick,
    pickName: voiceById(pick).name,
    elevenLabsId: resolved.elevenLabsId,
    elevenLabsName: resolved.elevenLabsName,
    fellBack: resolved.fellBack,
  };
}

// A plain-words answer for a failed ElevenLabs call. The provider's HTTP
// status is included so a bad key is distinguishable from a bad request;
// the provider's body is not echoed back.
async function providerError(res: Response): Promise<Response> {
  let detail = "";
  try {
    const body = (await res.json()) as any;
    const msg = body?.detail?.message || body?.detail || body?.message;
    if (typeof msg === "string" && msg) detail = msg;
  } catch {
    // Not JSON, or unreadable: the plain message below stands on its own.
  }
  const authFailed = res.status === 401 || res.status === 403;
  return json(
    {
      ok: false,
      error: authFailed ? "voice_auth_failed" : "voice_provider_error",
      providerStatus: res.status,
      message: authFailed
        ? "ElevenLabs didn't accept the voice key on the server, so I can't talk right now. That's a setup problem, not your phone — tell Neil the key needs checking."
        : "The voice service didn't answer properly just now. Try again in a moment.",
      ...(detail ? { detail } : {}),
    },
    502,
  );
}

// GET /api/voice/status — is live voice configured, and does this account
// have Upkeep? No Photon needed; this is the call screen's first check.
export async function voiceStatus(req: Request): Promise<Response> {
  const accountId = accountIdFrom(req, {});
  if (!isValidAccountId(accountId)) return bad("accountId required", 400);
  const a = getOrCreateAccount(accountId);
  const configured = voiceConfigured();
  return json({
    ok: true,
    configured,
    upkeep: a.upkeep,
    turnBased: true,
    message: !configured
      ? "Live voice isn't set up yet — the server needs an ElevenLabs key."
      : !a.upkeep
        ? "Live voice is set up, and it comes with Upkeep."
        : "Live voice is ready. Voice is turn-based for now: you talk, then I answer — not a live two-way call yet.",
  });
}

// POST /api/voice/say — body { accountId, photon, text }.
// Speaks the text in the Photon's saved voice and returns audio/mpeg.
// Text is capped at VOICE_MAX_TEXT characters.
export async function voiceSay(req: Request): Promise<Response> {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const gate = await gateVoice(req, body);
  if (gate.error) return gate.error;
  const { accountId, photon } = gate;

  const text = String(body.text || "").trim();
  if (!text) return bad("text required", 400);
  if (text.length > VOICE_MAX_TEXT) {
    return json({
      ok: false,
      error: "text_too_long",
      message: `That's too long to say in one go — keep it under ${VOICE_MAX_TEXT} characters.`,
    });
  }

  if (!voiceConfigured()) return notConnected();

  const voice = voiceFor(accountId, photon);
  let res: Response;
  try {
    res = await fetch(
      `${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(voice.elevenLabsId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": elevenLabsKey(),
          accept: "audio/mpeg",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: TTS_MODEL,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
        signal: AbortSignal.timeout(60000),
      },
    );
  } catch (e) {
    console.error("voice say: ElevenLabs request failed:", e);
    return json({
      ok: false,
      error: "voice_unreachable",
      message: "I couldn't reach the voice service just now. Try again in a moment.",
    }, 502);
  }
  if (!res.ok) return providerError(res);

  const audio = await res.arrayBuffer();
  return new Response(audio, {
    status: 200,
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "no-store",
      "x-voice-pick": voice.pick,
      "x-voice-name": voice.pickName,
      "x-voice-elevenlabs": voice.elevenLabsName,
      ...(voice.fellBack ? { "x-voice-fallback": "true" } : {}),
    },
  });
}

// POST /api/voice/transcribe — multipart body with an audio file in the
// "file" field (also accepts "audio"). Returns { ok: true, text } so the
// client can send the text as a normal chat message. Uploads are capped
// at VOICE_MAX_UPLOAD_BYTES.
export async function voiceTranscribe(req: Request): Promise<Response> {
  // The Photon rides in the form fields for a multipart body, not JSON.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("multipart audio required", 400);
  }
  const photon = String(form.get("photon") || "");
  const gate = await gateVoice(req, { accountId: String(form.get("accountId") || ""), photon });
  if (gate.error) return gate.error;

  const file = form.get("file") ?? form.get("audio");
  if (!file || typeof file === "string") {
    return bad("audio file required (field \"file\")", 400);
  }
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > VOICE_MAX_UPLOAD_BYTES) {
    return json({
      ok: false,
      error: "audio_too_large",
      message: "That recording is too big — keep voice notes under 10 MB.",
    });
  }
  if (file.size > VOICE_MAX_UPLOAD_BYTES) {
    return json({
      ok: false,
      error: "audio_too_large",
      message: "That recording is too big — keep voice notes under 10 MB.",
    });
  }
  if (file.size === 0) return bad("audio file is empty", 400);
  const mime = (file.type || "").split(";")[0].trim().toLowerCase();
  if (mime && !ACCEPTED_AUDIO_TYPES.has(mime)) {
    return json({
      ok: false,
      error: "audio_type_not_supported",
      message: `That audio format (${mime}) isn't one I can transcribe. Record as webm, mp4, mp3, or wav.`,
    });
  }

  if (!voiceConfigured()) return notConnected();

  const upstream = new FormData();
  upstream.append("model_id", STT_MODEL);
  upstream.append(
    "file",
    new File([file], (file as File).name || "voice-note.webm", {
      type: file.type || "audio/webm",
    }),
  );

  let res: Response;
  try {
    res = await fetch(`${ELEVENLABS_BASE}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": elevenLabsKey() },
      body: upstream,
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    console.error("voice transcribe: ElevenLabs request failed:", e);
    return json({
      ok: false,
      error: "voice_unreachable",
      message: "I couldn't reach the voice service just now. Try again in a moment.",
    }, 502);
  }
  if (!res.ok) return providerError(res);

  let data: any = {};
  try {
    data = await res.json();
  } catch {
    return json({
      ok: false,
      error: "voice_provider_error",
      message: "The voice service answered in a way I couldn't read. Try again in a moment.",
    }, 502);
  }
  const text = typeof data.text === "string" ? data.text : "";
  return json({
    ok: true,
    text,
    language: typeof data.language_code === "string" ? data.language_code : null,
  });
}
