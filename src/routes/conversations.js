import express from "express";
import { pool } from "../db.js";
import * as ghl from "../ghlClient.js";
import { summarizeThread, suggestReplies } from "../ai.js";

const router = express.Router();

// GET /api/conversations — list with filters
router.get("/", async (req, res) => {
  const { channel, assignedTo, tag, search, status, priority, dateFrom, dateTo, sort } = req.query;
  const clauses = [];
  const params = [];
  let i = 1;

  if (channel) {
    clauses.push(`c.channel = $${i++}`);
    params.push(channel);
  }
  if (assignedTo) {
    clauses.push(`c.assigned_to = $${i++}`);
    params.push(assignedTo);
  }
  if (status === "unread") clauses.push(`c.unread_count > 0`);
  if (status === "read") clauses.push(`c.unread_count = 0`);
  if (priority) {
    clauses.push(`s.priority = $${i++}`);
    params.push(priority);
  }
  if (search) {
    clauses.push(`(c.contact_name ILIKE $${i} OR c.last_message_body ILIKE $${i})`);
    params.push(`%${search}%`);
    i++;
  }
  if (dateFrom) {
    clauses.push(`c.last_message_at >= $${i++}`);
    params.push(dateFrom);
  }
  if (dateTo) {
    clauses.push(`c.last_message_at <= $${i++}`);
    params.push(dateTo);
  }
  if (tag) {
    clauses.push(`$${i++} = ANY(ct.tags)`);
    params.push(tag);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  // Default sort is priority-first — that's the point of the dashboard:
  // urgent threads surface at the very top, then high, normal, low, and
  // untriaged (no summary yet) threads sit alongside "normal" rather than
  // getting buried or jumping the queue.
  const PRIORITY_ORDER = `CASE s.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 2 END`;
  let orderBy;
  if (sort === "oldest") orderBy = "c.last_message_at ASC";
  else if (sort === "newest") orderBy = "c.last_message_at DESC";
  else orderBy = `${PRIORITY_ORDER} ASC, c.last_message_at DESC`;

  const { rows } = await pool.query(
    `SELECT c.id, c.ghl_conversation_id, c.contact_name, c.channel, c.unread_count,
            c.assigned_to, c.last_message_body, c.last_message_direction, c.last_message_at,
            ct.email, ct.phone, ct.tags,
            s.summary, s.sentiment, s.action_needed, s.priority, s.priority_reason
     FROM conversations c
     LEFT JOIN contacts ct ON ct.id = c.contact_id
     LEFT JOIN summaries s ON s.conversation_id = c.id
     ${where}
     ORDER BY ${orderBy}
     LIMIT 300`,
    params
  );
  res.json(rows);
});

// GET /api/conversations/filters — distinct values for dropdowns + priority counts
router.get("/filters", async (_req, res) => {
  const [channels, assignees, tags, priorities] = await Promise.all([
    pool.query(`SELECT DISTINCT channel FROM conversations WHERE channel IS NOT NULL ORDER BY 1`),
    pool.query(`SELECT DISTINCT assigned_to FROM conversations WHERE assigned_to IS NOT NULL ORDER BY 1`),
    pool.query(`SELECT DISTINCT unnest(tags) AS tag FROM contacts ORDER BY 1`),
    pool.query(`SELECT priority, count(*) AS count FROM summaries WHERE priority IS NOT NULL GROUP BY priority`),
  ]);
  res.json({
    channels: channels.rows.map((r) => r.channel),
    assignees: assignees.rows.map((r) => r.assigned_to),
    tags: tags.rows.map((r) => r.tag),
    priorityCounts: priorities.rows.reduce((acc, r) => ({ ...acc, [r.priority]: Number(r.count) }), {}),
  });
});

// GET /api/conversations/:id — thread + messages + summary
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  const convRes = await pool.query(
    `SELECT c.*, ct.email, ct.phone, ct.tags,
            s.summary, s.sentiment, s.action_needed, s.priority, s.priority_reason, s.updated_at AS summarized_at,
            rs.suggestions, rs.updated_at AS suggestions_updated_at
     FROM conversations c
     LEFT JOIN contacts ct ON ct.id = c.contact_id
     LEFT JOIN summaries s ON s.conversation_id = c.id
     LEFT JOIN reply_suggestions rs ON rs.conversation_id = c.id
     WHERE c.id = $1`,
    [id]
  );
  if (!convRes.rows.length) return res.status(404).json({ error: "Not found" });

  const msgRes = await pool.query(
    `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [id]
  );
  res.json({ conversation: convRes.rows[0], messages: msgRes.rows });
});

// POST /api/conversations/:id/summarize — force (re)compute AI summary + priority
router.post("/:id/summarize", async (req, res) => {
  const { id } = req.params;
  const convRes = await pool.query(`SELECT * FROM conversations WHERE id = $1`, [id]);
  if (!convRes.rows.length) return res.status(404).json({ error: "Not found" });
  const conv = convRes.rows[0];

  const msgRes = await pool.query(
    `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [id]
  );
  if (!msgRes.rows.length) return res.status(400).json({ error: "No messages to summarize yet" });

  try {
    const result = await summarizeThread({
      contactName: conv.contact_name,
      channel: conv.channel,
      messages: msgRes.rows,
    });

    await pool.query(
      `INSERT INTO summaries (conversation_id, summary, sentiment, action_needed, priority, priority_reason, model, summarized_message_count, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (conversation_id) DO UPDATE SET
         summary = EXCLUDED.summary, sentiment = EXCLUDED.sentiment,
         action_needed = EXCLUDED.action_needed, priority = EXCLUDED.priority,
         priority_reason = EXCLUDED.priority_reason, model = EXCLUDED.model,
         summarized_message_count = EXCLUDED.summarized_message_count, updated_at = now()`,
      [id, result.summary, result.sentiment, result.action_needed, result.priority, result.priority_reason, process.env.AI_PROVIDER, msgRes.rows.length]
    );
    res.json(result);
  } catch (err) {
    console.error("Summarize failed:", err.message);
    res.status(500).json({ error: "Summarization failed", detail: err.message });
  }
});

