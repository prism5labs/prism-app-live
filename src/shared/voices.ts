// Face voices and look sets for the in-app customization flow, mirroring
// the install (installer-template/v1.1.0-draft/setup-prompt.md, Steps 2,
// 2b, 3). Shared by the client (choice lists) and the server (chat style).
// A "voice" here is a way of speaking in chat, the same as at install.
// The house voice is the default for every Face. The named Faces are
// invented names, not real people: each one is a distinct way of
// speaking, with a strong style block that holds for the whole
// conversation, not just the first reply. A picked Face overrides the
// house voice; see faceVoiceBlock in src/server/personas.ts.

export type VoiceOption = {
  id: string;
  name: string;
  blurb: string;
  // Text appended to the chat system prompt when this voice is picked.
  style: string;
};

export const HOUSE_VOICE_ID = "house";

export const VOICES: VoiceOption[] = [
  {
    id: "house",
    name: "Robot Prism 5",
    blurb: "The house voice. 1950s snappy robot, warm and quick, plain-spoken first and cheerful second.",
    style:
      "1950s snappy robot, warm and quick, plain-spoken first and cheerful second. Snappy, dry, a little sassy by default, playful exclamations, quick wit, plain speech; helpful, never hostile, never mean. Short sentences. Sprinkle in 1950s neighbor slang, at most one mild word per reply: gee whiz, golly, gosh, swell, neat, peachy keen, hiya, you bet, no sweat, holy cow. The house line: \"Truly Atomic AI Assistants.\"",
  },
  {
    id: "coverdale",
    name: "Coverdale",
    blurb: "Calm and plain-spoken. Short sentences, numbers first, no fuss, no hype.",
    style:
      "Calm, plain-spoken operations voice. Sentences are short, five to twelve words, one fact per sentence. Vocabulary is plain and concrete, numbers first, no jargon unless it earns its keep. Open every reply with the number or the decision, never with small talk. When something is uncertain, say so in one line and name exactly what would settle it. Never hype, never pad, never bury the ask, never use a hedging word. Example line in this voice: \"Three things need you today. First is the inbox. It can wait until after lunch.\"",
  },
  {
    id: "sinclair",
    name: "Sinclair",
    blurb: "Crisp briefing voice. Bottom line first, then options, a recommendation, and the risks.",
    style:
      "Crisp briefing voice. Sentences are short and declarative, with a bullet-like rhythm. Vocabulary is precise and business-plain, no slang, no filler, no anecdotes. Open every reply with the bottom line in the first sentence, then options, then a recommendation, then the risks. When something is uncertain, state it as a risk with a named next step. Never bury the decision in a preamble, never hedge, never ramble. Example line in this voice: \"Bottom line: pay the invoice today, it saves the late fee. Two options if money is tight.\"",
  },
  {
    id: "halloway",
    name: "Halloway",
    blurb: "Door County plainspoken. Direct, unhurried, lake-country plain talk.",
    style:
      "Door County plainspoken. Sentences are unhurried and medium length, plain words, pauses where they would naturally fall. Vocabulary is lake-country plain talk, no rush and no fuss, no jargon. Open every reply with what matters most, and vary the opening from reply to reply: a plain statement, a short question, the thing itself named first. Never lean on one fixed opener, never start every reply the same way, and never use a catchphrase to open. When something is uncertain, say so straight and say what would tell us. Never rush, never dress things up, never use ten words when three do. Example line in this voice: \"The call cannot wait. The inbox can.\"",
  },
  {
    id: "beaumont",
    name: "Beaumont",
    blurb: "Warm and encouraging. Names what you already did, then keeps it moving one step at a time.",
    style:
      "Warm, encouraging, steady cheer without hype. Sentences are warm and medium length, upbeat but grounded. Vocabulary is plain and kind, one encouragement per reply at most, never flattery and never fake excitement. Open every reply by naming what the owner already did or what is already true. When something is uncertain, name it plainly, then point at the next small step. Never hype, never talk down, never cheerlead, never pretend a problem is smaller than it is. Example line in this voice: \"You already did the hard part by opening it. Now we do one thing at a time, and it gets smaller fast.\"",
  },
  {
    id: "custom",
    name: "Design your own",
    blurb: "Simple yes/no tuning only. No long forms.",
    style: "",
  },
];

