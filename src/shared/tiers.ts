// Approved Launch copy (Neil, Nov 15, 2026). This is the wording in the
// builder app (v9): the 90,000-lines claim, the 30 specialists and five
// tuning dials, and the hours/working-days lines.
// NOTE: the website was later revised (Nov 15, ~04:30) with precision-language
// wording for the Supernova sentence and numbers-only stats lines for the
// lower tiers. The app has not been updated to match yet; when Neil confirms
// the website wording is the app wording too, update here and in the Store.

export const TIER_COPY = {
  supernova: {
    title: "Supernova",
    body: "A Supernova is roughly 90,000 lines of instructions, written carefully, tested until it works, and designed to do exactly what it is meant to do. The prompts are written in ways most people do not know how to write them. And one assistant is not one thing. Underneath it are 30 different specialists, plus five tuning dials set specifically so it focuses on what matters to you. When you buy a Supernova, you get all of it, the lines, the specialists, the dials, the testing time, the care, built in.",
    hours: "That is roughly 300 hours of building and testing, about 37 working days, built in.",
  },
  satellite: {
    title: "Satellite",
    body: "A Satellite is a smaller build, roughly 45,000 lines, the same careful writing and testing, built from the same system.",
    hours: "Roughly 150 hours, about 19 working days.",
  },
  plug: {
    title: "Plug",
    body: "A Plug is one job, fully automated, roughly 15,000 lines, written and tested the same way.",
    hours: "Roughly 50 hours, about 6 working days.",
  },
  spark: {
    title: "Spark",
    body: "A Spark is one button, one job, roughly 7,500 lines, written and tested the same way.",
    hours: "Roughly 25 hours, about 3 working days.",
  },
};

// Upkeep, in plain words (decided Nov 15, 2026).
export const UPKEEP_COPY = {
  title: "Upkeep",
  priceLine: "$29 a month",
  body: "Upkeep is the care that keeps your Launch alive: unlimited chat, Launch updates as they come out, priority support, and live voice calls. Every purchase already includes 300 chats a month on the standard brain, free forever, no subscription needed. Upkeep is never required to use what you bought.",
  included: [
    "Unlimited chat",
    "Launch updates",
    "Priority support",
    "Live voice calls",
  ],
};

// The free 300 chats a month, in plain words.
export const FREE_CHATS_COPY =
  "Every purchase includes 300 chats a month, free forever. No subscription needed.";
