import axios from "axios";
import { ENV } from "./_core/env";

const omnisendClient = axios.create({
  baseURL: "https://api.omnisend.com/v3",
  headers: {
    "X-API-KEY": ENV.omnisendApiKey,
    "Content-Type": "application/json",
  },
});

export async function pushContactToOmnisend(contact: {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  tags?: string[];
}) {
  try {
    const payload: Record<string, unknown> = {
      identifiers: [{ type: "email", id: contact.email, channels: { email: { status: "subscribed" } } }],
      firstName: contact.firstName || "",
      lastName: contact.lastName || "",
      tags: contact.tags || [],
    };
    if (contact.phone) {
      (payload.identifiers as Array<Record<string, unknown>>).push({
        type: "phone",
        id: contact.phone,
        channels: { sms: { status: "subscribed" } },
      });
    }
    const { data } = await omnisendClient.post("/contacts", payload);
    return data;
  } catch (err: unknown) {
    const error = err as { response?: { status?: number; data?: unknown } };
    if (error.response?.status === 409) {
      // Contact exists, update tags
      return updateOmnisendTags(contact.email, contact.tags || []);
    }
    console.error("[Omnisend] Push contact error:", error.response?.data || err);
    return null;
  }
}

export async function updateOmnisendTags(email: string, tags: string[]) {
  try {
    const { data } = await omnisendClient.patch(`/contacts/${encodeURIComponent(email)}`, { tags });
    return data;
  } catch (err: unknown) {
    const error = err as { response?: { data?: unknown } };
    console.error("[Omnisend] Update tags error:", error.response?.data || err);
    return null;
  }
}