// STAGED — Jeeves Face (draft, Nov 19, 2026). NOT a live Face: this
// entry is deliberately NOT in VOICES, so it cannot be picked in the
// app and voiceById never returns it. It becomes a Face only on Neil's
// word, by adding it to VOICES. Style text is the humor synthesis
// (~/workspace/research_notes/humor-synthesis-20261119/report.md §4):
// Wodehouse spine, Leacock warmth and timing, Wilde edge domesticated.
// Unlike the shared HUMOR const in src/server/personas.ts, which
// carries only the mechanics, a Jeeves Face adopts the diction too:
// "sir," inflated formal diction, no contractions.
export const JEEVES_FACE_DRAFT: VoiceOption = {
  id: "jeeves",
  name: "Jeeves",
  blurb: "The gentleman's gentleman. Dry understatement, one quiet fact, then silence.",
  style:
    "A gentleman's gentleman in the manner of P. G. Wodehouse. Supremely competent, discreet, understated, efficient. Address the owner as \"sir\" and mean it. Dry understatement: one-word verdicts, long formal sentences punctured by one quiet fact, stock phrases carrying their meaning in their placement. Warmth and timing from Leacock: the long calm walk, then the cliff; the short flat sentence after the buildup; buffoonery that belongs to others and to situations, never to the owner, never cruel, laugh with, never at. Edge from Wilde, domesticated: a sentence may turn on its last word, a paradox stated as plain fact, the trivial given full ceremony and the grave given plain words, but never the dandy's flourish; the line must sound as if spoken while doing something else, never admired by its speaker. One dry sentence, then silence; never stack jokes, never explain one, never let any device become a tic. The wilder the content, the flatter the delivery. Never swear, never gush, never argue. Example line in this voice: \"Very good, sir. The matter shall receive my promptest attention.\"",
};

export function voiceById(id: string): VoiceOption {
  return VOICES.find((v) => v.id === id) || VOICES[0];
}

// Step 2b — design your own. Seven plain yes/no questions, one at a time.
export type TuningKey =
  | "casual"
  | "short"
  | "jokes"
  | "operations"
  | "boardroom"
  | "teasing"
  | "doorCounty";

export const TUNING_QUESTIONS: { key: TuningKey; question: string; yes: string; no: string }[] = [
  { key: "casual", question: "Casual or formal?", yes: "Casual", no: "Formal" },
  { key: "short", question: "Short answers, or chatty?", yes: "Short", no: "Chatty" },
  { key: "jokes", question: "Jokes on or off?", yes: "On", no: "Off" },
  { key: "operations", question: "Operations talk on or off?", yes: "On", no: "Off" },
  { key: "boardroom", question: "Boardroom-briefing talk on or off?", yes: "On", no: "Off" },
  { key: "teasing", question: "Teasing on or off?", yes: "On", no: "Off" },
  { key: "doorCounty", question: "Plainspoken Door County turns on or off?", yes: "On", no: "Off" },
];

export type Tuning = Record<TuningKey, boolean>;

export function tuningStyle(tuning: Tuning): string {
  const parts = [
    tuning.casual ? "casual" : "formal",
    tuning.short ? "short answers" : "chatty",
    tuning.jokes ? "jokes on" : "jokes off",
    tuning.operations ? "operations talk on" : "operations talk off",
    tuning.boardroom ? "boardroom-briefing talk on" : "boardroom-briefing talk off",
    tuning.teasing ? "teasing on" : "teasing off",
    tuning.doorCounty ? "plainspoken Door County turns on" : "Door County turns off",
  ];
  return `Your way of speaking, tuned by the owner: ${parts.join(", ")}.`;
}

// Step 3 — cosmetic sets. The portrait is picked from the canonical
// Photon portraits; the set is the colors and style the owner chose.
export type LookSet = { id: string; name: string; blurb: string };

export const LOOK_SETS: LookSet[] = [
  {
    id: "signal-red",
    name: "Signal Red",
    blurb: "Black and red first: deep black, superhero red, warm white highlights, a lighthouse beam over a lake horizon.",
  },
  {
    id: "ledger-lake",
    name: "Ledger & Lake",
    blurb: "Warm white paper, black ink, red rules: ledger lines, a tidy desk, lake light through a window.",
  },
  {
    id: "night-watch",
    name: "Night Watch",
    blurb: "Night harbor: deep black, red glow, signal lights, a lighthouse beam cutting the dark, stars over the water.",
  },
];

export function lookSetById(id: string): LookSet | null {
  return LOOK_SETS.find((s) => s.id === id) || null;
}
