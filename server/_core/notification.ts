import { TRPCError } from "@trpc/server";
import { ENV } from "./env";

export type NotificationPayload = {
  title: string;
  content: string;
};

// ---------------------------------------------------------------------------
// Deduplication cache — prevents notification spam when multiple subsystems
// fire for the same lead/event within a short window.
// Key: normalized title | TTL: 5 minutes
// ---------------------------------------------------------------------------
const _dedupCache = new Map<string, number>();
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

function _dedupKey(title: string): string {
  // Normalize: lowercase, strip non-alphanumeric chars (emoji, icons), collapse whitespace
  return title
    .toLowerCase()
    .replace(/[^a-z0-9: ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function _isDuplicate(title: string): boolean {
  const key = _dedupKey(title);
  const lastSent = _dedupCache.get(key);
  const now = Date.now();
  if (lastSent !== undefined && now - lastSent < DEDUP_TTL_MS) {
    return true;
  }
  _dedupCache.set(key, now);
  // Prune stale entries periodically to prevent unbounded growth
  if (_dedupCache.size > 500) {
    const entries = Array.from(_dedupCache.entries());
    for (const [k, ts] of entries) {
      if (now - ts > DEDUP_TTL_MS) _dedupCache.delete(k);
    }
  }
  return false;
}

const TITLE_MAX_LENGTH = 1200;
const CONTENT_MAX_LENGTH = 20000;

const trimValue = (value: string): string => value.trim();
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const buildEndpointUrl = (baseUrl: string): string => {
  const normalizedBase = baseUrl.endsWith("/")
    ? baseUrl
    : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};

const validatePayload = (input: NotificationPayload): NotificationPayload => {
  if (!isNonEmptyString(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required.",
    });
  }
  if (!isNonEmptyString(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required.",
    });
  }

  const title = trimValue(input.title);
  const content = trimValue(input.content);

  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`,
    });
  }

  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`,
    });
  }

  return { title, content };
};

/**
 * Dispatches a project-owner notification through the Manus Notification Service.
 *
 * Built-in deduplication: if the same notification title fires more than once
 * within a 5-minute window (e.g., multiple subsystems reacting to the same
 * webhook event), only the first call sends — subsequent calls return `true`
 * silently without hitting the upstream service.
 *
 * Returns `true` if the request was accepted (or suppressed as a duplicate),
 * `false` when the upstream service cannot be reached. Validation errors
 * bubble up as TRPC errors so callers can fix the payload.
 */
export async function notifyOwner(
  payload: NotificationPayload
): Promise<boolean> {
  const { title, content } = validatePayload(payload);

  // Deduplicate: skip if same title was sent within the last 5 minutes
  if (_isDuplicate(title)) {
    console.log(`[Notification] Suppressed duplicate: "${title}"`);
    return true;
  }

  if (!ENV.forgeApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service URL is not configured.",
    });
  }

  if (!ENV.forgeApiKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service API key is not configured.",
    });
  }

  const endpoint = buildEndpointUrl(ENV.forgeApiUrl);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "content-type": "application/json",
        "connect-protocol-version": "1",
      },
      body: JSON.stringify({ title, content }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Failed to notify owner (${response.status} ${response.statusText})${
          detail ? `: ${detail}` : ""
        }`
      );
      return false;
    }

    return true;
  } catch (error) {
    console.warn("[Notification] Error calling notification service:", error);
    return false;
  }
}
