import { pool } from "./db.js";
import * as ghl from "./ghlClient.js";

// Normalize whatever shape a GHL conversation object has into what we store.
function normalizeConversation(c) {
  return {
    ghl_conversation_id: c.id,
    contact_ghl_id: c.contactId,
    contact_name: c.contactName || c.fullName || c.name || null,
    channel: c.lastMessageType || c.type || "SMS",
    unread_count: c.unreadCount ?? 0,
    assigned_to: c.assignedTo || c.userId || null,
    last_message_body: c.lastMessageBody || null,
    last_message_direction: c.lastMessageDirection || null,
    last_message_at: c.lastMessageDate ? new Date(c.lastMessageDate) : null,
  };
}

async function upsertContact(client, ghlContactId, name) {
  if (!ghlContactId) return null;
  const res = await client.query(
    `INSERT INTO contacts (ghl_contact_id, name, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (ghl_contact_id)
     DO UPDATE SET name = COALESCE(EXCLUDED.name, contacts.name), updated_at = now()
     RETURNING id`,
    [ghlContactId, name]
  );
  return res.rows[0].id;
}

async function upsertConversation(client, conv, contactRowId) {
  const res = await client.query(
    `INSERT INTO conversations
       (ghl_conversation_id, contact_id, contact_name, channel, unread_count,
        assigned_to, last_message_body, last_message_direction, last_message_at, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (ghl_conversation_id) DO UPDATE SET
       contact_id = EXCLUDED.contact_id,
       contact_name = EXCLUDED.contact_name,
       channel = EXCLUDED.channel,
       unread_count = EXCLUDED.unread_count,
       assigned_to = EXCLUDED.assigned_to,
       last_message_body = EXCLUDED.last_message_body,
       last_message_direction = EXCLUDED.last_message_direction,
       last_message_at = EXCLUDED.last_message_at,
       synced_at = now()
     RETURNING id`,
    [
      conv.ghl_conversation_id,
      contactRowId,
      conv.contact_name,
      conv.channel,
      conv.unread_count,
      conv.assigned_to,
      conv.last_message_body,
      conv.last_message_direction,
      conv.last_message_at,
    ]
  );
  return res.rows[0].id;
}

async function syncMessagesForConversation(client, ghlConversationId, localConvId) {
  let messages = [];
  try {
    messages = await ghl.getMessages(ghlConversationId);
  } catch (err) {
    console.error(`Failed to fetch messages for ${ghlConversationId}:`, err.message);
    return 0;
  }
  let count = 0;
  for (const m of messages) {
    const res = await client.query(
      `INSERT INTO messages (ghl_message_id, conversation_id, direction, channel, body, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (ghl_message_id) DO NOTHING`,
      [
        m.id,
        localConvId,
        m.direction || (m.type === "TYPE_INBOUND" ? "inbound" : "outbound"),
        m.messageType || m.type || null,
        m.body || m.message || null,
        m.status || null,
        m.dateAdded ? new Date(m.dateAdded) : new Date(),
      ]
    );
    if (res.rowCount) count++;
  }
  return count;
}

export async function runSync({ full = false, withMessages = true } = {}) {
  const client = await pool.connect();
  const logRes = await client.query(
    `INSERT INTO sync_log (started_at, status) VALUES (now(), 'running') RETURNING id`
  );
  const logId = logRes.rows[0].id;

  let convosSynced = 0;
  let messagesSynced = 0;

  try {
    const rawConvos = await ghl.searchConversations({ limit: full ? 200 : 100 });

    for (const raw of rawConvos) {
      const norm = normalizeConversation(raw);
      const contactRowId = await upsertContact(client, norm.contact_ghl_id, norm.contact_name);
      const localConvId = await upsertConversation(client, norm, contactRowId);
      convosSynced++;

      if (withMessages) {
        messagesSynced += await syncMessagesForConversation(client, norm.ghl_conversation_id, localConvId);
      }
    }

    await client.query(
      `UPDATE sync_log SET finished_at = now(), status = 'ok',
       conversations_synced = $1, messages_synced = $2 WHERE id = $3`,
      [convosSynced, messagesSynced, logId]
    );
  } catch (err) {
    console.error("Sync failed:", err);
    await client.query(
      `UPDATE sync_log SET finished_at = now(), status = 'error', error = $1 WHERE id = $2`,
      [err.message, logId]
    );
    throw err;
  } finally {
    client.release();
  }

  return { convosSynced, messagesSynced };
}
