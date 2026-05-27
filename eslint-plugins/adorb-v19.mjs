/**
 * eslint-plugins/adorb-v19.mjs
 *
 * Custom ESLint rules enforcing v1.9 data-access discipline.
 *
 * Rules:
 *   adorb-v19/no-direct-leads-write
 *     — Forbids db.update(leads).set(...) outside of the canonical helpers:
 *       updateLeadFields (db.ts) and applyComposeOutcome / applyNullBrainOutcome
 *       (apply-compose-outcome.ts). All lead writes must go through those helpers
 *       so firstContactSentAt, consecutiveNullCount, and bannedPhraseBlockCount
 *       are always updated atomically.
 *
 *   adorb-v19/no-direct-outbox-status-write
 *     — Forbids raw SQL UPDATE outbox SET outbox_status = ... outside of
 *       outbox-worker.ts (markOutbox, claimOutboxRows, rescheduleOutbox) and
 *       compose-and-send.ts. All outbox status transitions must go through
 *       those modules to preserve the v1.9 lifecycle contract.
 */

/** @type {import('eslint').Rule.RuleModule} */
const noDirectLeadsWrite = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid db.update(leads).set() outside canonical helpers (updateLeadFields, applyComposeOutcome, applyNullBrainOutcome).",
      category: "v1.9 Data Discipline",
    },
    messages: {
      forbidden:
        "Direct db.update(leads) call detected. Use updateLeadFields() from db.ts or applyComposeOutcome() from apply-compose-outcome.ts instead.",
    },
    schema: [],
  },
  create(context) {
    // ESLint 9 flat config uses context.filename; ESLint 8 uses context.getFilename()
    const filename = context.filename ?? (typeof context.getFilename === "function" ? context.getFilename() : "");
    // Allowed files: the canonical helpers themselves
    const ALLOWED = [
      "db.ts",
      "apply-compose-outcome.ts",
    ];
    if (ALLOWED.some((f) => filename.endsWith(f))) return {};

    return {
      CallExpression(node) {
        // Match: db.update(leads)
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "update" &&
          node.arguments.length >= 1
        ) {
          const arg = node.arguments[0];
          if (
            arg.type === "Identifier" &&
            arg.name === "leads"
          ) {
            context.report({ node, messageId: "forbidden" });
          }
        }
      },
    };
  },
};

/** @type {import('eslint').Rule.RuleModule} */
const noDirectOutboxStatusWrite = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid raw UPDATE outbox SET outbox_status outside outbox-worker.ts and compose-and-send.ts.",
      category: "v1.9 Data Discipline",
    },
    messages: {
      forbidden:
        "Direct outbox status SQL detected. Use markOutbox() in outbox-worker.ts or the status-update helpers in compose-and-send.ts instead.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? (typeof context.getFilename === "function" ? context.getFilename() : "");
    const ALLOWED = [
      "outbox-worker.ts",
      "compose-and-send.ts",
      "apply-compose-outcome.ts",
      "crons.ts", // crons.ts owns orphaned-claim reclaim per spec §5.7.1
    ];
    if (ALLOWED.some((f) => filename.endsWith(f))) return {};

    return {
      // Detect: db.execute(sql`UPDATE outbox SET outbox_status ...`)
      // or: db.execute(sql`UPDATE outbox SET status ...`)
      TaggedTemplateExpression(node) {
        const quasi = node.quasi;
        if (!quasi) return;
        const raw = quasi.quasis.map((q) => q.value.raw).join("");
        if (
          /UPDATE\s+outbox\s+SET\s+(outbox_status|status)\s*=/i.test(raw)
        ) {
          context.report({ node, messageId: "forbidden" });
        }
      },
      // Also catch string-based execute calls
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "execute"
        ) {
          const arg = node.arguments[0];
          if (arg && arg.type === "Literal" && typeof arg.value === "string") {
            if (/UPDATE\s+outbox\s+SET\s+(outbox_status|status)\s*=/i.test(arg.value)) {
              context.report({ node, messageId: "forbidden" });
            }
          }
        }
      },
    };
  },
};

export default {
  meta: {
    name: "adorb-v19",
    version: "1.0.0",
  },
  rules: {
    "no-direct-leads-write": noDirectLeadsWrite,
    "no-direct-outbox-status-write": noDirectOutboxStatusWrite,
  },
};
