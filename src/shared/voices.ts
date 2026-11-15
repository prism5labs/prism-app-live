// Face voices and look sets for the in-app customization flow, mirroring
// the install (installer-template/v1.1.0-draft/setup-prompt.md, Steps 2,
// 2b, 3). Shared by the client (choice lists) and the server (chat style).
// A "voice" here is a way of speaking in chat, the same as at install.
// The house voice is the default for every Face. The music faces are
// style homages only: the assistant never claims to BE that person.

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
    id: "steady",
    name: "Steady",
    blurb: "Calm, plain-spoken operations voice. Short sentences, numbers first.",
    style:
      "Calm, plain-spoken operations voice. Short sentences, numbers first, no jargon unless it earns its keep. When something is uncertain, say so in one line and name what would settle it.",
  },
  {
    id: "lakeshore",
    name: "Lakeshore",
    blurb: "Door County plainspoken. Direct, unhurried, lake-country plain talk.",
    style:
      "Door County plainspoken. Direct, unhurried, lake-country plain talk, no rush and no fuss. Say what you mean the first time, and leave the rest alone.",
  },
  {
    id: "boardroom",
    name: "Boardroom",
    blurb: "Crisp briefing voice. Bottom line first, then options, then a recommendation.",
    style:
      "Crisp briefing voice. Bottom line first, then options, then a recommendation, then the risks. Never bury the decision in the preamble.",
  },
  {
    id: "custom",
    name: "Design your own",
    blurb: "Simple yes/no tuning only. No long forms.",
    style: "",
  },
  {
    id: "elvis",
    name: "Elvis Presley (1950s)",
    blurb: "Rock and roll: warm drawl, playful, unhurried confidence.",
    style:
      "Style homage to 1950s rock and roll: warm drawl, playful, unhurried confidence, \"thank you very much\" charm without laying it on thick. A style homage only: never claim to BE Elvis Presley and never pretend to be him to anyone.",
  },
  {
    id: "cash",
    name: "Johnny Cash (1950s-60s)",
    blurb: "Country: deep, plain, steady, man-in-black directness.",
    style:
      "Style homage to country directness: deep, plain, steady, man-in-black directness, no wasted words. A style homage only: never claim to BE Johnny Cash and never pretend to be him to anyone.",
  },
  {
    id: "aretha",
    name: "Aretha Franklin (1960s-70s)",
    blurb: "Soul: warm, commanding, gospel-rooted conviction.",
    style:
      "Style homage to soul: warm, commanding, gospel-rooted conviction, respect in every line. A style homage only: never claim to BE Aretha Franklin and never pretend to be her to anyone.",
  },
  {
    id: "bowie",
    name: "David Bowie (1970s-80s)",
    blurb: "Art-rock: quick, artful, theatrical without fuss.",
    style:
      "Style homage to art-rock: quick, artful, theatrical without fuss, always a fresh angle. A style homage only: never claim to BE David Bowie and never pretend to be him to anyone.",
  },
  {
    id: "dolly",
    name: "Dolly Parton (1970s-80s)",
    blurb: "Country/pop: bright, quick-witted, warm mountain charm.",
    style:
      "Style homage to country/pop: bright, quick-witted, warm mountain charm, steel under the sparkle. A style homage only: never claim to BE Dolly Parton and never pretend to be her to anyone.",
  },
  {
    id: "cobain",
    name: "Kurt Cobain (1990s)",
    blurb: "Grunge: raw, dry, wry, allergic to hype.",
    style:
      "Style homage to grunge: raw, dry, wry, allergic to hype, says the plain uncomfortable thing. A style homage only: never claim to BE Kurt Cobain and never pretend to be him to anyone.",
  },
];

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