// POST /api/conversations/:id/suggest-replies — generate 2-3 ready-to-send reply options
router.post("/:id/suggest-replies", async (req, res) => {
  const { id } = req.params;
  const convRes = await pool.query(`SELECT * FROM conversations WHERE id = $1`, [id]);
  if (!convRes.rows.length) return res.status(404).json({ error: "Not found" });
  const conv = convRes.rows[0];

  const msgRes = await pool.query(
    `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [id]
  );
  if (!msgRes.rows.length) return res.status(400).json({ error: "No messages to reply to yet" });

  try {
    const suggestions = await suggestReplies({
      contactName: conv.contact_name,
      channel: conv.channel,
      messages: msgRes.rows,
    });

    await pool.query(
      `INSERT INTO reply_suggestions (conversation_id, suggestions, model, message_count, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (conversation_id) DO UPDATE SET
         suggestions = EXCLUDED.suggestions, model = EXCLUDED.model,
         message_count = EXCLUDED.message_count, updated_at = now()`,
      [id, JSON.stringify(suggestions), process.env.AI_PROVIDER, msgRes.rows.length]
    );
    res.json({ suggestions });
  } catch (err) {
    console.error("Suggest-replies failed:", err.message);
    res.status(500).json({ error: "Couldn't generate suggestions", detail: err.message });
  }
});

// POST /api/conversations/:id/reply — send a message, auto-matching the thread's channel
router.post("/:id/reply", async (req, res) => {
  const { id } = req.params;
  const { message, subject, html } = req.body;
  if (!message) return res.status(400).json({ error: "message is required" });

  const convRes = await pool.query(
    `SELECT c.*, ct.ghl_contact_id FROM conversations c
     LEFT JOIN contacts ct ON ct.id = c.contact_id
     WHERE c.id = $1`,
    [id]
  );
  if (!convRes.rows.length) return res.status(404).json({ error: "Not found" });
  const conv = convRes.rows[0];

  const sendType = ghl.channelToSendType(conv.channel);

  try {
    const result = await ghl.sendMessage({
      conversationId: conv.ghl_conversation_id,
      contactId: conv.ghl_contact_id,
      type: sendType,
      message,
      subject,
      html,
    });

    await pool.query(
      `INSERT INTO messages (ghl_message_id, conversation_id, direction, channel, body, status, created_at)
       VALUES ($1,$2,'outbound',$3,$4,'sent', now())
       ON CONFLICT (ghl_message_id) DO NOTHING`,
      [result.messageId || result.id || `local-${Date.now()}`, id, conv.channel, message]
    );
    await pool.query(
      `UPDATE conversations SET last_message_body = $1, last_message_direction = 'outbound', last_message_at = now() WHERE id = $2`,
      [message, id]
    );

    res.json({ ok: true, sentAs: sendType, result });
  } catch (err) {
    console.error("Reply failed:", err.response?.data || err.message);
    res.status(500).json({ error: "Send failed", detail: err.response?.data || err.message });
  }
});

export default router;
