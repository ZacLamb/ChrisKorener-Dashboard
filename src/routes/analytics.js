import express from "express";
import { pool } from "../db.js";

const router = express.Router();

// GET /api/analytics — aggregate counts for dashboard charts
router.get("/", async (_req, res) => {
  const [byChannel, byDay, byAssignee, sentiment] = await Promise.all([
    pool.query(`SELECT channel, count(*) AS count FROM conversations GROUP BY channel ORDER BY count DESC`),
    pool.query(`
      SELECT date_trunc('day', last_message_at) AS day, count(*) AS count
      FROM conversations
      WHERE last_message_at > now() - interval '30 days'
      GROUP BY 1 ORDER BY 1
    `),
    pool.query(`
      SELECT COALESCE(assigned_to, 'Unassigned') AS assignee, count(*) AS count
      FROM conversations GROUP BY 1 ORDER BY count DESC
    `),
    pool.query(`SELECT sentiment, count(*) AS count FROM summaries GROUP BY sentiment`),
  ]);

  res.json({
    byChannel: byChannel.rows,
    byDay: byDay.rows,
    byAssignee: byAssignee.rows,
    sentiment: sentiment.rows,
  });
});

export default router;
