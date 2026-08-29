import express from "express";
import { pool } from "../db.js";
import { summarizeThread, buildOverviewReport } from "../ai.js";

const router = express.Router();

// POST /api/report — summarizes any un-summarized (or stale) conversations,
// then rolls everything up into one overview. This is the "report" button.
router.post("/", async (req, res) => {
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
       LIMIT 60`
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

    await pool.query(`INSERT INTO reports (overview, stats) VALUES ($1, $2)`, [
      overview,
      JSON.stringify(stats),
    ]);

    res.json({ overview, stats, resummarized: staleRes.rows.length });
  } catch (err) {
    console.error("Report generation failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/report/latest — most recently generated report, if any
router.get("/latest", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM reports ORDER BY created_at DESC LIMIT 1`
  );
  res.json(rows[0] || null);
});

export default router;
