import express from "express";
import { pool } from "../db.js";
import { summarizeThread, buildOverviewReport } from "../ai.js";

const router = express.Router();

let jobRunning = false;

async function generateReport(reportId) {
  try {
    // 1. Find conversations that have messages but no summary yet, or whose
    // summary predates their last message (stale).
    const staleRes = await pool.query(
      `SELECT c.id, c.contact_name, c.channel
       FROM conversations c
       LEFT JOIN summaries s ON s.conversation_id = c.id
       WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
         AND (s.conversation_id IS NULL OR s.updated_at < c.last_message_at)
       ORDER BY c.last_message_at DESC
       LIMIT 150`
    );

    for (const conv of staleRes.rows) {
      const msgRes = await pool.query(
        `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
        [conv.id]
      );
      if (!msgRes.rows.length) continue;
      try {
        const result = await summarizeThread({
          contactName: conv.contact_name,
          channel: conv.channel,
          messages: msgRes.rows,
        });
        await pool.query(
          `INSERT INTO summaries (conversation_id, summary, sentiment, action_needed, model, summarized_message_count, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6, now())
           ON CONFLICT (conversation_id) DO UPDATE SET
             summary = EXCLUDED.summary, sentiment = EXCLUDED.sentiment,
             action_needed = EXCLUDED.action_needed, model = EXCLUDED.model,
             summarized_message_count = EXCLUDED.summarized_message_count, updated_at = now()`,
          [conv.id, result.summary, result.sentiment, result.action_needed, process.env.AI_PROVIDER, msgRes.rows.length]
        );
      } catch (err) {
        console.error(`Failed to summarize conversation ${conv.id}:`, err.message);
      }
    }

    // 2. Pull stats.
    const statsRes = await pool.query(`
      SELECT
        (SELECT count(*) FROM conversations) AS total_conversations,
        (SELECT count(*) FROM conversations WHERE unread_count > 0) AS unread_conversations,
        (SELECT count(*) FROM summaries WHERE action_needed = true) AS needs_action,
        (SELECT count(*) FROM summaries WHERE sentiment = 'negative') AS negative_sentiment,
        (SELECT json_object_agg(channel, cnt) FROM (
           SELECT channel, count(*) AS cnt FROM conversations GROUP BY channel
         ) t) AS by_channel
    `);
    const stats = statsRes.rows[0];

    // 3. Roll up into an executive overview.
    const summaryLinesRes = await pool.query(
      `SELECT c.contact_name, c.channel, s.summary, s.action_needed
       FROM summaries s JOIN conversations c ON c.id = s.conversation_id
       ORDER BY c.last_message_at DESC LIMIT 300`
    );
    const lines = summaryLinesRes.rows.map(
      (r) => `[${r.channel}${r.action_needed ? ", NEEDS ACTION" : ""}] ${r.contact_name || "Unknown"}: ${r.summary}`
    );

    let overview = "No summarized conversations yet — run a sync first.";
    if (lines.length) {
      overview = await buildOverviewReport(lines);
    }

    await pool.query(
      `UPDATE reports SET overview = $1, stats = $2, resummarized = $3, status = 'done' WHERE id = $4`,
      [overview, JSON.stringify(stats), staleRes.rows.length, reportId]
    );
  } catch (err) {
    console.error("Report generation failed:", err);
    await pool.query(`UPDATE reports SET status = 'error', error = $1 WHERE id = $2`, [
      err.message,
      reportId,
    ]);
  } finally {
    jobRunning = false;
  }
}

// POST /api/report — kicks off report generation in the background and
// returns immediately. The frontend polls GET /api/report/latest for progress.
// (Summarizing 50-150 threads can take minutes — holding one HTTP request
// open that long trips Railway's proxy timeout, hence the async job here.)
router.post("/", async (_req, res) => {
  if (jobRunning) {
    return res.status(409).json({ error: "A report is already running — check back in a moment." });
  }
  jobRunning = true;

  const insertRes = await pool.query(
    `INSERT INTO reports (status) VALUES ('running') RETURNING id`
  );
  const reportId = insertRes.rows[0].id;

  res.json({ ok: true, id: reportId, status: "running" });

  // Fire and forget — runs after the response is already sent.
  generateReport(reportId);
});

// GET /api/report/latest — most recently generated/generating report
router.get("/latest", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM reports ORDER BY created_at DESC LIMIT 1`
  );
  res.json(rows[0] || null);
});

export default router;
