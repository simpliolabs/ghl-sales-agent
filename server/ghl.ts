import axios from "axios";
import { ENV } from "./_core/env";

const GHL_BASE = "https://services.leadconnectorhq.com";

const ghlClient = axios.create({
  baseURL: GHL_BASE,
  headers: {
    Authorization: `Bearer ${ENV.ghlApiKey}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
  },
});

// --- Contacts ---
export async function getContact(contactId: string) {
  const { data } = await ghlClient.get(`/contacts/${contactId}`);
  return data.contact;
}

export async function searchContacts(query: string, limit = 20) {
  const { data } = await ghlClient.get("/contacts/", {
    params: { locationId: ENV.ghlLocationId, query, limit },
  });
  return data.contacts || [];
}

export async function getContacts(limit = 100, startAfterId?: string) {
  const params: Record<string, unknown> = { locationId: ENV.ghlLocationId, limit };
  if (startAfterId) params.startAfterId = startAfterId;
  const { data } = await ghlClient.get("/contacts/", { params });
  return data;
}

export async function updateContactCustomField(contactId: string, customFields: Array<{ id: string; field_value: string }>) {
  const { data } = await ghlClient.put(`/contacts/${contactId}`, {
    customFields,
  });
  return data;
}

// --- Messages ---
export async function sendMessage(contactId: string, opts: {
  type: "SMS" | "Email" | "WhatsApp" | "FB" | "IG";
  message?: string;
  subject?: string;
  html?: string;
  fromName?: string;
}) {
  const payload: Record<string, unknown> = {
    type: opts.type,
    contactId,
  };
  if (opts.type === "Email") {
    payload.subject = opts.subject || "";
    payload.html = opts.html || opts.message || "";
    payload.emailFrom = "print@adorbcustomtees.com";
    if (opts.fromName) payload.emailFrom = `${opts.fromName} <print@adorbcustomtees.com>`;
  } else {
    payload.message = opts.message || "";
  }
  const { data } = await ghlClient.post(`/conversations/messages`, payload);
  return data;
}

export async function getConversationMessages(conversationId: string) {
  const { data } = await ghlClient.get(`/conversations/${conversationId}/messages`);
  return data.messages || [];
}

export async function getContactConversations(contactId: string) {
  const { data } = await ghlClient.get(`/conversations/search`, {
    params: { locationId: ENV.ghlLocationId, contactId },
  });
  return data.conversations || [];
}

// --- Tasks ---
export async function createTask(contactId: string, opts: {
  title: string;
  body?: string;
  dueDate?: string;
  assignedTo?: string;
}) {
  const { data } = await ghlClient.post(`/contacts/${contactId}/tasks`, {
    title: opts.title,
    body: opts.body || "",
    dueDate: opts.dueDate || new Date().toISOString(),
    completed: false,
    assignedTo: opts.assignedTo,
  });
  return data;
}

// --- Custom Fields ---
export async function getCustomFields() {
  const { data } = await ghlClient.get(`/locations/${ENV.ghlLocationId}/customFields`);
  return data.customFields || [];
}

// --- Opportunities / Pipeline ---
export async function getOpportunities(pipelineId: string, limit = 20, startAfterId?: string) {
  const params: Record<string, unknown> = { locationId: ENV.ghlLocationId, pipelineId, limit };
  if (startAfterId) params.startAfterId = startAfterId;
  const { data } = await ghlClient.get("/opportunities/search", { params });
  return data;
}

export async function updateOpportunityStage(opportunityId: string, stageId: string) {
  const { data } = await ghlClient.put(`/opportunities/${opportunityId}`, {
    stageId,
  });
  return data;
}

export async function updateOpportunityValue(opportunityId: string, monetaryValue: number) {
  const { data } = await ghlClient.put(`/opportunities/${opportunityId}`, {
    monetaryValue,
  });
  return data;
}

export async function getPipelines() {
  const { data } = await ghlClient.get("/opportunities/pipelines", {
    params: { locationId: ENV.ghlLocationId },
  });
  return data.pipelines || [];
}

// --- Users (Agents) ---
export async function getLocationUsers() {
  try {
    const { data } = await ghlClient.get(`/users/search`, {
      params: { companyId: ENV.ghlLocationId, locationId: ENV.ghlLocationId },
    });
    return data.users || [];
  } catch {
    return [];
  }
}

// --- Internal Notes ---
export async function addNote(contactId: string, body: string) {
  const { data } = await ghlClient.post(`/contacts/${contactId}/notes`, {
    body,
  });
  return data;
}

export async function getNotes(contactId: string) {
  const { data } = await ghlClient.get(`/contacts/${contactId}/notes`);
  return data.notes || [];
}
