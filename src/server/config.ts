// Server configuration, all from the environment. Nothing secret is committed:
// API keys and OAuth credentials come from env vars (set in the Render
// dashboard), never from files in this repo.

export const config = {
  port: Number(process.env.PORT || 10000),
  dataDir: process.env.DATA_DIR || "./data",
  nodeEnv: process.env.NODE_ENV || "development",
  // Anthropic: the chat brain. No key means the app serves the shell and
  // history, and new replies say the brain is not connected. Never commit a key.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  // Google Gemini: a temporary free bridge brain. The free tier needs no
  // card (key from Google AI Studio) and is only used when no Anthropic
  // key is set, so the app switches to Anthropic automatically once the
  // credits land and ANTHROPIC_API_KEY is set. Never commit a key.
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  geminiBaseUrl:
    process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com",
  // Friends-and-family free code, checked server-side only. There is no
  // default and no code value lives in this repo: set FREE_CODE in the
  // Render dashboard (the value itself is handed out by Neil, never
  // committed). When it is unset, no free code works.
  freeCode: process.env.FREE_CODE || "",
  // Google OAuth for the Inboxes tab (Gmail read + drafts). Without these the
  // Inboxes tab reports honestly that no accounts are connected.
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || "",
  // Public base URL of this deployment (used for the OAuth redirect).
  appUrl: process.env.APP_URL || "",
  // Twilio (steps 1 + 7): texts and calls. Without these the telephony
  // endpoints answer not_connected in plain words.
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || "",
  // ElevenLabs (step 5): live voice, turn-based. Without a key the voice
  // endpoints answer voice_not_connected.
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || "",
  // Meta (step 9): Facebook Page messaging. Without these the Messenger
  // endpoints answer messenger_not_configured. Personal Messenger has no
  // supported API and is never connected.
  metaPageId: process.env.META_PAGE_ID || "",
  metaPageAccessToken: process.env.META_PAGE_ACCESS_TOKEN || "",
  metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || "",
  // VAPID (step 3): Web Push. Without these, checks and reminders still
  // run but no push is sent.
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || "",
  vapidSubject: process.env.VAPID_SUBJECT || "",
  // Job plug (step 8): URL of a JSON or RSS/Atom job feed. No feed URL
  // means no job source is connected; the plug never scrapes a board.
  jobsFeedUrl: process.env.JOBS_FEED_URL || "",
  // Brave Search (step 10): live web research. Without a key the research
  // endpoint answers research_not_connected.
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || "",
  // Stripe (step 10): the webhook signing secret (whsec_...). The webhook
  // secret alone proves an event came from Stripe; no Stripe API key.
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
};

export type BrainProvider = "anthropic" | "gemini" | "none";

// Anthropic takes precedence: when its key is set the app uses it, and
// Gemini is only a fallback bridge. When neither key is set there is no brain.
export const brainProvider = (): BrainProvider =>
  config.anthropicApiKey.length > 0
    ? "anthropic"
    : config.geminiApiKey.length > 0
      ? "gemini"
      : "none";

export const brainConnected = () => brainProvider() !== "none";
export const googleConfigured = () =>
  config.googleClientId.length > 0 &&
  config.googleClientSecret.length > 0 &&
  config.googleRedirectUri.length > 0;
