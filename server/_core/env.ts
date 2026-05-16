export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  ghlApiKey: process.env.GHL_API_KEY ?? "",
  ghlLocationId: process.env.GHL_LOCATION_ID ?? "",
  omnisendApiKey: process.env.OMNISEND_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  /** Phase 0 Overhaul: When true, disables 12 legacy background timers (fast scanner, self-review, lookback, auto-correction, disposition, outcome backfill, overdue catchup, event triggers, post-delivery, seasonal, lost-lead nurture, import nurture). Reactive webhooks (follow-up trigger, supervisor, deferred response, SLA, stuck lock cleaner) remain active. */
  disableLegacyTimers: process.env.DISABLE_LEGACY_TIMERS === "true",
};
