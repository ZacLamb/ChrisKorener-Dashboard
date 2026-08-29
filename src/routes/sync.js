import express from "express";
import { pool } from "../db.js";
import { runSync } from "../sync.js";

const router = express.Router();

// POST /api/sync — trigger a sync from GHL. Body: { full?: boolean }
router.post("/", async (req, res) => {
  try {
    const result = await runSync({ full: !!req.body?.full });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/sync/status — last few sync runs
router.get("/status", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 10`
  );
  res.json(rows);
});

export default router;
