/**
 * eslint.config.mjs — v1.9 ESLint flat config
 *
 * Enforces custom adorb-v19 rules for data-access discipline.
 * Rules defined in eslint-plugins/adorb-v19.mjs:
 *   - no-direct-leads-write: all lead writes via updateLeadFields / applyComposeOutcome
 *   - no-direct-outbox-status-write: all outbox status writes via markOutbox / allowed modules
 *
 * Grandfather exceptions for pre-v1.9 violations are documented in notes/v1.9-tech-debt.md.
 */
import adorbV19 from "./eslint-plugins/adorb-v19.mjs";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["server/**/*.ts"],
    ignores: [
      "server/**/*.test.ts",
      "server/_core/**",
      // TODO(v1.9-tech-debt): migrate to updateLeadFields() in Phase 2
      // These files have pre-v1.9 db.update(leads) calls grandfathered in.
      // Tracking: see notes/v1.9-tech-debt.md
      "server/brain-adapter.ts",
      "server/scheduling-engine.ts",
      "server/webhook-events.ts",
    ],
    plugins: {
      "adorb-v19": adorbV19,
    },
    languageOptions: {
      parser: tsParser,
    },
    rules: {
      "adorb-v19/no-direct-leads-write": "error",
      "adorb-v19/no-direct-outbox-status-write": "error",
    },
  },
];
