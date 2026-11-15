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
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  // Google Gemini: a temporary free bridge brain. The free tier needs no
  // card (key from Google AI Studio) and is only used when no Anthropic
  // key is set, so the app switches to Anthropic automatically once the
  // credits land and ANTHROPIC_API_KEY is set. Never commit a key.
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  geminiBaseUrl:
    process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com",
  // Friends-and-family free code, checked server-side only. Env override lets
  // the code rotate without a code change. The default is the code already
  // recorded in the order log (Nov 15, 2026).
  freeCode: process.env.FREE_CODE || "2164039998",
  // Google OAuth for the Inboxes tab (Gmail read + drafts). Without these the
  // Inboxes tab reports honestly that no accounts are connected.
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || "",
  // Public base URL of this deployment (used for the OAuth redirect).
  appUrl: process.env.APP_URL || "",
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
