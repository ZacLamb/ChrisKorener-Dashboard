import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const VERSION = process.env.GHL_API_VERSION || "2021-07-28";
const LOCATION_ID = process.env.GHL_LOCATION_ID;

const client = axios.create({
  baseURL: BASE,
  headers: {
    Authorization: `Bearer ${process.env.GHL_API_TOKEN}`,
    Version: VERSION,
    "Content-Type": "application/json",
  },
  timeout: 20000,
});

// Map a GHL conversation's lastMessageType (or messageType) to the "type"
// value the Send Message endpoint expects. GHL's naming isn't 100%
// consistent across responses, so this normalizes the common variants.
export function channelToSendType(channel) {
  const map = {
    TYPE_SMS: "SMS",
    SMS: "SMS",
    TYPE_EMAIL: "Email",
    Email: "Email",
    TYPE_WHATSAPP: "WhatsApp",
    WhatsApp: "WhatsApp",
    TYPE_FACEBOOK: "FB",
    FB: "FB",
    TYPE_INSTAGRAM: "IG",
    IG: "IG",
    TYPE_GMB: "GMB",
    GMB: "GMB",
    TYPE_LIVE_CHAT: "Live_Chat",
    Live_Chat: "Live_Chat",
    TYPE_CALL: "Call",
    Call: "Call",
  };
  return map[channel] || channel || "SMS";
}

/**
 * List/search conversations for the location.
 * NOTE: GHL has iterated on this endpoint's exact query params over time.
 * If your Private Integration Token comes back with a schema error here,
 * check the current shape at your API docs and adjust the params object —
 * everything that touches GHL lives in this one file.
 */
export async function searchConversations({ limit = 100, startAfter, query } = {}) {
  const params = { locationId: LOCATION_ID, limit };
  if (startAfter) params.startAfterDate = startAfter;
  if (query) params.query = query;
  const { data } = await client.get("/conversations/search", { params });
  return data.conversations || data.data || [];
}

export async function getConversation(conversationId) {
  const { data } = await client.get(`/conversations/${conversationId}`);
  return data.conversation || data;
}

export async function getMessages(conversationId, { limit = 100 } = {}) {
  const { data } = await client.get(`/conversations/${conversationId}/messages`, {
    params: { limit },
  });
  return data.messages?.messages || data.messages || [];
}

export async function getContact(contactId) {
  const { data } = await client.get(`/contacts/${contactId}`);
  return data.contact || data;
}

/**
 * Send a reply. `type` should be the channel the thread came in on
 * (SMS, Email, WhatsApp, FB, IG, GMB, Live_Chat) — see channelToSendType().
 */
export async function sendMessage({ conversationId, contactId, type, message, subject, html }) {
  const body = { type, contactId, message };
  if (conversationId) body.conversationId = conversationId;
  if (type === "Email") {
    if (subject) body.subject = subject;
    if (html) body.html = html;
  }
  const { data } = await client.post("/conversations/messages", body);
  return data;
}

export default {
  searchConversations,
  getConversation,
  getMessages,
  getContact,
  sendMessage,
  channelToSendType,
};
